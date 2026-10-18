// ============================================================
// /api/admin/users — 契约测试（GC-4 envelope + requireAdmin 守卫）
// ============================================================
//
// 覆盖：
//   GET
//     - 未登录 → 401 UNAUTHORIZED
//     - 已登录非管理员（FREE/VIP）→ 403 FORBIDDEN
//     - 已登录 ADMIN + DB 权威角色重查通过 → 200 + envelope { users, total, page, pageSize }
//     - 透传 q / page / pageSize 查询参数给 listUsersForAdmin
//     - 分页参数兜底（page/pageSize 缺省 / 非法 → 默认 1/50）
//
// 全局 mock 模式（test/setup.ts）：
//   - getServerSessionMock 控制登录态（null / DEFAULT_SESSION / 自定义 admin session）
//   - serverMock.getUserRoleById 控制 requireAdmin 的 DB 权威角色重查
//   - serverMock.listUsersForAdmin 控制列表查询返回
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { serverMock, getServerSessionMock } from '../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../test/helpers';
import { GET } from '../route';

const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'ADMIN' },
  expires: '2099-01-01T00:00:00.000Z',
};

describe('GET /api/admin/users — requireAdmin guard', () => {
  beforeEach(() => {
    serverMock.getUserRoleById.mockReset();
    serverMock.listUsersForAdmin.mockReset();
  });

  it('returns 401 UNAUTHORIZED when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/users' });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
    // 未登录时不应触达 list / DB role 重查
    expect(serverMock.listUsersForAdmin).not.toHaveBeenCalled();
    expect(serverMock.getUserRoleById).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN when authenticated but role !== ADMIN (JWT claims FREE)', async () => {
    getServerSessionMock.mockResolvedValue({
      user: { id: 'user-free', role: 'FREE' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    // requireAdmin 信任 DB 不信任 JWT：DB 也返 FREE
    serverMock.getUserRoleById.mockResolvedValue('FREE');
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/users' });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
    expect(serverMock.listUsersForAdmin).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN on JWT/DB role stale mismatch (JWT says ADMIN, DB says FREE)', async () => {
    // 关键：DB 权威角色重查防止 JWT stale 越权（用户被降级后立即失效）
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('FREE'); // DB 说不是 ADMIN
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/users' });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(403);
    expect(serverMock.listUsersForAdmin).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHORIZED when DB user missing (getUserRoleById → null)', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue(null); // 用户已被删除
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/users' });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/admin/users — list envelope + query forwarding', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.listUsersForAdmin.mockReset();
  });

  it('returns 200 + { success:true, data:{ users, total, page, pageSize } } for admin', async () => {
    const listData = {
      users: [
        {
          id: 'u-1',
          email: 'a@b.com',
          name: 'A',
          avatarUrl: null,
          role: 'FREE',
          credits: 100,
          createdAt: '2026-07-19T00:00:00.000Z',
          lastLoginAt: null,
          phone: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    };
    serverMock.listUsersForAdmin.mockResolvedValue(listData);

    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/users',
      searchParams: { q: 'a@b', page: '2', pageSize: '25' },
    });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: typeof listData;
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(listData);

    // 查询参数透传：q + page + pageSize（都从 searchParams 解析）
    expect(serverMock.listUsersForAdmin).toHaveBeenCalledTimes(1);
    expect(serverMock.listUsersForAdmin).toHaveBeenCalledWith({
      q: 'a@b',
      page: 2,
      pageSize: 25,
    });
  });

  it('applies default page=1 / pageSize=50 when query params absent', async () => {
    serverMock.listUsersForAdmin.mockResolvedValue({
      users: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/users' });
    await GET(req as NextRequest);
    expect(serverMock.listUsersForAdmin).toHaveBeenCalledWith({
      q: '',
      page: 1,
      pageSize: 50,
    });
  });

  it('clamps pageSize to 100 max and page to >=1 (route-level guardrails)', async () => {
    serverMock.listUsersForAdmin.mockResolvedValue({
      users: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/users',
      searchParams: { page: '0', pageSize: '9999' },
    });
    await GET(req as NextRequest);
    // Math.max(1, 0) → page 1；Math.min(100, Math.max(1, 9999)) → pageSize 100
    expect(serverMock.listUsersForAdmin).toHaveBeenCalledWith({
      q: '',
      page: 1,
      pageSize: 100,
    });
  });
});
