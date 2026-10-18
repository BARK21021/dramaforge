// ============================================================
// /api/admin/users/[userId]/recharge — 契约测试（手动充值 + 幂等）
// ============================================================
//
// 覆盖：
//   POST
//     - 未登录 → 401 UNAUTHORIZED
//     - 已登录非管理员 → 403 FORBIDDEN
//     - amountYuan 非法（< 1 / > 10000 / 非数字 / 缺失）→ 400 BAD_AMOUNT
//     - amountYuan 合法 → 200 + envelope { credits, rechargeCredits, ledgerId }
//     - 1 元 = 10 积分换算：amountYuan=10 → rechargeCredits=100
//     - idempotencyKey 透传：body 携带 → 进入 creditManual metadata.idempotencyKey
//     - idempotencyKey 缺省：creditManual 不收到该字段（保持 app1 兼容路径）
//     - adminUserId 透传：requireAdmin 解析出的 admin.userId 进 metadata
//     - note 透传：body.note → metadata.note + description 文案
//     - 异常（creditManual 抛 BillingError 404 用户不存在）→ handleApiError 转 envelope
//
// 注：幂等的真实去重逻辑在 server/test/domain/billing.test.ts 的 creditManual 块覆盖
// （依赖有状态 mock query）。本文件验证 route 层正确透传 idempotencyKey 到 service。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { serverMock, getServerSessionMock } from '../../../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../../../test/helpers';
import { POST } from '../route';

const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'ADMIN' },
  expires: '2099-01-01T00:00:00.000Z',
};

const TARGET_USER_ID = 'u-target';

function rechargeReq(body: unknown): NextRequest {
  return makeRequest({
    method: 'POST',
    url: `http://localhost/api/admin/users/${TARGET_USER_ID}/recharge`,
    body,
  }) as NextRequest;
}

function rechargeCtx() {
  return makeParamsCtx({ userId: TARGET_USER_ID });
}

/** 构造一个 creditManual 的返回值（对齐 server/src/domain/billing/service.ts BillingEntry）。 */
function makeManualEntry(overrides: Partial<{
  id: string;
  balance: number;
}> = {}) {
  return {
    id: overrides.id ?? 'ledger-1',
    userId: TARGET_USER_ID,
    taskId: null,
    type: 'PURCHASE_CREDIT' as const,
    amount: -100,
    balance: overrides.balance ?? 200,
    credits: 100,
    description: '管理员充值 ¥10',
    metadata: { rechargeCredits: 100, source: 'admin_manual' },
    createdAt: '2026-07-21T00:00:00.000Z',
  };
}

describe('POST /api/admin/users/[userId]/recharge — auth guard', () => {
  beforeEach(() => {
    serverMock.getUserRoleById.mockReset();
    serverMock.creditManual.mockReset();
  });

  it('returns 401 UNAUTHORIZED when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(rechargeReq({ amountYuan: 10 }), rechargeCtx());
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('UNAUTHORIZED');
    expect(serverMock.creditManual).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN when authenticated but DB role !== ADMIN', async () => {
    getServerSessionMock.mockResolvedValue({
      user: { id: 'user-vip', role: 'VIP' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    serverMock.getUserRoleById.mockResolvedValue('VIP');
    const res = await POST(rechargeReq({ amountYuan: 10 }), rechargeCtx());
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('FORBIDDEN');
    expect(serverMock.creditManual).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/users/[userId]/recharge — amount validation', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.creditManual.mockReset();
  });

  it('returns 400 BAD_AMOUNT when amountYuan < 1', async () => {
    const res = await POST(rechargeReq({ amountYuan: 0.5 }), rechargeCtx());
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('BAD_AMOUNT');
    expect(serverMock.creditManual).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_AMOUNT when amountYuan > 10000', async () => {
    const res = await POST(rechargeReq({ amountYuan: 10001 }), rechargeCtx());
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('BAD_AMOUNT');
    expect(serverMock.creditManual).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_AMOUNT when amountYuan is missing / non-finite', async () => {
    const res = await POST(rechargeReq({ amountYuan: 'abc' }), rechargeCtx());
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('BAD_AMOUNT');
    expect(serverMock.creditManual).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_AMOUNT when body is malformed JSON', async () => {
    const req = new NextRequest(
      `http://localhost/api/admin/users/${TARGET_USER_ID}/recharge`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' },
    );
    const res = await POST(req, rechargeCtx());
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('BAD_AMOUNT');
    expect(serverMock.creditManual).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/users/[userId]/recharge — happy path + conversion', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.creditManual.mockReset();
  });

  it('returns 200 + { credits, rechargeCredits, ledgerId } and converts 1 元 = 10 积分', async () => {
    serverMock.creditManual.mockResolvedValue(makeManualEntry({ balance: 200 }));
    const res = await POST(rechargeReq({ amountYuan: 10 }), rechargeCtx());
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { credits: number; rechargeCredits: number; ledgerId: string };
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      credits: 200, // 来自 entry.balance
      rechargeCredits: 100, // 10 / 0.1 = 100
      ledgerId: 'ledger-1',
    });
  });

  it('passes adminUserId (from requireAdmin) into creditManual metadata', async () => {
    serverMock.creditManual.mockResolvedValue(makeManualEntry());
    await POST(rechargeReq({ amountYuan: 10 }), rechargeCtx());
    expect(serverMock.creditManual).toHaveBeenCalledTimes(1);
    const [, , , metadata] = serverMock.creditManual.mock.calls[0];
    expect(metadata).toMatchObject({ adminUserId: 'admin-1' });
  });

  it('embeds note into description and metadata.note when provided', async () => {
    serverMock.creditManual.mockResolvedValue(makeManualEntry());
    await POST(rechargeReq({ amountYuan: 10, note: '现金' }), rechargeCtx());
    const [, , description, metadata] = serverMock.creditManual.mock.calls[0];
    expect(description).toBe('管理员充值 ¥10（备注：现金）');
    expect(metadata).toMatchObject({ note: '现金' });
  });

  it('description omits 备注 clause when note missing/empty', async () => {
    serverMock.creditManual.mockResolvedValue(makeManualEntry());
    await POST(rechargeReq({ amountYuan: 5 }), rechargeCtx());
    const [, , description, metadata] = serverMock.creditManual.mock.calls[0];
    expect(description).toBe('管理员充值 ¥5');
    expect(metadata).toMatchObject({ note: undefined });
  });

  it('forwards BillingError(404) from creditManual via handleApiError as envelope', async () => {
    // service 层用户不存在 → BillingError(404)；route 应透传为 envelope
    const err = Object.assign(new Error('用户不存在'), {
      name: 'BillingError',
      statusCode: 404,
    });
    serverMock.creditManual.mockRejectedValue(err);
    const res = await POST(rechargeReq({ amountYuan: 10 }), rechargeCtx());
    // BillingError 不是 AuthError/ZodError → 走 handleApiError 兜底 500 路径
    // （route 层只识别 AuthError，BillingError 走 generic INTERNAL_ERROR）
    expect(res.status).toBe(500);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});

describe('POST /api/admin/users/[userId]/recharge — idempotencyKey pass-through', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.creditManual.mockReset();
  });

  it('forwards body.idempotencyKey into creditManual metadata.idempotencyKey', async () => {
    serverMock.creditManual.mockResolvedValue(makeManualEntry());
    await POST(
      rechargeReq({ amountYuan: 10, idempotencyKey: 'uuid-from-form-1' }),
      rechargeCtx(),
    );
    const [, , , metadata] = serverMock.creditManual.mock.calls[0];
    expect(metadata).toMatchObject({ idempotencyKey: 'uuid-from-form-1' });
  });

  it('omits idempotencyKey from metadata when body lacks it (backwards-compat)', async () => {
    serverMock.creditManual.mockResolvedValue(makeManualEntry());
    await POST(rechargeReq({ amountYuan: 10 }), rechargeCtx());
    const [, , , metadata] = serverMock.creditManual.mock.calls[0];
    expect(metadata).not.toHaveProperty('idempotencyKey');
  });

  it('rejects oversized idempotencyKey (>128 chars) by treating as absent', async () => {
    serverMock.creditManual.mockResolvedValue(makeManualEntry());
    const hugeKey = 'x'.repeat(200);
    await POST(rechargeReq({ amountYuan: 10, idempotencyKey: hugeKey }), rechargeCtx());
    const [, , , metadata] = serverMock.creditManual.mock.calls[0];
    expect(metadata).not.toHaveProperty('idempotencyKey');
  });

  it('rejects non-string idempotencyKey by treating as absent', async () => {
    serverMock.creditManual.mockResolvedValue(makeManualEntry());
    await POST(
      rechargeReq({ amountYuan: 10, idempotencyKey: 12345 }),
      rechargeCtx(),
    );
    const [, , , metadata] = serverMock.creditManual.mock.calls[0];
    expect(metadata).not.toHaveProperty('idempotencyKey');
  });
});
