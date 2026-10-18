import { describe, expect, it } from 'vitest';
import { resolveAnalysisGuidance } from '../lib/analysis-guidance';

describe('resolveAnalysisGuidance', () => {
  it('prefers request, then episode, then project persisted guidance', () => {
    expect(resolveAnalysisGuidance(' 本次要求 ', { analysisGuidance: '分集要求' }, { analysisGuidance: '项目要求' }))
      .toBe('本次要求');
    expect(resolveAnalysisGuidance(undefined, { analysisGuidance: ' 分集要求 ' }, { analysisGuidance: '项目要求' }))
      .toBe('分集要求');
    expect(resolveAnalysisGuidance(undefined, {}, { analysisGuidance: ' 项目要求 ' }))
      .toBe('项目要求');
  });

  it('ignores malformed persisted data', () => {
    expect(resolveAnalysisGuidance(undefined, 'bad', { analysisGuidance: 42 })).toBeUndefined();
  });
});
