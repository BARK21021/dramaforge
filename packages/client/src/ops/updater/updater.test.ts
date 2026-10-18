import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startUpdater } from './updater';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { UpdateCheckResponse } from '@dramaforge/shared';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';

function makeJsonResponse(
  body: Partial<UpdateCheckResponse> &
    Pick<UpdateCheckResponse, 'latestVersion' | 'downloadUrl' | 'force'>,
): Response {
  // signature/sha256 默认空串：不关心验签的旧测试无需传，验签测试显式传。
  return new Response(JSON.stringify({ signature: '', sha256: '', ...body }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('startUpdater', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let tmpDirs: string[];

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    tmpDirs = [];
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function makeTmpCacheDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sf-updater-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('performs a check on each interval tick (default 1h) and builds the correct URL', async () => {
    vi.useFakeTimers();
    // No update available (latestVersion == currentVersion) → no download, no
    // fs I/O, so fake timers are safe here.
    fetchMock.mockResolvedValue(
      makeJsonResponse({ latestVersion: '1.0.0', downloadUrl: '', force: false }),
    );

    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir: '/nonexistent/sf-updater-test',
    });

    // No immediate fire — first check is after one full interval.
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/client/update?version=1.0.0&os=win',
    );

    handle.stop();
  });

  it('downloads the new version and notifies via onDownloaded when latestVersion > currentVersion', async () => {
    const cacheDir = await makeTmpCacheDir();
    const payload = 'UPDATE-PAYLOAD-12345';

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '2.0.0',
          downloadUrl: 'https://cdn.example.com/dramaforge-2.0.0.exe',
          force: false,
        });
      }
      return new Response(payload, { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir,
      onDownloaded,
    });

    await handle.checkNow();

    const destPath = join(cacheDir, '2.0.0-update');
    expect(onDownloaded).toHaveBeenCalledTimes(1);
    expect(onDownloaded).toHaveBeenCalledWith({
      version: '2.0.0',
      path: destPath,
      force: false,
    });
    expect(existsSync(destPath)).toBe(true);
    const bytes = await readFile(destPath);
    expect(new TextDecoder().decode(bytes)).toBe(payload);

    handle.stop();
  });

  it('forwards force=true to onDownloaded for a strong restart prompt', async () => {
    const cacheDir = await makeTmpCacheDir();

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '3.0.0',
          downloadUrl: 'https://cdn.example.com/dramaforge-3.0.0.exe',
          force: true,
        });
      }
      return new Response('forced-payload', { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '2.5.0',
      os: 'mac',
      apiBase: 'https://api.example.com',
      cacheDir,
      onDownloaded,
    });

    await handle.checkNow();

    expect(onDownloaded).toHaveBeenCalledTimes(1);
    expect(onDownloaded).toHaveBeenCalledWith({
      version: '3.0.0',
      path: join(cacheDir, '3.0.0-update'),
      force: true,
    });

    handle.stop();
  });

  it('skips download when the version file is already cached', async () => {
    const cacheDir = await makeTmpCacheDir();
    // Pre-create the cached update file so existsSync() short-circuits.
    await writeFile(join(cacheDir, '2.0.0-update'), new Uint8Array([9, 9, 9]));

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '2.0.0',
          downloadUrl: 'https://cdn.example.com/dramaforge-2.0.0.exe',
          force: false,
        });
      }
      return new Response('should-not-be-downloaded', { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'linux',
      apiBase: 'https://api.example.com',
      cacheDir,
      onDownloaded,
    });

    await handle.checkNow();

    // Only the check fetch happened — the download URL was never hit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/client/update?version=1.0.0&os=linux',
    );
    expect(onDownloaded).not.toHaveBeenCalled();

    handle.stop();
  });

  it('swallows network errors without crashing (returns network-error result)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir: '/nonexistent/sf-updater-test',
      onDownloaded,
    });

    // Auto-poll callers ignore the return; manual callers read it to toast.
    // Either way the resilient contract holds: never throws, never calls
    // onDownloaded on a check that did not produce a cached installer.
    const result = await handle.checkNow();
    expect(result.outcome).toBe('network-error');
    expect(onDownloaded).not.toHaveBeenCalled();

    handle.stop();
  });

  it('manual mode returns no-update when latestVersion == currentVersion', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({ latestVersion: '1.0.0', downloadUrl: '', force: false }),
    );

    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir: '/nonexistent/sf-updater-test',
    });

    const result = await handle.checkNow({ manual: true });
    expect(result).toEqual({ outcome: 'no-update', latestVersion: '1.0.0' });

    handle.stop();
  });

  it('manual mode re-fires onDownloaded when new version is already cached (user re-checks after deferring)', async () => {
    const cacheDir = await makeTmpCacheDir();
    // Pre-create the cached update file so existsSync() short-circuits.
    await writeFile(join(cacheDir, '2.0.0-update'), new Uint8Array([9, 9, 9]));

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '2.0.0',
          downloadUrl: 'https://cdn.example.com/dramaforge-2.0.0.exe',
          force: false,
        });
      }
      return new Response('should-not-be-downloaded', { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir,
      onDownloaded,
    });

    const result = await handle.checkNow({ manual: true });

    // Auto mode would silently return without re-prompting; manual mode
    // re-fires onDownloaded so the install dialog shows again.
    expect(result).toEqual({
      outcome: 'update-available',
      latestVersion: '2.0.0',
      downloaded: false,
    });
    expect(onDownloaded).toHaveBeenCalledTimes(1);
    expect(onDownloaded).toHaveBeenCalledWith({
      version: '2.0.0',
      path: join(cacheDir, '2.0.0-update'),
      force: false,
    });

    handle.stop();
  });
});

// ============================================================
// Ed25519 签名验签（防供应链投毒）
// ============================================================
describe('startUpdater — Ed25519 signature verification', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let tmpDirs: string[];

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    tmpDirs = [];
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function makeTmpCacheDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sf-updater-sig-'));
    tmpDirs.push(dir);
    return dir;
  }

  // 测试专用密钥对（每次 run 生成；私钥永不离开测试进程）
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  function signPayload(data: Uint8Array): { signature: string; sha256: string } {
    const sig = sign(null, data, privateKey);
    return {
      signature: sig.toString('base64'),
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }

  it('downloads and notifies when signature verifies OK', async () => {
    const cacheDir = await makeTmpCacheDir();
    const payload = 'SIGNED-PAYLOAD-OK';
    const payloadBytes = new TextEncoder().encode(payload);
    const { signature, sha256 } = signPayload(payloadBytes);

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '2.0.0',
          downloadUrl: 'https://cdn.example.com/x.exe',
          force: false,
          signature,
          sha256,
        });
      }
      return new Response(payload, { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir,
      publicKey: publicKeyB64,
      onDownloaded,
    });
    await handle.checkNow();

    expect(onDownloaded).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cacheDir, '2.0.0-update'))).toBe(true);
    handle.stop();
  });

  it('rejects + deletes cached file when Ed25519 signature is wrong (fail-closed)', async () => {
    const cacheDir = await makeTmpCacheDir();
    const payload = 'TAMPERED-PAYLOAD';
    const payloadBytes = new TextEncoder().encode(payload);
    // sha256 匹配（传输完整），但 signature 是假的 → Ed25519 验不过
    const tamperedSig = Buffer.from('not-a-real-signature').toString('base64');

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '2.0.0',
          downloadUrl: 'https://cdn.example.com/x.exe',
          force: false,
          signature: tamperedSig,
          sha256: createHash('sha256').update(payloadBytes).digest('hex'),
        });
      }
      return new Response(payload, { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir,
      publicKey: publicKeyB64,
      onDownloaded,
    });
    const result = await handle.checkNow();

    expect(result.outcome).toBe('signature-failed');
    expect(onDownloaded).not.toHaveBeenCalled();
    expect(existsSync(join(cacheDir, '2.0.0-update'))).toBe(false); // 缓存已删
    handle.stop();
  });

  it('rejects when server returns no signature (fail-closed, 旧服务器)', async () => {
    const cacheDir = await makeTmpCacheDir();

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '2.0.0',
          downloadUrl: 'https://cdn.example.com/x.exe',
          force: false,
          // 无 signature/sha256（模拟旧服务器）
        });
      }
      return new Response('X', { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir,
      publicKey: publicKeyB64,
      onDownloaded,
    });
    const result = await handle.checkNow();

    expect(result.outcome).toBe('signature-failed');
    expect(onDownloaded).not.toHaveBeenCalled();
    handle.stop();
  });

  it('rejects when sha256 mismatch (传输损坏)', async () => {
    const cacheDir = await makeTmpCacheDir();
    const payload = 'CORRUPTED';
    const payloadBytes = new TextEncoder().encode(payload);
    const { signature } = signPayload(payloadBytes); // 签名对 payload 有效

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '2.0.0',
          downloadUrl: 'https://cdn.example.com/x.exe',
          force: false,
          signature,
          sha256: 'deadbeef'.repeat(8), // sha256 故意不符
        });
      }
      return new Response(payload, { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir,
      publicKey: publicKeyB64,
      onDownloaded,
    });
    const result = await handle.checkNow();

    expect(result.outcome).toBe('signature-failed');
    expect(onDownloaded).not.toHaveBeenCalled();
    handle.stop();
  });

  it('skips verification in dev when no public key configured (向后兼容)', async () => {
    const cacheDir = await makeTmpCacheDir();

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('/api/client/update')) {
        return makeJsonResponse({
          latestVersion: '2.0.0',
          downloadUrl: 'https://cdn.example.com/x.exe',
          force: false,
        });
      }
      return new Response('dev-payload', { status: 200 });
    });

    const onDownloaded = vi.fn();
    const handle = startUpdater({
      currentVersion: '1.0.0',
      os: 'win',
      apiBase: 'https://api.example.com',
      cacheDir, // 无 publicKey = dev，跳过验签
      onDownloaded,
    });
    await handle.checkNow();

    // dev 模式照常通知安装（无签名保护，仅 dev）
    expect(onDownloaded).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
