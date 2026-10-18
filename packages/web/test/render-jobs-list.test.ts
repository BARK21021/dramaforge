// ============================================================
// GET /api/render/jobs — 当前用户作业列表契约
// ============================================================
// 列表用于全局任务条恢复状态，响应不能泄露 input 或租约凭据。

import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/render/jobs/route';
import { DEFAULT_SESSION, getServerSessionMock, serverMock } from './mocks';
import { makeRequest, readJson } from './helpers';

function renderJob() {
  return {
    id: 'job-1',
    taskId: 'task-1',
    userId: 'user-1',
    type: 'CHAIN_COMPILE',
    status: 'RUNNING',
    input: { filmMeta: { projectId: 'project-1' }, secret: 'must-not-leak' },
    result: null,
    claimedBy: 'machine-1',
    claimToken: 'secret-token',
    error: null,
    createdAt: '2026-07-21T00:00:00.000Z',
    claimedAt: '2026-07-21T00:00:01.000Z',
    heartbeatAt: '2026-07-21T00:00:02.000Z',
    completedAt: null,
  };
}

describe('GET /api/render/jobs', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.renderJobRepo.listByUser.mockReset();
  });

  it('requires authentication before querying the repository', async () => {
    getServerSessionMock.mockResolvedValue(null);

    const res = await GET(makeRequest({ url: 'http://localhost/api/render/jobs' }));

    expect(res.status).toBe(401);
    expect(serverMock.renderJobRepo.listByUser).not.toHaveBeenCalled();
  });

  it('forwards filters and returns only task display fields', async () => {
    serverMock.renderJobRepo.listByUser.mockResolvedValue([renderJob()]);

    const res = await GET(
      makeRequest({
        url: 'http://localhost/api/render/jobs?status=RUNNING&type=CHAIN_COMPILE&projectId=project-1',
      }),
    );

    expect(res.status).toBe(200);
    expect(serverMock.renderJobRepo.listByUser).toHaveBeenCalledWith('user-1', {
      status: 'RUNNING',
      type: 'CHAIN_COMPILE',
      projectId: 'project-1',
      limit: 100,
    });
    expect(await readJson(res)).toEqual({
      jobs: [
        {
          id: 'task-1',
          taskId: 'task-1',
          renderJobId: 'job-1',
          status: 'RUNNING',
          type: 'CHAIN_COMPILE',
          projectId: 'project-1',
          result: null,
          error: null,
          createdAt: '2026-07-21T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:02.000Z',
        },
      ],
      total: 1,
    });
  });

  it('rejects unknown statuses before querying', async () => {
    const res = await GET(
      makeRequest({ url: 'http://localhost/api/render/jobs?status=UNKNOWN' }),
    );

    expect(res.status).toBe(400);
    expect(serverMock.renderJobRepo.listByUser).not.toHaveBeenCalled();
  });
});
