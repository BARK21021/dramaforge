// ============================================================
// 成组提示词预览路由契约测试
// ============================================================
// 覆盖安全边界：项目越权、空镜头、未知镜头、跨分集、分集越界，以及成功响应。
// 纯文本拼装算法另由 server/domain/group-preview.test.ts 使用真实实现验证。
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION,
  getServerSessionMock,
  serverMock,
} from '../../../../../../../test/mocks';
import {
  makeParamsCtx,
  makeRequest,
  readJson,
} from '../../../../../../../test/helpers';
import { POST } from '../route';

/** 构造路由测试所需的最小项目记录。 */
function makeProject(userId = 'user-1') {
  return {
    id: 'proj-1',
    userId,
    title: '项目一',
    artStyle: null,
    scriptData: null,
  };
}

/** 构造路由测试所需的最小镜头记录，其余字段不参与范围校验。 */
function makeShot(
  id: string,
  episodeId: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    projectId: 'proj-1',
    episodeId,
    shotIndex: 1,
    sortOrder: 1,
    durationSeconds: 4,
    visualPrompt: `${id} 的画面`,
    ...overrides,
  };
}

/** 动态路由参数固定到当前测试项目。 */
const ctx = () => makeParamsCtx({ id: 'proj-1' });

describe('POST /api/projects/[id]/shots/generate-group-preview', () => {
  beforeEach(() => {
    // 每个用例从“已登录、拥有项目、分集归属正确”的安全基线开始。
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.getById.mockReset();
    serverMock.listShots.mockReset();
    serverMock.listAssets.mockReset();
    serverMock.updateShot.mockReset();
    serverMock.readLocalizationProfile.mockReset();
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue({
      id: 'ep-1',
      projectId: 'proj-1',
      scriptData: null,
    });
    serverMock.listShots.mockResolvedValue([
      makeShot('shot-1', 'ep-1'),
      makeShot('shot-2', 'ep-1', { shotIndex: 2, sortOrder: 2 }),
    ]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.updateShot.mockResolvedValue(makeShot('shot-1', 'ep-1'));
    serverMock.readLocalizationProfile.mockReturnValue(null);
  });

  it('项目越权时返回 404，且不读取镜头', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject('other-user'));

    const response = await POST(
      makeRequest({ method: 'POST', body: { shotIds: ['shot-1'] } }),
      ctx(),
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'NOT_FOUND',
    });
    expect(serverMock.listShots).not.toHaveBeenCalled();
    expect(serverMock.updateShot).not.toHaveBeenCalled();
  });

  it('shotIds 为空时返回 400', async () => {
    const response = await POST(
      makeRequest({ method: 'POST', body: { shotIds: [] } }),
      ctx(),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'INVALID_SHOT_IDS',
    });
    expect(serverMock.listShots).not.toHaveBeenCalled();
  });

  it('请求含未知或外项目镜头时整体返回 404，不做部分预览', async () => {
    const response = await POST(
      makeRequest({
        method: 'POST',
        body: { shotIds: ['shot-1', 'foreign-shot'] },
      }),
      ctx(),
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'SHOT_NOT_FOUND',
    });
    expect(serverMock.episodeRepo.getById).not.toHaveBeenCalled();
    expect(serverMock.updateShot).not.toHaveBeenCalled();
  });

  it('跨分集 shotIds 返回 400', async () => {
    serverMock.listShots.mockResolvedValue([
      makeShot('shot-1', 'ep-1'),
      makeShot('shot-2', 'ep-2', { shotIndex: 2, sortOrder: 2 }),
    ]);

    const response = await POST(
      makeRequest({
        method: 'POST',
        body: { shotIds: ['shot-1', 'shot-2'] },
      }),
      ctx(),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'CROSS_EPISODE_SHOTS',
    });
    expect(serverMock.episodeRepo.getById).not.toHaveBeenCalled();
    expect(serverMock.updateShot).not.toHaveBeenCalled();
  });

  it('分集不属于当前项目时返回 404', async () => {
    serverMock.episodeRepo.getById.mockResolvedValue({
      id: 'ep-1',
      projectId: 'proj-other',
    });

    const response = await POST(
      makeRequest({ method: 'POST', body: { shotIds: ['shot-1'] } }),
      ctx(),
    );

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'EPISODE_NOT_FOUND',
    });
    expect(serverMock.updateShot).not.toHaveBeenCalled();
  });

  it('同项目同分集镜头返回纯文本预览与时长', async () => {
    const response = await POST(
      makeRequest({
        method: 'POST',
        body: { shotIds: ['shot-2', 'shot-1'] },
      }),
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(serverMock.listShots).toHaveBeenCalledWith('proj-1');
    expect(serverMock.episodeRepo.getById).toHaveBeenCalledWith('ep-1');
    expect(serverMock.updateShot).toHaveBeenCalledWith(
      'shot-1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          seedanceGroupPrompt: expect.stringContaining('当前生成组分镜'),
          seedanceGroupPromptVersion: 4,
          seedanceGroupPromptShotIds: ['shot-1', 'shot-2'],
          seedanceGroupPromptContextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(await readJson(response)).toMatchObject({
      success: true,
      data: {
        combinedPrompt: expect.stringContaining('当前生成组分镜'),
        totalDuration: 8,
        validDuration: 8,
        ready: true,
        contextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });
});
