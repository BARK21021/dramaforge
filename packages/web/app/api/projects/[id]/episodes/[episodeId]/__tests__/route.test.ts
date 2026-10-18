// ============================================================
// /api/projects/[id]/episodes/[episodeId] — 契约测试（P7.1 T3）
// ============================================================
//
// 覆盖 GET / PATCH / DELETE：
//   - GET  404 episode 不属于该 project / 200 返分集
//   - PATCH 200 更新；update 以 (episodeId, parsed) 调
//   - DELETE 200 返 { deletedId }
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../../../test/helpers';
import { GET, PATCH, DELETE } from '../route';
import type { EpisodeRecord, ProjectRecord } from '@dramaforge/shared';

function makeProject(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1', userId: 'user-1', title: '项目', description: null,
    category: 'DOMESTIC', status: 'DRAFT', version: 1, artStyle: null,
    artStylePrompt: null, novelText: null, videoScriptDraft: null,
    scriptData: null, characterMapping: null, voiceprintMapping: null,
    longVideoProgress: null, sourceProjectId: null, scriptOverride: false,
    createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
    ...over,
  };
}
function makeEpisode(over: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: 'ep-1', projectId: 'proj-1', episodeNumber: 1, title: '第 1 集',
    content: null, contentKilo: null, status: 'PENDING', defaultVisualStyle: null,
    scenes: null, emotionArc: null, videoScriptDraft: null, novelText: null,
    stageStatus: 'input', scriptData: null, sortOrder: 0,
    createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
  serverMock.projectRepo.getById.mockReset();
  serverMock.episodeRepo.getById.mockReset();
  serverMock.episodeRepo.update.mockReset();
  serverMock.episodeRepo.remove.mockReset();
});

describe('GET /api/projects/[id]/episodes/[episodeId]', () => {
  it('404 when episode not in this project', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(
      makeEpisode({ projectId: 'other-project' }),
    );
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/episodes/ep-1' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(404);
  });

  it('200 + episode when valid', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/episodes/ep-1' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: EpisodeRecord };
    expect(body.data.id).toBe('ep-1');
  });
});

describe('PATCH /api/projects/[id]/episodes/[episodeId]', () => {
  it('200 + updated episode; update called with (episodeId, parsed)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    const updated = makeEpisode({ novelText: '新剧本', contentKilo: 2 });
    serverMock.episodeRepo.update.mockResolvedValue(updated);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1',
      body: { novelText: '新剧本' },
    });
    const res = await PATCH(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: EpisodeRecord };
    expect(body.data.novelText).toBe('新剧本');
    expect(serverMock.episodeRepo.update).toHaveBeenCalledWith(
      'ep-1',
      expect.objectContaining({ novelText: '新剧本' }),
    );
  });

  it('404 when episode not in project', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(
      makeEpisode({ projectId: 'other-project' }),
    );
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1',
      body: { title: 'x' },
    });
    const res = await PATCH(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(404);
    expect(serverMock.episodeRepo.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/projects/[id]/episodes/[episodeId]', () => {
  it('200 + { deletedId }; remove called', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.episodeRepo.remove.mockResolvedValue(undefined);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1',
    });
    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { deletedId: string } };
    expect(body.data.deletedId).toBe('ep-1');
    expect(serverMock.episodeRepo.remove).toHaveBeenCalledWith('ep-1');
  });
});
