import { describe, it, expect } from 'vitest';
import { isVersionBelow } from '../src/version';

describe('isVersionBelow', () => {
  it('returns true when v is strictly below min', () => {
    expect(isVersionBelow('1.2.0', '1.3.0')).toBe(true);
  });

  it('returns false when v equals min', () => {
    expect(isVersionBelow('1.3.0', '1.3.0')).toBe(false);
  });

  it('returns false when v is above min', () => {
    expect(isVersionBelow('2.0.0', '1.9.9')).toBe(false);
  });

  it('returns true when v is below min on patch segment', () => {
    expect(isVersionBelow('1.0.0', '1.0.1')).toBe(true);
  });
});
