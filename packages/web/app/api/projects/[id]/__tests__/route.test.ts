// ============================================================
// /api/projects/[id] — 契约测试（P7.1 T3）
// ============================================================
//
// 覆盖 GET / PATCH / DELETE：
//   - GET  401 未登录 / 404 项目不存在或无权 / 200 返项目
//   - PATCH 404 无权 / 400 空标题 / 200 改 title 透传 update
//
// mock 模式照搬 app/api/projects/route.test.ts。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../test/helpers';
import { DELETE, GET, PATCH } from '../route';
import type { ProjectRecord } from '@dramaforge/shared';

function makeProject(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1',
    userId: 'user-1',
    title: '项目',
    description: null,
    category: 'DOMESTIC',
    status: 'DRAFT',
    version: 1,
    artStyle: null,
    artStylePrompt: null,
    novelText: null,
    videoScriptDraft: null,
    scriptData: null,
    characterMapping: null,
    voiceprintMapping: null,
    longVideoProgress: null,
    sourceProjectId: null,
    scriptOverride: false,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...over,
  };
}

describe('GET /api/projects/[id]', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
  });

  it('401 when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(401);
    expect(serverMock.projectRepo.getById).not.toHaveBeenCalled();
  });

  it('404 when project missing (no existence leak)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-x' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-x' }));
    expect(res.status).toBe(404);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('404 when project owned by another user', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(
      makeProject({ userId: 'other-user' }),
    );
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(404);
  });

  it('200 + project when owned', async () => {
    const project = makeProject({ title: '我的项目' });
    serverMock.projectRepo.getById.mockResolvedValue(project);
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: ProjectRecord };
    expect(body.success).toBe(true);
    expect(body.data.title).toBe('我的项目');
    expect(serverMock.projectRepo.getById).toHaveBeenCalledWith('proj-1');
  });
});

describe('PATCH /api/projects/[id]', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.projectRepo.update.mockReset();
  });

  it('404 when not owned', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-x',
      body: { title: '新' },
    });
    const res = await PATCH(req, makeParamsCtx({ id: 'proj-x' }));
    expect(res.status).toBe(404);
    expect(serverMock.projectRepo.update).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR when title empty', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1',
      body: { title: '' },
    });
    const res = await PATCH(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('200 + updated project on rename', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const renamed = makeProject({ title: '新标题' });
    serverMock.projectRepo.update.mockResolvedValue(renamed);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1',
      body: { title: '新标题' },
    });
    const res = await PATCH(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: ProjectRecord };
    expect(body.data.title).toBe('新标题');
    expect(serverMock.projectRepo.update).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ title: '新标题' }),
    );
  });
});

describe('DELETE /api/projects/[id]', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.projectRepo.remove.mockReset();
  });

  it('returns the same 404 for a missing or foreign project', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject({ userId: 'other-user' }));
    const req = makeRequest({ method: 'DELETE', url: 'http://localhost/api/projects/proj-1' });

    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1' }));

    expect(res.status).toBe(404);
    expect(serverMock.projectRepo.remove).not.toHaveBeenCalled();
  });

  it('deletes an owned project and returns its id', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.projectRepo.remove.mockResolvedValue(true);
    const req = makeRequest({ method: 'DELETE', url: 'http://localhost/api/projects/proj-1' });

    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1' }));

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ success: true, data: { id: 'proj-1' } });
    expect(serverMock.projectRepo.remove).toHaveBeenCalledWith('proj-1');
  });
});
