import { describe, expect, it } from 'vitest';
import {
  buildLocalizedDurationBudget,
  type LocalizationProfile,
  type TargetLanguage,
} from '../../src/domain/prompt';

function profile(code: string): LocalizationProfile {
  const language: TargetLanguage = {
    code,
    native: code,
    zh: code,
    en: code,
    region: 'test',
    cultureHint: 'test',
  };
  return { stylePrompt: '真人写实海外转绘', targetLanguage: language };
}

describe('localized duration budget', () => {
  it('uses source duration and an English-specific 90–150 second range', () => {
    expect(buildLocalizedDurationBudget(profile('en-US'), 174.474)).toEqual({
      languageCode: 'en-us',
      languageFactor: 1.05,
      minSeconds: 95,
      targetSeconds: 158,
      maxSeconds: 158,
    });
  });

  it('allows more room for German than Japanese', () => {
    const german = buildLocalizedDurationBudget(profile('de'), 174.474);
    const japanese = buildLocalizedDurationBudget(profile('ja'), 174.474);
    expect(german).toMatchObject({ minSeconds: 99, targetSeconds: 165, maxSeconds: 165 });
    expect(japanese).toMatchObject({ minSeconds: 88, targetSeconds: 147, maxSeconds: 147 });
    expect(german.maxSeconds).toBeGreaterThan(japanese.maxSeconds);
  });

  it('uses the language-adjusted midpoint when source duration is unknown', () => {
    expect(buildLocalizedDurationBudget(profile('fr')).targetSeconds).toBe(129);
  });
});
