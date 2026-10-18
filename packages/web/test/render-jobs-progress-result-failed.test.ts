import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from './mocks';
import { makeRequest, makeParamsCtx, readJson } from './helpers';
import { POST as progressPOST } from '../app/api/render/jobs/[id]/progress/route';
import { POST as resultPOST } from '../app/api/render/jobs/[id]/result/route';
import { POST as failedPOST } from '../app/api/render/jobs/[id]/failed/route';

function claimedJob(overrides: Partial<{
  id: string;
  claimedBy: string | null;
  claimToken: string | null;
  taskId: string;
  userId: string;
  status: 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
}> = {}) {
  return {
    id: overrides.id ?? 'job-1',
    taskId: overrides.taskId ?? 'task-1',
    userId: overrides.userId ?? 'user-1',
    type: 'CONCAT' as const,
    status: overrides.status ?? 'CLAIMED',
    input: { clips: [], outputUploadUrl: 'https://up' },
    result: null,
    claimedBy: overrides.claimedBy ?? 'machine-A',
    claimToken: overrides.claimToken ?? 'token-A',
    error: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    claimedAt: '2026-07-18T00:00:00.000Z',
    heartbeatAt: '2026-07-18T00:00:00.000Z',
    completedAt: null,
  };
}

function leaseHeaders(machineId = 'machine-A', claimToken = 'token-A') {
  return {
    'x-machine-id': machineId,
    'x-claim-token': claimToken,
  };
}

vi.mock('@web/lib/publish', () => ({
  publishTaskEvent: vi.fn(),
}));
import { publishTaskEvent } from '@web/lib/publish';

describe('POST /api/render/jobs/[id]/progress', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.renderJobRepo.getById.mockReset();
    serverMock.renderJobRepo.markRunning.mockReset();
    (publishTaskEvent as ReturnType<typeof vi.fn>).mockReset();
  });

  it('returns 401 without a user session', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST', headers: leaseHeaders(), body: { progress: 10, stage: 'starting' },
    });
    const res = await progressPOST(req, makeParamsCtx({ id: 'job-1' }));
    expect(res.status).toBe(401);
    expect(serverMock.renderJobRepo.getById).not.toHaveBeenCalled();
  });

  it('heartbeats the matching lease and publishes RUNNING', async () => {
    const job = claimedJob();
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markRunning.mockResolvedValue({ ...job, status: 'RUNNING' });
    const req = makeRequest({
      method: 'POST', headers: leaseHeaders(), body: { progress: 50, stage: 'concatenating' },
    });

    const res = await progressPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    expect(serverMock.renderJobRepo.markRunning).toHaveBeenCalledWith(
      'job-1', 'user-1', 'machine-A', 'token-A', 50, 'concatenating',
    );
    expect(publishTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', userId: 'user-1', status: 'RUNNING',
      progress: 50, stage: 'concatenating',
    }));
  });

  it('渐进回传:转发可选 groupClip 到 SSE(组片 sf-asset url 透传,服务端不碰字节)', async () => {
    const job = claimedJob();
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markRunning.mockResolvedValue({ ...job, status: 'RUNNING' });
    const req = makeRequest({
      method: 'POST', headers: leaseHeaders(),
      body: {
        progress: 60, stage: '第 2/5 组完成',
        groupClip: { shotIds: ['shot-a', 'shot-b'], videoUrl: 'sf-asset://job-1-group-2.mp4' },
      },
    });

    const res = await progressPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    expect(publishTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', userId: 'user-1', status: 'RUNNING',
      progress: 60, stage: '第 2/5 组完成',
      groupClip: { shotIds: ['shot-a', 'shot-b'], videoUrl: 'sf-asset://job-1-group-2.mp4' },
    }));
  });

  it('渐进回传:groupClip 形状不合规时丢弃但仍正常上报进度(防脏数据进 SSE)', async () => {
    const job = claimedJob();
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markRunning.mockResolvedValue({ ...job, status: 'RUNNING' });
    const req = makeRequest({
      method: 'POST', headers: leaseHeaders(),
      body: {
        progress: 60, stage: '第 2/5 组完成',
        groupClip: { shotIds: 'not-an-array', videoUrl: 'sf-asset://x' },
      },
    });

    const res = await progressPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    expect(publishTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      progress: 60, stage: '第 2/5 组完成',
    }));
    const callArg = (publishTaskEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.groupClip).toBeUndefined();
  });

  it('returns 409 without publishing when lease CAS loses', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob());
    serverMock.renderJobRepo.markRunning.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST', headers: leaseHeaders(), body: { progress: 10, stage: 'starting' },
    });

    const res = await progressPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(409);
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });

  it('rejects machine, owner, and token mismatches', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob());
    let req = makeRequest({
      method: 'POST', headers: leaseHeaders('machine-B'), body: { progress: 10, stage: 'x' },
    });
    expect((await progressPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(403);

    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob({ userId: 'user-2' }));
    req = makeRequest({
      method: 'POST', headers: leaseHeaders(), body: { progress: 10, stage: 'x' },
    });
    expect((await progressPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(403);

    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob());
    req = makeRequest({
      method: 'POST', headers: leaseHeaders('machine-A', 'wrong'), body: { progress: 10, stage: 'x' },
    });
    expect((await progressPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(403);
    expect(serverMock.renderJobRepo.markRunning).not.toHaveBeenCalled();
  });

  it('requires machineId and x-claim-token', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob());
    let req = makeRequest({
      method: 'POST', headers: { 'x-claim-token': 'token-A' },
      body: { progress: 10, stage: 'x' },
    });
    expect((await progressPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(400);

    req = makeRequest({
      method: 'POST', headers: { 'x-machine-id': 'machine-A' },
      body: { progress: 10, stage: 'x' },
    });
    const res = await progressPOST(req, makeParamsCtx({ id: 'job-1' }));
    expect(res.status).toBe(400);
    expect(((await readJson(res)) as { error: string }).error).toMatch(/claimToken/);
  });

  it('returns 404 for a missing job and 400 for invalid body', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(null);
    let req = makeRequest({
      method: 'POST', headers: leaseHeaders(), body: { progress: 10, stage: 'x' },
    });
    expect((await progressPOST(req, makeParamsCtx({ id: 'nope' }))).status).toBe(404);

    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob());
    req = makeRequest({ method: 'POST', headers: leaseHeaders(), body: { progress: 10 } });
    expect((await progressPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(400);
  });
});

describe('POST /api/render/jobs/[id]/result', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.renderJobRepo.getById.mockReset();
    serverMock.renderJobRepo.markResult.mockReset();
    (publishTaskEvent as ReturnType<typeof vi.fn>).mockReset();
  });

  it('CAS-completes and publishes only an applied transition', async () => {
    const job = claimedJob({ status: 'RUNNING' });
    const result = { outputUrl: 'https://minio/out.mp4' };
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markResult.mockResolvedValue({ outcome: 'applied', job });
    const req = makeRequest({ method: 'POST', headers: leaseHeaders(), body: result });

    const res = await resultPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    expect(serverMock.renderJobRepo.markResult).toHaveBeenCalledWith(
      'job-1', 'user-1', 'machine-A', 'token-A', result,
    );
    expect(publishTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', status: 'COMPLETED', result,
    }));
  });

  it('publishes the automatically queued episode CONCAT after the group result commits', async () => {
    const job = claimedJob({ status: 'RUNNING' });
    const followUpJob = {
      ...claimedJob({ id: 'episode-film-1', taskId: 'episode-film-task-1' }),
      type: 'CONCAT' as const,
      status: 'PENDING' as const,
      claimedBy: null,
      claimToken: null,
    };
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markResult.mockResolvedValue({
      outcome: 'applied',
      job,
      followUpJob,
    });
    const req = makeRequest({
      method: 'POST',
      headers: leaseHeaders(),
      body: { outputUrl: 'sf-asset://group.mp4' },
    });

    const res = await resultPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    expect(publishTaskEvent).toHaveBeenNthCalledWith(2, {
      taskId: 'episode-film-task-1',
      userId: 'user-1',
      status: 'QUEUED',
      type: 'status_change',
    });
  });

  it('returns 200 without duplicate SSE for an idempotent retry', async () => {
    const job = claimedJob({ status: 'COMPLETED' });
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markResult.mockResolvedValue({ outcome: 'already_applied', job });
    const req = makeRequest({
      method: 'POST', headers: leaseHeaders(), body: { outputUrl: 'https://minio/out.mp4' },
    });

    const res = await resultPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });

  it('returns 409 without SSE for a conflicting transition', async () => {
    const job = claimedJob({ status: 'RUNNING' });
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markResult.mockResolvedValue({ outcome: 'rejected', job });
    const req = makeRequest({
      method: 'POST', headers: leaseHeaders(), body: { outputUrl: 'https://minio/out.mp4' },
    });

    const res = await resultPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(409);
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing or mismatched claim token before CAS', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob());
    let req = makeRequest({
      method: 'POST', headers: { 'x-machine-id': 'machine-A' }, body: { outputUrl: 'x' },
    });
    expect((await resultPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(400);

    req = makeRequest({
      method: 'POST', headers: leaseHeaders('machine-A', 'wrong'), body: { outputUrl: 'x' },
    });
    expect((await resultPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(403);
    expect(serverMock.renderJobRepo.markResult).not.toHaveBeenCalled();
  });

  it('rejects non-object and malformed nested results before CAS', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob());
    const invalidResults: unknown[] = [
      null,
      1,
      'result',
      [],
      { outputs: [1] },
      { outputs: ['ok', null] },
      { meta: null },
      { meta: [] },
      { durationSec: '4' },
    ];

    for (const body of invalidResults) {
      const req = makeRequest({ method: 'POST', headers: leaseHeaders(), body });
      const res = await resultPOST(req, makeParamsCtx({ id: 'job-1' }));
      expect(res.status).toBe(400);
    }
    expect(serverMock.renderJobRepo.markResult).not.toHaveBeenCalled();
  });

  it('strips unknown result fields before CAS and publish', async () => {
    const job = claimedJob({ status: 'RUNNING' });
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markResult.mockResolvedValue({ outcome: 'applied', job });
    const req = makeRequest({
      method: 'POST',
      headers: leaseHeaders(),
      body: { outputUrl: 'sf-asset://job-1.mp4', privateField: 'drop-me' },
    });

    const res = await resultPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    const result = { outputUrl: 'sf-asset://job-1.mp4' };
    expect(serverMock.renderJobRepo.markResult).toHaveBeenCalledWith(
      'job-1', 'user-1', 'machine-A', 'token-A', result,
    );
    expect(publishTaskEvent).toHaveBeenCalledWith(expect.objectContaining({ result }));
  });
});

describe('POST /api/render/jobs/[id]/failed', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.renderJobRepo.getById.mockReset();
    serverMock.renderJobRepo.markFailed.mockReset();
    serverMock.refundTaskDebit.mockReset();
    (publishTaskEvent as ReturnType<typeof vi.fn>).mockReset();
  });

  it('CAS-fails and publishes only an applied transition', async () => {
    const job = claimedJob({ status: 'RUNNING' });
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markFailed.mockResolvedValue({ outcome: 'applied', job });
    const req = makeRequest({
      method: 'POST', headers: leaseHeaders(), body: { error: 'ffmpeg crashed' },
    });

    const res = await failedPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    expect(serverMock.renderJobRepo.markFailed).toHaveBeenCalledWith(
      'job-1', 'user-1', 'machine-A', 'token-A', 'ffmpeg crashed',
    );
    expect(publishTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1', status: 'FAILED', error: 'ffmpeg crashed',
    }));
    // 退款用 job.taskId（=chargeAggregatedTaskCost 的 billingTaskId = render_jobs.task_id），
    // 非主键 id（用主键 id 查 billing_ledger 查不到 → 退款永不触发，资损）。claimedJob 的
    // id='job-1'、taskId='task-1'，故退款应传 'task-1'。
    expect(serverMock.refundTaskDebit).toHaveBeenCalledWith('user-1', 'task-1');
  });

  it('returns 200 without duplicate SSE for an idempotent retry', async () => {
    const job = claimedJob({ status: 'FAILED' });
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markFailed.mockResolvedValue({ outcome: 'already_applied', job });
    const req = makeRequest({ method: 'POST', headers: leaseHeaders(), body: { error: 'boom' } });

    const res = await failedPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(200);
    expect(publishTaskEvent).not.toHaveBeenCalled();
    // 幂等重试也检查退款，确保首次补偿遇到临时数据库故障后仍能恢复。
    // 退款用 job.taskId（=chargeAggregatedTaskCost 的 billingTaskId = render_jobs.task_id），
    // 非主键 id（用主键 id 查 billing_ledger 查不到 → 退款永不触发，资损）。claimedJob 的
    // id='job-1'、taskId='task-1'，故退款应传 'task-1'。
    expect(serverMock.refundTaskDebit).toHaveBeenCalledWith('user-1', 'task-1');
  });

  it('returns 409 without SSE for a conflicting transition', async () => {
    const job = claimedJob({ status: 'RUNNING' });
    serverMock.renderJobRepo.getById.mockResolvedValue(job);
    serverMock.renderJobRepo.markFailed.mockResolvedValue({ outcome: 'rejected', job });
    const req = makeRequest({ method: 'POST', headers: leaseHeaders(), body: { error: 'boom' } });

    const res = await failedPOST(req, makeParamsCtx({ id: 'job-1' }));

    expect(res.status).toBe(409);
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });

  it('validates error body and lease token', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(claimedJob());
    let req = makeRequest({ method: 'POST', headers: leaseHeaders(), body: { nope: 'x' } });
    expect((await failedPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(400);

    req = makeRequest({
      method: 'POST', headers: leaseHeaders('machine-A', 'wrong'), body: { error: 'boom' },
    });
    expect((await failedPOST(req, makeParamsCtx({ id: 'job-1' }))).status).toBe(403);
    expect(serverMock.renderJobRepo.markFailed).not.toHaveBeenCalled();
  });
});
