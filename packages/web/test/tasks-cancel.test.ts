// DELETE /api/tasks/[taskId] — 取消 AI 任务（BullMQ）单测
// 对照 DELETE /api/render/jobs/[id]（render_jobs 取消）：AI 任务走 getAiTask 归属校验 +
// cancelAiTask CAS + removeQueuedAiJob best-effort + publishTaskEvent CANCELLED。

import { beforeEach, describe, expect, it } from 'vitest';
import { DELETE } from '../app/api/tasks/[taskId]/route';
import { DEFAULT_SESSION, getServerSessionMock, serverMock } from './mocks';
import { makeParamsCtx, makeRequest, readJson } from './helpers';

describe('DELETE /api/tasks/[taskId] — 取消 AI 任务', () => {
  beforeEach(() => {
    getServerSessionMock.mockReset();
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.getAiTask.mockReset();
    serverMock.cancelAiTask.mockReset();
    serverMock.removeQueuedAiJob.mockReset();
    serverMock.removeQueuedAiJob.mockResolvedValue(undefined);
    serverMock.publishTaskEvent.mockReset();
    serverMock.publishTaskEvent.mockResolvedValue(undefined);
  });

  it('requires a session (401)', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await DELETE(
      makeRequest({ url: 'http://localhost/api/tasks/t1', method: 'DELETE' }),
      makeParamsCtx({ taskId: 't1' }),
    );
    expect(res.status).toBe(401);
    expect(serverMock.getAiTask).not.toHaveBeenCalled();
  });

  it('404 when task not found / not owned（getAiTask null，不泄漏存在性）', async () => {
    serverMock.getAiTask.mockResolvedValue(null);
    const res = await DELETE(
      makeRequest({ url: 'http://localhost/api/tasks/t1', method: 'DELETE' }),
      makeParamsCtx({ taskId: 't1' }),
    );
    expect(res.status).toBe(404);
    expect(serverMock.cancelAiTask).not.toHaveBeenCalled();
  });

  it('409 when task already terminal（cancelAiTask CAS miss）', async () => {
    serverMock.getAiTask.mockResolvedValue({
      id: 't1', userId: 'user-1', type: 'IMAGE_GENERATE', status: 'COMPLETED',
    });
    serverMock.cancelAiTask.mockResolvedValue(null);
    const res = await DELETE(
      makeRequest({ url: 'http://localhost/api/tasks/t1', method: 'DELETE' }),
      makeParamsCtx({ taskId: 't1' }),
    );
    expect(res.status).toBe(409);
    expect(serverMock.removeQueuedAiJob).not.toHaveBeenCalled();
  });

  it('200 + removeQueuedAiJob + publishTaskEvent CANCELLED on success', async () => {
    serverMock.getAiTask.mockResolvedValue({
      id: 't1', userId: 'user-1', type: 'IMAGE_GENERATE', status: 'RUNNING',
    });
    serverMock.cancelAiTask.mockResolvedValue({
      id: 't1', userId: 'user-1', type: 'IMAGE_GENERATE', status: 'CANCELLED',
    });
    const res = await DELETE(
      makeRequest({ url: 'http://localhost/api/tasks/t1', method: 'DELETE' }),
      makeParamsCtx({ taskId: 't1' }),
    );
    expect(res.status).toBe(200);
    expect(serverMock.cancelAiTask).toHaveBeenCalledWith('t1', 'user-1');
    expect(serverMock.removeQueuedAiJob).toHaveBeenCalledWith('t1', 'IMAGE_GENERATE');
    expect(serverMock.publishTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', userId: 'user-1', status: 'CANCELLED' }),
    );
    const body = (await readJson(res)) as { data?: { cancelled?: boolean } };
    expect(body.data).toEqual({ cancelled: true });
  });

  it('removeQueuedAiJob 失败不阻断取消（best-effort，CAS+早退兜底）', async () => {
    serverMock.getAiTask.mockResolvedValue({
      id: 't1', userId: 'user-1', type: 'VIDEO_GENERATE', status: 'QUEUED',
    });
    serverMock.cancelAiTask.mockResolvedValue({
      id: 't1', userId: 'user-1', type: 'VIDEO_GENERATE', status: 'CANCELLED',
    });
    serverMock.removeQueuedAiJob.mockRejectedValue(new Error('active job locked'));
    const res = await DELETE(
      makeRequest({ url: 'http://localhost/api/tasks/t1', method: 'DELETE' }),
      makeParamsCtx({ taskId: 't1' }),
    );
    expect(res.status).toBe(200);
    expect(serverMock.publishTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'CANCELLED' }),
    );
  });
});
