// ============================================================
// ⑥ server/ai-worker/model-util — 单测（纯函数）
// ============================================================
//
// 覆盖：
//   - parseModel：正常拆分 / 无前缀抛错 / 空字符串抛错 / provider 为空抛错
//   - tryExtractProvider：正常 / 无前缀返回 null / 空返回 null
//   - computeAspectRatio：9:16 / 16:9 / 3:4 / 4:3 / 21:9 / 9:21 / 1:1 / 缺省
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  parseModel,
  tryExtractProvider,
  computeAspectRatio,
  DEFAULT_NEGATIVE_PROMPT,
} from '../../src/ai-worker/model-util';

describe('parseModel', () => {
  it('splits "ark/doubao-seedance-2-0" into provider=ark, model=full', () => {
    const r = parseModel('ark/doubao-seedance-2-0');
    expect(r.provider).toBe('ark');
    expect(r.model).toBe('ark/doubao-seedance-2-0');
  });

  it('splits "openai/gpt-4o" into provider=openai', () => {
    const r = parseModel('openai/gpt-4o');
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('openai/gpt-4o');
  });

  it('throws when model has no provider prefix', () => {
    expect(() => parseModel('doubao-seedance-2-0')).toThrow('缺少 provider 前缀');
  });

  it('throws when model is empty string', () => {
    expect(() => parseModel('')).toThrow('为空');
  });

  it('throws when provider prefix is empty (leading slash)', () => {
    expect(() => parseModel('/model-id')).toThrow('provider 前缀为空');
  });
});

describe('tryExtractProvider', () => {
  it('returns provider for "ark/seedream"', () => {
    expect(tryExtractProvider('ark/seedream')).toBe('ark');
  });

  it('returns null for model without prefix', () => {
    expect(tryExtractProvider('flux-pro')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(tryExtractProvider('')).toBeNull();
  });
});

describe('computeAspectRatio', () => {
  it('returns 9:16 for 1080x1920', () => {
    expect(computeAspectRatio(1080, 1920)).toBe('9:16');
  });

  it('returns 16:9 for 1920x1080', () => {
    expect(computeAspectRatio(1920, 1080)).toBe('16:9');
  });

  it('returns 3:4 for 768x1024', () => {
    expect(computeAspectRatio(768, 1024)).toBe('3:4');
  });

  it('returns 4:3 for 1024x768', () => {
    expect(computeAspectRatio(1024, 768)).toBe('4:3');
  });

  it('returns 21:9 for 2560x1080', () => {
    expect(computeAspectRatio(2560, 1080)).toBe('21:9');
  });

  it('returns 9:21 for 1080x2560', () => {
    expect(computeAspectRatio(1080, 2560)).toBe('9:21');
  });

  it('returns 1:1 for 1024x1024', () => {
    expect(computeAspectRatio(1024, 1024)).toBe('1:1');
  });

  it('returns 1:1 when width/height missing', () => {
    expect(computeAspectRatio(undefined, undefined)).toBe('1:1');
  });

  it('returns 1:1 for non-matching ratio', () => {
    expect(computeAspectRatio(1000, 1001)).toBe('1:1');
  });
});

describe('DEFAULT_NEGATIVE_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_NEGATIVE_PROMPT).toBe('string');
    expect(DEFAULT_NEGATIVE_PROMPT.length).toBeGreaterThan(0);
  });
});
