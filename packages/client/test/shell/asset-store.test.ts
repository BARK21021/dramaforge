// Unit tests for ⑪ client/shell — local asset store (P4 Task 1).
//
// Covers the pure helpers (clipKey / resolveClipUrl / clipsDirFrom /
// parseProtocolUrl) and the downloadAsset function. Style matches
// `render-worker/uploader.test.ts`:
//   - globalThis.fetch is mocked per-test (success / non-2xx / network error /
//     timeout simulation).
//   - real node:fs is used against os.tmpdir() so the write/rename path runs
//     against the actual filesystem (catches mode/perm/stream bugs a mock fs
//     would hide).
//
// What is NOT tested here: protocol.handle (Electron runtime, covered by the
// shell index.test.ts wiring assertion) and the IPC layer (covered by the
// ipcMain.handle count assertion). This file tests the asset-store algorithm
// + path-traversal guards in isolation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLIP_PROTOCOL,
  DOWNLOAD_TIMEOUT_MS,
  clipKey,
  clipsDirFrom,
  resolveClipUrl,
  parseProtocolUrl,
  resolveClipKeyPath,
  downloadAsset,
  saveLocalAsset,
  stageOriginalUploadFromPath,
  readAssetToBaseUrl,
  newClipId,
  parseRange,
  mimeForExt,
} from '../../main/asset-store';

const originalFetch = globalThis.fetch;

/**
 * Make a fake Response whose `.body` is a real ReadableStream over the given
 * bytes — matches what `downloadAsset` consumes via `Readable.fromWeb`.
 */
function makeOkResponse(bytes: Buffer): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, statusText: 'OK' });
}

describe('clipKey / resolveClipUrl / clipsDirFrom', () => {
  it('clipKey appends .mp4 to the clipId', () => {
    expect(clipKey('abc-123')).toBe('abc-123.mp4');
  });

  it('resolveClipUrl produces an sf-asset:// URL', () => {
    expect(resolveClipUrl('abc-123.mp4')).toBe(`${CLIP_PROTOCOL}://abc-123.mp4`);
  });

  it('clipsDirFrom joins userData + clips', () => {
    const dir = clipsDirFrom(path.join(os.tmpdir(), 'userData'));
    expect(dir.endsWith(path.join('userData', 'clips'))).toBe(true);
  });

  it('newClipId returns a 36-char UUID', () => {
    const id = newClipId();
    expect(id).toMatch(/^[a-f0-9-]{36}$/i);
  });
});

describe('parseProtocolUrl', () => {
  const clipsDir = path.join(os.tmpdir(), 'sf-asset-clips');

  it('resolves a bare sf-asset://<clipId>.mp4 to the local file path', () => {
    const url = 'sf-asset://11111111-2222-3333-4444-555555555555.mp4';
    const resolved = parseProtocolUrl(url, clipsDir);
    expect(resolved).toBe(
      path.join(clipsDir, '11111111-2222-3333-4444-555555555555.mp4'),
    );
  });

  it('returns null for a non-sf-asset scheme', () => {
    expect(parseProtocolUrl('https://abc.mp4', clipsDir)).toBeNull();
    expect(parseProtocolUrl('file:///abc.mp4', clipsDir)).toBeNull();
  });

  it('returns null when the URL has a path/query/hash component', () => {
    expect(parseProtocolUrl('sf-asset://abc.mp4/extra', clipsDir)).toBeNull();
    expect(parseProtocolUrl('sf-asset://abc.mp4?q=1', clipsDir)).toBeNull();
    expect(parseProtocolUrl('sf-asset://abc.mp4#h', clipsDir)).toBeNull();
  });

  it('returns null when the key is not a bare <clipId>.mp4 (rejects path traversal)', () => {
    // No .mp4 extension.
    expect(parseProtocolUrl('sf-asset://abc', clipsDir)).toBeNull();
    // Dot-segment traversal attempt.
    expect(parseProtocolUrl('sf-asset://..%2fsecret.mp4', clipsDir)).toBeNull();
    // Slash inside the host (URL parser splits host/path).
    expect(parseProtocolUrl('sf-asset://../secret.mp4', clipsDir)).toBeNull();
    // Non-mp4 extension.
    expect(parseProtocolUrl('sf-asset://abc.txt', clipsDir)).toBeNull();
  });

  it('returns null for an unparseable URL', () => {
    expect(parseProtocolUrl('not-a-url', clipsDir)).toBeNull();
  });
});

describe('resolveClipKeyPath (批8 R3/R4: saveFilm/removeFilm IPC path validation)', () => {
  const clipsDir = path.join(os.tmpdir(), 'sf-asset-clips');

  it('resolves a bare <clipId>.mp4 localKey to the local file path', () => {
    const resolved = resolveClipKeyPath('11111111-2222-3333-4444-555555555555.mp4', clipsDir);
    expect(resolved).toBe(
      path.join(clipsDir, '11111111-2222-3333-4444-555555555555.mp4'),
    );
  });

  it('accepts image extensions (png/jpg/webp)', () => {
    expect(resolveClipKeyPath('abc.png', clipsDir)).toBe(path.join(clipsDir, 'abc.png'));
    expect(resolveClipKeyPath('abc.jpg', clipsDir)).toBe(path.join(clipsDir, 'abc.jpg'));
    expect(resolveClipKeyPath('abc.webp', clipsDir)).toBe(path.join(clipsDir, 'abc.webp'));
  });

  it('returns null for non-string localKey', () => {
    expect(resolveClipKeyPath(null as unknown as string, clipsDir)).toBeNull();
    expect(resolveClipKeyPath(undefined as unknown as string, clipsDir)).toBeNull();
    expect(resolveClipKeyPath(123 as unknown as string, clipsDir)).toBeNull();
  });

  it('returns null when localKey is not bare <clipId>.<ext> (path traversal defense)', () => {
    // No extension.
    expect(resolveClipKeyPath('abc', clipsDir)).toBeNull();
    // Slash (path traversal attempt).
    expect(resolveClipKeyPath('../secret.mp4', clipsDir)).toBeNull();
    expect(resolveClipKeyPath('subdir/abc.mp4', clipsDir)).toBeNull();
    // Dot-segment.
    expect(resolveClipKeyPath('..\\secret.mp4', clipsDir)).toBeNull();
    // Non-allowed extension.
    expect(resolveClipKeyPath('abc.txt', clipsDir)).toBeNull();
    expect(resolveClipKeyPath('abc.exe', clipsDir)).toBeNull();
    // Empty string.
    expect(resolveClipKeyPath('', clipsDir)).toBeNull();
  });
});

describe('downloadAsset', () => {
  let clipsDir: string;

  beforeEach(async () => {
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    clipsDir = path.join(os.tmpdir(), `sf-asset-test-${rand}`, 'clips');
    await fs.mkdir(clipsDir, { recursive: true });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(path.dirname(clipsDir), { recursive: true, force: true });
  });

  it('downloads a 2xx response to <clipsDir>/<clipId>.mp4 and returns the protocol URL', async () => {
    const body = Buffer.from('fake-video-bytes-0123456789');
    const fetchMock = vi.fn(async () => makeOkResponse(body));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const clipId = '11111111-2222-3333-4444-555555555555';
    const result = await downloadAsset('https://ark.example/presigned.mp4', { clipId, clipsDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.key).toBe(`${clipId}.mp4`);
    expect(result.protocolUrl).toBe(`sf-asset://${clipId}.mp4`);
    expect(result.localPath).toBe(path.join(clipsDir, `${clipId}.mp4`));

    // File exists with the expected bytes.
    expect(existsSync(result.localPath)).toBe(true);
    const written = await fs.readFile(result.localPath);
    expect(written.equals(body)).toBe(true);

    // No .tmp file left behind.
    expect(existsSync(`${result.localPath}.tmp`)).toBe(false);

    // Fetch was called with the timeout signal.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns HTTP_ERROR with status on a non-2xx response (does not write the file)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof globalThis.fetch;

    const clipId = '22222222-2222-3333-4444-555555555555';
    const result = await downloadAsset('https://ark.example/expired.mp4', { clipId, clipsDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('HTTP_ERROR');
    expect(result.error.status).toBe(403);
    expect(result.error.message).toMatch(/403/);

    // No file was written.
    expect(existsSync(path.join(clipsDir, `${clipId}.mp4`))).toBe(false);
    expect(existsSync(path.join(clipsDir, `${clipId}.mp4.tmp`))).toBe(false);
  });

  it('returns HTTP_ERROR on a 5xx response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Internal Server Error', { status: 500 }),
    ) as unknown as typeof globalThis.fetch;

    const clipId = '33333333-2222-3333-4444-555555555555';
    const result = await downloadAsset('https://ark.example/oops.mp4', { clipId, clipsDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('HTTP_ERROR');
    expect(result.error.status).toBe(500);
  });

  it('returns TIMEOUT when fetch throws a TimeoutError (simulated 180s expiry)', async () => {
    // Simulate AbortSignal.timeout firing: fetch rejects with a DOMException
    // named 'TimeoutError' (this is what Node's AbortSignal.timeout throws).
    const timeoutErr = Object.assign(new Error('The operation timed out'), {
      name: 'TimeoutError',
    });
    globalThis.fetch = vi.fn(async () => {
      throw timeoutErr;
    }) as unknown as typeof globalThis.fetch;

    const clipId = '44444444-2222-3333-4444-555555555555';
    const result = await downloadAsset('https://ark.example/slow.mp4', { clipId, clipsDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('TIMEOUT');
    expect(result.error.message).toMatch(/timed out/);

    // No partial file.
    expect(existsSync(path.join(clipsDir, `${clipId}.mp4`))).toBe(false);
    expect(existsSync(path.join(clipsDir, `${clipId}.mp4.tmp`))).toBe(false);
  });

  it('returns NETWORK_ERROR when fetch rejects with a generic Error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof globalThis.fetch;

    const clipId = '55555555-2222-3333-4444-555555555555';
    const result = await downloadAsset('https://ark.example/reset.mp4', { clipId, clipsDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('NETWORK_ERROR');
    expect(result.error.message).toMatch(/ECONNRESET/);
  });

  it('returns INVALID_URL for non-http(s) URLs (blocks file:// and local paths)', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const clipId = '66666666-2222-3333-4444-555555555555';
    const result = await downloadAsset('file:///etc/passwd', { clipId, clipsDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns INVALID_URL for a malformed clipId (defends against bad caller input)', async () => {
    const result = await downloadAsset('https://ark.example/x.mp4', {
      clipId: '../escape',
      clipsDir,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_URL');
  });

  it('does not leave a .tmp file when the body stream errors mid-download', async () => {
    // Stream that errors after the first chunk.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error('stream broke'));
      },
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(stream, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const clipId = '77777777-2222-3333-4444-555555555555';
    const result = await downloadAsset('https://ark.example/broken.mp4', { clipId, clipsDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Stream errors surface as WRITE_ERROR (pipeline rejects during write).
    expect(['WRITE_ERROR', 'NETWORK_ERROR']).toContain(result.error.code);

    // Neither final nor .tmp survives.
    expect(existsSync(path.join(clipsDir, `${clipId}.mp4`))).toBe(false);
    expect(existsSync(path.join(clipsDir, `${clipId}.mp4.tmp`))).toBe(false);
  });

  it('DOWNLOAD_TIMEOUT_MS is 180 000 (matches app1 persistVideo VW283)', () => {
    expect(DOWNLOAD_TIMEOUT_MS).toBe(180_000);
  });
});

describe('saveLocalAsset (批2a: renderer bytes → local clips)', () => {
  let clipsDir: string;

  beforeEach(async () => {
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    clipsDir = path.join(os.tmpdir(), `sf-save-test-${rand}`, 'clips');
    await fs.mkdir(clipsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(clipsDir), { recursive: true, force: true });
  });

  const CLIP = '11111111-2222-3333-4444-555555555555';

  it('writes bytes to <clipsDir>/<clipId>.png and returns the protocol URL (default ext)', async () => {
    const bytes = new Uint8Array(Buffer.from('user-picked-image-bytes'));
    const result = await saveLocalAsset(bytes, { clipId: CLIP, clipsDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.key).toBe(`${CLIP}.png`);
    expect(result.protocolUrl).toBe(`sf-asset://${CLIP}.png`);
    expect(result.localPath).toBe(path.join(clipsDir, `${CLIP}.png`));

    expect(existsSync(result.localPath)).toBe(true);
    const written = await fs.readFile(result.localPath);
    expect(written.equals(Buffer.from(bytes))).toBe(true);
    expect(existsSync(`${result.localPath}.tmp`)).toBe(false);
  });

  it('honors an explicit ext (jpeg normalized to jpg)', async () => {
    const result = await saveLocalAsset(new Uint8Array([1, 2, 3]), {
      clipId: CLIP,
      clipsDir,
      ext: 'jpeg',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.key).toBe(`${CLIP}.jpg`);
  });

  it('stores generated dialogue audio as a distinct sf-asset revision', async () => {
    const result = await saveLocalAsset(new Uint8Array([0x49, 0x44, 0x33]), {
      clipId: CLIP,
      clipsDir,
      ext: 'mp3',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.key).toBe(`${CLIP}.mp3`);
    expect(parseProtocolUrl(result.protocolUrl, clipsDir)).toBe(result.localPath);
  });

  it('returns INVALID_INPUT for empty / non-Uint8Array bytes', async () => {
    const empty = await saveLocalAsset(new Uint8Array(0), { clipId: CLIP, clipsDir });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('unreachable');
    expect(empty.error.code).toBe('INVALID_INPUT');

    const bad = await saveLocalAsset('not-bytes' as unknown as Uint8Array, {
      clipId: CLIP,
      clipsDir,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_URL for a malformed clipId (path-traversal defense)', async () => {
    const result = await saveLocalAsset(new Uint8Array([1]), {
      clipId: '../escape',
      clipsDir,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_URL');
  });
});

describe('stageOriginalUploadFromPath (R1: 3GB 流式落地，不缓冲进内存)', () => {
  let base: string;
  let originalUploadsDir: string;
  let srcDir: string;

  beforeEach(async () => {
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    base = path.join(os.tmpdir(), `sf-stage-path-${rand}`);
    originalUploadsDir = path.join(base, 'original-uploads');
    srcDir = path.join(base, 'src');
    await fs.mkdir(originalUploadsDir, { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  const OID = '11111111-2222-3333-4444-555555555555';

  it('stream-copies the source file to <dir>/<id>.mp4 (content + size match, no .tmp leftover)', async () => {
    // R1 的核心保证：用 pipeline(createReadStream, createWriteStream) 而非 writeFile(bytes)，
    // 内存恒定（与文件大小无关）。小文件此处验证 copy 正确性；3GB 不 OOM 是架构保证。
    const payload = Buffer.from('a-simulated-3gb-original-video-payload');
    const srcPath = path.join(srcDir, 'user-pilot.mp4');
    await fs.writeFile(srcPath, payload);

    const result = await stageOriginalUploadFromPath(srcPath, {
      originalId: OID,
      originalUploadsDir,
      ext: 'mp4',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.localPath).toBe(path.join(originalUploadsDir, `${OID}.mp4`));
    expect(result.totalBytes).toBe(payload.length);
    expect(existsSync(result.localPath)).toBe(true);
    const written = await fs.readFile(result.localPath);
    expect(written.equals(payload)).toBe(true);
    expect(existsSync(`${result.localPath}.tmp`)).toBe(false);
  });

  it('accepts mkv/webm/mov (ffmpeg-decodable containers, unlike clips/ image+mp4 subset)', async () => {
    const srcPath = path.join(srcDir, 'clip.mkv');
    await fs.writeFile(srcPath, Buffer.from('mkv-bytes'));
    const result = await stageOriginalUploadFromPath(srcPath, {
      originalId: OID,
      originalUploadsDir,
      ext: 'mkv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.localPath.endsWith(`${OID}.mkv`)).toBe(true);
  });

  it('returns INVALID_INPUT for an empty srcPath', async () => {
    const r = await stageOriginalUploadFromPath('', { originalId: OID, originalUploadsDir, ext: 'mp4' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_URL for a malformed originalId', async () => {
    const srcPath = path.join(srcDir, 'x.mp4');
    await fs.writeFile(srcPath, Buffer.from('x'));
    const r = await stageOriginalUploadFromPath(srcPath, {
      originalId: '../escape',
      originalUploadsDir,
      ext: 'mp4',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('INVALID_URL');
  });

  it('returns INVALID_INPUT for a disallowed ext', async () => {
    const srcPath = path.join(srcDir, 'x.mp4');
    await fs.writeFile(srcPath, Buffer.from('x'));
    const r = await stageOriginalUploadFromPath(srcPath, {
      originalId: OID,
      originalUploadsDir,
      ext: 'avi',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('returns READ_ERROR when the source path does not exist (stat fails)', async () => {
    const r = await stageOriginalUploadFromPath(path.join(srcDir, 'nope.mp4'), {
      originalId: OID,
      originalUploadsDir,
      ext: 'mp4',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('READ_ERROR');
  });
});

describe('readAssetToBaseUrl (批4: 本地 sf-asset:// → base64 data URL)', () => {
  let clipsDir: string;

  beforeEach(async () => {
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    clipsDir = path.join(os.tmpdir(), `sf-read-test-${rand}`, 'clips');
    await fs.mkdir(clipsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(clipsDir), { recursive: true, force: true });
  });

  const CLIP = '11111111-2222-3333-4444-555555555555';

  it('reads a sf-asset:// png file → data:image/png;base64,...', async () => {
    const bytes = Buffer.from('png-bytes');
    await fs.writeFile(path.join(clipsDir, `${CLIP}.png`), bytes);

    const result = await readAssetToBaseUrl(`sf-asset://${CLIP}.png`, clipsDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.dataUrl).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  });

  it('maps jpg/jpeg → image/jpeg', async () => {
    await fs.writeFile(path.join(clipsDir, `${CLIP}.jpg`), Buffer.from('jpg'));
    const r = await readAssetToBaseUrl(`sf-asset://${CLIP}.jpg`, clipsDir);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('maps local mp3 dialogue to an audio data URL for cloud lipsync', async () => {
    const bytes = Buffer.from('mp3-bytes');
    await fs.writeFile(path.join(clipsDir, `${CLIP}.mp3`), bytes);
    const result = await readAssetToBaseUrl(`sf-asset://${CLIP}.mp3`, clipsDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.dataUrl).toBe(`data:audio/mpeg;base64,${bytes.toString('base64')}`);
  });

  it('returns INVALID_URL for non-sf-asset:// / path-traversal URLs', async () => {
    const r1 = await readAssetToBaseUrl('https://evil.com/x.png', clipsDir);
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('unreachable');
    expect(r1.error.code).toBe('INVALID_URL');

    const r2 = await readAssetToBaseUrl('sf-asset://../escape.png', clipsDir);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('unreachable');
    expect(r2.error.code).toBe('INVALID_URL');
  });

  it('returns READ_ERROR when the file does not exist', async () => {
    const result = await readAssetToBaseUrl(`sf-asset://${CLIP}.png`, clipsDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('READ_ERROR');
  });
});

describe('mimeForExt', () => {
  it('maps video/image/audio extensions to MIME types', () => {
    expect(mimeForExt('mp4')).toBe('video/mp4');
    expect(mimeForExt('png')).toBe('image/png');
    expect(mimeForExt('JPG')).toBe('image/jpeg');
    expect(mimeForExt('.webp')).toBe('image/webp');
    expect(mimeForExt('mp3')).toBe('audio/mpeg');
    expect(mimeForExt('m4a')).toBe('audio/mp4');
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(mimeForExt('mov')).toBe('application/octet-stream');
    expect(mimeForExt('')).toBe('application/octet-stream');
  });
});

describe('parseRange', () => {
  // Chromium <video> range shapes the protocol handler must satisfy (#38749 fix).
  const SIZE = 1_000_000;

  it('parses an open-ended range bytes=N-', () => {
    // 最常见：初次加载 + 拖动到中段都发 bytes=N-。
    expect(parseRange('bytes=100-', SIZE)).toEqual({ start: 100, end: SIZE - 1 });
  });

  it('parses a fully bounded range bytes=A-B', () => {
    expect(parseRange('bytes=0-1023', SIZE)).toEqual({ start: 0, end: 1023 });
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range bytes=-K (last K bytes)', () => {
    expect(parseRange('bytes=-500', SIZE)).toEqual({ start: SIZE - 500, end: SIZE - 1 });
  });

  it('clamps end to size-1 when the requested end overruns the file', () => {
    // 客户端按 Content-Length 估的范围可能越界 → 必须钳到 size-1，不能 416 暴毙。
    expect(parseRange('bytes=999900-2000000', SIZE)).toEqual({ start: 999900, end: SIZE - 1 });
  });

  it('returns null for absent / malformed / empty headers (caller serves full 200)', () => {
    expect(parseRange('', SIZE)).toBeNull();
    expect(parseRange('bytes=', SIZE)).toBeNull();
    expect(parseRange('lines=0-99', SIZE)).toBeNull(); // 非 bytes unit
    expect(parseRange('bytes=abc-def', SIZE)).toBeNull();
  });

  it('returns null when the start offset is at/over size (unsatisfiable → 200)', () => {
    expect(parseRange('bytes=1000000-', SIZE)).toBeNull();
    expect(parseRange('bytes=2000000-', SIZE)).toBeNull();
  });

  it('returns null for a zero-byte resource (nothing to range)', () => {
    expect(parseRange('bytes=0-', 0)).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRange('  bytes=0-1023  ', SIZE)).toEqual({ start: 0, end: 1023 });
  });
});
