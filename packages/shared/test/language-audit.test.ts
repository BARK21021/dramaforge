import { describe, expect, it } from 'vitest';
import { auditLanguageScript } from '../src/language';

describe('auditLanguageScript', () => {
  it('accepts the expected writing system and rejects cross-script leaks', () => {
    expect(auditLanguageScript('Hello, this is English.', 'en').matches).toBe(true);
    expect(auditLanguageScript('你好，这是中文。', 'en').matches).toBe(false);
    expect(auditLanguageScript('こんにちは世界', 'ja').matches).toBe(true);
    expect(auditLanguageScript('Привет, мир!', 'ru').matches).toBe(true);
    expect(auditLanguageScript('Hello 世界', 'en')).toMatchObject({
      matches: false,
      unexpectedCharacters: 2,
    });
  });

  it('supports right-to-left and South Asian scripts', () => {
    expect(auditLanguageScript('مرحبا بالعالم', 'ar').matches).toBe(true);
    expect(auditLanguageScript('नमस्ते दुनिया', 'hi').matches).toBe(true);
    expect(auditLanguageScript('שלום עולם', 'he').matches).toBe(true);
  });

  it('does not claim semantic detection for unknown language codes', () => {
    expect(auditLanguageScript('hello', 'xx')).toMatchObject({
      supported: false,
      matches: false,
    });
  });
});
