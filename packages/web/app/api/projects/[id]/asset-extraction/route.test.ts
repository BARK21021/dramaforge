import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SESSION, getServerSessionMock, serverMock } from '@web/test/mocks';
import { makeRequest } from '@web/test/helpers';
import { POST } from './route';

const projectCostume = {
  sceneId: 'S0', character: '林夏', costumeLabel: '便装', costumeDesc: '米色针织衫', isNew: false,
};
const episodeCostume = {
  sceneId: 'S2', character: '林夏', costumeLabel: '礼服', costumeDesc: '黑色晚礼服', isNew: true,
};

describe('POST /api/projects/[id]/asset-extraction prompt context', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      category: 'DOMESTIC',
      artStyle: null,
      scriptData: { costumeMap: [projectCostume] },
      characterMapping: null,
    });
    serverMock.episodeRepo.listByProject.mockResolvedValue([
      {
        episodeNumber: 1,
        title: '第一集',
        novelText: '林夏走进宴会厅，发现所有宾客都在等待她。'.repeat(5),
        scriptData: { characters: ['林夏'], costumeMap: [episodeCostume] },
      },
    ]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.buildAssetExtractionPrompt.mockReturnValue({ system: 'SYSTEM', user: 'USER' });
    serverMock.callAI.mockResolvedValue({ cost: 0, meta: { content: '{"characters":[]}' } });
    const extracted = {
      characters: [{ name: '林夏' }],
      items: [],
      environments: [],
      entities: [],
    };
    serverMock.parseAssetExtraction.mockReturnValue(extracted);
    serverMock.validateSuggestedVoices.mockImplementation((value: unknown) => value);
    serverMock.reconcileExtractedAssetCharacterNames.mockImplementation((value: unknown) => value);
    serverMock.replaceExtractedAssets.mockResolvedValue({ characters: 1, items: 0, environments: 0, entities: 0 });
  });

  it('passes the whole-project and per-episode costume table into the real extraction prompt', async () => {
    const response = await POST(
      makeRequest({ method: 'POST', body: {} }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    const options = serverMock.buildAssetExtractionPrompt.mock.calls[0]?.[2] as {
      costumeMap?: Array<{ costumeLabel: string }>;
    };
    expect(options.costumeMap?.map((entry) => entry.costumeLabel)).toEqual(['便装', '礼服']);
  });
});
