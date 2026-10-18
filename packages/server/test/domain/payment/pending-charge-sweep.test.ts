// ============================================================
// payment/pending-charge-sweep — 任务补扣兜底单测（防漏收，P1-5）
// ============================================================
// 两块：
//   1. sweepPendingCharges（DI 注入 fake findPending/charge/clear）——验编排：
//      分类计数 / 单笔出错不致命且不清空 / limit 透传 / findPending 失败不抛 / 审计日志
//   2. findPendingChargeTasks / clearPendingCharge（mock @server/infra query）——验 SQL 形状
//      （pendingCharge IS NOT NULL AND status='COMPLETED'，清空置 NULL）。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from '../../../src/infra/pg';

// mock @server/infra（repo 用 query）；同时隔离 billing 避免触真实 charge/查询。
// 列全 pending-charge-sweep.ts 顶部从 billing import 的符号（含 P0-2 新增的补扣辅助），
// 否则被 mock 成 undefined——现有测试靠 DI 不调它们尚能跑，但补全更稳、防未来回归。
vi.mock('@server/infra', () => ({ query: vi.fn() }));
vi.mock('../../../src/domain/billing', () => ({
  chargeCredits: vi.fn(),
  chargeAggregatedTaskCost: vi.fn(),
  findPendingDebitEntries: vi.fn(),
  markPendingDebitSettled: vi.fn(),
  markPendingDebitAttempted: vi.fn(),
}));

import {
  sweepPendingCharges,
  findPendingChargeTasks,
  clearPendingCharge,
  PENDING_CHARGE_SWEEP_BATCH_LIMIT,
  type PendingChargeRow,
} from '../../../src/domain/payment/pending-charge-sweep';
import { query } from '@server/infra';

const mkRow = (id: string, credits = 10): PendingChargeRow => ({
  id,
  userId: `user-${id}`,
  pendingCharge: { credits, reason: '余额不足', createdAt: '2026-07-23T00:00:00Z' },
});

// ============================================================
// sweepPendingCharges 编排（DI）
// ============================================================
describe('sweepPendingCharges', () => {
  it('无待补扣单 → 全零，不调 charge/clear，不日志', async () => {
    const charge = vi.fn();
    const clear = vi.fn();
    const log = vi.fn();
    const r = await sweepPendingCharges({
      findPending: async () => [],
      charge,
      clear,
      log,
    });
    expect(r).toEqual({ scanned: 0, charged: 0, errored: 0 });
    expect(charge).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('limit = PENDING_CHARGE_SWEEP_BATCH_LIMIT 透传给 findPending', async () => {
    const findPending = vi.fn(async () => []);
    await sweepPendingCharges({ findPending, log: () => {} });
    expect(findPending).toHaveBeenCalledTimes(1);
    const [limit] = findPending.mock.calls[0] as [number];
    expect(limit).toBe(PENDING_CHARGE_SWEEP_BATCH_LIMIT);
  });

  it('成功补扣 → charged+1 且调 clear 清空 pendingCharge', async () => {
    const charge = vi.fn();
    const clear = vi.fn();
    const r = await sweepPendingCharges({
      findPending: async () => [mkRow('a')],
      charge,
      clear,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 1, charged: 1, errored: 0 });
    expect(charge).toHaveBeenCalledWith(mkRow('a'));
    expect(clear).toHaveBeenCalledWith('a');
  });

  it('多笔混合（成功/失败/成功）→ 分类计数正确，失败笔不调 clear', async () => {
    const charge = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('余额不足'))
      .mockResolvedValueOnce(undefined);
    const clear = vi.fn();
    const r = await sweepPendingCharges({
      findPending: async () => [mkRow('a'), mkRow('b'), mkRow('c')],
      charge,
      clear,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 3, charged: 2, errored: 1 });
    // 只对成功的 a / c 清空，b 失败不清空（留待下次 tick 重试）
    expect(clear).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledWith('a');
    expect(clear).toHaveBeenCalledWith('c');
    expect(clear).not.toHaveBeenCalledWith('b');
  });

  it('单笔抛错 → 计 errored，其余照常处理，sweep 不抛', async () => {
    const charge = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const clear = vi.fn();
    const r = await sweepPendingCharges({
      findPending: async () => [mkRow('a'), mkRow('b')],
      charge,
      clear,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 2, charged: 1, errored: 1 });
  });

  it('findPending 抛错 → 返回全零不抛，记失败日志', async () => {
    const log = vi.fn();
    const r = await sweepPendingCharges({
      findPending: async () => {
        throw new Error('db down');
      },
      log,
    });
    expect(r).toEqual({ scanned: 0, charged: 0, errored: 0 });
    expect(log).toHaveBeenCalledWith(
      '[pending-charge-sweep] findPending 失败，本 tick 跳过',
      expect.objectContaining({ err: expect.any(String) }),
    );
  });

  it('有处理时记审计日志（含统计）', async () => {
    const log = vi.fn();
    await sweepPendingCharges({
      findPending: async () => [mkRow('a')],
      charge: async () => {},
      clear: async () => {},
      log,
    });
    expect(log).toHaveBeenCalledWith(
      '[pending-charge-sweep] tick 完成',
      expect.objectContaining({ scanned: 1, charged: 1 }),
    );
  });
});

// ============================================================
// findPendingChargeTasks repo SQL
// ============================================================
describe('findPendingChargeTasks', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('返回行，SQL 含 pendingCharge IS NOT NULL / status=COMPLETED / LIMIT $1，参数透传', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [mkRow('t1', 5), mkRow('t2', 8)],
      rowCount: 2,
    } as QueryResult);
    const rows = await findPendingChargeTasks(50);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('t1');
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"pendingCharge" IS NOT NULL');
    expect(sql).toContain("status = 'COMPLETED'");
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([50]);
  });

  it('未传 limit → 默认 PENDING_CHARGE_SWEEP_BATCH_LIMIT', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as QueryResult);
    await findPendingChargeTasks();
    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(PENDING_CHARGE_SWEEP_BATCH_LIMIT);
  });

  it('空结果 → 空数组', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as QueryResult);
    const rows = await findPendingChargeTasks();
    expect(rows).toEqual([]);
  });
});

// ============================================================
// clearPendingCharge repo SQL
// ============================================================
describe('clearPendingCharge', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('置 pendingCharge=NULL，WHERE id=$1', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as QueryResult);
    await clearPendingCharge('t1');
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"pendingCharge" = NULL');
    expect(sql).toContain('WHERE id = $1');
    expect(params).toEqual(['t1']);
  });
});
