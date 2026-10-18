// ============================================================
// ③ server/domain/storyboard/degenerate — 退化/无意义画面检测 单测
// ============================================================
// 覆盖：
//   - isDegenerateVisualPrompt：黑屏/白屏/无主体/无场景等退化标记命中；正常画面不命中。
//   - sanitizeDegenerateVisualPrompt：退化措辞机械改写成可生成措辞；非退化原样返回。
// 纯函数（零 import），不依赖 @shared/* / @server/* 别名解析。
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  isDegenerateVisualPrompt,
  sanitizeDegenerateVisualPrompt,
} from '../../src/domain/storyboard/degenerate';

describe('isDegenerateVisualPrompt', () => {
  it('detects black/white screen + no-subject/no-scene markers', () => {
    expect(isDegenerateVisualPrompt('画面：黑屏。从全黑开始，整个过程画面无任何图像内容')).toBe(true);
    expect(isDegenerateVisualPrompt('固定白屏，无主体')).toBe(true);
    expect(isDegenerateVisualPrompt('纯黑背景，无场景')).toBe(true);
    expect(isDegenerateVisualPrompt('画面无图像内容')).toBe(true);
  });

  it('passes normal visible prompts (有可见主体/场景)', () => {
    expect(isDegenerateVisualPrompt('林夏推门走入大厅，暖光打在脸上，她低头沉思')).toBe(false);
    expect(isDegenerateVisualPrompt('极暗，Maya 的剪影隐现在近乎全黑的画面中')).toBe(false);
  });

  it('handles empty / nullish input (不算退化)', () => {
    expect(isDegenerateVisualPrompt('')).toBe(false);
    expect(isDegenerateVisualPrompt(undefined)).toBe(false);
    expect(isDegenerateVisualPrompt(null)).toBe(false);
  });
});

describe('sanitizeDegenerateVisualPrompt', () => {
  it('rewrites black-screen + no-subject into generable visible phrasing', () => {
    const out = sanitizeDegenerateVisualPrompt('画面：黑屏。无主体，无场景。固定黑屏，无移动。');
    // 黑屏/无主体等不可生成措辞被改写掉
    expect(out).not.toContain('黑屏');
    expect(out).not.toContain('无主体');
    expect(out).not.toContain('固定黑屏');
    // 改写后含可见主体措辞（剪影/人物）
    expect(out).toContain('剪影');
  });

  it('rewrites white-screen markers', () => {
    const out = sanitizeDegenerateVisualPrompt('纯白屏，无场景');
    expect(out).not.toContain('白屏');
    expect(out).not.toContain('无场景');
  });

  it('leaves non-degenerate text unchanged', () => {
    expect(sanitizeDegenerateVisualPrompt('林夏在暖光下低头沉思')).toBe('林夏在暖光下低头沉思');
  });

  it('handles empty input', () => {
    expect(sanitizeDegenerateVisualPrompt('')).toBe('');
    expect(sanitizeDegenerateVisualPrompt(undefined)).toBe('');
  });
});
