import { describe, it, expect } from 'vitest';
import { loadPresetVoiceManifest } from '../../src/domain/prompt/voice-manifest';

describe('voice-manifest sanity (批6 音色库)', () => {
  it('loads entries with file/gender/desc (200 条预设音色)', () => {
    const list = loadPresetVoiceManifest();
    expect(list.length).toBeGreaterThan(100);
    for (const v of list) {
      expect(typeof v.file).toBe('string');
      expect(v.file.length).toBeGreaterThan(0);
      expect(['female', 'male']).toContain(v.gender);
      expect(typeof v.desc).toBe('string');
    }
  });
});
