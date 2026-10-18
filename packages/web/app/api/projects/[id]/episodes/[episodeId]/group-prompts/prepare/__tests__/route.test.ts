import { beforeEach, describe, expect, it } from 'vitest';

import { makeParamsCtx, makeRequest, readJson } from '@web/test/helpers';
import { DEFAULT_SESSION, getServerSessionMock, serverMock } from '@web/test/mocks';
import { POST } from '../route';

function makeProject(over: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    userId: 'user-1',
    title: '测试项目',
    category: 'DOMESTIC',
    artStyle: null,
    scriptData: null,
    ...over,
  };
}

function makeEpisode(over: Record<string, unknown> = {}) {
  return {
    id: 'ep-1',
    projectId: 'proj-1',
    scriptData: null,
    ...over,
  };
}

function makeShot(over: Record<string, unknown> = {}) {
  return {
    id: 'shot-1',
    projectId: 'proj-1',
    episodeId: 'ep-1',
    shotIndex: 0,
    sortOrder: 0,
    visualPrompt: '林夏在雨中停下',
    durationSeconds: 5,
    aspectRatio: '9:16',
    referencedAssets: null,
    metadata: { legacy: true },
    ...over,
  };
}

describe('POST group-prompts/prepare', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.getById.mockReset();
    serverMock.listShots.mockReset();
    serverMock.listAssets.mockReset();
    serverMock.updateShot.mockReset();
    serverMock.readLocalizationProfile.mockReset();
    serverMock.readLocalizationProfile.mockReturnValue(null);
  });

  it('builds and persists every missing group prompt before reporting ready', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue([
      // 两镜各自 groupIndex 不同；durationSeconds=8 让合并后 16s > 15s 上限，
      // 这样 computeGroupsForChain 阶段 3 不会把它们合并——保留多组持久化路径的覆盖。
      makeShot({ durationSeconds: 8, metadata: { legacy: true, groupIndex: 1 } }),
      makeShot({
        id: 'shot-2',
        shotIndex: 1,
        sortOrder: 1,
        durationSeconds: 8,
        visualPrompt: '她抬头看向屋檐',
        metadata: { groupIndex: 2 },
      }),
    ]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.updateShot.mockResolvedValue(undefined);

    const request = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/group-prompts/prepare',
      body: {},
    });
    const response = await POST(
      request,
      makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }),
    );

    expect(response.status).toBe(200);
    expect(serverMock.updateShot).toHaveBeenCalledTimes(2);
    expect(serverMock.updateShot.mock.calls[0][0]).toBe('shot-1');
    expect(serverMock.updateShot.mock.calls[1][0]).toBe('shot-2');
    const metadata = serverMock.updateShot.mock.calls[0][1].metadata as Record<string, unknown>;
    expect(metadata.legacy).toBe(true);
    expect(metadata.seedanceGroupPrompt).toContain('### 当前生成组分镜');
    expect(metadata.seedanceGroupPromptVersion).toBe(4);
    expect(metadata.seedanceGroupPromptShotIds).toEqual(['shot-1']);
    expect(metadata.seedanceGroupPromptContextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.seedanceGroupPromptSource).toBe('auto');

    const body = await readJson(response) as {
      success: boolean;
      data: {
        ready: boolean;
        groupCount: number;
        generated: number;
        reused: number;
        groups: Array<{ firstShotId: string; shotIds: string[]; contextHash: string }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      ready: true,
      groupCount: 2,
      generated: 2,
      reused: 0,
    });
    expect(body.data.groups[0]).toMatchObject({
      firstShotId: 'shot-1',
      shotIds: ['shot-1'],
      contextHash: metadata.seedanceGroupPromptContextHash,
    });
  });

  it('keeps a stale user-edited prompt (user version wins, not overwritten by auto)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue([makeShot({
      metadata: {
        seedanceGroupPrompt: '这是用户已经编辑过的提示词',
        seedanceGroupPromptVersion: 2,
        seedanceGroupPromptShotIds: ['shot-1'],
        seedanceGroupPromptContextHash: 'outdated-context',
        seedanceGroupPromptSource: 'user',
      },
    })]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.updateShot.mockResolvedValue(undefined);

    const request = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/group-prompts/prepare',
      body: {},
    });
    const response = await POST(
      request,
      makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }),
    );

    // 用户手改版本（source='user'）最高优先：即使 STALE 也不被现算 auto 覆盖。
    // 生成时 resolveGroupExecutablePrompt 分支 1 会原样用用户版（历史 bug：STALE 的
    // user 版被 prepare/finalize 落库覆盖 → 生成用的是保存前的旧版）。
    expect(response.status).toBe(200);
    const body = await readJson(response) as {
      success: boolean;
      data: { generated: number; reused: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.reused).toBe(1);
    expect(body.data.generated).toBe(0);
    expect(serverMock.updateShot).not.toHaveBeenCalled();
  });
});
