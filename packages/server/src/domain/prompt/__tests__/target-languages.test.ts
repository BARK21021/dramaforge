import { describe, it, expect } from 'vitest';
import {
  buildExplicitDurationBudget,
  resolveExplicitStoryboardTarget,
} from '../target-languages';

describe('buildExplicitDurationBudget', () => {
  it('以目标为权威，±5% 带，不夹 90–150，languageFactor=1', () => {
    const b = buildExplicitDurationBudget(300);
    expect(b.languageFactor).toBe(1);
    expect(b.targetSeconds).toBe(300);
    expect(b.minSeconds).toBe(285);
    expect(b.maxSeconds).toBe(315);
  });

  it('短目标不被夹到 90', () => {
    const b = buildExplicitDurationBudget(15);
    expect(b.targetSeconds).toBe(15);
    expect(b.minSeconds).toBe(14);
    expect(b.maxSeconds).toBe(16);
  });

  it('非正输入退化为 90', () => {
    expect(buildExplicitDurationBudget(0).targetSeconds).toBe(90);
    expect(buildExplicitDurationBudget(NaN).targetSeconds).toBe(90);
  });

  it('languageCode 取自 profile，系数仍为 1', () => {
    const b = buildExplicitDurationBudget(120, {
      stylePrompt: 'x',
      targetLanguage: { code: 'de' } as never,
    });
    expect(b.languageCode).toBe('de');
    expect(b.languageFactor).toBe(1);
  });
});

describe('resolveExplicitStoryboardTarget', () => {
  it('参考视频优先于 body', () => {
    expect(resolveExplicitStoryboardTarget(200, 300)).toBe(200);
  });
  it('无参考视频时取 body', () => {
    expect(resolveExplicitStoryboardTarget(undefined, 300)).toBe(300);
  });
  it('参考视频非正时回退 body', () => {
    expect(resolveExplicitStoryboardTarget(0, 120)).toBe(120);
  });
  it('两者都无 → undefined', () => {
    expect(resolveExplicitStoryboardTarget(undefined, undefined)).toBeUndefined();
    expect(resolveExplicitStoryboardTarget(null, null)).toBeUndefined();
  });
});
