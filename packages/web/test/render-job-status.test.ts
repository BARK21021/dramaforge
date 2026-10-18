import { beforeEach, describe, expect, it } from 'vitest';
import { DELETE, GET } from '../app/api/render/jobs/[id]/route';
import { POST as RETRY } from '../app/api/render/jobs/[id]/retry/route';
import { DEFAULT_SESSION, getServerSessionMock, serverMock } from './mocks';
import { makeParamsCtx, makeRequest, readJson } from './helpers';

function renderJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    taskId: 'task-1',
    userId: 'user-1',
    type: 'CONCAT',
    status: 'COMPLETED',
    input: { clips: [{ url: 'https://example.test/private.mp4' }] },
    result: { outputUrl: 'sf-asset://job-1.mp4' },
    claimedBy: 'machine-A',
    claimToken: 'secret-claim-token',
    error: null,
    createdAt: '2026-07-19T00:00:00.000Z',
    claimedAt: '2026-07-19T00:00:01.000Z',
    heartbeatAt: '2026-07-19T00:00:02.000Z',
    completedAt: '2026-07-19T00:00:03.000Z',
    ...overrides,
  };
}

describe('GET /api/render/jobs/[id]', () => {
  beforeEach(() => {
    getServerSessionMock.mockReset();
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.renderJobRepo.getById.mockReset();
    serverMock.renderJobRepo.getByTaskId.mockReset();
    serverMock.renderJobRepo.cancel.mockReset();
    serverMock.renderJobRepo.retry.mockReset();
    serverMock.renderJobRepo.createRetryCopy.mockReset();
    serverMock.publishTaskEvent.mockReset();
  });

  it('requires a session before reading the job', async () => {
    getServerSessionMock.mockResolvedValue(null);

    const res = await GET(
      makeRequest({ url: 'http://localhost/api/render/jobs/job-1' }),
      makeParamsCtx({ id: 'job-1' }),
    );

    expect(res.status).toBe(401);
    expect(serverMock.renderJobRepo.getById).not.toHaveBeenCalled();
  });

  it('returns only status, result, and error for the owner', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(renderJob());

    const res = await GET(
      makeRequest({ url: 'http://localhost/api/render/jobs/job-1' }),
      makeParamsCtx({ id: 'job-1' }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(serverMock.renderJobRepo.getById).toHaveBeenCalledWith('job-1');
    expect(await readJson(res)).toEqual({
      job: {
        id: 'job-1',
        taskId: 'task-1',
        status: 'COMPLETED',
        type: 'CONCAT',
        createdAt: '2026-07-19T00:00:00.000Z',
        result: { outputUrl: 'sf-asset://job-1.mp4' },
        error: null,
      },
    });
  });

  it('falls back to an owner-scoped taskId lookup', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(null);
    serverMock.renderJobRepo.getByTaskId.mockResolvedValue(renderJob());

    const res = await GET(
      makeRequest({ url: 'http://localhost/api/render/jobs/task-1' }),
      makeParamsCtx({ id: 'task-1' }),
    );

    expect(res.status).toBe(200);
    expect(serverMock.renderJobRepo.getByTaskId).toHaveBeenCalledWith('task-1', 'user-1');
  });

  it('uses the same 404 response for a missing job and another user\'s job', async () => {
    serverMock.renderJobRepo.getById.mockResolvedValue(null);
    const missing = await GET(
      makeRequest({ url: 'http://localhost/api/render/jobs/missing' }),
      makeParamsCtx({ id: 'missing' }),
    );

    serverMock.renderJobRepo.getById.mockResolvedValue(renderJob({ userId: 'user-2' }));
    const foreign = await GET(
      makeRequest({ url: 'http://localhost/api/render/jobs/job-1' }),
      makeParamsCtx({ id: 'job-1' }),
    );

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await readJson(missing)).toEqual(await readJson(foreign));
  });
});

describe('DELETE /api/render/jobs/[id]', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.renderJobRepo.getById.mockReset();
    serverMock.renderJobRepo.getByTaskId.mockReset();
    serverMock.renderJobRepo.cancel.mockReset();
    serverMock.publishTaskEvent.mockReset();
  });

  it('cancels by taskId and publishes the terminal SSE event', async () => {
    const running = renderJob({ status: 'RUNNING' });
    const cancelled = renderJob({ status: 'CANCELLED', error: '用户已取消' });
    serverMock.renderJobRepo.getById.mockResolvedValue(null);
    serverMock.renderJobRepo.getByTaskId.mockResolvedValue(running);
    serverMock.renderJobRepo.cancel.mockResolvedValue(cancelled);

    const res = await DELETE(
      makeRequest({ method: 'DELETE', url: 'http://localhost/api/render/jobs/task-1' }),
      makeParamsCtx({ id: 'task-1' }),
    );

    expect(res.status).toBe(200);
    expect(serverMock.renderJobRepo.cancel).toHaveBeenCalledWith('job-1', 'user-1');
    expect(serverMock.publishTaskEvent).toHaveBeenCalledWith({
      taskId: 'task-1',
      userId: 'user-1',
      status: 'CANCELLED',
      type: 'status_change',
    });
    expect(await readJson(res)).toEqual({
      ok: true,
      job: { id: 'job-1', status: 'CANCELLED' },
    });
  });
});

describe('POST /api/render/jobs/[id]/retry', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.renderJobRepo.getById.mockReset();
    serverMock.renderJobRepo.getByTaskId.mockReset();
    serverMock.renderJobRepo.createRetryCopy.mockReset();
    serverMock.publishTaskEvent.mockReset();
  });

  it('creates a NEW job copy on retry (old record and files preserved)', async () => {
    const failed = renderJob({ status: 'FAILED', error: 'boom' });
    const pending = renderJob({
      id: 'job-2',
      taskId: 'task-2',
      status: 'PENDING',
      error: null,
    });
    serverMock.renderJobRepo.getById.mockResolvedValue(failed);
    serverMock.renderJobRepo.createRetryCopy.mockResolvedValue(pending);

    const res = await RETRY(
      makeRequest({ method: 'POST', url: 'http://localhost/api/render/jobs/job-1/retry' }),
      makeParamsCtx({ id: 'job-1' }),
    );

    expect(res.status).toBe(200);
    expect(serverMock.renderJobRepo.createRetryCopy).toHaveBeenCalledWith('job-1', 'user-1');
    expect(serverMock.publishTaskEvent).toHaveBeenCalledWith({
      taskId: 'task-2',
      userId: 'user-1',
      status: 'QUEUED',
      type: 'status_change',
    });
  });
});
