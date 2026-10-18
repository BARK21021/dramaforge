// ============================================================
// GET/PUT /api/admin/concurrency — 服务器级并发配置
// ============================================================
//
// 覆盖：
//   - GET：renderJobSlots 默认 10（无 RENDER_JOB_SLOTS 行）/ 配置值透传
//   - PUT：成功 upsert 落库 / 400 非法（0/17/字符串）/ 401 / 403
//
// getRenderJobSlots/setRenderJobSlots 走 @dramaforge/server 的 query（serverMock.query）。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { serverMock, getServerSessionMock } from '../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../test/helpers';
import { GET, PUT } from '../route';

const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'ADMIN' },
  expires: '2099-01-01T00:00:00.000Z',
};

describe('/api/admin/concurrency', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(ADMIN_SESSION);
    serverMock.getUserRoleById.mockResolvedValue('ADMIN');
    serverMock.query.mockReset();
  });

  it('GET returns 401 when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('GET returns 403 when DB role is not ADMIN', async () => {
    serverMock.getUserRoleById.mockResolvedValue('FREE');
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('GET returns default renderJobSlots=10 when no config row', async () => {
    serverMock.query.mockResolvedValue({ rows: [] });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { renderJobSlots: number } };
    expect(body.success).toBe(true);
    expect(body.data.renderJobSlots).toBe(10);
  });

  it('GET returns configured renderJobSlots', async () => {
    serverMock.query.mockResolvedValue({ rows: [{ value: '5' }] });
    const res = await GET();
    const body = (await readJson(res)) as { success: boolean; data: { renderJobSlots: number } };
    expect(body.data.renderJobSlots).toBe(5);
  });

  it('PUT persists renderJobSlots and returns it', async () => {
    serverMock.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const req = makeRequest({ method: 'PUT', url: 'http://localhost/api/admin/concurrency', body: { renderJobSlots: 8 } });
    const res = await PUT(req as NextRequest);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { renderJobSlots: number } };
    expect(body.data.renderJobSlots).toBe(8);

    const upsert = serverMock.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('RENDER_JOB_SLOTS'));
    expect(upsert).toBeDefined();
    expect(String(upsert![0])).toContain('INSERT INTO system_configs');
    expect(String(upsert![0])).toContain('ON CONFLICT (key) DO UPDATE');
    expect(upsert![1]).toEqual(['8']);
  });

  it.each([{ renderJobSlots: 0 }, { renderJobSlots: 17 }, { renderJobSlots: '5' }, {}])(
    'PUT returns 400 for invalid body %j',
    async (body) => {
      serverMock.query.mockResolvedValue({ rows: [], rowCount: 1 });
      const req = makeRequest({ method: 'PUT', url: 'http://localhost/api/admin/concurrency', body });
      const res = await PUT(req as NextRequest);
      expect(res.status).toBe(400);
      const parsed = (await readJson(res)) as { code: string };
      expect(parsed.code).toBe('INVALID_RENDER_JOB_SLOTS');
      expect(
        serverMock.query.mock.calls.some((c: unknown[]) => String(c[0]).includes('RENDER_JOB_SLOTS')),
      ).toBe(false);
    },
  );
});
