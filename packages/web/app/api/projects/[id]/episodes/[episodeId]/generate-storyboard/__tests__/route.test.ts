import { beforeEach, describe, expect, it, vi } from 'vitest';

// @dramaforge/server 由 vitest 全局 setup 自动 mock（serverMock 即共享实例，见 split 路由测试）。
// 只需额外 mock 本包的计费副作用：
vi.mock('@web/lib/direct-media-generation', () => ({
  billDirectGeneration: vi.fn().mockResolvedValue(undefined),
}));

import { serverMock } from '../../../../../../../../test/mocks';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { runStoryboardGeneration } from '../../../../../../../../lib/storyboard-generation-runner';

const PROJECT_ID = 'proj-1';
const EPISODE_ID = 'ep-1';

describe('runStoryboardGeneration (分镜生成 runner)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverMock.projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'DOMESTIC',
      scriptData: null,
      artStyle: null,
    });
    serverMock.episodeRepo.getById.mockResolvedValue({
      id: EPISODE_ID,
      projectId: PROJECT_ID,
      episodeNumber: 1,
      scriptData: {
        scenes: [{
          id: 'S1',
          location: 'Abandoned Boathouse',
          content: 'The shackles fall on the floor.',
        }],
      },
    });
    serverMock.listAssets.mockResolvedValue([
      {
        kind: 'LOCATION',
        name: '废弃船屋',
        description: '临海木屋',
        metadata: {
          sourceNames: [' Abandoned Boathouse ', 'Abandoned Boathouse', null],
        },
      },
      {
        kind: 'PROP',
        name: '银色镣铐',
        description: '束缚道具',
        metadata: { sourceNames: ['Silver Binding Shackles'] },
      },
    ]);
    serverMock.hasLockedTargetLanguage.mockReturnValue(true);
    serverMock.resolveExplicitStoryboardTarget.mockReturnValue(undefined);
    serverMock.buildLocalizedDurationBudget.mockReturnValue(undefined);
    serverMock.buildStoryboardPrompt.mockReturnValue({ system: 'SYSTEM', user: 'USER' });
    serverMock.callAI.mockResolvedValue({
      url: '',
      meta: { content: '{"shots":[]}' },
      cost: 0.01,
    });
    const parsedShot = {
      sceneId: 'S1',
      shotIndex: 1,
      visualPrompt: 'The shackles fall.',
      durationSeconds: 4,
      purposeTag: '',
      dialogue: '',
      characters: [],
      speakingCharacters: [],
      environments: ['Abandoned Boathouse'],
      items: ['Silver Binding Shackles'],
    };
    serverMock.parseStoryboardShots.mockReturnValue([parsedShot]);
    serverMock.postprocessStoryboardShots.mockReturnValue({
      shots: [{
        ...parsedShot,
        environments: ['废弃船屋'],
        items: ['银色镣铐'],
        groupIndex: 0,
        groupLabel: '建场组',
      }],
      dialogueCoverage: [],
      languageAudit: [],
      warnings: [],
    });
    serverMock.replaceEpisodeShots.mockResolvedValue(undefined);
    serverMock.listShots.mockResolvedValue([]);
    serverMock.reportInlineAiTaskProgress.mockResolvedValue(undefined);
    serverMock.completeInlineAiTask.mockResolvedValue(undefined);
    serverMock.failInlineAiTask.mockResolvedValue(undefined);
  });

  it('把 metadata.sourceNames 规范化(去空白/去重/丢 null)后注入 prompt 与 postprocess,最终落 Chinese 名', async () => {
    await runStoryboardGeneration({
      taskId: 't1',
      userId: 'user-1',
      projectId: PROJECT_ID,
      episodeId: EPISODE_ID,
      model: 'deepseek/deepseek-v4-flash',
    });

    const expectedAssets = [
      expect.objectContaining({
        kind: 'LOCATION',
        name: '废弃船屋',
        sourceNames: ['Abandoned Boathouse'],
      }),
      expect.objectContaining({
        kind: 'PROP',
        name: '银色镣铐',
        sourceNames: ['Silver Binding Shackles'],
      }),
    ];
    expect(serverMock.buildStoryboardPrompt).toHaveBeenCalledWith(
      expect.any(Array),
      expectedAssets,
      expect.any(Object),
    );
    expect(serverMock.postprocessStoryboardShots).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expectedAssets,
      'zh',
      undefined, // novelText（本测试 episode 无 novelText；runner 透传给 postprocess 做台词完整性校验）
    );
    expect(serverMock.replaceEpisodeShots).toHaveBeenCalledWith(
      EPISODE_ID,
      [expect.objectContaining({
        referencedAssets: expect.objectContaining({
          environments: ['废弃船屋'],
          items: ['银色镣铐'],
        }),
      })],
    );
    expect(serverMock.completeInlineAiTask).toHaveBeenCalledWith(
      't1', 'user-1', expect.objectContaining({ episodeId: EPISODE_ID }),
    );
  });

  it('AI 返回空 → failInlineAiTask + 不扣费 + 不落库', async () => {
    serverMock.callAI.mockResolvedValue({ url: '', meta: { content: '' }, cost: 0.01 });

    await runStoryboardGeneration({
      taskId: 't2', userId: 'user-1', projectId: PROJECT_ID, episodeId: EPISODE_ID,
      model: 'deepseek/deepseek-v4-flash',
    });

    expect(billDirectGeneration).not.toHaveBeenCalled();
    expect(serverMock.replaceEpisodeShots).not.toHaveBeenCalled();
    expect(serverMock.failInlineAiTask).toHaveBeenCalledWith('t2', 'user-1', expect.any(String));
  });
});
