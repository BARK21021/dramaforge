// ============================================================
// PATCH /api/admin/users/[userId] — 管理员调参用户并发上限
// ============================================================
//
// 覆盖：
//   - 401 未登录 / 403 非管理员（requireAdmin 守卫）
//   - 200：updateUserConcurrency(userId, value) + envelope
//   - 400：maxConcurrent 非法（缺失/非整数/0/65/字符串）
//   - 404：用户不存在（updateUserConcurrency 返回 null）
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { serverMock, getServerSessionMock } from '../../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../../test/helpers';
import { PATCH } from '../route';

const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'ADMIN' },
  expires: '2099-01-01T00:00:00.000Z',
};

async function patchConcurrency(body: unknown): Promise<Response> {
  const req = makeRequest({
    method: 'PATCH',
    url: 'http://localhost/api/admin/users/u-1',
    body,
  });
  return PATCH(req as NextRequest, { params: Promise.resolve({ userId: 'u-1' }) });
}

describe('PATCH /api/admin/users/[userId] — 并发上限调参', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.updateUserConcurrency.mockReset();
  });

  it('returns 401 UNAUTHORIZED when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await patchConcurrency({ maxConcurrent: 10 });
    expect(res.status).toBe(401);
    expect(serverMock.updateUserConcurrency).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN when DB role is not ADMIN', async () => {
    serverMock.getUserRoleById.mockResolvedValue('FREE');
    const res = await patchConcurrency({ maxConcurrent: 10 });
    expect(res.status).toBe(403);
    expect(serverMock.updateUserConcurrency).not.toHaveBeenCalled();
  });

  it('returns 200 + envelope when admin sets maxConcurrent', async () => {
    serverMock.updateUserConcurrency.mockResolvedValue({ id: 'u-1', maxConcurrent: 12 });
    const res = await patchConcurrency({ maxConcurrent: 12 });
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: unknown };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ user: { id: 'u-1', maxConcurrent: 12 } });
    expect(serverMock.updateUserConcurrency).toHaveBeenCalledWith('u-1', 12);
  });

  it.each([
    { maxConcurrent: 0 },
    { maxConcurrent: 65 },
    { maxConcurrent: 2.5 },
    { maxConcurrent: '10' },
    {},
  ])('returns 400 for invalid body %j', async (body) => {
    const res = await patchConcurrency(body);
    expect(res.status).toBe(400);
    const parsed = (await readJson(res)) as { code: string };
    expect(parsed.code).toBe('INVALID_MAX_CONCURRENT');
    expect(serverMock.updateUserConcurrency).not.toHaveBeenCalled();
  });

  it('returns 404 when user missing', async () => {
    serverMock.updateUserConcurrency.mockResolvedValue(null);
    const res = await patchConcurrency({ maxConcurrent: 8 });
    expect(res.status).toBe(404);
    const parsed = (await readJson(res)) as { code: string };
    expect(parsed.code).toBe('NOT_FOUND');
  });
});
