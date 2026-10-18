import { describe, expect, it } from 'vitest';

import { buildEpisodeAnalysisContext } from '../lib/episode-analysis-context';

describe('episode analysis continuity context', () => {
  it('keeps full previous scripts and existing costume variants while excluding current/future episodes', () => {
    const result = buildEpisodeAnalysisContext(
      { id: 'ep-2', episodeNumber: 2, title: '第二集' },
      [
        {
          id: 'ep-1', episodeNumber: 1, title: '第一集',
          scenes: [{ id: 'S1', location: '码头', characters: ['林夏'], content: '林夏把银色镣铐交给赵默，并约定天亮前回来。' }],
        },
        { id: 'ep-2', episodeNumber: 2, content: '当前集不能提前注入' },
        { id: 'ep-3', episodeNumber: 3, content: '未来剧情不能泄露' },
      ],
      [{
        kind: 'CHARACTER', name: '林夏', description: '女主角', coverageScenes: ['S1'],
        costumes: [
          { key: 'default', label: '便装', imageUrl: '/default.png' },
          { key: 'formal', label: '礼服', imageUrl: '/formal.png' },
        ],
      }],
      'zh',
    );

    expect(result.previousScriptsPrefix).toContain('林夏把银色镣铐交给赵默，并约定天亮前回来。');
    expect(result.previousScriptsPrefix).not.toContain('当前集不能提前注入');
    expect(result.previousScriptsPrefix).not.toContain('未来剧情不能泄露');
    expect(result.previousEpisodes).toHaveLength(1);
    expect(result.existingAssets[0].costumes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'formal', label: '礼服' }),
    ]));
  });
});
