// ============================================================
// ⑧ client/ffmpeg — FFmpeg pipeline (migrated from app1 core/video/ffmpeg-pipeline.ts)
// ============================================================
//
// ffmpeg runs LOCALLY on the user's machine (Electron client), NEVER on the
// server. The server is forbidden from importing this module.
//
// Migration notes vs app1:
//   - Binary resolution: use @ffmpeg-installer/ffmpeg (npm-managed, cross-machine)
//     instead of the repo-bundled videostylization/whisper/ffmpeg.exe.
//   - fluent-ffmpeg is configured with the installer path (setFfmpegPath) so any
//     client code using fluent-ffmpeg's API runs the bundled binary. The
//     operations here use execFile with explicit args (matches app1's proven
//     argv exactly and avoids fluent-ffmpeg option-ordering pitfalls).
//   - Duration probing uses `ffmpeg -i` + stderr parsing: @ffmpeg-installer/ffmpeg
//     ships only the ffmpeg binary (no ffprobe), so we cannot use ffprobe.
//   - Server storage-factory dependency STRIPPED: resolveStorageUrl is now a
//     no-op pass-through. On the client, clip URLs are already absolute (MinIO
//     presigned URLs from the render-worker, or local file paths). Upload is
//     handled by the render-worker via MinIO presigned URLs, not here.
//   - dedupClipsByUrl dropped (not in the required client API; URL dedup is
//     trivially done by callers with a Set if needed).
// ============================================================

import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { parseUrl } from '@dramaforge/shared';
import {
  fetchWithAbortTimeout,
  throwIfAborted,
  withAbortableRetry,
} from '../abort';

const execFileAsync = promisify(execFile);

/** Path to the bundled ffmpeg binary (from @ffmpeg-installer/ffmpeg). */
const FFMPEG_PATH: string = ffmpegInstaller.path.includes('app.asar') && !ffmpegInstaller.path.includes('app.asar.unpacked')
  ? ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked')
  : ffmpegInstaller.path;

/** Default timeout for ffmpeg subprocesses (ms). */
const FFMPEG_TIMEOUT_MS = 300_000;

// ============================================================
// Types
// ============================================================

/** A clip to concatenate: a URL or local path, with an optional duration hint. */
export interface ConcatClip {
  url: string;
  durationSec?: number;
}

// ============================================================
// Binary path
// ============================================================

/** Returns the path to the ffmpeg binary used by this module. */
export function getFfmpegPath(): string {
  return FFMPEG_PATH;
}

// ============================================================
// URL handling (server storage-factory stripped)
// ============================================================

/**
 * No-op pass-through. On the client, clip URLs are already absolute (MinIO
 * presigned URLs or local file paths), so no server-side base-URL resolution
 * is needed. Kept for API compatibility with migrated callers; returns the
 * URL unchanged.
 *
 * (app1's version prepended NEXT_PUBLIC_BASE_URL / NEXTAUTH_URL for relative
 * paths — that was a server-side concern and is stripped here.)
 */
export function resolveStorageUrl(url: string): string {
  return url;
}

/** True if `s` is a remote http(s) URL (vs a local file path). */
function isRemoteUrl(s: string): boolean {
  const u = parseUrl(s);
  return u !== null && (u.protocol === 'http:' || u.protocol === 'https:');
}

// ============================================================
// Duration probing (ffmpeg -i, no ffprobe binary needed)
// ============================================================

/**
 * Probe video duration using `ffmpeg -i <url>` and parsing the
 * `Duration: HH:MM:SS.ss` line from stderr.
 *
 * We use ffmpeg rather than ffprobe because @ffmpeg-installer/ffmpeg ships
 * only the ffmpeg binary. `ffmpeg -i <input>` (no output) exits non-zero but
 * prints input metadata (incl. Duration) to stderr.
 *
 * @param url - video URL or local file path
 * @returns duration in seconds, or 0 if it cannot be determined
 */
export async function getVideoDuration(
  url: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  try {
    await execFileAsync(FFMPEG_PATH, ['-i', url], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      signal,
    });
  } catch (err) {
    // 取消必须原样向上传播，不能被“探测失败返回 0”的兼容逻辑吞掉。
    throwIfAborted(signal);
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const sec = parseFloat(m[3]);
      return h * 3600 + min * 60 + sec;
    }
  }
  return 0;
}

// ============================================================
// Resolution probe + downscale（视频转剧本上传前强制降到 480p）
// ============================================================

/**
 * Probe 视频流高度（像素），复用 `ffmpeg -i` stderr 解析法（@ffmpeg-installer
 * 不带 ffprobe）。stderr 的 Video 行形如：
 *   `Stream #0:0(...): Video: h264 ..., 1920x1080 ..., ...`
 * 取该行第一个 `WxH` 的高度。解析失败返 0（调用方据此决定是否需要降分辨率）。
 *
 * @param url - video URL 或本地文件路径
 * @returns 视频高度（像素），无法解析返 0
 */
export async function probeVideoHeight(
  url: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  try {
    await execFileAsync(FFMPEG_PATH, ['-i', url], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      signal,
    });
  } catch (err) {
    // `ffmpeg -i`（无输出）非零退出但把输入元数据打到 stderr；取消必须原样上抛。
    throwIfAborted(signal);
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const videoLine = stderr.split('\n').find((l) => /Video:/i.test(l));
    if (videoLine) {
      const m = videoLine.match(/(\d{2,5})x(\d{2,5})/);
      if (m) return parseInt(m[2], 10);
    }
  }
  return 0;
}

/**
 * 把视频重编码到目标高度（保比例、偶数宽），输出 H.264/AAC mp4。
 *
 * 用于视频转剧本上传前强制降到 480p：Kimi 官方文档「>1080p 不提升理解、只多耗
 * token 和时间」，480p 是省 token / 提速的纯收益。调用方应先 `probeVideoHeight`
 * 判断是否 > 目标高度，再决定是否调用本函数（避免对已达标视频做无谓重编码）。
 *
 * `-vf scale=-2:<H>`：高度锁定 H，宽度按比例自适应并取偶数（libx264 要求偶数）。
 *
 * @param inputPath    输入本地文件路径
 * @param outPath      输出 mp4 路径（调用方负责唯一命名 + 清理）
 * @param targetHeight 目标高度，默认 480
 * @throws ffmpeg 非零退出时抛错（调用方映射为 IPC 失败）
 */
export async function downscaleVideoToHeight(
  inputPath: string,
  outPath: string,
  targetHeight = 480,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const args = [
    '-y',
    '-i', inputPath,
    '-vf', `scale=-2:${targetHeight}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outPath,
  ];
  await execFileAsync(FFMPEG_PATH, args, {
    timeout: FFMPEG_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    signal,
  });
}

// ============================================================
// Clip download
// ============================================================

/**
 * Download clips by URL to local files in `dir`.
 *
 * Remote http(s) URLs are fetched (with retry + exponential backoff) and
 * written to `dir`. Local file paths are returned unchanged (must already
 * exist). Returns local file paths in the same order as `urls`.
 *
 * @param urls - clip URLs (remote) or local file paths
 * @param dir - destination directory for downloaded files (created if missing)
 * @returns local file paths, one per url, in input order
 */
export async function downloadClips(
  urls: string[],
  dir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  if (urls.length === 0) return [];
  await fs.mkdir(dir, { recursive: true });

  const results: string[] = new Array(urls.length).fill('');
  const queue = urls.map((url, idx) => ({ url, idx }));
  const concurrency = Math.min(8, urls.length);
  const workers: Promise<void>[] = [];

  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          throwIfAborted(signal);
          const item = queue.shift();
          if (!item) break;
          const { url, idx } = item;
          results[idx] = await withAbortableRetry(
            async () => downloadSingle(url, dir, signal),
            { tries: 5, backoffMs: 1000 },
            signal,
          );
        }
      })(),
    );
  }

  await Promise.all(workers);
  return results;
}

/** Download a single remote URL to `dir`, or pass through a local path. */
async function downloadSingle(
  url: string,
  dir: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (!isRemoteUrl(url)) {
    // Local path — return as-is (must already exist).
    if (!existsSync(url)) {
      throw new Error(`downloadClips: local file not found: ${url}`);
    }
    return url;
  }
  const urlHash = createHash('md5').update(url).digest('hex');
  const filePath = path.join(dir, `clip-${urlHash}.mp4`);
  const res = await fetchWithAbortTimeout(url, {}, 180_000, signal);
  if (!res.ok) {
    throw new Error(`downloadClips: HTTP ${res.status} (${url})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  throwIfAborted(signal);
  await fs.writeFile(filePath, buf);
  return filePath;
}

// ============================================================
// FFmpeg concat (concat demuxer)
// ============================================================

/**
 * Concatenate multiple clips into one video using the ffmpeg concat demuxer.
 *
 * Remote clip URLs are downloaded to a temp dir first; local paths are used
 * directly. A concat list file (`file 'path'` per line) is written and fed to
 * `ffmpeg -f concat -safe 0 -i list -c copy -y outPath`.
 *
 * @param clips - clips to concatenate (URL or local path + optional duration)
 * @param outPath - output video path
 * @throws on empty clips, download failure, or ffmpeg error
 */
export async function execFfmpegConcat(
  clips: ConcatClip[],
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (clips.length === 0) {
    throw new Error('execFfmpegConcat: clips is empty');
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-concat-'));
  try {
    const urls = clips.map((c) => c.url);
    const localPaths = await downloadClips(urls, tmpDir, signal);

    // Build concat list file. Single quotes inside paths are escaped per the
    // concat demuxer's quoting rules: ' -> '\''.
    const listPath = path.join(tmpDir, 'concat-list.txt');
    const lines = localPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
    await fs.writeFile(listPath, lines.join('\n'), 'utf8');

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-y', // overwrite
      outPath,
    ];
    try {
      await execFileAsync(FFMPEG_PATH, args, {
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        signal,
      });
    } catch (err) {
      throwIfAborted(signal);
      const stderr = (err as { stderr?: string })?.stderr ?? '';
      throw new Error(`ffmpeg concat failed: ${stderr || (err as Error).message}`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================
// Extract last frame
// ============================================================

/**
 * Extract the last frame of a video as an image.
 *
 * Uses `-sseof -0.1` (seek from end) to land on the final frame, output as a
 * single high-quality frame. `videoUrl` may be a local path or http(s) URL
 * (ffmpeg handles both natively).
 *
 * @param videoUrl - input video URL or local file path
 * @param outPath - output image path (suggest .jpg for small size)
 * @throws on ffmpeg error
 */
export async function extractLastFrame(
  videoUrl: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  // 三种抽取策略,任一产出非空帧即成功。-sseof 对某些视频(尤其网络流 / 异常时长
  // 元数据)会定位到内容之后 → ffmpeg 退出 0 却不写文件,后续 gridOverlay 的 sharp()
  // 读不到帧便抛 ENOENT(group-N-lastframe.jpg 缺失)。故每条策略后必须校验产出存在且
  // 非空,失败再降级。这是与 app1 共有的潜在缺陷,2026-07-23 加固。
  const strategies: ReadonlyArray<ReadonlyArray<string>> = [
    // ① 现状策略:从结尾前 0.1s 取帧(快;原始行为)。
    ['-sseof', '-0.1', '-i', videoUrl, '-frames:v', '1', '-q:v', '2', '-y', outPath],
    // ② 更大余量:从结尾前 3s 取帧(快;应对 -0.1 越过内容的视频)。
    ['-sseof', '-3', '-i', videoUrl, '-frames:v', '1', '-q:v', '2', '-y', outPath],
    // ③ 兜底:reverse 滤镜倒放后取首帧 = 原始最后一帧(必产出;需解码整段,仅 ①②
    //    均失败时触发,组视频很短代价可接受)。
    ['-i', videoUrl, '-vf', 'reverse', '-an', '-frames:v', '1', '-q:v', '2', '-y', outPath],
  ];

  let lastErr = '';
  for (let i = 0; i < strategies.length; i++) {
    throwIfAborted(signal);
    // 清掉残留 / 上次失败产物,保证下面的存在性校验可信(ffmpeg 退出 0 ≠ 写过文件)。
    await fs.rm(outPath, { force: true });
    try {
      await execFileAsync(FFMPEG_PATH, strategies[i] as string[], {
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
        signal,
      });
    } catch (err) {
      throwIfAborted(signal);
      lastErr = (err as { stderr?: string })?.stderr ?? (err as Error).message;
      continue; // 该策略失败(含 ffmpeg 报错),降级下一条
    }
    // ffmpeg 可能退出 0 但没写文件(-sseof 越过内容):校验产出存在且非空才算成功。
    if (existsSync(outPath)) {
      let size = 0;
      try {
        size = (await fs.stat(outPath)).size;
      } catch {
        size = 0;
      }
      if (size > 0) return;
      lastErr = `strategy#${i} ffmpeg exited 0 but wrote 0-byte file`;
      continue;
    }
    if (!lastErr) lastErr = `strategy#${i} ffmpeg exited 0 but wrote no frame`;
  }

  throw new Error(
    `ffmpeg extractLastFrame failed: 三种策略均未产出帧 video=${videoUrl} lastErr=${lastErr}`,
  );
}

/**
 * Trim the first `maxSec` seconds of a media file into `outPath`.
 *
 * Purpose: cap Seedance `reference_audio` per-file duration so a multi-character
 * shot's total reference audio stays ≤15s (官方 Seedance 2.0 限制：「所有音频总
 * 时长不超过 15 s」)。预置音色全是 PCM wav，`-c copy` 对 wav 是采样级精确
 * （无关键帧/包边界），不超时、不重编码、保真。
 *
 * 单次产出 + 非空校验（与 extractLastFrame 同一纪律：ffmpeg 退出 0 ≠ 写过文件）。
 *
 * @param srcPath  input media path (local)
 * @param maxSec   keep the first `maxSec` seconds
 * @param outPath  output path
 * @throws on ffmpeg error or empty/missing output
 */
export async function trimAudio(
  srcPath: string,
  maxSec: number,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  // 清残留，保证下面的存在性校验可信。
  await fs.rm(outPath, { force: true });
  try {
    await execFileAsync(
      FFMPEG_PATH,
      ['-i', srcPath, '-t', String(maxSec), '-c', 'copy', '-y', outPath],
      { timeout: 60_000, maxBuffer: 5 * 1024 * 1024, signal },
    );
  } catch (err) {
    throwIfAborted(signal);
    throw new Error(
      `ffmpeg trimAudio failed: ${srcPath} → ${maxSec}s: ${(err as { stderr?: string })?.stderr ?? (err as Error).message}`,
    );
  }

  // ffmpeg 可能退出 0 但没写文件（坏输入）：校验产出存在且非空。
  let size = 0;
  try {
    size = (await fs.stat(outPath)).size;
  } catch {
    size = 0;
  }
  if (size <= 0) {
    throw new Error(`ffmpeg trimAudio produced empty output: ${srcPath} → ${outPath}`);
  }
}

// ============================================================
// Split helpers
// ============================================================

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect segment files matching `${prefix}-NNN.mp4` from disk, sorted by index.
 * @param prefix - the output prefix passed to the split functions
 * @param expectedCount - if set, throw when the count differs (strict check)
 */
async function collectSegmentPaths(
  prefix: string,
  expectedCount?: number,
): Promise<string[]> {
  const dir = path.dirname(prefix) || '.';
  const base = path.basename(prefix);
  const re = new RegExp(`^${escapeRegex(base)}-\\d+\\.mp4$`);
  const files = await fs.readdir(dir);
  const segFiles = files.filter((f) => re.test(f)).sort();
  if (expectedCount !== undefined && segFiles.length !== expectedCount) {
    throw new Error(
      `split: expected ${expectedCount} segments, got ${segFiles.length}`,
    );
  }
  return segFiles.map((f) => path.join(dir, f));
}

// ============================================================
// Split by duration (stream copy, keyframe-aligned)
// ============================================================

/**
 * Split a video into segments of `segmentSec` seconds each using
 * `-c copy -f segment` (no re-encode; splits at keyframes, so the last segment
 * of each span may be shorter).
 *
 * @param url - input video URL or local file path
 * @param segmentSec - target seconds per segment
 * @param prefix - output prefix; files are written as `${prefix}-NNN.mp4`
 * @returns list of segment file paths, sorted by index
 * @throws on ffmpeg error
 */
export async function splitVideoByDuration(
  url: string,
  segmentSec: number,
  prefix: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  if (!(segmentSec > 0)) {
    throw new Error('splitVideoByDuration: segmentSec must be > 0');
  }
  const dir = path.dirname(prefix) || '.';
  await fs.mkdir(dir, { recursive: true });

  const outputPattern = `${prefix}-%03d.mp4`;
  const args = [
    '-i', url,
    '-c', 'copy', // no re-encode
    '-f', 'segment',
    '-segment_time', String(segmentSec),
    '-reset_timestamps', '1',
    '-y',
    outputPattern,
  ];
  try {
    await execFileAsync(FFMPEG_PATH, args, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
  } catch (err) {
    throwIfAborted(signal);
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    throw new Error(`ffmpeg segment failed: ${stderr || (err as Error).message}`);
  }
  return collectSegmentPaths(prefix);
}

// ============================================================
// Split evenly (re-encode, forced keyframes for exact N segments)
// ============================================================

/**
 * Re-encode a video into exactly `segments` equal-length segments.
 *
 * Unlike splitVideoByDuration (stream copy, keyframe-bound), this re-encodes
 * with libx264 and forces a keyframe at each segment boundary, so the output
 * count is exactly `segments`. Segment duration is computed as
 * totalDuration / segments (probed via getVideoDuration).
 *
 * @param url - input video URL or local file path
 * @param segments - exact number of output segments (>= 1)
 * @param prefix - output prefix; files are written as `${prefix}-NNN.mp4`
 * @returns list of segment file paths (length === segments), sorted by index
 * @throws if segments is invalid, duration cannot be probed, or the output
 *   count does not match `segments`
 */
export async function splitVideoEvenly(
  url: string,
  segments: number,
  prefix: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  if (!Number.isInteger(segments) || segments < 1) {
    throw new Error('splitVideoEvenly: segments must be a positive integer');
  }
  const totalDuration = await getVideoDuration(url, signal);
  if (totalDuration <= 0) {
    throw new Error('splitVideoEvenly: cannot determine video duration');
  }
  const segmentDurationSec = totalDuration / segments;

  const dir = path.dirname(prefix) || '.';
  await fs.mkdir(dir, { recursive: true });

  const outputPattern = `${prefix}-%03d.mp4`;
  const args = [
    '-i', url,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4000k',
    '-maxrate', '4500k', '-bufsize', '9000k',
    '-force_key_frames', `expr:gte(t,n_forced*${segmentDurationSec})`,
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'segment',
    '-segment_time', String(segmentDurationSec),
    '-segment_time_delta', '0.02',
    '-reset_timestamps', '1',
    '-avoid_negative_ts', 'make_zero',
    '-y', outputPattern,
  ];
  try {
    await execFileAsync(FFMPEG_PATH, args, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
  } catch (err) {
    throwIfAborted(signal);
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    throw new Error(`ffmpeg even split failed: ${stderr || (err as Error).message}`);
  }
  return collectSegmentPaths(prefix, segments);
}

// ============================================================
// Split for Kimi Files API (转绘 X3.5 — stream-copy first, port app1)
// ============================================================

/**
 * A video segment produced by {@link splitVideoForKimi}, carrying the timing
 * metadata the Kimi video-understanding call needs for continuity anchors.
 */
export interface VideoSegment {
  path: string;
  startSec: number;
  endSec: number;
  index: number;
}

/** Kimi Files API 单文件安全上限留余量（app1 同值）。 */
const KIMI_MAX_SEGMENT_BYTES = 95 * 1024 * 1024;
/** Kimi 拆片超时：3GB stream-copy 需数分钟，libx264 回退可能更久；对齐 app1 24h。 */
const KIMI_SPLIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * 为 Kimi Files API 拆片：优先无损 stream-copy（`-c copy -f segment`），不再把
 * 低码率长视频统一膨胀转码到 4 Mbps（splitVideoEvenly 总是 libx264 4Mbps，会把
 * 3GB 低码率源膨胀 5-10GB）。只有封装/编码不兼容（webm/mkv 复用到 mp4 失败）或
 * 单片超 95 MiB 时才回退到受控码率 libx264 转码。
 *
 * 移植自 app1 core/video/ffmpeg-pipeline.ts:505-597（argv verbatim，仅 FFMPEG_BIN
 * → FFMPEG_PATH、返回 VideoSegment[] 带 timing）。
 *
 * @param videoPath         - 输入视频本地路径
 * @param segmentCount      - 目标段数（calculateKimiSegmentPlan 算出）
 * @param segmentDurationSec- 单段时长（秒）
 * @param outputDir         - 输出目录（会 mkdir -p）；文件名 segment-NNN.mp4
 * @returns VideoSegment[]（length === segmentCount，按 index 升序，带 start/end Sec）
 * @throws 参数非法 / 段数不符 / 单段超 95 MiB / ffmpeg 转码仍失败
 */
export async function splitVideoForKimi(
  videoPath: string,
  segmentCount: number,
  segmentDurationSec: number,
  outputDir: string,
  signal?: AbortSignal,
): Promise<VideoSegment[]> {
  throwIfAborted(signal);
  if (!Number.isInteger(segmentCount) || segmentCount < 1 || !(segmentDurationSec > 0)) {
    throw new Error('splitVideoForKimi: 非法的 Kimi 拆分参数');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const outputPattern = path.join(outputDir, 'segment-%03d.mp4');

  const removeSegments = async (): Promise<void> => {
    const names = await fs.readdir(outputDir);
    await Promise.all(
      names
        .filter((name) => /^segment-\d+\.mp4$/.test(name))
        .map((name) => fs.rm(path.join(outputDir, name), { force: true })),
    );
  };
  const collectSegments = async (): Promise<VideoSegment[]> => {
    const files = (await fs.readdir(outputDir))
      .filter((file) => /^segment-\d+\.mp4$/.test(file))
      .sort();
    if (files.length !== segmentCount) {
      throw new Error(`splitVideoForKimi: 预计 ${segmentCount} 段，实际 ${files.length} 段`);
    }
    const segments: VideoSegment[] = [];
    for (const [index, file] of files.entries()) {
      const segmentPath = path.join(outputDir, file);
      const { size } = await fs.stat(segmentPath);
      if (size > KIMI_MAX_SEGMENT_BYTES) {
        throw new Error(
          `splitVideoForKimi: 第 ${index + 1} 段 ${(size / 1024 / 1024).toFixed(1)} MiB，超过安全上限`,
        );
      }
      segments.push({
        path: segmentPath,
        startSec: index * segmentDurationSec,
        endSec: (index + 1) * segmentDurationSec,
        index,
      });
    }
    return segments;
  };

  await removeSegments();
  try {
    await execFileAsync(
      FFMPEG_PATH,
      [
        '-i', videoPath,
        '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy',
        '-f', 'segment',
        '-segment_time', String(segmentDurationSec),
        '-reset_timestamps', '1',
        '-avoid_negative_ts', 'make_zero',
        '-y', outputPattern,
      ],
      {
        timeout: KIMI_SPLIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        signal,
      },
    );
    return await collectSegments();
  } catch {
    // 首次 stream-copy 被取消时不能进入高成本转码回退。
    throwIfAborted(signal);
    // WebM/MKV 等封装可能无法直接复用到 MP4；极端 VBR 也可能让单片超限。
    // 仅此时回退到受控码率转码，按片段实际时长把目标压在 88 MiB 内。
    await removeSegments();
    const targetTotalKbps = Math.max(
      420,
      Math.floor((88 * 1024 * 1024 * 8) / segmentDurationSec / 1000),
    );
    const audioKbps = 96;
    const videoKbps = Math.max(300, targetTotalKbps - audioKbps);
    try {
      await execFileAsync(
        FFMPEG_PATH,
        [
          '-i', videoPath,
          '-map', '0:v:0', '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'ultrafast',
          '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
          '-force_key_frames', `expr:gte(t,n_forced*${segmentDurationSec})`,
          '-c:a', 'aac', '-b:a', `${audioKbps}k`,
          '-f', 'segment',
          '-segment_time', String(segmentDurationSec),
          '-segment_time_delta', '0.02',
          '-reset_timestamps', '1',
          '-avoid_negative_ts', 'make_zero',
          '-y', outputPattern,
        ],
        {
          timeout: KIMI_SPLIT_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          signal,
        },
      );
      return await collectSegments();
    } catch (err) {
      throwIfAborted(signal);
      const stderr = (err as { stderr?: string })?.stderr ?? '';
      throw new Error(`splitVideoForKimi: Kimi 视频拆分失败: ${stderr || (err as Error).message}`);
    }
  }
}

// ============================================================
// Reference-video scene detection + cutting（国外转绘 REFERENCE_VIDEO）
// ============================================================
//
// 参考视频转绘：原视频按场景（镜头）切割成 ≤15s 的切片（ARK Seedance 参考视频
// 上限），切片 720p 封顶后由客户端直传 MinIO presigned URL（有界瞬态），
// 分镜生成时每组参考对应场景切片做 video-to-video 转绘。全在客户端本地执行，
// 服务器零 ffmpeg、零媒体字节。
//
// ⚠ 检测必须用 spawn + 流式读 stderr，不能用 execFile：`-f null -` 正常退出码
// 为 0（不像 `-i` 探测非零退出），showinfo 的 pts_time 全在 stderr 上——若用
// promisify(execFile) 会在成功时忽略 stderr（且 maxBuffer 截断大 stderr），
// 场景检测将恒返回单场景。此为历史踩坑，测试已锁死该回归。

/** 场景检测结果：场景切换点（秒）+ 源视频时长。 */
export interface SceneBoundariesResult {
  /** 场景切换点（秒，升序，不含 0 与末尾）；相邻两点构成一个场景区间。 */
  boundaries: number[];
  sourceDurationSec: number;
}

/** 单个参考视频切片（本地文件 + 时间窗）。 */
export interface ReferenceVideoCutClip {
  path: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** 实际输出高度（≤ maxHeight，scale=-2 偶数对齐）。 */
  height: number;
}

/** 切割进度事件（IPC 推送用）。 */
export interface ReferenceVideoCutProgress {
  stage: 'detecting' | 'cutting' | 'done';
  done: number;
  total: number;
}

/**
 * 跑一条 ffmpeg 命令并逐行流式读取 stderr（spawn 版）。
 *
 * execFile 的 maxBuffer 会在 stderr 超过上限时抛 "maxBuffer exceeded"，
 * 而 `-f null -` 成功退出（码 0）时 showinfo 输出又不会被读取——本辅助函数
 * 解决这两个问题：流式消费 stderr，成功退出也保留全部输出行。
 */
function runFfmpegStream(
  args: string[],
  opts: { signal?: AbortSignal; onStderrLine?: (line: string) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderrTail = '';
    let settled = false;

    const onAbort = () => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-8192);
      if (opts.onStderrLine) {
        for (const line of text.split('\n')) {
          if (line.length > 0) opts.onStderrLine(line);
        }
      }
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg 退出码 ${code}: ${stderrTail.slice(-2000) || '无 stderr 输出'}`));
      }
    });
  });
}

/**
 * 场景检测：`select='gt(scene,τ)',showinfo` 找画面突变帧的 pts_time。
 *
 * @param threshold   场景变化分数阈值（0..1，默认 REFERENCE_VIDEO_SCENE_THRESHOLD）
 * @param minSceneSec 低于此秒数的碎场景与相邻合并（默认 2s）
 * @param maxClips    超过此切片数时按均分兜底（默认 REFERENCE_VIDEO_MAX_CLIPS）
 */
export async function detectSceneBoundaries(
  videoPath: string,
  opts: {
    threshold?: number;
    minSceneSec?: number;
    maxClips?: number;
    signal?: AbortSignal;
  } = {},
): Promise<SceneBoundariesResult> {
  throwIfAborted(opts.signal);
  const threshold = opts.threshold ?? 0.3;
  const minSceneSec = opts.minSceneSec ?? 2;
  const maxClips = opts.maxClips ?? 40;

  const sourceDurationSec = await getVideoDuration(videoPath, opts.signal);

  // `-f null -` 成功退出码为 0，pts_time 全在 stderr —— 必须 spawn 流式读。
  const rawPts: number[] = [];
  await runFfmpegStream(
    [
      '-nostdin', '-i', videoPath,
      '-an',
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-f', 'null', '-',
    ],
    {
      signal: opts.signal,
      onStderrLine: (line) => {
        const m = line.match(/pts_time:(\d+(?:\.\d+)?)/);
        if (m) rawPts.push(parseFloat(m[1]));
      },
    },
  );

  // 去重（同一突变帧可能被 showinfo 多行覆盖），仅保留在源时长内的点。
  const pts = [...new Set(rawPts)]
    .filter((t) => t > 0 && (sourceDurationSec === 0 || t < sourceDurationSec - 0.05))
    .sort((a, b) => a - b);

  // 合并碎场景：相邻边界间距 < minSceneSec 时丢掉靠后的边界（并入前一个场景）。
  let boundaries = pts;
  if (minSceneSec > 0) {
    boundaries = [];
    for (const t of pts) {
      const prev = boundaries[boundaries.length - 1];
      if (prev !== undefined && t - prev < minSceneSec) continue;
      boundaries.push(t);
    }
  }

  // 超限兜底：按均分重切（对齐 splitVideoForKimi 的段计划思路）。
  if (boundaries.length > maxClips - 1 && sourceDurationSec > 0) {
    boundaries = Array.from(
      { length: maxClips - 1 },
      (_, i) => ((i + 1) * sourceDurationSec) / maxClips,
    );
  }

  return { boundaries, sourceDurationSec };
}

/**
 * 参考视频场景切割：按检测出的边界把原视频切成切片，单片 > maxClipSec 再拆，
 * 输出高度封顶 maxHeight（默认 720）。
 *
 * 输出：`outDir/clip-<i>.mp4`（i 为 0-based 全局序），H.264/AAC MP4（ARK 参考
 * 视频要求 H.264/H.265 + AAC/MP3）。无场景切换点时退化为单切片（超长再按时长拆）。
 */
export async function cutReferenceVideo(
  videoPath: string,
  outDir: string,
  opts: {
    maxHeight?: number;
    maxClipSec?: number;
    minClipSec?: number;
    onProgress?: (p: ReferenceVideoCutProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ clips: ReferenceVideoCutClip[]; sourceDurationSec: number }> {
  throwIfAborted(opts.signal);
  const maxHeight = opts.maxHeight ?? 1280;
  const maxClipSec = opts.maxClipSec ?? 15;
  const minClipSec = opts.minClipSec ?? 4;

  const sourceDurationSec = await getVideoDuration(videoPath, opts.signal);
  const srcHeight = await probeVideoHeight(videoPath, opts.signal);
  const scaleHeight = srcHeight > 0 ? Math.min(maxHeight, srcHeight) & ~1 : 0;

  // 纯 15s 等分切割（不用场景检测），最后一段 <4s 也单独成段，生成时按 4s 下限。
  const windows: Array<{ startSec: number; endSec: number }> = [];
  const fullSegments = Math.floor(sourceDurationSec / maxClipSec);
  const remainder = sourceDurationSec - fullSegments * maxClipSec;

  for (let i = 0; i < fullSegments; i++) {
    windows.push({ startSec: i * maxClipSec, endSec: (i + 1) * maxClipSec });
  }

  // 最后一段不管多短都单独成段（不并入前段），durationSec 不足 4s 时记 4s 供生成使用。
  if (remainder > 0) {
    const tailStart = fullSegments * maxClipSec;
    const tailEnd = Math.max(sourceDurationSec, tailStart + minClipSec);
    windows.push({ startSec: tailStart, endSec: tailEnd });
  } else if (windows.length === 0) {
    // 源视频本身就 <15s，整段一个切片
    windows.push({ startSec: 0, endSec: sourceDurationSec });
  }
  const totalClips = windows.length;

  await fs.mkdir(outDir, { recursive: true });
  const clips: ReferenceVideoCutClip[] = [];
  let done = 0;
  opts.onProgress?.({ stage: 'detecting', done: 0, total: totalClips });

  for (const w of windows) {
    throwIfAborted(opts.signal);
    const clipPath = path.join(outDir, `clip-${clips.length}.mp4`);
    await runFfmpegStream(
      [
        '-nostdin', '-i', videoPath,
        '-ss', String(w.startSec), '-to', String(w.endSec),
        ...(scaleHeight > 0 ? ['-vf', `scale=-2:${scaleHeight}`] : []),
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        '-y', clipPath,
      ],
      { signal: opts.signal },
    );
    const d = await getVideoDuration(clipPath, opts.signal);
    clips.push({
      path: clipPath,
      startSec: w.startSec,
      endSec: w.endSec,
      durationSec: d > 0 ? d : w.endSec - w.startSec,
      height: scaleHeight,
    });
    done += 1;
    opts.onProgress?.({ stage: 'cutting', done, total: totalClips });
  }

  opts.onProgress?.({ stage: 'done', done: totalClips, total: totalClips });
  return { clips, sourceDurationSec };
}

// ============================================================
// Depth-map generation (Depth Anything V2 + tmix temporal smoothing)
// ============================================================
//
// 深度图生成：逐帧提取 → Python + Depth Anything V2 Large 推理 → ffmpeg tmix
// 时间平滑 → 与源同 fps 的灰度深度视频。全在客户端本地执行（ffmpeg +
// Python 子进程），服务器零参与。
//
// 降级策略：检测不到 Python / torch / transformers（或调用方没传 scriptPath）
// 时，自动回退到 ffmpeg edgedetect 边缘图作为深度近似——保证任何环境都能产
// 出结果，只是质量不同。深度模型权重（~1.4 GB）不打包进客户端，首次推理时
// 由 transformers 下载到调用方指定的 modelDir（userData 子目录）。

/**
 * Spawn an arbitrary process, stream-read stderr/stdout line-by-line, and honor
 * an AbortSignal. Mirrors {@link runFfmpegStream}'s abort + error semantics but
 * for a caller-supplied command (used to drive the Python depth script).
 */
function runProcess(
  cmd: string,
  args: string[],
  opts: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onStderrLine?: (line: string) => void;
    onStdoutLine?: (line: string) => void;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: opts.env });
    let stderrTail = '';
    let settled = false;

    const onAbort = () => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-8192);
      if (opts.onStderrLine) {
        for (const line of text.split('\n')) {
          if (line.length > 0) opts.onStderrLine(line);
        }
      }
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (opts.onStdoutLine) {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.length > 0) opts.onStdoutLine(line);
        }
      }
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`process "${cmd}" 退出码 ${code}: ${stderrTail.slice(-2000) || '无 stderr 输出'}`));
      }
    });
  });
}

/**
 * Probe video frame rate from the `ffmpeg -i` stderr Video stream line.
 *
 * Parses the first `N fps` (falling back to `N tbr`) on the `Video:` line.
 * Returns an integer fps, or 0 when it cannot be determined.
 *
 * @param url - video URL or local file path
 * @returns integer fps (e.g. 30), or 0
 */
export async function probeVideoFps(
  url: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  try {
    await execFileAsync(FFMPEG_PATH, ['-i', url], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      signal,
    });
  } catch (err) {
    // `ffmpeg -i` (no output) exits non-zero but prints input metadata to
    // stderr; aborts must propagate verbatim.
    throwIfAborted(signal);
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const videoLine = stderr.split('\n').find((l) => /Video:/i.test(l)) ?? '';
    const fpsM = videoLine.match(/([\d.]+)\s*fps/i);
    if (fpsM) return Math.round(parseFloat(fpsM[1]));
    const tbrM = videoLine.match(/([\d.]+)\s*tbr/i);
    if (tbrM) return Math.round(parseFloat(tbrM[1]));
  }
  return 0;
}

/**
 * Detect a usable Python executable with `torch` + `transformers` importable.
 *
 * Probes platform-appropriate candidate names (`python`/`py`/`python3`) by
 * running `-c "import torch, transformers"`. Returns the first candidate that
 * exits 0, or `null` when none qualify — the caller then falls back to edges.
 *
 * CUDA availability is checked inside gen_depth.py (device selection), not here;
 * a CPU-only torch is still "usable" (just slower).
 */
export async function detectPythonRuntime(
  signal?: AbortSignal,
): Promise<string | null> {
  const candidates =
    process.platform === 'win32'
      ? ['python', 'py', 'python3']
      : ['python3', 'python'];
  for (const candidate of candidates) {
    throwIfAborted(signal);
    try {
      await execFileAsync(
        candidate,
        ['-c', 'import torch, transformers'],
        {
          timeout: 60_000,
          maxBuffer: 1 * 1024 * 1024,
          windowsHide: true,
          signal,
        },
      );
      return candidate;
    } catch {
      // Wrong candidate (missing / no torch) → try the next one.
    }
  }
  return null;
}

/** Which backend produced the depth video. */
export type DepthBackend = 'depth-anything' | 'edge-fallback';

/** Per-stage progress event pushed to the renderer over IPC. */
export interface DepthMapProgress {
  stage: 'extracting' | 'inferring' | 'assembling' | 'fallback' | 'done';
  /** 0..1 progress within the current stage (best-effort; omitted when unknown). */
  progress?: number;
  /** Free-form detail line (e.g. device name, fallback reason). */
  detail?: string;
}

/** Result of {@link exportContentDepthMap}. */
export interface DepthMapResult {
  /** Absolute path to the produced grayscale depth video. */
  outPath: string;
  /** Backend that produced the output. */
  backend: DepthBackend;
}

/**
 * Generate a grayscale depth video for `videoPath`, written to `outPath`.
 *
 * Pipeline (ML backend, when Python + torch + transformers + gen_depth.py are
 * all available):
 *   1. ffmpeg extracts frames to a temp dir at `fps` (default = source fps,
 *      falling back to 30).
 *   2. gen_depth.py runs Depth Anything V2 Large (batch=8, fp16/CUDA or
 *      fp32/CPU) producing grayscale depth PNGs.
 *   3. ffmpeg reassembles the depth frames with a `tmix` temporal-smoothing
 *      window (`smoothingFrames`, default 5) into an H.264 mp4 at `fps`.
 *
 * Fallback (edge backend): when Python/torch/script is unavailable, a single
 * ffmpeg pass with `edgedetect` produces an edge-strength approximation. The
 * output is still a valid grayscale mp4 at `fps`, so callers need no special
 * handling — they just see `backend: 'edge-fallback'`.
 *
 * The model weights (~1.4 GB) are downloaded by transformers on first run into
 * `modelDir/hf-cache` (set via HF_HOME); they are never bundled with the app.
 *
 * @param videoPath - local input video path
 * @param outPath   - output depth video path (caller creates parent dir)
 * @param opts.fps         - extraction/output fps (default = source fps, else 30)
 * @param opts.modelDir    - userData dir for the HF model cache (no download when omitted)
 * @param opts.scriptPath  - absolute path to gen_depth.py (ML backend disabled when omitted)
 * @param opts.pythonPath  - python executable override (auto-detected when omitted)
 * @param opts.smoothingFrames - tmix window in frames (default 5; 1 disables smoothing)
 * @throws on ffmpeg/Python error or abort; never silently produces nothing
 */
export async function exportContentDepthMap(
  videoPath: string,
  outPath: string,
  opts: {
    fps?: number;
    modelDir?: string;
    scriptPath?: string;
    pythonPath?: string;
    smoothingFrames?: number;
    onProgress?: (p: DepthMapProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<DepthMapResult> {
  throwIfAborted(opts.signal);

  // Resolve fps: explicit > source > 30. Extract and output at the same rate so
  // frame timing is preserved (no resampling drift).
  let fps = opts.fps ?? 0;
  if (!(fps > 0)) fps = (await probeVideoFps(videoPath, opts.signal)) || 30;
  const smoothing = Math.max(1, opts.smoothingFrames ?? 7);

  // Cache: if a pre-computed depth video exists next to the source, use it directly.
  const depthCache = path.join(path.dirname(videoPath), `depth-${path.basename(videoPath)}`);
  if (existsSync(depthCache)) {
    await fs.copyFile(depthCache, outPath);
    opts.onProgress?.({ stage: 'done', progress: 1 });
    return { outPath, backend: 'depth-anything' };
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-depth-'));
  try {
    const framesDir = path.join(tmpDir, 'frames');
    const depthDir = path.join(tmpDir, 'depth');
    await fs.mkdir(framesDir, { recursive: true });

    // --- Stage 1: extract frames -----------------------------------------
    opts.onProgress?.({ stage: 'extracting', progress: 0 });
    const framePattern = path.join(framesDir, 'frame_%08d.png');
    await runFfmpegStream(
      ['-nostdin', '-i', videoPath, '-vf', `fps=${fps}`, '-q:v', '2', framePattern],
      { signal: opts.signal },
    );
    const frameFiles = (await fs.readdir(framesDir)).filter((f) =>
      /^frame_\d+\.png$/.test(f),
    );
    if (frameFiles.length === 0) {
      throw new Error('exportContentDepthMap: ffmpeg extracted 0 frames');
    }

    // --- ML backend probe -------------------------------------------------
    const python = opts.pythonPath ?? (await detectPythonRuntime(opts.signal));
    const scriptOk =
      !!opts.scriptPath && existsSync(opts.scriptPath);

    if (python && scriptOk) {
      // --- Stage 2: Python depth inference -------------------------------
      opts.onProgress?.({ stage: 'inferring', progress: 0 });
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (opts.modelDir) {
        await fs.mkdir(opts.modelDir, { recursive: true });
        // Pin the HF cache inside userData so the ~1.4 GB download persists.
        env.HF_HOME = path.join(opts.modelDir, 'hf-cache');
        env.TRANSFORMERS_CACHE = path.join(opts.modelDir, 'hf-cache');
      }
      await runProcess(python, [opts.scriptPath as string, framesDir, depthDir], {
        signal: opts.signal,
        env,
        onStderrLine: (line) => {
          const m = line.match(/PROGRESS\s+([\d.]+)/);
          if (m) opts.onProgress?.({ stage: 'inferring', progress: parseFloat(m[1]) });
        },
      });

      // Sanity: depth script must have produced outputs.
      const depthFiles = (await fs.readdir(depthDir)).filter((f) =>
        /^frame_\d+\.png$/.test(f),
      );
      if (depthFiles.length === 0) {
        throw new Error('exportContentDepthMap: depth script produced 0 frames');
      }

      // --- Stage 3: assemble depth frames + tmix smoothing --------------
      opts.onProgress?.({ stage: 'assembling', progress: 0 });
      const weights = Array.from({ length: smoothing }, () => '1').join(' ');
      const vf =
        smoothing > 1
          ? `scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2,eq=saturation=0:contrast=1.0,tmix=frames=${smoothing}:weights=${weights},format=yuv420p`
          : 'scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2,eq=saturation=0:contrast=1.0,format=yuv420p';
      await runFfmpegStream(
        [
          '-framerate', String(fps),
          '-i', path.join(depthDir, 'frame_%08d.png'),
          '-vf', vf,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-r', String(fps), '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-y', outPath,
        ],
        { signal: opts.signal },
      );
      opts.onProgress?.({ stage: 'done', progress: 1 });
      return { outPath, backend: 'depth-anything' };
    }

    // --- Fallback: edgedetect (no Python/torch/script) -------------------
    opts.onProgress?.({
      stage: 'fallback',
      progress: 0,
      detail: 'Python/torch 不可用，回退到边缘图（edgedetect）',
    });
    await runFfmpegStream(
      [
        '-nostdin', '-i', videoPath,
        '-vf', 'scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2,edgedetect=low=0.05:high=0.12,eq=brightness=0.5:contrast=1.2,format=gray',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-r', String(fps), '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y', outPath,
      ],
      { signal: opts.signal },
    );
    opts.onProgress?.({ stage: 'done', progress: 1 });
    return { outPath, backend: 'edge-fallback' };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
