import { describe, expect, it } from 'vitest';
import {
  inferEpisodeCountFromProjectTitle,
  normalizeProjectScriptForHash,
  resolveExpectedEpisodeCount,
  resolveProjectSourceScriptText,
} from '../src/project-script-snapshot';

describe('project source-script snapshots', () => {
  it('prefers the explicit immutable snapshot over legacy and current manuscript fields', () => {
    expect(resolveProjectSourceScriptText({
      novelText: 'styled current manuscript',
      sourceProjectId: 'source-1',
      scriptData: {
        novelText: 'legacy copied manuscript',
        sourceScriptSnapshot: {
          version: 1,
          text: 'frozen original manuscript',
          hash: 'stored-hash-is-not-trusted-for-resolution',
          sourceProjectId: 'source-1',
        },
      },
    })).toBe('frozen original manuscript');
  });

  it('keeps legacy projects compatible and normalizes line endings for hashing', () => {
    expect(resolveProjectSourceScriptText({
      novelText: 'current manuscript',
      scriptData: JSON.stringify({ novelText: '  legacy\r\nmanuscript  ' }),
    })).toBe('legacy\nmanuscript');
    expect(normalizeProjectScriptForHash('  a\r\nb  ')).toBe('a\nb');
  });

  it('keeps legacy count-hint readers compatible for non-production callers', () => {
    expect(inferEpisodeCountFromProjectTitle('1-45集-示例剧A')).toBe(45);
    expect(inferEpisodeCountFromProjectTitle('共 21 集 人鱼故事')).toBe(21);
    expect(inferEpisodeCountFromProjectTitle('2026 年原创剧本')).toBeNull();
    expect(resolveExpectedEpisodeCount({
      scriptData: {
        sourceScriptSnapshot: { expectedEpisodeCount: 45 },
        previousEpisodes: Array.from({ length: 21 }),
      },
    })).toBe(45);
    expect(resolveExpectedEpisodeCount({
      scriptData: { previousEpisodes: Array.from({ length: 21 }) },
    })).toBe(21);
  });

});
