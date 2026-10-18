import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION,
  getServerSessionMock,
  serverMock,
} from '../../../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../../../test/helpers';
import { POST } from '../route';

const PROJECT_ID = 'project-overseas';
const SOURCE_ID = 'project-original';
const NOVEL_TEXT = '这是目标项目创建时冻结的完整原创整剧文本。'.repeat(8);
const CURRENT_STYLED_TEXT = '这是目标项目当前可变的转风格稿，不能拿来替代冻结原文。'.repeat(8);
const SOURCE_PROJECT_LATER_TEXT = '这是原创源项目后来被修改的新文本。'.repeat(8);
const SOURCE_SCRIPT_HASH = createHash('sha256').update(NOVEL_TEXT).digest('hex');

function ctx() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

describe('POST /api/projects/[id]/episodes/split', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.listByProject.mockReset();
    serverMock.enqueueAiTask.mockReset();
    serverMock.readLocalizationProfile.mockReset();
    serverMock.projectRepo.getById.mockImplementation(async (id: string) =>
      id === PROJECT_ID
        ? {
            id: PROJECT_ID,
             userId: 'user-1',
             title: '1-45集-标题数字不能成为拆集约束',
             category: 'OVERSEAS',
             sourceProjectId: SOURCE_ID,
             novelText: CURRENT_STYLED_TEXT,
             scriptData: {
               sourceMode: 'ORIGINAL_PROJECT',
               expectedEpisodeCount: 70,
               previousEpisodes: Array.from({ length: 36 }, (_, index) => ({ n: index + 1 })),
               sourceScriptSnapshot: {
                 version: 1,
                 text: NOVEL_TEXT,
                 hash: SOURCE_SCRIPT_HASH,
                 sourceProjectId: SOURCE_ID,
                 expectedEpisodeCount: 21,
               },
             },
           }
         : {
            id: SOURCE_ID,
             userId: 'user-1',
             category: 'ORIGINAL',
             novelText: SOURCE_PROJECT_LATER_TEXT,
           },
    );
    serverMock.episodeRepo.listByProject.mockResolvedValue([]);
    serverMock.readLocalizationProfile.mockReturnValue(null);
    serverMock.enqueueAiTask.mockResolvedValue({
      task: { id: 'task-1', status: 'QUEUED' },
      reused: false,
    });
  });

  it('lets AI read the frozen script without title, stale snapshot, or history count constraints', async () => {
    const response = await POST(
      makeRequest({
        method: 'POST',
        body: {
          model: 'deepseek/deepseek-v4-pro',
          stylePrompt: '日语 / 日本文化与社会习俗 / 亚洲',
        },
      }),
      ctx(),
    );

    expect(response.status).toBe(202);
     expect(serverMock.enqueueAiTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        type: 'EPISODE_SPLIT',
        payload: expect.objectContaining({
           novelText: NOVEL_TEXT,
           sourceScriptHash: SOURCE_SCRIPT_HASH,
           category: 'OVERSEAS',
          stylePrompt: '日语 / 日本文化与社会习俗 / 亚洲',
        }),
      }),
     );
    const queuedPayload = serverMock.enqueueAiTask.mock.calls[0]?.[0]?.payload;
    expect(queuedPayload).not.toHaveProperty('expectedEpisodeCount');
    expect(serverMock.projectRepo.getById).toHaveBeenCalledTimes(1);
    expect(serverMock.projectRepo.getById).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('rejects an overseas whole-series job without a target language', async () => {
    const response = await POST(
      makeRequest({ method: 'POST', body: {} }),
      ctx(),
    );
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'TARGET_STYLE_REQUIRED' });
    expect(serverMock.enqueueAiTask).not.toHaveBeenCalled();
  });
});
