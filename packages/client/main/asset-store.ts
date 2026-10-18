// ============================================================
// ⑪ client/shell — local asset store (downloads clips to userData/clips)
// ============================================================
//
// P4 Task 1: renderer-side AI generation returns a 1h-expiring ARK presigned
// URL. We persist the video bytes to the user's LOCAL disk (under
// `app.getPath('userData')/clips/<clipId>.mp4`) and serve it back to `<video>`
// via a custom `sf-asset://` protocol. The cloud server NEVER touches media
// bytes (constraint `dramaforge-assets-client-local`).
//
// Why a custom protocol instead of `file://`:
//   The renderer loads an https:// page (your-domain.example.com). Browsers block
//   `file://` sub-resources from https origins (mixed-content + scheme
//   isolation). The renderer also runs sandboxed with no Node fs. All bytes
//   cross the IPC boundary exactly once (download → disk) inside this module
//   (main process), then are re-served by `protocol.handle('sf-asset', ...)`.
//
// Pure / side-effect-free: no electron import — `app.getPath('userData')` is
// injected by the caller. `fetch` is the global (Node 18+ / Electron),
// mockable in tests by reassigning `globalThis.fetch` (same pattern as
// `src/render-worker/uploader.ts`). Unit-tested without any electron mock.
//
// Error model: structured `DownloadAssetResult` — never throws. The IPC
// handler forwards the result envelope directly to the renderer (which toasts
// the error). Main process never crashes on a download failure.

import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { genId, parseUrl } from '@dramaforge/shared';

/** Custom protocol scheme that serves local clips to the renderer's `<video>`. */
export const CLIP_PROTOCOL = 'sf-asset';

/** Download timeout — matches app1 persistVideo (VW283) and chain-generate. */
export const DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * I4 — byte ceilings per asset class. Defends the client disk + memory against
 * a malicious / misbehaving upstream that streams a multi-GB body where a
 * poster was expected. Two layers:
 *   - Content-Length pre-check (rejects before the first byte is written)
 *   - Transform byte counter (rejects when Content-Length is a lie / absent)
 *
 * Images cap at 200 MiB (handles 8K stills with headroom), video at 2 GiB
 * (covers ~10 min 1080p H.264; longer films are segmented shot-by-shot so
 * the per-clip budget stays well under this).
 */
export const IMAGE_MAX_BYTES = 200 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Dialogue/TTS tracks are bounded separately so a malformed response cannot fill disk. */
export const AUDIO_MAX_BYTES = 200 * 1024 * 1024;

/** Image extensions — share the IMAGE_MAX_BYTES budget. */
const IMAGE_EXTS: ReadonlySet<AssetExt> = new Set(['png', 'jpg', 'webp']);
/** Video extensions — share the VIDEO_MAX_BYTES budget. */
const VIDEO_EXTS: ReadonlySet<AssetExt> = new Set(['mp4']);
/** Audio extensions supported by the local dialogue and lipsync workflow. */
const AUDIO_EXTS: ReadonlySet<AssetExt> = new Set(['mp3', 'wav', 'm4a', 'aac']);

/** Resolve the byte ceiling for a given canonical ext (defaults to video). */
function maxBytesForExt(ext: AssetExt): number {
  if (IMAGE_EXTS.has(ext)) return IMAGE_MAX_BYTES;
  if (VIDEO_EXTS.has(ext)) return VIDEO_MAX_BYTES;
  if (AUDIO_EXTS.has(ext)) return AUDIO_MAX_BYTES;
  return VIDEO_MAX_BYTES;
}

/**
 * Structured error codes for download failures.
 * - `INVALID_URL`           — caller passed a non-http(s) URL or a non-string.
 * - `HTTP_ERROR`            — remote returned non-2xx (status captured).
 * - `TIMEOUT`               — fetch aborted after DOWNLOAD_TIMEOUT_MS.
 * - `NETWORK_ERROR`         — fetch rejected (DNS/connection/reset).
 * - `WRITE_ERROR`           — local fs write or rename failed (disk full / perms).
 * - `SIZE_LIMIT_EXCEEDED`   — body exceeded the per-ext byte ceiling (I4).
 */
export type AssetErrorCode =
  | 'INVALID_URL'
  | 'INVALID_INPUT'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'WRITE_ERROR'
  | 'READ_ERROR'
  | 'SIZE_LIMIT_EXCEEDED';

/**
 * Sentinel thrown by the byte-counting Transform when the streaming body
 * crosses the per-ext ceiling. Distinct class so the pipeline catch block can
 * branch on `instanceof` instead of regex-matching message strings.
 */
class SizeLimitError extends Error {
  readonly bytesSeen: number;
  readonly limit: number;
  constructor(bytesSeen: number, limit: number) {
    super(`SIZE_LIMIT_EXCEEDED: ${bytesSeen} > ${limit}`);
    this.name = 'SizeLimitError';
    this.bytesSeen = bytesSeen;
    this.limit = limit;
  }
}

export interface AssetErrorShape {
  code: AssetErrorCode;
  message: string;
  /** HTTP status when `code === 'HTTP_ERROR'`. */
  status?: number;
}

/** Result envelope returned to the renderer. Never throws. */
export type DownloadAssetResult =
  | { ok: true; key: string; protocolUrl: string; localPath: string }
  | { ok: false; error: AssetErrorShape };

/**
 * Extensions allowed for local assets. Enforced by CLIP_KEY_RE on the
 * protocol handler + IPC; downloadAsset infers one of these per URL.
 */
export const ASSET_EXTS = ['mp4', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a', 'aac'] as const;
export type AssetExt = typeof ASSET_EXTS[number];

/**
 * Validate a clip key (clipId + .mp4|image ext). Defends protocol handler +
 * IPC against path-traversal / unknown extensions.
 */
const CLIP_KEY_RE = /^[a-z0-9-]+\.(mp4|png|jpg|jpeg|webp|mp3|wav|m4a|aac)$/i;
/** clipId = UUID v4 (hex+dash). Tighter than CLIP_KEY_RE. */
const CLIP_ID_RE = /^[a-f0-9-]{36}$/i;

/**
 * 批8 R3/R4: 校验 localKey 是 bare `<clipId>.<ext>`（无 slash / `..` / query）并
 * 解析为 `<clipsDir>/<localKey>` 绝对路径。供 IPC saveFilm / removeFilm 复用，
 * 与 protocol.handle 的 parseProtocolUrl 共用 CLIP_KEY_RE 防御。
 *
 * 返 null 表示 localKey 不合法（IPC handler 应返错误结果而非崩溃）。
 */
export function resolveClipKeyPath(localKey: string, clipsDir: string): string | null {
  if (typeof localKey !== 'string' || !CLIP_KEY_RE.test(localKey)) return null;
  const absClipsDir = join(clipsDir, '.'); // normalize trailing sep
  const filePath = join(absClipsDir, localKey);
  // Path-traversal guard: resolved path must start with clipsDir + sep.
  if (!filePath.startsWith(absClipsDir + sep) && filePath !== absClipsDir) {
    return null;
  }
  return filePath;
}

/**
 * Build the clip key from a clipId. The key is the relative path under
 * `userData/clips/` and also the host part of the `sf-asset://` URL.
 * `ext` defaults to `'mp4'` for backward compat with video-only callers.
 * Example: `clipKey('abc')` → `'abc.mp4'`; `clipKey('abc', 'png')` → `'abc.png'`.
 */
export function clipKey(clipId: string, ext: string = 'mp4'): string {
  return `${clipId}.${ext}`;
}

/** True when `e` (case-insensitive) is one of ASSET_EXTS. */
function isAssetExt(e: string): e is AssetExt {
  return (ASSET_EXTS as readonly string[]).includes(e.toLowerCase());
}

/**
 * Normalize a caller-supplied ext to a canonical AssetExt, or null if rejected.
 * - lowercase + strip a leading dot
 * - `jpeg` → `jpg` (canonical)
 * - unknown values → null (so a bad opts.ext can't poison the path; the
 *   inference chain simply falls through to the next priority)
 */
function normalizeExt(e: unknown): AssetExt | null {
  if (typeof e !== 'string') return null;
  const lower = e.toLowerCase().replace(/^\./, '');
  if (lower === 'jpeg') return 'jpg';
  return isAssetExt(lower) ? (lower as AssetExt) : null;
}

/** Map a response Content-Type to an AssetExt, or null if not a known media type. */
function mimeToExt(mime: string | null): AssetExt | null {
  if (!mime) return null;
  const base = mime.split(';')[0].trim().toLowerCase();
  switch (base) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'video/mp4': return 'mp4';
    case 'audio/mpeg': return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav': return 'wav';
    case 'audio/mp4':
    case 'audio/x-m4a': return 'm4a';
    case 'audio/aac': return 'aac';
    default: return null;
  }
}

/** Pull a usable ext from the URL pathname (.png/.jpg/.jpeg/.webp/.mp4). */
function urlExt(rawUrl: string): AssetExt | null {
  try {
    const u = new URL(rawUrl);
    const m = u.pathname.match(/\.(mp4|png|jpe?g|webp|mp3|wav|m4a|aac)$/i);
    if (!m) return null;
    return normalizeExt(m[1]);
  } catch {
    return null;
  }
}

/**
 * Compose the `sf-asset://` URL the renderer's `<video src>` should load.
 * Example: `resolveClipUrl('abc.mp4')` → `'sf-asset://abc.mp4'`.
 */
export function resolveClipUrl(key: string): string {
  return `${CLIP_PROTOCOL}://${key}`;
}

/** `userData/clips` absolute path. Pure: caller passes `userData` in. */
export function clipsDirFrom(userDataDir: string): string {
  return join(userDataDir, 'clips');
}

/** Generate a fresh clipId (UUID v4 via shared util). */
export function newClipId(): string {
  return genId();
}

/**
 * Resolve a `sf-asset://<key>` URL to an absolute local file path, with path
 * traversal defense. Returns null when:
 *   - the URL is not a valid `sf-asset://` URL
 *   - the key is not a bare `<clipId>.mp4` (no slashes, no `..`, no query)
 *   - the resolved path escapes `clipsDir` (paranoid belt-and-braces)
 *
 * Used by the `protocol.handle('sf-asset', ...)` handler in main/index.ts.
 */
export function parseProtocolUrl(url: string, clipsDir: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  if (parsed.protocol !== `${CLIP_PROTOCOL}:`) return null;

  // For a non-standard scheme, WHATWG puts the part after `://` into `host`
  // when it looks like a host (no slashes). `sf-asset://abc.mp4` →
  // host='abc.mp4', pathname='/'. `sf-asset://abc.mp4/x` → host='abc.mp4',
  // pathname='/x'. We only accept the bare-key form.
  const host = parsed.hostname ?? '';
  const path = parsed.pathname ?? '';
  // Reject anything with extra path/query/hash — only `sf-asset://<key>` is allowed.
  if (path !== '' && path !== '/') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (!CLIP_KEY_RE.test(host)) return null;

  const absClipsDir = join(clipsDir, '.'); // normalize trailing sep
  const filePath = join(absClipsDir, host);
  // Path-traversal guard: resolved path must start with clipsDir + sep.
  if (!filePath.startsWith(absClipsDir + sep) && filePath !== absClipsDir) {
    return null;
  }
  return filePath;
}

/**
 * Map a clip file extension to its MIME type for the `sf-asset://` protocol
 * handler. Chromium's media pipeline needs an explicit `Content-Type` to route
 * a response to the right decoder; without it `<video>` over a custom scheme
 * refuses to play (the bytes download fine, but playback stays black).
 */
const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

/** MIME for a clip extension (lowercased, leading dot tolerated); unknown → octet-stream. */
export function mimeForExt(ext: string): string {
  const key = (ext ?? '').toLowerCase().replace(/^\./, '');
  return MIME_BY_EXT[key] ?? 'application/octet-stream';
}

/**
 * Parse an HTTP `Range` header against a known resource size, for the manual
 * `206 Partial Content` path in `registerAssetProtocol`.
 *
 * Chromium's `<video>` issues byte-range requests (`bytes=N-`, `bytes=A-B`, or
 * a suffix `bytes=-K`) to stream + seek media. The old `net.fetch(file://)`
 * handler ignored these and always returned `200` with the whole body — short
 * clips buffered by luck, but anything longer or any seek came back black
 * (Electron #38749). This parser turns a satisfiable range into inclusive
 * `{ start, end }` byte offsets; anything absent/malformed/unsatisfiable →
 * `null` (caller then serves a full `200`).
 */
export function parseRange(
  rangeHeader: string,
  size: number,
): { start: number; end: number } | null {
  if (typeof rangeHeader !== 'string' || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  let start: number;
  let end: number;
  if (startRaw === '') {
    // Suffix range `bytes=-K` → last K bytes.
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    if (!Number.isFinite(start) || start < 0 || start >= size) return null;
    end = endRaw === '' ? size - 1 : Number.parseInt(endRaw, 10);
  }
  if (!Number.isFinite(end)) return null;
  if (end >= size) end = size - 1;
  if (end < start) return null;
  return { start, end };
}

/** Validate that a URL string is a remote http(s) URL (renderer must not pass
 * `file://` or local paths — those are blocked at fetch time anyway).
 */
function isRemoteUrl(s: string): boolean {
  const u = parseUrl(s);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
}

/**
 * Download `url` to `<clipsDir>/<clipId>.<ext>` atomically.
 *
 * Writes to `<clipId>.<ext>.tmp` first, then renames — a partial download never
 * appears under the final name (so the protocol handler never serves a
 * truncated file). The tmp file is cleaned up on any failure.
 *
 * Extension inference priority:
 *   1. `opts.ext`           — caller override (validated against ASSET_EXTS)
 *   2. URL pathname suffix  — `.mp4`/`.png`/`.jpg`/`.jpeg`/`.webp`
 *   3. response Content-Type — `image/png`→png, `image/jpeg`→jpg,
 *      `image/webp`→webp, `video/mp4`→mp4
 *   4. `'mp4'` (default — preserves prior video-only behavior)
 *
 * @param url      remote https URL (e.g. ARK 1h presigned)
 * @param opts     { clipId, clipsDir, ext? }
 * @returns discriminated union — success with key/protocolUrl/localPath, or
 *          failure with structured error. Never throws.
 */
export async function downloadAsset(
  url: string,
  opts: { clipId: string; clipsDir: string; ext?: string },
): Promise<DownloadAssetResult> {
  const { clipId, clipsDir } = opts;

  // Validate inputs BEFORE touching the network or disk.
  if (typeof url !== 'string' || !isRemoteUrl(url)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: `downloadAsset: URL must be http(s), got: ${typeof url === 'string' ? url : '<non-string>'}`,
      },
    };
  }
  if (!CLIP_ID_RE.test(clipId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: `downloadAsset: clipId must be a UUID, got: ${clipId}`,
      },
    };
  }

  // --- Ext inference (pre-fetch stage). ---
  // Priority: opts.ext > URL suffix > Content-Type (resolved post-fetch) > 'mp4'.
  // normalizeExt rejects unknown values so a bad opts.ext can't poison the
  // path — the chain simply falls through to the next priority.
  const explicitExt = normalizeExt(opts.ext);
  const urlInferred = urlExt(url);

  // Fetch with timeout. AbortSignal.timeout throws DOMException 'TimeoutError'
  // (name) on expiry — we detect that and return TIMEOUT. Any other fetch
  // rejection is NETWORK_ERROR.
  let res: Response;
  try {
    res = await globalThis.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: isAbortTimeout(err) ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: `downloadAsset: ${isAbortTimeout(err) ? 'timed out' : 'network error'} fetching ${url}: ${stringifyErr(err)}`,
      },
    };
  }
  if (!res.ok || !res.body) {
    return {
      ok: false,
      error: {
        code: 'HTTP_ERROR',
        status: res.status,
        message: `downloadAsset: HTTP ${res.status} ${res.statusText} (${url})`,
      },
    };
  }

  // --- Ext inference (final stage): fall back to Content-Type, then 'mp4'. ---
  // The default 'mp4' preserves the prior video-only behavior when the caller
  // passes no opts.ext AND the URL has no recognizable suffix AND there's no
  // useful Content-Type (e.g. ARK presigned URLs sometimes return binary).
  const ext: AssetExt =
    explicitExt ?? urlInferred ?? mimeToExt(res.headers.get('content-type')) ?? 'mp4';

  const key = clipKey(clipId, ext);
  const finalPath = join(clipsDir, key);
  const tmpPath = `${finalPath}.tmp`;
  const protocolUrl = resolveClipUrl(key);

  // --- I4: byte ceiling (Content-Length pre-check, fast reject). ---
  // If the upstream honestly declares a size and it already exceeds the
  // per-ext budget, refuse before touching disk. The streaming Transform
  // below is the second layer for when Content-Length is absent or a lie.
  const maxBytes = maxBytesForExt(ext);
  const declaredSizeRaw = res.headers.get('content-length');
  const declaredSize =
    declaredSizeRaw !== null ? Number.parseInt(declaredSizeRaw, 10) : Number.NaN;
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    return {
      ok: false,
      error: {
        code: 'SIZE_LIMIT_EXCEEDED',
        message: `downloadAsset: content-length ${declaredSize} exceeds ${ext} limit ${maxBytes} bytes (${url})`,
      },
    };
  }

  // Ensure clips dir exists. Then stream the response body to .tmp.
  try {
    await mkdir(dirname(finalPath), { recursive: true });
    const webStream = res.body;
    // I4 second layer: Transform that tallies bytes flowing through and
    // rejects (SizeLimitError) when the running total crosses maxBytes.
    // pipeline() propagates the rejection → outer catch cleans up the .tmp.
    let bytesSeen = 0;
    const byteCounter = new Transform({
      transform(chunk, _enc, cb) {
        bytesSeen += chunk.length;
        if (bytesSeen > maxBytes) {
          cb(new SizeLimitError(bytesSeen, maxBytes));
        } else {
          cb(null, chunk);
        }
      },
    });
    // web ReadableStream → Node Readable. pipeline() propagates backpressure
    // and rejects on any stream error (network reset mid-download included).
    await pipeline(
      Readable.fromWeb(webStream as unknown as Parameters<typeof Readable.fromWeb>[0]),
      byteCounter,
      createWriteStream(tmpPath),
    );
  } catch (err) {
    await safeRm(tmpPath);
    if (err instanceof SizeLimitError) {
      return {
        ok: false,
        error: {
          code: 'SIZE_LIMIT_EXCEEDED',
          message: `downloadAsset: body exceeded ${ext} limit ${maxBytes} bytes after ${err.bytesSeen} bytes (${url})`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: isAbortTimeout(err) ? 'TIMEOUT' : 'WRITE_ERROR',
        message: `downloadAsset: write failed for ${key}: ${stringifyErr(err)}`,
      },
    };
  }

  // Atomic rename .tmp → final.
  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    await safeRm(tmpPath);
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `downloadAsset: rename failed for ${key}: ${stringifyErr(err)}`,
      },
    };
  }

  return { ok: true, key, protocolUrl, localPath: finalPath };
}

/**
 * Save caller-supplied bytes (a user-picked File's arrayBuffer, or a cloud-AI
 * result re-landed by the renderer) to `<clipsDir>/<clipId>.<ext>` atomically.
 *
 * The C/S inverse of `downloadAsset`: instead of fetching a remote URL, the
 * renderer hands local bytes (e.g. `<input type=file>` → `File.arrayBuffer()`)
 * across the IPC boundary once; the cloud server only ever sees the resulting
 * `sf-asset://` key string (constraint `dramaforge-assets-client-local` — server
 * holds zero media bytes).
 *
 * Writes to `<clipId>.<ext>.tmp` first, then renames — a partial write never
 * appears under the final name (same atomic discipline as `downloadAsset`).
 *
 * @param bytes   non-empty Uint8Array (renderer's File bytes; Buffer also OK)
 * @param opts    { clipId: UUID, clipsDir, ext?: AssetExt (default 'png') }
 * @returns discriminated union — same shape as `downloadAsset`. Never throws.
 */
export async function saveLocalAsset(
  bytes: Uint8Array,
  opts: { clipId: string; clipsDir: string; ext?: string },
): Promise<DownloadAssetResult> {
  const { clipId, clipsDir } = opts;

  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'saveLocalAsset: bytes must be a non-empty Uint8Array',
      },
    };
  }
  if (!CLIP_ID_RE.test(clipId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: `saveLocalAsset: clipId must be a UUID, got: ${clipId}`,
      },
    };
  }

  // ext defaults to 'png' (image-upload is the primary use case; the cloud
  // generate-image results that re-land here are also images). normalizeExt
  // rejects unknown values so a bad opts.ext can't poison the path.
  const ext: AssetExt = normalizeExt(opts.ext) ?? 'png';
  const maxBytes = maxBytesForExt(ext);
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      error: {
        code: 'SIZE_LIMIT_EXCEEDED',
        message: `saveLocalAsset: ${bytes.length} bytes exceeds ${ext} limit ${maxBytes}`,
      },
    };
  }

  const key = clipKey(clipId, ext);
  const finalPath = join(clipsDir, key);
  const tmpPath = `${finalPath}.tmp`;
  const protocolUrl = resolveClipUrl(key);

  try {
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, finalPath);
  } catch (err) {
    await safeRm(tmpPath);
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `saveLocalAsset: write failed for ${key}: ${stringifyErr(err)}`,
      },
    };
  }

  return { ok: true, key, protocolUrl, localPath: finalPath };
}

/**
 * Copy a local `sf-asset://` asset file to a fresh key（季继承：把源季图复制成
 * 目标季新 key）。Same-machine `copyFile`, zero network. The source file must
 * already exist under `clipsDir` (otherwise READ_ERROR — e.g. source asset was
 * generated on another machine; 季继承前提是同机).
 *
 * @param srcProtocolUrl  `sf-asset://<clipId>.<ext>` (validated via parseProtocolUrl)
 * @param opts            { clipsDir, destClipId: UUID }
 * @returns same envelope as `saveLocalAsset`. Never throws.
 */
export async function copyLocalAsset(
  srcProtocolUrl: string,
  opts: { clipsDir: string; destClipId: string },
): Promise<DownloadAssetResult> {
  const srcPath = parseProtocolUrl(srcProtocolUrl, opts.clipsDir);
  if (!srcPath) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: `copyLocalAsset: not a valid sf-asset:// URL: ${srcProtocolUrl}`,
      },
    };
  }
  if (!CLIP_ID_RE.test(opts.destClipId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: `copyLocalAsset: destClipId must be a UUID, got: ${opts.destClipId}`,
      },
    };
  }
  // 保留源文件扩展名（normalizeExt 拒未知值，回落 png）。
  const srcExt = srcPath.split('.').pop()?.toLowerCase() ?? '';
  const ext: AssetExt = normalizeExt(srcExt) ?? 'png';
  const key = clipKey(opts.destClipId, ext);
  const finalPath = join(opts.clipsDir, key);
  const tmpPath = `${finalPath}.tmp`;
  try {
    await mkdir(dirname(finalPath), { recursive: true });
    await copyFile(srcPath, tmpPath);
    await rename(tmpPath, finalPath);
  } catch (err) {
    await safeRm(tmpPath);
    const isNotFound = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    return {
      ok: false,
      error: {
        code: isNotFound ? 'READ_ERROR' : 'WRITE_ERROR',
        message: `copyLocalAsset: ${isNotFound ? 'source not found' : 'copy failed'} for ${srcProtocolUrl}: ${stringifyErr(err)}`,
      },
    };
  }
  return { ok: true, key, protocolUrl: resolveClipUrl(key), localPath: finalPath };
}

/** Result of readAssetToBaseUrl — base64 data URL for cloud AI i2i, or error. */
export type ReadAssetResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: AssetErrorShape };

// ============================================================
// 转绘 X3.7 — original-uploads（整剧重写原视频本地落地）
// ============================================================

/**
 * 转绘 X3.7: 3GB 整剧视频允许的封装格式（对齐 OriginalRewriteStage.tsx
 * ALLOWED_EXTENSIONS = ['.mp4','.webm','.mov','.mkv']）。注意与 clips/ 的
 * ASSET_EXTS（仅 mp4 + 图像）不同——original-uploads 不走 sf-asset://
 * 协议，只供本地 ffmpeg 直接读路径切片，故放行更多封装。
 */
export const ORIGINAL_UPLOAD_EXTS = ['mp4', 'webm', 'mov', 'mkv'] as const;
export type OriginalUploadExt = typeof ORIGINAL_UPLOAD_EXTS[number];

/**
 * 3GB 整剧视频字节上限（对齐 OriginalRewriteStage MAX_BYTES = 3 GiB）。
 * 与 VIDEO_MAX_BYTES（2 GiB，clips/ 用）不同：整剧重写源视频天然更大。
 */
export const ORIGINAL_UPLOAD_MAX_BYTES = 3 * 1024 * 1024 * 1024;

/** `userData/original-uploads` 绝对路径。Pure: 由调用方传入 userData。 */
export function originalUploadsDirFrom(userDataDir: string): string {
  return join(userDataDir, 'original-uploads');
}

/** True 当 `e`（大小写不敏感）属于 ORIGINAL_UPLOAD_EXTS 之一。 */
function isOriginalUploadExt(e: string): e is OriginalUploadExt {
  return (ORIGINAL_UPLOAD_EXTS as readonly string[]).includes(e.toLowerCase());
}

/**
 * 把调用方传入的扩展名规范成 OriginalUploadExt，或 null（拒绝）。
 * - 小写化 + 去掉前导点
 * - 未知值 → null（坏的 ext 不能污染路径，直接返 null 让 IPC handler 报错）
 */
function normalizeOriginalExt(e: unknown): OriginalUploadExt | null {
  if (typeof e !== 'string') return null;
  const lower = e.toLowerCase().replace(/^\./, '');
  return isOriginalUploadExt(lower) ? (lower as OriginalUploadExt) : null;
}

/** 转绘 X3.7 stageOriginalUpload 的结果 envelope（永不抛错）。 */
export type StageOriginalUploadResult =
  | { ok: true; localPath: string; totalBytes: number }
  | { ok: false; error: AssetErrorShape };

/**
 * 把 renderer 传入的整剧视频字节（File.arrayBuffer()）原子落到
 * `<originalUploadsDir>/<originalId>.<ext>`。
 *
 * 与 `saveLocalAsset` 同构：写 `.tmp` 再 rename，partial write 永不暴露在
 * 最终名下。服务器零字节（dramaforge-assets-client-local）；返回的 `localPath`
 * 是绝对路径，后续 render-worker 的 ffmpeg.splitVideoEvenly 直接读它切片。
 *
 * 与 clips/ saveLocalAsset 的关键差异：
 *   - 放行 mp4/webm/mov/mkv（ffmpeg 可解的封装），不是 clips/ 的图像+mp4 子集。
 *   - 不返 protocolUrl——original-uploads 不挂 sf-asset://（renderer 不直接播
 *     这个 3GB 源视频，只把绝对路径作元数据 POST 给服务器）。
 *   - 上限 3 GiB（对齐 OriginalRewriteStage MAX_BYTES），高于 clips/ 的 2 GiB。
 *
 * @param bytes  非空 Uint8Array（renderer File bytes；Buffer 也 OK）
 * @param opts   { originalId: UUID, originalUploadsDir, ext: 'mp4'|'webm'|'mov'|'mkv' }
 * @returns discriminated union — 成功返 localPath + totalBytes，失败返结构化
 *          error。永不抛错。
 */
export async function stageOriginalUpload(
  bytes: Uint8Array,
  opts: { originalId: string; originalUploadsDir: string; ext: string },
): Promise<StageOriginalUploadResult> {
  const { originalId, originalUploadsDir } = opts;

  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'stageOriginalUpload: bytes must be a non-empty Uint8Array',
      },
    };
  }
  if (!CLIP_ID_RE.test(originalId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: `stageOriginalUpload: originalId must be a UUID, got: ${originalId}`,
      },
    };
  }
  const ext: OriginalUploadExt | null = normalizeOriginalExt(opts.ext);
  if (ext === null) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `stageOriginalUpload: ext must be one of ${ORIGINAL_UPLOAD_EXTS.join('|')}, got: ${String(opts.ext)}`,
      },
    };
  }
  if (bytes.length > ORIGINAL_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: 'SIZE_LIMIT_EXCEEDED',
        message: `stageOriginalUpload: ${bytes.length} bytes exceeds 3 GiB limit (${ORIGINAL_UPLOAD_MAX_BYTES})`,
      },
    };
  }

  const key = `${originalId}.${ext}`;
  const finalPath = join(originalUploadsDir, key);
  const tmpPath = `${finalPath}.tmp`;

  try {
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, finalPath);
  } catch (err) {
    await safeRm(tmpPath);
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `stageOriginalUpload: write failed for ${key}: ${stringifyErr(err)}`,
      },
    };
  }

  return { ok: true, localPath: finalPath, totalBytes: bytes.length };
}

/**
 * 流式落地变体（修 stageOriginalUpload 的 3GB OOM 根因）：从 renderer 解析出的
 * 源文件**绝对路径**直接 `pipeline(createReadStream, createWriteStream)` 边读边写，
 * **绝不把整段 ≤3GB 视频读进 main 进程内存**。
 *
 * 旧路径在 IPC handler 里 `await file.arrayBuffer()` 把整块字节灌进 V8 堆 → 撞
 * ArrayBuffer 单分配上限 / IPC 结构化克隆上限 → READ_ERROR → 前端"本地暂存视频失败"。
 * 图片链没事（~5MiB），唯独这条 3GB 原视频链是整块缓冲——本变体与 downloadAsset
 * 的流式 `pipeline` 写法一致，内存占用恒定（仅流缓冲，与文件大小无关）。
 *
 * 安全：`srcPath` 必为 renderer `<input type=file>` 经 `webUtils.getPathForFile`
 * 解析出的真实路径——preload 强制派生，renderer（contextIsolation）无法注入任意路径。
 * 拷贝到 original-uploads 与旧路径行为等价（用户自己选的文件，非提权）。
 *
 * @param srcPath  renderer File 的磁盘绝对路径（webUtils.getPathForFile）
 * @param opts     { originalId: UUID, originalUploadsDir, ext: 'mp4'|'webm'|'mov'|'mkv' }
 * @returns 同 stageOriginalUpload envelope。永不抛错。
 */
export async function stageOriginalUploadFromPath(
  srcPath: string,
  opts: { originalId: string; originalUploadsDir: string; ext: string },
): Promise<StageOriginalUploadResult> {
  const { originalId, originalUploadsDir } = opts;

  if (typeof srcPath !== 'string' || srcPath.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'stageOriginalUploadFromPath: srcPath must be a non-empty string',
      },
    };
  }
  if (!CLIP_ID_RE.test(originalId)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: `stageOriginalUploadFromPath: originalId must be a UUID, got: ${originalId}`,
      },
    };
  }
  const ext: OriginalUploadExt | null = normalizeOriginalExt(opts.ext);
  if (ext === null) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `stageOriginalUploadFromPath: ext must be one of ${ORIGINAL_UPLOAD_EXTS.join('|')}, got: ${String(opts.ext)}`,
      },
    };
  }

  // 先 stat 源文件拿大小——超 3GB 直接拒，不浪费一次流式 copy（快失败）。
  let totalBytes: number;
  try {
    totalBytes = (await stat(srcPath)).size;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'READ_ERROR',
        message: `stageOriginalUploadFromPath: stat failed for ${srcPath}: ${stringifyErr(err)}`,
      },
    };
  }
  if (totalBytes <= 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `stageOriginalUploadFromPath: source file is empty: ${srcPath}`,
      },
    };
  }
  if (totalBytes > ORIGINAL_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: 'SIZE_LIMIT_EXCEEDED',
        message: `stageOriginalUploadFromPath: ${totalBytes} bytes exceeds 3 GiB limit (${ORIGINAL_UPLOAD_MAX_BYTES})`,
      },
    };
  }

  const key = `${originalId}.${ext}`;
  const finalPath = join(originalUploadsDir, key);
  const tmpPath = `${finalPath}.tmp`;

  try {
    await mkdir(dirname(finalPath), { recursive: true });
    // 流式 copy：createReadStream → createWriteStream，内存恒定（流缓冲级），
    // 不再吃 3GB V8 堆。pipeline 传播背压与错误（中途磁盘满/读失败→reject）。
    await pipeline(createReadStream(srcPath), createWriteStream(tmpPath));
    await rename(tmpPath, finalPath);
  } catch (err) {
    await safeRm(tmpPath);
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `stageOriginalUploadFromPath: stream/copy failed for ${key}: ${stringifyErr(err)}`,
      },
    };
  }

  return { ok: true, localPath: finalPath, totalBytes };
}

/**
 * Read a local `sf-asset://<clipId>.<ext>` file back into a base64 `data:` URL —
 * the C/S seam for cloud AI image-to-image (costume variants, pencil repaint):
 * the cloud ARK/ComfyUI gateway can't fetch a client-local `sf-asset://` URL,
 * so the renderer reads the bytes here (over IPC, once) and POSTs them as a
 * `data:` URL the gateway passes straight through (`ensureAccessibleUrl`
 * accepts `data:`). The server still holds zero media bytes.
 *
 * @param protocolUrl  `sf-asset://<clipId>.<ext>` (validated via parseProtocolUrl)
 * @param clipsDir     userData/clips absolute path
 * @returns { ok:true, dataUrl } or { ok:false, error }. Never throws.
 */
export async function readAssetToBaseUrl(
  protocolUrl: string,
  clipsDir: string,
): Promise<ReadAssetResult> {
  const filePath = parseProtocolUrl(protocolUrl, clipsDir);
  if (!filePath) {
    return {
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: `readAssetToBaseUrl: not a valid sf-asset:// URL: ${protocolUrl}`,
      },
    };
  }
  try {
    const bytes = await readFile(filePath);
    const ext = filePath.split('.').pop()?.toLowerCase();
    const mime =
      ext === 'png' ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp'
      : ext === 'mp4' ? 'video/mp4'
      : ext === 'mp3' ? 'audio/mpeg'
      : ext === 'wav' ? 'audio/wav'
      : ext === 'm4a' ? 'audio/mp4'
      : ext === 'aac' ? 'audio/aac'
      : 'application/octet-stream';
    return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'READ_ERROR',
        message: `readAssetToBaseUrl: read failed for ${protocolUrl}: ${stringifyErr(err)}`,
      },
    };
  }
}

/** True when the thrown value is an AbortError triggered by AbortSignal.timeout. */
function isAbortTimeout(err: unknown): boolean {
  if (err instanceof Error) {
    const name = (err as Error & { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') return true;
  }
  // DOMException surfaces across the fetch boundary with name in `cause`.
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error) {
    const cname = (cause as Error & { name?: string }).name;
    if (cname === 'TimeoutError' || cname === 'AbortError') return true;
  }
  return false;
}

/** Render any thrown value into a single-line string for error messages. */
function stringifyErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Best-effort cleanup; never throws. */
async function safeRm(p: string): Promise<void> {
  try {
    await rm(p, { force: true });
  } catch {
    /* swallow — we're already in an error path */
  }
}
