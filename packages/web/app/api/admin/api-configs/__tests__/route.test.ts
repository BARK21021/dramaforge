// ============================================================
// /api/admin/api-configs — 契约测试（GC-4 envelope + requireAdmin 守卫）
// ============================================================
//
// 覆盖：
//   GET
//     - 未登录 → 401 UNAUTHORIZED
//     - 已登录非管理员 → 403 FORBIDDEN
//     - 已登录 ADMIN + DB 权威角色重查通过 → 200 + envelope 数据（apiKey 已掩码）
//
//   POST
//     - provider 缺失 → 400 BAD_PROVIDER
//     - apiKey 缺失 → 400 BAD_API_KEY
//     - admin + 合法 body → 201 + 调 listPlatformConfigs / createPlatformConfig 透传
//
//   POST /test（嵌套路由）
//     - 非管理员 → 403
//     - admin + 合法 configId → 200 + envelope { ok, message }
//
//   PATCH /[configId]
//     - 非管理员 → 403
//
//   DELETE /[configId]
//     - 非管理员 → 403
//
// 全局 mock 模式（test/setup.ts）：serverMock 已 mock @dramaforge/server 全部导出。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { serverMock, getServerSessionMock } from '../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../test/helpers';
import { GET, POST } from '../route';
import { PATCH, DELETE } from '../[configId]/route';
import { GET as GET_SECRET } from '../[configId]/secret/route';
import { POST as POST_TEST } from '../test/route';

const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'ADMIN' },
  expires: '2099-01-01T00:00:00.000Z',
};

const maskedView = {
  id: 'cfg-1',
  provider: 'kimi',
  label: '主号',
  apiKeyMasked: 'sk-a…b1c2',
  baseUrl: 'https://api.moonshot.cn/v1',
  weight: 1,
  isEnabled: true,
  keyStatus: 'active',
  lastUsedAt: null,
  errorCount: 0,
  consecutiveFailures: 0,
  disabledUntil: null,
  lastErrorMessage: null,
};

// ============================================================
// GET — auth guard + envelope
// ============================================================

describe('GET /api/admin/api-configs — auth guard', () => {
  beforeEach(() => {
    serverMock.getUserRoleById.mockReset();
    serverMock.listPlatformConfigs.mockReset();
  });

  it('returns 401 UNAUTHORIZED when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/api-configs' });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(serverMock.listPlatformConfigs).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN when authenticated but role !== ADMIN (DB authoritative)', async () => {
    getServerSessionMock.mockResolvedValue({
      user: { id: 'user-vip', role: 'VIP' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    serverMock.getUserRoleById.mockResolvedValue('VIP');
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/api-configs' });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('FORBIDDEN');
    expect(serverMock.listPlatformConfigs).not.toHaveBeenCalled();
  });

  it('returns 403 when JWT says ADMIN but DB says FREE (stale-role guard)', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('FREE');
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/api-configs' });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(403);
  });

  it('returns 200 + envelope (apiKeyMasked only) for admin', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.listPlatformConfigs.mockResolvedValue([maskedView]);

    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/admin/api-configs' });
    const res = await GET(req as NextRequest);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([maskedView]);
    // 契约：apiKey 明文永不出现，只有 apiKeyMasked 字段
    const json = JSON.stringify(body);
    expect(json).not.toContain('sk-full-secret-key-1234567890');
    expect(json).toContain('apiKeyMasked');
  });
});

// ============================================================
// POST — validation + create
// ============================================================

describe('POST /api/admin/api-configs — validation + create', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.createPlatformConfig.mockReset();
  });

  it('returns 400 BAD_PROVIDER when provider missing', async () => {
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs',
      body: { apiKey: 'sk-x' },
    });
    const res = await POST(req as NextRequest);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('BAD_PROVIDER');
    expect(serverMock.createPlatformConfig).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_API_KEY when apiKey missing', async () => {
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs',
      body: { provider: 'kimi' },
    });
    const res = await POST(req as NextRequest);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('BAD_API_KEY');
  });

  it('returns 403 FORBIDDEN for non-admin even with valid body', async () => {
    getServerSessionMock.mockResolvedValue({
      user: { id: 'free-user', role: 'FREE' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    serverMock.getUserRoleById.mockResolvedValue('FREE');
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs',
      body: { provider: 'kimi', apiKey: 'sk-x' },
    });
    const res = await POST(req as NextRequest);
    expect(res.status).toBe(403);
    expect(serverMock.createPlatformConfig).not.toHaveBeenCalled();
  });

  it('returns 201 + envelope for admin with valid body', async () => {
    serverMock.createPlatformConfig.mockResolvedValue(maskedView);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs',
      body: {
        provider: 'kimi',
        apiKey: 'sk-brand-new-key-12345',
        label: '主号',
        weight: 2,
        baseUrl: 'https://api.moonshot.cn/v1',
      },
    });
    const res = await POST(req as NextRequest);
    expect(res.status).toBe(201);
    const body = (await readJson(res)) as { success: boolean; data: typeof maskedView };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(maskedView);
    expect(serverMock.createPlatformConfig).toHaveBeenCalledWith({
      provider: 'kimi',
      apiKey: 'sk-brand-new-key-12345',
      label: '主号',
      weight: 2,
      baseUrl: 'https://api.moonshot.cn/v1',
      maxConcurrent: null, // 未提供 → 路由透传 null（运行时视为不限）
    });
  });
});

// ============================================================
// PATCH /[configId] — auth guard
// ============================================================

describe('PATCH /api/admin/api-configs/[configId] — auth guard', () => {
  beforeEach(() => {
    serverMock.getUserRoleById.mockReset();
    serverMock.updatePlatformConfig.mockReset();
  });

  it('returns 403 FORBIDDEN for non-admin', async () => {
    getServerSessionMock.mockResolvedValue({
      user: { id: 'user-vip', role: 'VIP' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    serverMock.getUserRoleById.mockResolvedValue('VIP');
    const req = makeRequest({
      method: 'POST', // makeRequest 限制 method；route 只看 body，方法名不影响鉴权
      url: 'http://localhost/api/admin/api-configs/c-1',
      body: { weight: 5 },
    });
    const res = await PATCH(req as NextRequest, makeParamsCtx({ configId: 'c-1' }));
    expect(res.status).toBe(403);
    expect(serverMock.updatePlatformConfig).not.toHaveBeenCalled();
  });

  it('forwards patch fields to updatePlatformConfig for admin', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.updatePlatformConfig.mockResolvedValue(maskedView);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs/c-1',
      body: { weight: 5, isEnabled: false },
    });
    const res = await PATCH(req as NextRequest, makeParamsCtx({ configId: 'c-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.updatePlatformConfig).toHaveBeenCalledWith('c-1', {
      weight: 5,
      isEnabled: false,
    });
  });

  it('allows an admin to replace a key without ever echoing plaintext', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.updatePlatformConfig.mockResolvedValue({
      ...maskedView,
      apiKeyMasked: 'sk-n…5678',
    });
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs/c-1',
      body: { apiKey: 'sk-new-secret-5678' },
    });

    const res = await PATCH(req as NextRequest, makeParamsCtx({ configId: 'c-1' }));
    const body = await readJson(res);
    expect(res.status).toBe(200);
    expect(serverMock.updatePlatformConfig).toHaveBeenCalledWith('c-1', {
      apiKey: 'sk-new-secret-5678',
    });
    expect(JSON.stringify(body)).not.toContain('sk-new-secret-5678');
  });
});

// ============================================================
// DELETE /[configId] — auth guard
// ============================================================

describe('DELETE /api/admin/api-configs/[configId] — auth guard', () => {
  beforeEach(() => {
    serverMock.getUserRoleById.mockReset();
    serverMock.deletePlatformConfig.mockReset();
  });

  it('returns 403 FORBIDDEN for non-admin', async () => {
    getServerSessionMock.mockResolvedValue({
      user: { id: 'user-free', role: 'FREE' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    serverMock.getUserRoleById.mockResolvedValue('FREE');
    const req = makeRequest({
      method: 'GET', // DELETE 无 body；GET 即可
      url: 'http://localhost/api/admin/api-configs/c-1',
    });
    const res = await DELETE(req as NextRequest, makeParamsCtx({ configId: 'c-1' }));
    expect(res.status).toBe(403);
    expect(serverMock.deletePlatformConfig).not.toHaveBeenCalled();
  });

  it('returns 200 + { deleted: true } for admin', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.deletePlatformConfig.mockResolvedValue(undefined);
    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/api-configs/c-1',
    });
    const res = await DELETE(req as NextRequest, makeParamsCtx({ configId: 'c-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);
    expect(serverMock.deletePlatformConfig).toHaveBeenCalledWith('c-1');
  });
});

// ============================================================
// GET /[configId]/secret — 管理员按需查看单条明文
// ============================================================

describe('GET /api/admin/api-configs/[configId]/secret — admin-only reveal', () => {
  beforeEach(() => {
    serverMock.getUserRoleById.mockReset();
    serverMock.revealPlatformConfigKey.mockReset();
  });

  it('refuses a non-admin without reading the secret', async () => {
    getServerSessionMock.mockResolvedValue({
      user: { id: 'user-free', role: 'FREE' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    serverMock.getUserRoleById.mockResolvedValue('FREE');
    const request = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/api-configs/c-1/secret',
    });

    const response = await GET_SECRET(request as NextRequest, makeParamsCtx({ configId: 'c-1' }));
    expect(response.status).toBe(403);
    expect(serverMock.revealPlatformConfigKey).not.toHaveBeenCalled();
  });

  it('returns one secret to an admin and forbids caching', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.revealPlatformConfigKey.mockResolvedValue('sk-full-secret-123456');
    const request = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/api-configs/c-1/secret',
    });

    const response = await GET_SECRET(request as NextRequest, makeParamsCtx({ configId: 'c-1' }));
    const body = await readJson(response) as { data: { apiKey: string } };
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(body.data.apiKey).toBe('sk-full-secret-123456');
    expect(serverMock.revealPlatformConfigKey).toHaveBeenCalledWith('c-1');
  });
});

// ============================================================
// POST /test — auth guard + envelope
// ============================================================

describe('POST /api/admin/api-configs/test — auth guard + result envelope', () => {
  beforeEach(() => {
    serverMock.getUserRoleById.mockReset();
    serverMock.testConfig.mockReset();
  });

  it('returns 403 FORBIDDEN for non-admin', async () => {
    getServerSessionMock.mockResolvedValue({
      user: { id: 'user-vip', role: 'VIP' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    serverMock.getUserRoleById.mockResolvedValue('VIP');
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs/test',
      body: { configId: 'c-1' },
    });
    const res = await POST_TEST(req as NextRequest);
    expect(res.status).toBe(403);
    expect(serverMock.testConfig).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_CONFIG_ID when configId missing', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs/test',
      body: {},
    });
    const res = await POST_TEST(req as NextRequest);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('BAD_CONFIG_ID');
  });

  it('returns 200 + envelope { ok, message } for admin', async () => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.testConfig.mockResolvedValue({ ok: true, message: '连接成功' });
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/admin/api-configs/test',
      body: { configId: 'c-1' },
    });
    const res = await POST_TEST(req as NextRequest);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { ok: boolean; message: string };
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ ok: true, message: '连接成功' });
    expect(serverMock.testConfig).toHaveBeenCalledWith('c-1');
  });
});
