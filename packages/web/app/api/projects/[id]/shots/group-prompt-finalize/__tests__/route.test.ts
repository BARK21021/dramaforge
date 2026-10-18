// ============================================================
// /api/projects/[id]/shots/group-prompt-finalize — 契约测试
// ============================================================
// 覆盖：
//   1. 已认可（approved=true）且非 force → 直接返回锁定提示词，不调 callAI、不写库（防误花钱）。
//   2. 未认可 → 调 callAI 跑 LLM 重写 + 落库（rewritten/approved=false）。
//   3. 已认可 + force → 强制重跑（调 callAI、approved 重置 false）。
//   4. 鉴权/越权/参数校验。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../../../test/helpers';
import { POST } from '../route';
import type { EpisodeRecord, ProjectRecord } from '@dramaforge/shared';

function makeProject(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1',
    userId: 'user-1',
    title: '我的剧',
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

const shotFixture = {
  id: 'shot-1',
  projectId: 'proj-1',
  episodeId: 'ep-1',
  shotIndex: 0,
  sortOrder: 0,
  visualPrompt: '镜头一',
  durationSeconds: 5,
  aspectRatio: '9:16',
  videoStatus: 'PENDING' as const,
  currentMaterialUrl: null,
  createdAt: new Date('2026-07-21T00:00:00.000Z'),
  updatedAt: new Date('2026-07-21T00:00:00.000Z'),
};

describe('POST /api/projects/[id]/shots/group-prompt-finalize', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.getById.mockReset();
    serverMock.listShots.mockReset();
    serverMock.listAssets.mockReset();
    serverMock.updateShot.mockReset();
    serverMock.callAI.mockReset();
  });

  it('401 未登录不调 callAI', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/shots/group-prompt-finalize',
      body: { shotIds: ['shot-1'] },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(401);
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('400 shotIds 缺失', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/shots/group-prompt-finalize',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(400);
  });

  it('已认可（approved=true）非 force → 返回锁定提示词、不调 callAI、不写库', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue([{
      ...shotFixture,
      metadata: {
        seedanceGroupPrompt: 'LOCKED 已认可提示词',
        seedanceGroupPromptVersion: 3,
        seedanceGroupPromptShotIds: ['shot-1'],
        seedanceGroupPromptContextHash: 'any',
        seedanceGroupPromptSource: 'user',
        seedanceGroupPromptRewritten: true,
        seedanceGroupPromptApproved: true,
      },
    }]);
    serverMock.listAssets.mockResolvedValue([]);

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/shots/group-prompt-finalize',
      body: { shotIds: ['shot-1'] },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.callAI).not.toHaveBeenCalled();
    expect(serverMock.updateShot).not.toHaveBeenCalled();
    const body = (await readJson(res)) as { data: { finalPrompt: string; approved: boolean } };
    expect(body.data.finalPrompt).toBe('LOCKED 已认可提示词');
    expect(body.data.approved).toBe(true);
  });

  it('用户手改未认可 + 非 force → 短路返回用户版本、不调 callAI、只标记 rewritten 不覆盖正文', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue([{
      ...shotFixture,
      metadata: {
        seedanceGroupPrompt: '用户手改的提示词',
        seedanceGroupPromptVersion: 3,
        seedanceGroupPromptShotIds: ['shot-1'],
        seedanceGroupPromptContextHash: 'any',
        seedanceGroupPromptSource: 'user',
        seedanceGroupPromptRewritten: false,
        seedanceGroupPromptApproved: false,
      },
    }]);
    serverMock.listAssets.mockResolvedValue([]);

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/shots/group-prompt-finalize',
      body: { shotIds: ['shot-1'] },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.callAI).not.toHaveBeenCalled();
    // 短路仍落库一次：只把 rewritten 标记 true（UI 的 promptFinalized 判定依赖），
    // 不覆盖 prompt/source——用户版本正文保持不变。
    expect(serverMock.updateShot).toHaveBeenCalledTimes(1);
    const meta = serverMock.updateShot.mock.calls[0][1].metadata as Record<string, unknown>;
    expect(meta.seedanceGroupPrompt).toBe('用户手改的提示词');
    expect(meta.seedanceGroupPromptSource).toBe('user');
    expect(meta.seedanceGroupPromptRewritten).toBe(true);
    const body = (await readJson(res)) as { data: { finalPrompt: string; source?: string } };
    expect(body.data.finalPrompt).toBe('用户手改的提示词');
    expect(body.data.source).toBe('user');
  });

  it('未认可 → 调 callAI 重写 + 落库（approved=false）', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue([{ ...shotFixture, metadata: {} }]);
    serverMock.listAssets.mockResolvedValue([]);

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/shots/group-prompt-finalize',
      body: { shotIds: ['shot-1'] },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.callAI).toHaveBeenCalledTimes(1);
    expect(serverMock.updateShot).toHaveBeenCalledTimes(1);
    const meta = serverMock.updateShot.mock.calls[0][1].metadata as Record<string, unknown>;
    expect(meta.seedanceGroupPromptApproved).toBe(false);
  });

  it('已认可 + force → 强制重跑 callAI（approved 重置 false）', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue([{
      ...shotFixture,
      metadata: {
        seedanceGroupPrompt: 'OLD LOCKED',
        seedanceGroupPromptVersion: 3,
        seedanceGroupPromptShotIds: ['shot-1'],
        seedanceGroupPromptContextHash: 'any',
        seedanceGroupPromptSource: 'user',
        seedanceGroupPromptRewritten: true,
        seedanceGroupPromptApproved: true,
      },
    }]);
    serverMock.listAssets.mockResolvedValue([]);

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/shots/group-prompt-finalize',
      body: { shotIds: ['shot-1'], force: true },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.callAI).toHaveBeenCalledTimes(1);
    const meta = serverMock.updateShot.mock.calls[0][1].metadata as Record<string, unknown>;
    expect(meta.seedanceGroupPromptApproved).toBe(false);
  });
});
