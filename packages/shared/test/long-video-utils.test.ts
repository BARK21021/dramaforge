import { describe, it, expect } from 'vitest';
import {
  extractEpisodeNumbers,
  buildThreeStageEpisodeRanges,
  replaceScriptEpisodeRange,
  buildEpisodeRanges,
  appendOnlyMissingEpisodes,
  episodeRangeCompletionMarker,
  inferTargetEpisodeCount,
  inferEpisodeCountRange,
  stripMetaCommentary,
} from '../src/long-video-utils';

describe('extractEpisodeNumbers', () => {
  it('collects zero-padded and non-padded episode headings in order', () => {
    const text = [
      '第001集：开篇',
      '第2集：发展',
      '## 第003集 标题',
      '第001集重复出现不应额外计入', // duplicate ignored
      '正文中提到第4集不应被匹配', // body reference ignored (no heading anchor)
    ].join('\n');
    expect(extractEpisodeNumbers(text)).toEqual([1, 2, 3]);
  });

  it('returns empty array when no episode headings present', () => {
    expect(extractEpisodeNumbers('hello world')).toEqual([]);
  });

  it('ignores non-positive or malformed numbers', () => {
    const text = '第0集\n第9999集\n第集';
    expect(extractEpisodeNumbers(text)).toEqual([9999]);
  });
});

describe('buildThreeStageEpisodeRanges', () => {
  it('splits 60 episodes into roughly equal thirds', () => {
    expect(buildThreeStageEpisodeRanges(60)).toEqual([
      { start: 1, end: 20 },
      { start: 21, end: 40 },
      { start: 41, end: 60 },
    ]);
  });

  it('collapses empty ranges for small totals', () => {
    expect(buildThreeStageEpisodeRanges(2)).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  it('handles single episode as one range', () => {
    expect(buildThreeStageEpisodeRanges(1)).toEqual([{ start: 1, end: 1 }]);
  });
});

describe('replaceScriptEpisodeRange', () => {
  it('replaces the target range while preserving prefix and suffix', () => {
    const original = [
      '第001集：原稿一',
      '原稿正文一',
      '第002集：原稿二',
      '原稿正文二',
      '第003集：原稿三',
      '原稿正文三',
    ].join('\n');
    const replacement = [
      '《剧名》第2-2集正式剧本',
      '第002集：重写二',
      '重写正文二',
    ].join('\n');
    const result = replaceScriptEpisodeRange(original, replacement, { start: 2, end: 2 });
    expect(result).toContain('第001集：原稿一');
    expect(result).toContain('原稿正文一');
    expect(result).toContain('第002集：重写二');
    expect(result).toContain('重写正文二');
    expect(result).not.toContain('原稿正文二');
    expect(result).toContain('第003集：原稿三');
    expect(result).toContain('原稿正文三');
    // Title strip: replacement's 《剧名》 line dropped because we slice from 第002
    expect(result).not.toContain('《剧名》');
  });

  it('falls back to whole replacement when range start missing in original', () => {
    const original = '第001集：保留';
    const replacement = '第005集：全新';
    const result = replaceScriptEpisodeRange(original, replacement, { start: 5, end: 5 });
    expect(result).toBe('第005集：全新');
  });
});

describe('buildEpisodeRanges', () => {
  it('chunks contiguous episodes into batches of N', () => {
    expect(buildEpisodeRanges([1, 2, 3, 4, 5], 2)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 5 },
    ]);
  });

  it('splits non-contiguous sequences into separate ranges', () => {
    expect(buildEpisodeRanges([1, 2, 5, 6, 7], 10)).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 7 },
    ]);
  });
});

describe('appendOnlyMissingEpisodes', () => {
  it('skips continuation content for episodes already present', () => {
    const existing = '第001集：已存在\n正文一\n第002集：已存在\n正文二';
    const continuation = '第001集：重打一遍\n不应该被并入\n第003集：新内容\n正文三';
    const result = appendOnlyMissingEpisodes(existing, continuation);
    expect(result).toContain('正文一');
    expect(result).toContain('正文二');
    expect(result).not.toContain('重打一遍');
    expect(result).toContain('第003集：新内容');
    expect(result).toContain('正文三');
  });
});

describe('episodeRangeCompletionMarker', () => {
  it('formats start-end with RANGE_COMPLETE sentinel', () => {
    expect(episodeRangeCompletionMarker({ start: 5, end: 10 })).toBe('[[RANGE_COMPLETE:5-10]]');
  });
});

describe('inferTargetEpisodeCount', () => {
  it('prefers terminal episode heading when present', () => {
    const outline = '第001集 开篇\n第050集 普通集\n第051集 大结局';
    expect(inferTargetEpisodeCount(outline, 60 * 60)).toBe(51);
  });

  it('uses source duration instead of imposing a 50-episode long-form floor', () => {
    const outline = '第001集 开篇\n第010集 转折';
    expect(inferTargetEpisodeCount(outline, 60 * 60)).toBe(40);
  });

  it('uses duration-based target for short content (<45min)', () => {
    const outline = '';
    // 15 min / 90 sec per episode = ~10 episodes
    expect(inferTargetEpisodeCount(outline, 15 * 60)).toBe(10);
  });

  it('does not cap duration-derived long stories at 70 episodes', () => {
    expect(inferTargetEpisodeCount('', 150 * 60)).toBe(100);
  });
});

describe('inferEpisodeCountRange', () => {
  it('derives a compact range from source and target episode duration', () => {
    expect(inferEpisodeCountRange(15 * 60)).toEqual({
      min: 8,
      max: 10,
      target: 10,
      targetEpisodeSec: 90,
    });
    expect(inferEpisodeCountRange(60 * 60)).toEqual({
      min: 32,
      max: 40,
      target: 40,
      targetEpisodeSec: 90,
    });
  });

  it('keeps callers without a usable duration backward-compatible', () => {
    expect(inferEpisodeCountRange()).toBeNull();
    expect(inferEpisodeCountRange(Number.NaN)).toBeNull();
  });
});

describe('stripMetaCommentary', () => {
  it('removes Chinese planning/batch/continuation lines without deleting screenplay content', () => {
    const result = stripMetaCommentary([
      'AI思考：需要从上一批继续。',
      '本次只生成第001集至第010集。',
      '第2批次：剩余场次会在后续补齐。',
      '续写计划：先补完当前集，再拼接下一段。',
      '',
      '第001集：灵石阵',
      '[1-1 矿洞 夜 内 人物：秦萧、阿灵]',
      '▲ 秦萧把灵石放入阵眼，蓝光沿石缝一寸寸亮起。',
      '秦萧：这台机关能生成新的护盾，别碰它。',
    ].join('\n'));

    expect(result).not.toMatch(/AI思考|本次只生成|批次|续写计划|拼接下一段/);
    expect(result).toContain('第001集：灵石阵');
    expect(result).toContain('秦萧：这台机关能生成新的护盾，别碰它。');
  });

  it('filters common English AI planning lines and preserves action/dialogue', () => {
    const result = stripMetaCommentary([
      'As an AI, I need to continue the previous batch.',
      'This batch only generates episodes 11-20.',
      'Continuation plan: finish the interrupted scene first.',
      'Episode 011: The Door',
      '▲ The steel door closes behind Mara.',
      'Mara: This generator powers the door.',
    ].join('\n'));

    expect(result).not.toMatch(/As an AI|This batch|Continuation plan/);
    expect(result).toContain('Episode 011: The Door');
    expect(result).toContain('Mara: This generator powers the door.');
  });
});
