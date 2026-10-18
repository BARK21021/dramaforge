// ============================================================
// /api/projects/[id]/episodes — 契约测试（P7.1 T3）
// ============================================================
//
// 覆盖 GET（列表）/ POST（创建）/ POST ?reorder=1（重排）：
//   - GET  401 / 404 无权 / 200 返 { episodes: [] }
//   - POST 创建 404 无权 / 201 返新建分集 / update 以 (projectId, parsed) 调
//   - POST reorder 200 返重排后列表
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../../test/helpers';
import { GET, POST } from '../route';
import type { EpisodeRecord, ProjectRecord } from '@dramaforge/shared';

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

function makeEpisode(over: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: 'ep-1',
    projectId: 'proj-1',
    episodeNumber: 1,
    title: '第 1 集',
    content: null,
    contentKilo: null,
    status: 'PENDING',
    defaultVisualStyle: null,
    scenes: null,
    emotionArc: null,
    videoScriptDraft: null,
    novelText: null,
    stageStatus: 'input',
    scriptData: null,
    sortOrder: 0,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...over,
  };
}

describe('GET /api/projects/[id]/episodes', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.listByProject.mockReset();
  });

  it('401 when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/episodes' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(401);
  });

  it('404 when project not owned', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-x/episodes' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-x' }));
    expect(res.status).toBe(404);
  });

  it('200 + { episodes: [...] } when owned', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const eps = [makeEpisode({ id: 'ep-1' }), makeEpisode({ id: 'ep-2', episodeNumber: 2 })];
    serverMock.episodeRepo.listByProject.mockResolvedValue(eps);
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/episodes' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { episodes: EpisodeRecord[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.episodes).toHaveLength(2);
    expect(serverMock.episodeRepo.listByProject).toHaveBeenCalledWith('proj-1');
  });
});

describe('POST /api/projects/[id]/episodes (create)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.create.mockReset();
  });

  it('404 when project not owned', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-x/episodes',
      body: { title: '新集' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-x' }));
    expect(res.status).toBe(404);
    expect(serverMock.episodeRepo.create).not.toHaveBeenCalled();
  });

  it('201 + new episode; create called with (projectId, parsed)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const created = makeEpisode({ id: 'ep-new', title: '新集', episodeNumber: 1 });
    serverMock.episodeRepo.create.mockResolvedValue(created);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes',
      body: { title: '新集', novelText: '一段剧本' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(201);
    const body = (await readJson(res)) as { success: boolean; data: EpisodeRecord };
    expect(body.data.id).toBe('ep-new');
    expect(serverMock.episodeRepo.create).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ title: '新集', novelText: '一段剧本' }),
    );
  });
});

describe('POST /api/projects/[id]/episodes?reorder=1', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.reorder.mockReset();
  });

  it('200 + reordered list; reorder called with (projectId, {episodeIds})', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const reordered = [makeEpisode({ id: 'ep-2', episodeNumber: 1 }), makeEpisode({ id: 'ep-1', episodeNumber: 2 })];
    serverMock.episodeRepo.reorder.mockResolvedValue(reordered);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes',
      searchParams: { reorder: '1' },
      body: { episodeIds: ['ep-2', 'ep-1'] },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.episodeRepo.reorder).toHaveBeenCalledWith(
      'proj-1',
      { episodeIds: ['ep-2', 'ep-1'] },
    );
  });

  it('400 when episodeIds empty', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes',
      searchParams: { reorder: '1' },
      body: { episodeIds: [] },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(400);
  });
});
