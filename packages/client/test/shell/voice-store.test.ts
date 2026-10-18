// Unit tests for ⑪ client/shell — preset voice library (批6).
//
// Style mirrors asset-store.test.ts: real node:fs against os.tmpdir() so
// path-traversal / read guards run against the actual filesystem (a mock fs
// would hide real path.resolve / access bugs).
//
// Covers:
//   - listPresetVoices: read manifest, malformed JSON, non-array top-level,
//     per-entry field validation (skip bad entries).
//   - readPresetVoice: path-traversal defense (../, slash, backslash, non-wav),
//     manifest allowlist (file not in manifest), missing file, happy path
//     returns data:audio/wav;base64,...

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Mock the ffmpeg helper so readPresetVoiceTrimmed tests don't require the real
// ffmpeg binary — we assert only the branching (when to trim) + envelope shape.
// The real trim behavior is covered separately in pipeline.test.ts (guardIt).
vi.mock('../../src/ffmpeg/ffmpeg-pipeline', () => ({
  trimAudio: vi.fn(),
}));

import {
  isBareWavName,
  listPresetVoices,
  readPresetVoice,
  readPresetVoiceTrimmed,
} from '../../main/voice-store';
import { trimAudio } from '../../src/ffmpeg/ffmpeg-pipeline';
import type { PresetVoice } from '../../main/voice-store';

const SAMPLE_VOICE: PresetVoice = {
  file: 'female_001_test.wav',
  gender: 'female',
  dur: 3.76,
  desc: '温柔甜美的少女声音',
  text: 'The best way to predict the future is to create it yourself.',
  lang: 'English',
};

async function makeVoicesDir(entries: PresetVoice[] = [SAMPLE_VOICE]): Promise<string> {
  const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(os.tmpdir(), `sf-voices-test-${rand}`, 'voices');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(entries), 'utf8');
  // Touch the actual wav files (contents don't matter for tests; small stub).
  for (const e of entries) {
    await fs.writeFile(path.join(dir, e.file), Buffer.from('fake-wav-bytes'));
  }
  return dir;
}

describe('isBareWavName', () => {
  it('accepts a bare <name>.wav', () => {
    expect(isBareWavName('female_001_test.wav')).toBe(true);
    expect(isBareWavName('UPPER.WAV')).toBe(true);
  });

  it('rejects path separators and traversal segments', () => {
    expect(isBareWavName('../secret.wav')).toBe(false);
    expect(isBareWavName('subdir/foo.wav')).toBe(false);
    expect(isBareWavName('foo\\bar.wav')).toBe(false);
    expect(isBareWavName('..\\secret.wav')).toBe(false);
  });

  it('rejects non-wav extensions and missing extension', () => {
    expect(isBareWavName('foo.mp3')).toBe(false);
    expect(isBareWavName('foo')).toBe(false);
    expect(isBareWavName('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isBareWavName(null as unknown as string)).toBe(false);
    expect(isBareWavName(undefined as unknown as string)).toBe(false);
    expect(isBareWavName(123 as unknown as string)).toBe(false);
  });
});

describe('listPresetVoices', () => {
  let dir: string;
  let dirRoot: string;

  beforeEach(async () => {
    dir = await makeVoicesDir();
    dirRoot = path.dirname(dir);
  });

  afterEach(async () => {
    await fs.rm(dirRoot, { recursive: true, force: true });
  });

  it('reads the manifest and returns the parsed voices array', async () => {
    const result = await listPresetVoices(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.voices).toEqual([SAMPLE_VOICE]);
  });

  it('returns READ_ERROR when manifest.json is missing', async () => {
    await fs.rm(path.join(dir, 'manifest.json'));
    const result = await listPresetVoices(dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('READ_ERROR');
    expect(result.message).toMatch(/manifest/);
  });

  it('returns INVALID_MANIFEST when manifest is not valid JSON', async () => {
    await fs.writeFile(path.join(dir, 'manifest.json'), '{not json', 'utf8');
    const result = await listPresetVoices(dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('INVALID_MANIFEST');
  });

  it('returns INVALID_MANIFEST when top-level is not an array', async () => {
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ foo: 'bar' }), 'utf8');
    const result = await listPresetVoices(dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('INVALID_MANIFEST');
    expect(result.message).toMatch(/array/);
  });

  it('skips entries with bad fields without throwing (one bad apple)', async () => {
    const good: PresetVoice = { ...SAMPLE_VOICE, file: 'good.wav' };
    const badFile = { ...SAMPLE_VOICE, file: '../escape.wav' }; // traversal → reject
    const badType = { ...SAMPLE_VOICE, dur: 'NaN-string' }; // wrong type → reject
    const noGender = { ...SAMPLE_VOICE, gender: undefined }; // missing → reject
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify([good, badFile, badType, noGender]),
      'utf8',
    );
    const result = await listPresetVoices(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.voices).toEqual([good]);
  });
});

describe('readPresetVoice — path traversal defense', () => {
  let dir: string;
  let dirRoot: string;

  beforeEach(async () => {
    dir = await makeVoicesDir();
    dirRoot = path.dirname(dir);
  });

  afterEach(async () => {
    await fs.rm(dirRoot, { recursive: true, force: true });
  });

  it('rejects file containing ".."', async () => {
    const result = await readPresetVoice('../escape.wav', dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('INVALID_FILE');
  });

  it('rejects file with slash / backslash', async () => {
    expect((await readPresetVoice('subdir/foo.wav', dir)).ok).toBe(false);
    expect((await readPresetVoice('foo\\bar.wav', dir)).ok).toBe(false);
  });

  it('rejects non-wav extension', async () => {
    const r = await readPresetVoice('foo.mp3', dir);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('INVALID_FILE');
  });

  it('rejects file that passes shape check but is NOT in manifest (allowlist)', async () => {
    // Shape-valid (bare .wav) but not listed in manifest.
    const result = await readPresetVoice('female_999_not_in_manifest.wav', dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('INVALID_FILE');
    expect(result.message).toMatch(/not in manifest/);
  });

  it('returns READ_ERROR when wav file is missing from disk', async () => {
    // Add to manifest so it passes allowlist, but don't create the actual file.
    const listed: PresetVoice = { ...SAMPLE_VOICE, file: 'ghost.wav' };
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify([listed, SAMPLE_VOICE]),
      'utf8',
    );
    const result = await readPresetVoice('ghost.wav', dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('READ_ERROR');
  });
});

describe('readPresetVoice — happy path', () => {
  let dir: string;
  let dirRoot: string;

  beforeEach(async () => {
    dir = await makeVoicesDir();
    dirRoot = path.dirname(dir);
  });

  afterEach(async () => {
    await fs.rm(dirRoot, { recursive: true, force: true });
  });

  it('reads the wav and returns a data:audio/wav;base64,... URL', async () => {
    const result = await readPresetVoice(SAMPLE_VOICE.file, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.dataUrl).toMatch(/^data:audio\/wav;base64,/);
    // Verify the base64 decodes back to the bytes we wrote.
    const b64 = result.dataUrl.slice('data:audio/wav;base64,'.length);
    const decoded = Buffer.from(b64, 'base64');
    expect(decoded.equals(Buffer.from('fake-wav-bytes'))).toBe(true);
  });

  it('handles Chinese characters in file name (round-trips through manifest)', async () => {
    const cn: PresetVoice = {
      ...SAMPLE_VOICE,
      file: 'female_002_活泼开朗年轻女孩语速.wav',
      lang: 'Chinese',
    };
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify([cn]), 'utf8');
    // Re-stub the actual file (makeVoicesDir only stubs SAMPLE_VOICE).
    await fs.writeFile(path.join(dir, cn.file), Buffer.from('cn-bytes'));

    const result = await readPresetVoice(cn.file, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const b64 = result.dataUrl.slice('data:audio/wav;base64,'.length);
    expect(Buffer.from(b64, 'base64').equals(Buffer.from('cn-bytes'))).toBe(true);
  });
});

describe('readPresetVoiceTrimmed', () => {
  let dir: string;
  let dirRoot: string;

  beforeEach(async () => {
    vi.mocked(trimAudio).mockReset();
    dir = await makeVoicesDir();
    dirRoot = path.dirname(dir);
  });

  afterEach(async () => {
    await fs.rm(dirRoot, { recursive: true, force: true });
  });

  it('maxSec=null delegates to readPresetVoice (as-is, no trim)', async () => {
    const r = await readPresetVoiceTrimmed(SAMPLE_VOICE.file, dir, null);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const b64 = r.dataUrl.slice('data:audio/wav;base64,'.length);
    expect(Buffer.from(b64, 'base64').equals(Buffer.from('fake-wav-bytes'))).toBe(true);
    expect(vi.mocked(trimAudio)).not.toHaveBeenCalled();
  });

  it('dur ≤ maxSec reads as-is without trimming', async () => {
    // SAMPLE_VOICE.dur = 3.76 ≤ 5 → 原样读。
    const r = await readPresetVoiceTrimmed(SAMPLE_VOICE.file, dir, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const b64 = r.dataUrl.slice('data:audio/wav;base64,'.length);
    expect(Buffer.from(b64, 'base64').equals(Buffer.from('fake-wav-bytes'))).toBe(true);
    expect(vi.mocked(trimAudio)).not.toHaveBeenCalled();
  });

  it('dur > maxSec trims via trimAudio and returns the trimmed output', async () => {
    // 长音色 9.12s > 5 → 触发 trimAudio；mock 把 trimmed-bytes 写到 out。
    const longVoice: PresetVoice = { ...SAMPLE_VOICE, file: 'long_test.wav', dur: 9.12 };
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify([longVoice]), 'utf8');
    await fs.writeFile(path.join(dir, longVoice.file), Buffer.from('original-long-bytes'));
    vi.mocked(trimAudio).mockImplementation(async (_src, _sec, out) => {
      await fs.writeFile(out, Buffer.from('trimmed-bytes'));
    });

    const r = await readPresetVoiceTrimmed(longVoice.file, dir, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const b64 = r.dataUrl.slice('data:audio/wav;base64,'.length);
    expect(Buffer.from(b64, 'base64').equals(Buffer.from('trimmed-bytes'))).toBe(true);
    // trimAudio 以 (源路径, maxSec=5, 临时路径) 调用一次。
    expect(vi.mocked(trimAudio)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(trimAudio).mock.calls[0];
    expect(call?.[1]).toBe(5);
    expect(String(call?.[0])).toContain(longVoice.file);
  });

  it('trim failure → TRIM_ERROR envelope, never throws', async () => {
    const longVoice: PresetVoice = { ...SAMPLE_VOICE, file: 'long_test.wav', dur: 9.12 };
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify([longVoice]), 'utf8');
    await fs.writeFile(path.join(dir, longVoice.file), Buffer.from('original-long-bytes'));
    vi.mocked(trimAudio).mockRejectedValue(new Error('ffmpeg boom'));

    const r = await readPresetVoiceTrimmed(longVoice.file, dir, 5);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('TRIM_ERROR');
  });

  it('rejects path-traversal file name → INVALID_FILE, no trim', async () => {
    const r = await readPresetVoiceTrimmed('../escape.wav', dir, 5);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('INVALID_FILE');
    expect(vi.mocked(trimAudio)).not.toHaveBeenCalled();
  });

  it('rejects file not in manifest → INVALID_FILE, no trim', async () => {
    const r = await readPresetVoiceTrimmed('female_999_not_in_manifest.wav', dir, 5);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('INVALID_FILE');
    expect(vi.mocked(trimAudio)).not.toHaveBeenCalled();
  });
});
