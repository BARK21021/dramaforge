// ============================================================
// /api/render/jobs/next — 契约测试
// ============================================================
//
// 覆盖：
//   - 204 when claimNext 返回 null（无 PENDING 作业）
//   - 200 { job } when claimNext 返回作业
//   - 400 when 缺 machineId（既无查询参数也无头）
//   - machineId 从查询参数读取（⑨ 的契约）
//   - machineId 从 x-machine-id 头读取（fallback）
//
// mock：@dramaforge/server.renderJobRepo.claimNext + getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from './mocks';
import { makeRequest, readJson } from './helpers';
import { GET } from '../app/api/render/jobs/next/route';

describe('GET /api/render/jobs/next', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.renderJobRepo.claimNext.mockReset();
  });

  it('returns 401 without a user session', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'GET',
      searchParams: { machineId: 'machine-A' },
    });

    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(serverMock.renderJobRepo.claimNext).not.toHaveBeenCalled();
  });

  it('returns 204 when no pending job', async () => {
    serverMock.renderJobRepo.claimNext.mockResolvedValue(null);
    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/render/jobs/next',
      searchParams: { machineId: 'machine-A' },
    });
    const res = await GET(req);
    expect(res.status).toBe(204);
    expect(serverMock.renderJobRepo.claimNext).toHaveBeenCalledWith(
      'user-1',
      'machine-A',
    );
  });

  it('returns 200 { job } when a job is claimed', async () => {
    const job = {
      id: 'job-1',
      taskId: 'task-1',
      userId: 'user-1',
      type: 'CONCAT' as const,
      status: 'CLAIMED' as const,
      input: { clips: [], outputUploadUrl: 'https://up' },
      result: null,
      claimedBy: 'machine-A',
      claimToken: 'claim-token-A',
      error: null,
      createdAt: '2026-07-18T00:00:00.000Z',
      claimedAt: '2026-07-18T00:00:00.000Z',
      heartbeatAt: '2026-07-18T00:00:00.000Z',
      completedAt: null,
    };
    serverMock.renderJobRepo.claimNext.mockResolvedValue(job);
    const req = makeRequest({
      method: 'GET',
      searchParams: { machineId: 'machine-A' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toEqual({ job });
  });

  it('reads machineId from x-machine-id header (fallback)', async () => {
    serverMock.renderJobRepo.claimNext.mockResolvedValue(null);
    const req = makeRequest({
      method: 'GET',
      headers: { 'x-machine-id': 'machine-B' },
    });
    const res = await GET(req);
    expect(res.status).toBe(204);
    expect(serverMock.renderJobRepo.claimNext).toHaveBeenCalledWith(
      'user-1',
      'machine-B',
    );
  });

  it('returns 400 when machineId missing', async () => {
    const req = makeRequest({ method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { error: string };
    expect(body.error).toMatch(/machineId/);
    expect(serverMock.renderJobRepo.claimNext).not.toHaveBeenCalled();
  });

  it('prefers query param over header when both present', async () => {
    serverMock.renderJobRepo.claimNext.mockResolvedValue(null);
    const req = makeRequest({
      method: 'GET',
      searchParams: { machineId: 'from-query' },
      headers: { 'x-machine-id': 'from-header' },
    });
    await GET(req);
    expect(serverMock.renderJobRepo.claimNext).toHaveBeenCalledWith(
      'user-1',
      'from-query',
    );
  });

  describe('per-user 并发硬上限', () => {
    it('204 when active claims >= maxConcurrent — claimNext 不被调用', async () => {
      serverMock.renderJobRepo.countActiveClaims.mockResolvedValueOnce(10);
      serverMock.getConcurrencyLimit.mockResolvedValueOnce(10);
      const req = makeRequest({
        method: 'GET',
        searchParams: { machineId: 'machine-A' },
      });
      const res = await GET(req);
      expect(res.status).toBe(204);
      expect(serverMock.renderJobRepo.claimNext).not.toHaveBeenCalled();
    });

    it('200 { job } when active < maxConcurrent', async () => {
      serverMock.renderJobRepo.countActiveClaims.mockResolvedValueOnce(9);
      serverMock.getConcurrencyLimit.mockResolvedValueOnce(10);
      serverMock.renderJobRepo.claimNext.mockResolvedValue(null);
      const req = makeRequest({
        method: 'GET',
        searchParams: { machineId: 'machine-A' },
      });
      const res = await GET(req);
      expect(res.status).toBe(204); // claimNext null → 无 PENDING
      expect(serverMock.getConcurrencyLimit).toHaveBeenCalledWith('user-1');
      expect(serverMock.renderJobRepo.countActiveClaims).toHaveBeenCalledWith('user-1');
      expect(serverMock.renderJobRepo.claimNext).toHaveBeenCalledWith('user-1', 'machine-A');
    });

    it('计数按用户（跨机器）：路由只按 userId 计数，未满上限照常发 job', async () => {
      serverMock.renderJobRepo.countActiveClaims.mockResolvedValueOnce(2);
      serverMock.getConcurrencyLimit.mockResolvedValueOnce(3);
      serverMock.renderJobRepo.claimNext.mockResolvedValue(null);
      const req = makeRequest({
        method: 'GET',
        searchParams: { machineId: 'machine-B' },
      });
      const res = await GET(req);
      // active(2) < limit(3) → 放行；204 来自 claimNext 无 PENDING。
      expect(res.status).toBe(204);
      expect(serverMock.renderJobRepo.countActiveClaims).toHaveBeenCalledWith('user-1');
      expect(serverMock.renderJobRepo.claimNext).toHaveBeenCalledWith('user-1', 'machine-B');
    });

    it('getConcurrencyLimit 回退 3 时按 3 封顶', async () => {
      serverMock.renderJobRepo.countActiveClaims.mockResolvedValueOnce(3);
      serverMock.getConcurrencyLimit.mockResolvedValueOnce(3);
      const req = makeRequest({
        method: 'GET',
        searchParams: { machineId: 'machine-A' },
      });
      const res = await GET(req);
      expect(res.status).toBe(204);
      expect(serverMock.renderJobRepo.claimNext).not.toHaveBeenCalled();
    });
  });
});
