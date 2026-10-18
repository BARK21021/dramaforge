import { describe, expect, it } from 'vitest';
import { validateSplitAttempt } from '../../src/domain/episode/split-service';

describe('heading anchor edge cases', () => {
  it('rejects when AI returns fewer episodes than explicit headings (must not merge whole novel into one episode)', () => {
    const novelText = '头\n## 第1集\n甲好。\n## 第2集\n乙好。';
    // AI 少拆：只返回 1 集，但原文有 2 个标题 → 标题锚点不可用；上游已确认 2 集 → 拒绝
    const raw = JSON.stringify({
      episodes: [{ episodeNumber: 1, title: '一', content: '头\n## 第1集\n甲好。\n## 第2集\n乙好。' }],
    });
    const result = validateSplitAttempt(raw, novelText, 2);
    expect(result.drafts).toBeUndefined();
    expect(result.failureReason).toContain('分集数');
  });

  it('rejects when AI returns more episodes than explicit headings', () => {
    const novelText = '## 第1集\n甲好。\n## 第2集\n乙好。';
    const raw = JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '一', content: '## 第1集\n甲好。' },
        { episodeNumber: 2, title: '二', content: '## 第2集\n乙好。' },
        { episodeNumber: 3, title: '三', content: '多出来' },
      ],
    });
    const result = validateSplitAttempt(raw, novelText);
    // 3 集 vs 2 标题：锚点不可用；拼接!=原文且字数比超容差 → 拒绝
    expect(result.drafts).toBeUndefined();
  });

  it('handles heading suffix like 第28集（大结局）', () => {
    const novelText = '头\n## 第1集\n甲好。\n## 第2集（大结局）\n乙好。';
    const raw = JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '一', content: '## 第1集\n甲好。' },
        { episodeNumber: 2, title: '二', content: '## 第2集（大结局）\n乙好。' },
      ],
    });
    const result = validateSplitAttempt(raw, novelText);
    expect(result.drafts).toBeDefined();
    expect(result.splitMode).toBe('ai-heading-anchored');
    expect(result.drafts!.map((d) => d.content).join('')).toBe(novelText);
    expect(result.drafts![1].content.startsWith('## 第2集（大结局）')).toBe(true);
  });

  it('falls back to whitespace repair for headingless novels (anchor string path)', () => {
    const novelText = '甲说你好。乙说再见。丙说走好。';
    const raw = JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '一', content: '甲说你好。' },
        { episodeNumber: 2, title: '二', content: '乙说再见。' },
        { episodeNumber: 3, title: '三', content: '丙说走好。' },
      ],
    });
    const result = validateSplitAttempt(raw, novelText);
    expect(result.drafts).toBeDefined();
    expect(result.drafts!.map((d) => d.content).join('')).toBe(novelText);
    expect(result.drafts!.every((d) => d.content.trim().length > 0)).toBe(true);
  });
});
