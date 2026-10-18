// ============================================================
// ⑩ client/orchestrators — CHAIN_COMPILE (chain-generate)
// ============================================================
//
// Migrated from app1's CHAIN_GENERATE flow (D:\app1\src\workers\video.worker.ts
// handleChainGenerate + assembleFilm). The AI-resident step (Seedance video
// generation) runs in the cloud **ai-worker** (async BullMQ task), NOT in the
// web process: this orchestrator dispatches each group via `POST
// ${apiBase}/api/generate/video-async` (returns a taskId immediately) and polls
// `GET ${apiBase}/api/tasks/<taskId>` until COMPLETED/FAILED. ark's 20min poll
// stays in ai-worker — web never waits on ark, so no web requestTimeout reset
// (root cause of the 46-91min fake-death). ffmpeg pieces run locally
// (extractLastFrame, gridOverlay, downloadClips, execFfmpegConcat).
//
// Flow per app1's strict serial mode:
//   for each group i:
//     1. Build the cloud AI request body from the group's params + the
//        previous group's last-frame reference (extractLastFrame +
//        gridOverlay of group i-1's video, base64-encoded).
//     2. (P7.6 grid overlay) If the group's params carry
//        `characterReferenceImageUrls` AND `gridEnabled !== false`, overlay a
//        SPARSE 九宫格 grid (rule-of-thirds) on each character design image
//        before submit — used for composition alignment when the referenced
//        CHARACTER asset has `gridOverlayEnabled === true`. Reads bytes from
//        `sf-asset://` (client-local, the cloud can't fetch it) or `http(s)://`,
//        overlays via @client/ffmpeg gridOverlay, replaces the array entries
//        with `data:image/png;base64,...` data URLs. Default-path preservation:
//        when `characterReferenceImageUrls` is absent/empty OR `gridEnabled ===
//        false`, the body is untouched (existing behavior bit-for-bit).
//     3. POST /api/generate/video-async (with `Cookie: authCookie` if set)
//        → envelope { success:true, data:{ taskId } } (async dispatch; ark
//        runs in ai-worker). Then GET /api/tasks/<taskId> (polled 1.5s×2↑5s)
//        → { success:true, data:{ status:'COMPLETED', output:{ videoUrl } } }
//        (FAILED/CANCELLED/TIMEOUT → ChainGroupSkippedError).
//     4. Record the returned URL; if not the last group, extract its last
//        frame and overlay the sparse grid to feed group i+1 as a reference.
//   After all groups: downloadClips(all group URLs) → execFfmpegConcat →
//   copyFile to <filmsDir>/<jobId>.mp4 → sf-asset:// URL (batch 7 OP1,
//   client-local — server stores ZERO media bytes).
//
// Per-group error recovery: network/429/5xx errors retry up to three times.
// The cloud marks deterministic 4xx/content-policy failures retryable=false;
// those stop immediately and the render-worker reports /failed for the job.
//
// Cloud AI contract (async dispatch + poll; web implements both endpoints):
//   POST /api/generate/video-async  (UI-facing envelope, GC-4)
//     Headers: Content-Type: application/json
//              Cookie: <authCookie>  (when provided)
//     Body:    JSON — the group's generation params (prompt, model, duration,
//              aspectRatio, referenceImageUrls, …) PLUS chain-mode fields:
//              chainMode:true / projectId / dedupeKey / groupShotIds, and
//              (between groups) referenceImageBase64 = previous group's grid-
//              overlaid last frame. Web calls enqueueAiTask(VIDEO_GENERATE)
//              and returns immediately — ark runs in ai-worker.
//     Response: 200 → { success:true, data:{ taskId, status } }
//               4xx/5xx → { success:false, error, code?, retryable? }
//   GET /api/tasks/<taskId>  (unified AI-task + render_job query endpoint)
//     Response: 200 → { success:true, data:{ status, output?, error? } }
//               status: COMPLETED → output.videoUrl consumed
//                       FAILED/CANCELLED/TIMEOUT → ChainGroupSkippedError
//     Polling: 1.5s start, ×2 backoff capped at 5s; 32min wall-clock fallback.
//
// Leaf module: no @server/* imports (cloud via HTTP only). Imports allowed:
// @client/ffmpeg, @client/render-worker (OrchestratorContext), @shared, node built-ins.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import type { ChainCompileInput, RenderJobResult } from '@dramaforge/shared';
import type { OrchestratorContext } from '../render-worker';
import type { GridOverlayOptions } from '../ffmpeg';
import { exportContentDepthMap } from '../ffmpeg';
import { throwIfAborted, withAbortableRetry, fetchWithAbortTimeout } from '../abort';
import { readPresetVoiceTrimmed } from '../../main/voice-store';
import { uploadArtifact } from '../render-worker/uploader';

/**
 * Per-group entry on the input. The shared `ChainCompileInput.groupResults`
 * contract is `{url: string}[]` (frozen in Task ①); we locally extend it with
 * an optional `params` field carrying the group's cloud-AI generation params.
 *
 * Behavior:
 *   - `params` present  → orchestrator calls POST /api/generate/video with
 *                         `params` as the body and uses the returned URL.
 *   - `params` absent   → orchestrator falls back to the entry's `url`
 *                         (already-generated pass-through; useful for resumes
 *                         and for tests that don't want to mock the AI).
 *
 * The `params` shape is intentionally `Record<string, unknown>` — it is
 * forwarded verbatim to the cloud AI, which validates it against the
 * provider-specific schema (prompt/model/duration/aspectRatio/refs...).
 */
export interface ChainGroupEntry {
  url: string;
  /** 组内镜头 ID；新任务必传，历史任务缺省时不做镜头状态回写。 */
  shotIds?: string[];
  params?: Record<string, unknown>;
}

/** 客户端落盘后的组片映射；服务端只按任务输入中的 shotIds 白名单持久化。 */
interface PersistedShotGroup {
  shotIds: string[];
  videoUrl: string;
  localKey: string;
}

/** Retry policy for each per-group cloud AI call. */
const AI_RETRY = { tries: 3, backoffMs: 1_000 } as const;

/**
 * 派发请求（POST /api/generate/video-async）的客户端硬超时。派发本身秒级（只入队 BullMQ
 * 不等 ark），25min 纯兜底——只在 web 层异常挂起（fetch 永不返回）时兜底防假活。
 * ark 20min 轮询已挪到 ai-worker 进程，客户端不再同步等（根治 web reset 假死）。
 */
const CLOUD_VIDEO_HARD_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * 单组 wall-clock 预算上限（executeEntryWithBudget 包住整组：派发 + 轮询 + 网格/音频/末帧）。
 * 异步模式下 ark 20min 轮询在 ai-worker 进程，客户端只轮询任务状态；预算要覆盖 ark 正常
 * 最长（20min）+ 轮询 + 网格音频末帧 ~1min + 余量，故 30min。超过判该组挂起 → 跳过（strict
 * 出部分片 / fast 完整性门禁整链 fail）。ark 真正的超时由 ai-worker video worker 25min stall
 * + task timeoutMs(30min) 兜底，客户端 ASYNC_POLL_FALLBACK_MS(32min) 再兜一层。
 */
const PER_GROUP_BUDGET_MS = 30 * 60 * 1000;

/**
 * 服务端明确返回的业务错误。
 * retryable=false 时立即终止，防止内容安全等确定性失败重复调用模型。
 */
class CloudVideoRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CloudVideoRequestError';
  }
}

/**
 * strict 串行模式下，单组因内容审核/版权被云端拒绝时抛出——orchestrator 据此跳过该组
 * 继续后续组（对齐 app1 video.worker.ts:1170-1180 的 continue 降级），而非整链死。
 * fast 模式不 catch（冒到 Promise.all reject = fast-abort 语义，对齐 app1）。
 */
class ChainGroupSkippedError extends Error {
  constructor(readonly groupIndex: number, readonly cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`chainCompile group #${groupIndex + 1} skipped (${causeMsg.slice(0, 120)})`);
    this.name = 'ChainGroupSkippedError';
  }
}

/**
 * sf-asset:// clip key validator — mirrors the canonical `parseProtocolUrl`
 * guard in main/asset-store.ts (path-traversal defense, ext whitelist). Kept
 * inline here so chain-generate.ts stays a leaf module (no @client/main import).
 *
 * The full `parseProtocolUrl` accepts a trailing slash on the URL (`sf-asset://
 * <key>/`); this inline variant rejects it. Both reject any key containing
 * `/`, `?`, or `#` via CLIP_KEY_RE.
 */
const SF_ASSET_PREFIX = 'sf-asset://';
const CLIP_KEY_RE = /^[a-z0-9-]+\.(mp4|png|jpg|jpeg|webp)$/i;

/**
 * Resolve a `sf-asset://<clipId>.<ext>` URL to an absolute local file path
 * under `clipsDir`, with the same path-traversal defense as
 * `parseProtocolUrl` (asset-store.ts:227). Returns `null` for any non-
 * `sf-asset://` URL or a malformed/traversal-attempting key.
 */
function resolveSfAssetUrl(url: string, clipsDir: string): string | null {
  if (!url.startsWith(SF_ASSET_PREFIX)) return null;
  const key = url.slice(SF_ASSET_PREFIX.length);
  if (!CLIP_KEY_RE.test(key)) return null;
  const abs = path.join(clipsDir, key);
  // Path-traversal guard: resolved path must start with clipsDir + sep.
  if (!abs.startsWith(clipsDir + path.sep) && abs !== clipsDir) return null;
  return abs;
}

/** 把仅供 Electron 渲染器使用的 sf-asset URL 转为本地 ffmpeg 可读取的绝对路径。 */
function resolveLocalMediaInput(url: string, ctx: OrchestratorContext): string {
  if (!url.startsWith(SF_ASSET_PREFIX)) return url;
  if (!ctx.filmsDir) {
    throw new Error('chainCompile: filmsDir required for sf-asset:// group video');
  }
  const local = resolveSfAssetUrl(url, ctx.filmsDir);
  if (!local) throw new Error(`chainCompile: invalid sf-asset:// group video URL: ${url}`);
  return local;
}

/**
 * ark/TOS 临时签名 URL（约 1h 过期）——chain 模式跳过 persistVideo 时，新生成组的
 * 视频 URL 即此类。判定与服务端 chain-generate route 的 isReusableMaterialUrl 同源
 * （只换方向：这些正是"会过期、要避开重拉"的）。sf-asset:// 与持久 URL 不匹配。
 */
function isExpiringRemoteUrl(url: string): boolean {
  return /tos-[\w-]*\.volces\.com|volces\.com\/doubao-seedance|^https?:\/\/ark-/i.test(url);
}

/**
 * 解析 88% 拼接步骤某组视频的本地 ffmpeg 输入路径。
 *
 * 渐进回传已把每组视频落盘到 <filmsDir>/<jobId>-group-<原index+1>.mp4（生成时 URL 新鲜）。
 * 当组的源 URL 是会过期的 ark/TOS 签名 URL 时，优先复用这份本地副本，避免 88% 拼接阶段
 * 重拉过期 URL 致 downloadClips HTTP 403（Ep24/25 整链 FAILED 根因）。本地副本缺失时回退
 * 到源 URL（downloadClips 直拉，与旧行为一致）。sf-asset://（复用组）与持久 URL 无过期
 * 风险，仍走 resolveLocalMediaInput。
 */
function resolveGroupConcatInput(
  g: { index: number; url: string },
  ctx: OrchestratorContext,
): string {
  if (isExpiringRemoteUrl(g.url) && ctx.filmsDir && ctx.jobId) {
    const progressivePath = path.join(ctx.filmsDir, `${ctx.jobId}-group-${g.index + 1}.mp4`);
    if (existsSync(progressivePath)) return progressivePath;
  }
  return resolveLocalMediaInput(g.url, ctx);
}

/** Build the standard JSON headers, adding Cookie when auth is provided. */
function jsonHeaders(ctx: OrchestratorContext): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.authCookie) h['Cookie'] = ctx.authCookie;
  return h;
}

/**
 * Read raw image bytes from a URL the cloud AI can't necessarily reach:
 *   - `sf-asset://<clipId>.<ext>` — resolved against `ctx.filmsDir` (client-
 *     local; cloud can't fetch this scheme, so the chain orchestrator must
 *     read it locally and submit bytes inline as `data:`).
 *   - `data:image/...;base64,...`  — decode the embedded base64 payload.
 *   - `http(s)://...`              — fetch via globalThis.fetch.
*
 * @throws on URL resolve failure, fetch non-2xx, or missing ctx.filmsDir
 *   (chainCompile already guarantees filmsDir is set, but guard anyway).
 */
async function fetchImageBytes(
  url: string,
  ctx: OrchestratorContext,
): Promise<Buffer> {
  throwIfAborted(ctx.signal);
  // sf-asset:// → client-local file (cloud server can't fetch this scheme).
  if (url.startsWith(SF_ASSET_PREFIX)) {
    if (!ctx.filmsDir) {
      throw new Error(`chainCompile: filmsDir required for sf-asset:// reference (url=${url})`);
    }
    const local = resolveSfAssetUrl(url, ctx.filmsDir);
    if (!local) throw new Error(`chainCompile: invalid sf-asset:// URL: ${url}`);
    try {
      return await fs.readFile(local);
    } catch (err) {
      // ENOENT 等：带上 url / 解析后的绝对路径 / filmsDir，便于定位「资产图未落地到
      // clips/」类根因（服务器侧看不到客户端磁盘，必须靠错误串 + client-logs 传递）。
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `本地资产图缺失或不可读 url=${url} resolvedPath=${local} filmsDir=${ctx.filmsDir} (${reason})`,
      );
    }
  }
  // data: URL → decode base64 payload.
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error(`chainCompile: malformed data URL (no comma)`);
    return Buffer.from(url.slice(comma + 1), 'base64');
  }
  // http(s):// → fetch.
  const res = await globalThis.fetch(url, { signal: ctx.signal });
  if (!res.ok) {
    throw new Error(`chainCompile: HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 从 chain-generate 组参数（或 body）提取稀疏网格密度参数。gridCells/gridOpacity/
 * gridStrokeWidth 由 web route 校验（4-400 / 0-1 / 0.1-10）后注入 params，这里透传给
 * 网格叠加；缺省字段交由 @client/ffmpeg 回退到 DEFAULT_GRID_CELLS=100 / 0.6 / 1（对齐 app1）。
 */
function gridOptsFromParams(
  params: Record<string, unknown> | undefined,
): GridOverlayOptions {
  if (!params) return {};
  const pick = (key: string): number | undefined => {
    const value = params[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  return {
    cells: pick('gridCells'),
    opacity: pick('gridOpacity'),
    strokeWidth: pick('gridStrokeWidth'),
  };
}

/**
 * Read `url` → fetch bytes → 叠加 app1 同款稀疏网格（resize≤1280 + 网格 + JPEG 重编码）→
 * 返回 `data:image/jpeg;base64,...`。网格密度由 opts.cells 注入（来自 params.gridCells，
 * 对齐 app1 providers.ts applyCharacterReferenceGrid）。服务器零 ffmpeg，整条管线在客户端跑。
 */
async function gridOverlayUrlToDataUrl(
  url: string,
  ctx: OrchestratorContext,
  opts?: GridOverlayOptions,
): Promise<string> {
  const imageBuf = await fetchImageBytes(url, ctx);
  const jpegBuf = await ctx.ffmpeg.applyCharacterReferenceGrid(imageBuf, opts);
  throwIfAborted(ctx.signal);
  return `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
}

/**
 * Apply a sparse 九宫格 grid overlay to `body.characterReferenceImageUrls`
 * when the group's params request it. Mirrors app1 `providers.ts applyGridOverlay`
 * semantics at the chainCompile seam: character design images are grid-
 * overlaid client-side before submit, so the cloud AI gateway receives ready
 * `data:image/png;base64,...` URLs and stays a pure pass-through.
 *
 * Default-path preservation (HARD invariant):
 *   - `body.gridEnabled === false`          → return, body UNCHANGED
 *   - `body.characterReferenceImageUrls` is absent/empty/non-array → return, body UNCHANGED
 *   - Otherwise: each URL is resolved + grid-overlaid + base64-encoded, and
 *     `body.characterReferenceImageUrls` is replaced with the data URLs.
 *
 * Per-image failure handling（R1 修复，偏离 app1 providers.ts:1086-1156 的 drop 行为）：
 * on grid-overlay failure for a single character URL, fall back to the ORIGINAL
 * image as base64 (no grid) — never SKIP. Skipping would shorten
 * characterReferenceImageUrls vs the server prompt's 图片N count → Seedance gets a
 * misaligned array → wrong characters in the video (整条报废). Falling back keeps
 * array length aligned; the cost is that image loses grid protection and may trip
 * real-face detection (loud rejection, far better than silent misalignment). If the
 * original image is also unreadable (真缺图/损坏/非法 URL), the position can't be
 * filled without misaligning → throw fatal so the user fixes the missing asset
 * rather than getting a misaligned video.
 *
 * Constraint: ffmpeg/gridOverlay runs ONLY on the client (hard constraint).
 * The cloud server stays a pure pass-through — it receives `data:` URLs and
 * forwards them to ARK/Seedance, never running ffmpeg itself.
 */
async function applyCharacterAssetGridOverlay(
  body: Record<string, unknown>,
  ctx: OrchestratorContext,
  groupLabel: string,
): Promise<void> {
  // 网格密度从 chain-generate params 透传（body = {...entry.params}）。
  const gridOpts = gridOptsFromParams(body);
  const toDataUrl = async (url: string): Promise<string> => {
    if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) return url;
    const bytes = await fetchImageBytes(url, ctx);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        ? 'image/jpeg'
        : 'image/webp';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  };

  const prepare = async (key: 'characterReferenceImageUrls' | 'referenceImageUrls', overlayGrid: boolean): Promise<void> => {
    const urls = body[key];
    if (!Array.isArray(urls) || urls.length === 0) return;
    const prepared: string[] = [];
    let position = 0;
    for (const url of urls) {
      const idx = position++;
      if (typeof url !== 'string' || url.length === 0) continue;
      try {
        prepared.push(overlayGrid ? await gridOverlayUrlToDataUrl(url, ctx, gridOpts) : await toDataUrl(url));
      } catch (err) {
        throwIfAborted(ctx.signal);
        const detail = err instanceof Error ? err.message : String(err);
        const where = `${groupLabel} ${key}[${idx}/${urls.length}] url=${url}`;
        if (overlayGrid) {
          // R1 修复（偏离 app1 providers.ts:1086-1156 的 drop 行为）：人物参考图单张网格
          // 失败绝不能丢——丢会让 characterReferenceImageUrls 比原数组短 → 服务端 prompt 的
          // 图片N 编号与 Seedance 实收数组错位 → 整组视频角色错位、整条报废。改为回退
          // "原图 base64（去网格）"：服务器能消费 data: URL（裸 sf-asset:// 取不到，故不能
          // 只 push url）。代价：该张失去网格保护，可能触发真人检测被拦——但"被拦失败"
          // 远好于"静默错位"。
          try {
            const raw = await toDataUrl(url);
            ctx.logger.warn('chainCompile 人物参考图单张网格失败，回退原图(去网格)base64 保图片N对齐（防错位）', {
              group: groupLabel,
              field: key,
              index: idx,
              total: urls.length,
              url,
              gridError: detail,
            });
            prepared.push(raw);
          } catch (fallbackErr) {
            throwIfAborted(ctx.signal);
            const fbDetail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            // 原图也读不出（真缺图/损坏/URL 非法）：该位置无法填充，绝不能 drop（会错位）→
            // 整任务失败，逼用户修缺图，而非产出错位视频。
            ctx.logger.error('chainCompile 人物参考图原图也加载失败（真缺图/损坏），无法填充该位置，任务失败（防图片N错位）', {
              group: groupLabel,
              field: key,
              index: idx,
              total: urls.length,
              url,
              gridError: detail,
              rawError: fbDetail,
            });
            throw new Error(
              `chainCompile: 人物参考图网格失败且回退原图也失败，无法填充该位置（防图片N错位）@ ${where}（原图错误：${fbDetail}）`,
            );
          }
        } else {
          ctx.logger.warn('chainCompile: reference image preparation failed, leaving original URL', {
            group: groupLabel,
            field: key,
            index: idx,
            url,
            error: detail,
          });
          prepared.push(url);
        }
      }
    }
    body[key] = prepared;
  };

  const characterUrls = body.characterReferenceImageUrls;
  if (Array.isArray(characterUrls) && characterUrls.length > 0 && body.gridEnabled === false) {
    throw new Error(
      `chainCompile: 人物镜头必须启用稀疏网格 @ ${groupLabel} (${characterUrls.length} 张人物参考图)`,
    );
  }
  // 人物参考图强制叠加 app1 同款稀疏网格；单张网格失败回退原图(去网格)base64 保图片N对齐（R1 防错位）。
  await prepare('characterReferenceImageUrls', true);
  if (Array.isArray(characterUrls) && characterUrls.length > 0) {
    body.characterReferencesGridApplied = true;
  }
  await prepare('referenceImageUrls', false);
}

/**
 * Seedance 2.0 限制「所有参考音频总时长不超过 15s」。多角色镜头把多条预置音色
 * 塞进一个请求时，每条裁到 5s（3×5=15）保证总时长合法。见 voice-store.readPresetVoiceTrimmed。
 */
const REFERENCE_AUDIO_MAX_SEC = 5;

/** Resolve confirmed app1-style voice filenames to Seedance reference_audio data URLs. */
async function applyReferenceAudioFiles(
  body: Record<string, unknown>,
  ctx: OrchestratorContext,
): Promise<void> {
  const files = body.referenceAudioFiles;
  if (!Array.isArray(files) || files.length === 0) return;
  if (!ctx.voicesDir) {
    throw new Error('chainCompile: voicesDir required for Seedance reference audio');
  }
  const urls: string[] = [];
  for (const file of files.slice(0, 3)) {
    if (typeof file !== 'string' || !file.trim()) continue;
    const result = await readPresetVoiceTrimmed(file, ctx.voicesDir, REFERENCE_AUDIO_MAX_SEC);
    if (!result.ok) {
      throw new Error(`chainCompile: reference voice unavailable: ${file} (${result.code})`);
    }
    urls.push(result.dataUrl);
  }
  body.referenceAudioUrls = urls;
  delete body.referenceAudioFiles;
}

/**
 * relay 控制请求（POST 申请位 / GET 换 downloadUrl / DELETE 清理）的单次超时。
 */
const REFERENCE_VIDEO_RELAY_TIMEOUT_MS = 30_000;

/**
 * 从 relay 响应里取字段：兼容裸对象 `{ uploadUrl }` 与 web 惯用的 `{ success, data:{ uploadUrl } }` 信封。
 */
function relayField<T>(obj: Record<string, unknown>, field: string): T | undefined {
  if (obj[field] !== undefined) return obj[field] as T;
  const data = obj.data;
  if (data && typeof data === 'object') {
    const v = (data as Record<string, unknown>)[field];
    if (v !== undefined) return v as T;
  }
  return undefined;
}

/**
 * relay DELETE：fire-and-forget，任何失败静默（relay 对象短 TTL，孤儿会被过期/清扫兜底）。
 */
async function deleteReferenceVideoRelay(
  relayBase: string,
  storageKey: string,
  headers: Record<string, string>,
  ctx: OrchestratorContext,
): Promise<void> {
  try {
    await fetchWithAbortTimeout(
      `${relayBase}?storageKey=${encodeURIComponent(storageKey)}`,
      { method: 'DELETE', headers },
      REFERENCE_VIDEO_RELAY_TIMEOUT_MS,
      ctx.signal,
    );
  } catch {
    // best-effort：忽略。
  }
}

/**
 * REFERENCE_VIDEO 转绘——把组对齐到的本地参考视频切片经短 TTL relay 中转，拿到云端（ark）可拉的
 * downloadUrl 注入 body.referenceVideoUrls，再删掉 body.referenceVideoClip。
 *
 * 模式对齐 applyReferenceAudioFiles（「本地资产 → 云端可消费 URL」）；区别：音频小走内联 data URL，
 * 视频太大塞不进请求体，改走 relay 中转（POST 申请位 → uploadArtifact PUT → GET 换 downloadUrl）。
 * relay 对象用完即删：返回 cleanup 回调，由调用方在组生成结束后 best-effort DELETE（失败不报错）。
 *
 * @returns cleanup 回调；无 referenceVideoClip 时为 no-op。setup 中途失败会先 best-effort 清掉
 *          已申请/上传的对象，再把错误照常抛出（与 grid/audio 同列 fatal：缺切片=用户数据问题）。
 */
async function applyReferenceVideoClip(
  body: Record<string, unknown>,
  ctx: OrchestratorContext,
  projectId: string | undefined,
): Promise<() => Promise<void>> {
  const noop = async (): Promise<void> => undefined;
  const clip = body.referenceVideoClip as
    | { key: string; startSec?: number; endSec?: number }
    | undefined;
  if (!clip || typeof clip.key !== 'string' || !clip.key.trim()) return noop;
  if (!projectId) {
    throw new Error('chainCompile: projectId required for reference video relay');
  }
  if (!ctx.filmsDir) {
    throw new Error('chainCompile: filmsDir required for reference video clip');
  }
  // sf-asset://<key> → 本地文件路径（filmsDir 即 clipsDir，见 main/index.ts 的 worker 装配）。
  const sfAssetUrl = clip.key.startsWith(SF_ASSET_PREFIX)
    ? clip.key
    : `${SF_ASSET_PREFIX}${clip.key}`;
  const localPath = resolveSfAssetUrl(sfAssetUrl, ctx.filmsDir);
  if (!localPath) {
    throw new Error(`chainCompile: invalid reference video clip key: ${clip.key}`);
  }
  const relayBase = `${ctx.apiBase}/api/projects/${encodeURIComponent(projectId)}/reference-video-relay`;
  const headers = jsonHeaders(ctx);
  let storageKey: string | undefined;
  try {
    // 1) 申请 relay 上传位 → { uploadUrl, storageKey }
    const postRes = await fetchWithAbortTimeout(
      relayBase,
      { method: 'POST', headers, body: JSON.stringify({}) },
      REFERENCE_VIDEO_RELAY_TIMEOUT_MS,
      ctx.signal,
    );
    if (!postRes.ok) {
      throw new Error(
        `reference-video-relay POST failed: HTTP ${postRes.status} ${postRes.statusText}`,
      );
    }
    const posted = (await postRes.json()) as Record<string, unknown>;
    storageKey = relayField<string>(posted, 'storageKey');
    const uploadUrl = relayField<string>(posted, 'uploadUrl');
  if (!uploadUrl || !storageKey) {
      throw new Error('reference-video-relay POST response missing uploadUrl/storageKey');
    }
    // 2) 先生成深度图（去人脸特征，避免 ARK PrivacyInformation 审核拦截），
    //    再把深度图视频 PUT 到 uploadUrl。Python 环境不可用时自动 fallback
    //    到 edge-detect，仍能产出有效灰度视频。
    const tmpDepthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-v2v-depth-'));
    const depthPath = path.join(tmpDepthDir, 'depth.mp4');
    try {
      // 深度图推理环境：从 ctx.filmsDir（= userData/clips）反推 userData，
      // 再定位 python-env / depth-models / gen_depth.py。
      // ctx.filmsDir 一定存在（上方已校验）；userData = filmsDir 的父目录。
      const userDataPath = path.dirname(ctx.filmsDir);
      const pythonEnvPath = path.join(userDataPath, 'python-env', 'python.exe');
      const depthModelDir = path.join(userDataPath, 'depth-models');
      // gen_depth.py 在打包产物 resources/scripts/ 下（asar.unpacked）。
      const resourcesPath = process.resourcesPath ?? '';
      const scriptCandidates = [
        path.join(resourcesPath, 'scripts', 'gen_depth.py'),
        path.join(resourcesPath, 'app', 'scripts', 'gen_depth.py'),
      ].filter((p) => existsSync(p));
      ctx.logger?.info?.('[chain] depth map env probe', {
        filmsDir: ctx.filmsDir, userDataPath,
        pythonExists: existsSync(pythonEnvPath),
        modelExists: existsSync(depthModelDir),
        scriptFound: scriptCandidates[0] ?? 'none',
        resourcesPath,
      });
      await exportContentDepthMap(localPath, depthPath, {
        onProgress: (p) => {
          ctx.logger?.info?.('[chain] depth map progress', { stage: p.stage, progress: p.progress });
        },
        signal: ctx.signal,
        pythonPath: existsSync(pythonEnvPath) ? pythonEnvPath : undefined,
        scriptPath: scriptCandidates[0],
        modelDir: existsSync(depthModelDir) ? depthModelDir : undefined,
      });
      await uploadArtifact(depthPath, uploadUrl, ctx.signal);
    } finally {
      await fs.rm(tmpDepthDir, { recursive: true, force: true }).catch(() => {});
    }
    // 3) 换取 downloadUrl → { downloadUrl }
    const getRes = await fetchWithAbortTimeout(
      `${relayBase}?storageKey=${encodeURIComponent(storageKey)}`,
      { method: 'GET', headers },
      REFERENCE_VIDEO_RELAY_TIMEOUT_MS,
      ctx.signal,
    );
    if (!getRes.ok) {
      throw new Error(
        `reference-video-relay GET failed: HTTP ${getRes.status} ${getRes.statusText}`,
      );
    }
    const got = (await getRes.json()) as Record<string, unknown>;
    const downloadUrl = relayField<string>(got, 'downloadUrl');
    if (!downloadUrl) {
      throw new Error('reference-video-relay GET response missing downloadUrl');
    }
    body.referenceVideoUrls = [downloadUrl];
    delete body.referenceVideoClip;
    const keyToDelete = storageKey;
    return () => deleteReferenceVideoRelay(relayBase, keyToDelete, headers, ctx);
  } catch (err) {
    // setup 中途失败：best-effort 清掉已申请/上传的 relay 对象，再把错误照常抛出。
    if (storageKey) void deleteReferenceVideoRelay(relayBase, storageKey, headers, ctx);
    throw err;
  }
}

/** 固定并发并保持输入顺序，避免“完成顺序”污染后续合片顺序。 */
async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Call the cloud AI to generate a single group's video.
 *
 * POSTs `body` to `${apiBase}/api/generate/video` and returns the `url` field
 * from the response envelope. The route speaks the GC-4 UI envelope:
 *   - non-2xx HTTP           → temporary errors retry; retryable=false stops
 *   - 2xx `{ success:false, error, code?, ... }`
 *                            → thrown Error carrying `error`/`code` (don't
 *                              swallow as 'missing url' — preserves provider
 *                              error text like 'rate limited')
 *   - 2xx `{ success:true, data:{ url, meta? } }`
 *                            → return `data.url`; throw 'missing url' only if
 *                              that field is genuinely absent.
 */
/** 轮询起步间隔；每次 ×2 上限 POLL_INTERVAL_MAX_MS。 */
const POLL_INTERVAL_MS = 1_500;
const POLL_INTERVAL_MAX_MS = 5_000;
/** 单次轮询 GET /api/tasks/[id] 的请求超时（任务详情轻量）。 */
const POLL_REQUEST_TIMEOUT_MS = 30_000;
/**
 * 异步派发后客户端轮询兜底超时。ark 真正的超时由 ai-worker video worker 25min stall
 * + task timeoutMs(30min) 兜底；这里只防”派发后任务卡死永不变终态”（worker 全挂等）。
 */
const ASYNC_POLL_FALLBACK_MS = 32 * 60 * 1000;

/** 可中断 sleep；signal abort 时 reject（任务取消传播）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * 派发单组视频生成到 ai-worker（POST /api/generate/video-async）。秒级返回 taskId，
 * **不等 ark**——ark 20min 轮询在 ai-worker 进程，web 永不参与长等待（根治 web reset
 * 假死）。瞬时网络/5xx 错误重试 3 次；确定性 4xx（余额不足/内容拒绝）立即抛
 * CloudVideoRequestError(retryable=false)。
 */
async function dispatchCloudVideoTask(
  body: Record<string, unknown>,
  ctx: OrchestratorContext,
): Promise<string> {
  return withAbortableRetry(async () => {
    let res: Response;
    try {
      res = await fetchWithAbortTimeout(
        `${ctx.apiBase}/api/generate/video-async`,
        {
          method: 'POST',
          headers: jsonHeaders(ctx),
          body: JSON.stringify(body),
        },
        CLOUD_VIDEO_HARD_TIMEOUT_MS, // 派发秒级，复用硬超时兜底（实际远不到）
        ctx.signal,
      );
    } catch (e) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort|timed out/i.test(msg)) {
        throw new CloudVideoRequestError(
          `chainCompile: 派发请求超时/中断(${msg.slice(0, 80)})`,
          false,
        );
      }
      throw e; // 瞬时网络错误 → withAbortableRetry 重试
    }
    if (!res.ok) {
      // apiFail 在 4xx/5xx 仍返回结构化 JSON。先读正文再抛错，保留真实拒绝原因。
      const raw = await res.text().catch(() => '');
      let detail = raw.trim();
      let code = '';
      let retryable = true;
      if (detail) {
        try {
          const failure = JSON.parse(detail) as {
            error?: unknown;
            code?: unknown;
            retryable?: unknown;
          };
          detail = typeof failure.error === 'string' ? failure.error.trim() : detail;
          code = typeof failure.code === 'string' && failure.code.trim()
            ? ` [${failure.code.trim()}]`
            : '';
          retryable = failure.retryable !== false;
        } catch {
          // 反向代理可能返回 HTML/纯文本；保留压缩后的正文供客户端日志诊断。
        }
      }
      const looksLikeGatewayHtml =
        /<(?:!doctype|html|head|body|title|h1)\b/i.test(detail) ||
        /\b(?:502 Bad Gateway|nginx\/\d)/i.test(detail);
      const safeDetail = looksLikeGatewayHtml
        ? '云端服务暂时不可用，请稍后重试'
        : detail.replace(/\s+/g, ' ').slice(0, 1000);
      throw new CloudVideoRequestError(
        safeDetail
          ? `chainCompile: 派发失败: ${safeDetail}${code} (HTTP ${res.status})`
          : `chainCompile: 派发 HTTP ${res.status} ${res.statusText}`,
        retryable,
      );
    }
    const json = (await res.json()) as {
      success?: boolean;
      data?: { taskId?: string };
      error?: string;
      code?: string;
    };
    if (!json.success) {
      const errText = json.error ?? 'unknown error';
      const code = json.code ? ` [${json.code}]` : '';
      throw new CloudVideoRequestError(
        `chainCompile: 派发返回失败: ${errText}${code}`,
        true,
      );
    }
    const taskId = json.data?.taskId;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new Error('chainCompile: 派发响应缺 taskId');
    }
    return taskId;
  }, {
    ...AI_RETRY,
    // 网络和临时上游错误保留重试；服务端明确不可重试的错误立即结束。
    shouldRetry: (error) =>
      !(error instanceof CloudVideoRequestError) || error.retryable,
  }, ctx.signal);
}

/**
 * 轮询 /api/tasks/[taskId] 至终态。COMPLETED 取 output.videoUrl；FAILED/CANCELLED/
 * TIMEOUT 抛 CloudVideoRequestError(retryable=false)；超兜底抛 non-retryable。
 * 瞬时网络错误（含 5xx）退避重试不判终态；404 视为任务未落库（non-retryable）。
 * /api/tasks/[taskId] 对 AI task（tasks 表）和 render_job 统一查询，返回
 * { status, output, error }（见 web/app/api/tasks/[taskId]/route.ts）。
 */
async function pollCloudVideoTask(
  taskId: string,
  ctx: OrchestratorContext,
  deadlineMs: number,
): Promise<string> {
  let interval = POLL_INTERVAL_MS;
  let lastStatus = '';
  for (;;) {
    throwIfAborted(ctx.signal);
    const now = Date.now();
    if (now >= deadlineMs) {
      throw new CloudVideoRequestError(
        `chainCompile: 任务 ${taskId} 轮询超兜底(${ASYNC_POLL_FALLBACK_MS}ms)未终态，判定挂起`,
        false,
      );
    }
    let res: Response;
    try {
      res = await fetchWithAbortTimeout(
        `${ctx.apiBase}/api/tasks/${encodeURIComponent(taskId)}`,
        { headers: jsonHeaders(ctx) },
        POLL_REQUEST_TIMEOUT_MS,
        ctx.signal,
      );
    } catch (e) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? e;
      // 瞬时网络错误：退避后重试，不判终态。
      await sleep(Math.min(interval, deadlineMs - now), ctx.signal);
      interval = Math.min(interval * 2, POLL_INTERVAL_MAX_MS);
      continue;
    }
    if (res.status === 404) {
      throw new CloudVideoRequestError(
        `chainCompile: 任务 ${taskId} 不存在(404)，派发可能未落库`,
        false,
      );
    }
    if (!res.ok) {
      // 5xx 等：退避重试。
      await sleep(Math.min(interval, deadlineMs - now), ctx.signal);
      interval = Math.min(interval * 2, POLL_INTERVAL_MAX_MS);
      continue;
    }
    const env = (await res.json()) as {
      success?: boolean;
      data?: {
        status?: string;
        output?: { videoUrl?: string } | null;
        error?: string | null;
      };
    };
    const t = env.data;
    const status = t?.status ?? '';
    if (status !== lastStatus) {
      ctx.logger.info('chainCompile poll task', { taskId, status });
      lastStatus = status;
    }
    if (status === 'COMPLETED') {
      const url = t?.output?.videoUrl;
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error(`chainCompile: 任务 ${taskId} COMPLETED 但缺 videoUrl`);
      }
      return url;
    }
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMEOUT') {
      const errText = t?.error ?? status;
      throw new CloudVideoRequestError(
        `chainCompile: 任务 ${taskId} ${status}: ${String(errText).slice(0, 300)}`,
        false,
      );
    }
    // PENDING/QUEUED/RUNNING/PROCESSING/CLAIMED：继续轮询。
    await sleep(interval, ctx.signal);
    interval = Math.min(interval * 2, POLL_INTERVAL_MAX_MS);
  }
}

/**
 * 派发单组视频生成到 ai-worker 并轮询至终态。替代旧的同步 callCloudVideoAI——
 * web 永不参与 ark 长等待（根治 web reset 假死）：派发 /api/generate/video-async
 * 秒级返回 taskId，轮询 /api/tasks/[taskId] 拿 COMPLETED 的 videoUrl。
 */
async function dispatchAndPollCloudVideo(
  body: Record<string, unknown>,
  ctx: OrchestratorContext,
): Promise<string> {
  const taskId = await dispatchCloudVideoTask(body, ctx);
  const deadline = Date.now() + ASYNC_POLL_FALLBACK_MS;
  return pollCloudVideoTask(taskId, ctx, deadline);
}

/**
 * 渐进回传(dramaforge 独建,app1 无):某组视频刚生成完就立刻下载到客户端本地 filmsDir
 * (<jobId>-group-<i+1>.mp4),返回 {shotIds, videoUrl} 供编排器随 progress 事件下发,
 * 让对应镜头卡片在前端即时显示视频(不必等整条链跑完 + concat)。
 *
 * best-effort:下载/落盘失败只返回 null(跳过本次渐进显示),绝不杀组——末相 downloadClips
 * 仍会重新下载并持久化,链 COMPLETED 时前端 onRefresh 拿真值兜底。任务取消(signal abort)传播。
 *
 * 组片 ≤15s 仅几 MB,复用 downloadClips(同末相路径,arrayBuffer 无爆堆风险——3GB 那个是整集
 * 长视频)。文件名与末相 per-group 落盘一致(<jobId>-group-<i+1>.mp4),末相 copyFile 等价覆盖。
 */
async function persistGroupClipForProgressiveDisplay(
  index: number,
  groupUrl: string,
  entries: readonly ChainGroupEntry[],
  ctx: OrchestratorContext,
  tmpDir: string,
): Promise<{ shotIds: string[]; videoUrl: string } | null> {
  if (!ctx.jobId || !ctx.toAssetUrl || !ctx.filmsDir) return null;
  const entry = entries[index];
  const shotIds = Array.isArray(entry?.shotIds) ? [...(entry.shotIds as string[])] : [];
  // 历史任务无 shotIds,无法定位具体镜头 → 不发 groupClip(仍走末相整批持久化)。
  if (shotIds.length === 0) return null;
  const groupKey = `${ctx.jobId}-group-${index + 1}.mp4`;
  const dest = path.join(ctx.filmsDir, groupKey);
  try {
    const downloaded = await ctx.ffmpeg.downloadClips([groupUrl], tmpDir, ctx.signal);
    const tmpFile = downloaded[0];
    if (!tmpFile) return null;
    await fs.mkdir(ctx.filmsDir, { recursive: true });
    await fs.copyFile(tmpFile, dest);
    return { shotIds, videoUrl: ctx.toAssetUrl(groupKey) };
  } catch (e) {
    throwIfAborted(ctx.signal); // 任务取消传播(取消后不应继续产出渐进片)
    ctx.logger.warn('chainCompile 渐进回传:组片下载/落盘失败,跳过渐进显示(末相仍会持久化)', {
      index,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Run the CHAIN_COMPILE orchestration: per-group cloud AI video generation
 * with last-frame reference chaining (extractLastFrame + gridOverlay), then
 * local ffmpeg concat + client-local write.
 *
 * @param input - ChainCompileInput (groupResults; outputUploadUrl LEGACY optional)
 * @param ctx   - OrchestratorContext (ffmpeg, logger, apiBase, authCookie?,
 *                machineId?, filmsDir, toAssetUrl, jobId — filmsDir/toAssetUrl/
 *                jobId REQUIRED for the batch 7 OP1 client-local write)
 * @returns RenderJobResult with outputUrl = sf-asset://<jobId>.mp4 and
 *   meta.localKey = `<jobId>.mp4` (the server is never in the byte path).
 * @throws when a group returns a deterministic failure or exhausts retries, when any ffmpeg
 *   step fails (extractLastFrame / gridOverlay / downloadClips / concat),
 *   when the local copy to filmsDir fails, or when filmsDir/toAssetUrl/
 *   jobId is missing on ctx.
 */
export async function chainCompile(
  input: ChainCompileInput,
  ctx: OrchestratorContext,
): Promise<RenderJobResult> {
  throwIfAborted(ctx.signal);
  const entries = input.groupResults as readonly ChainGroupEntry[];
  if (entries.length === 0) {
    throw new Error('chainCompile: groupResults is empty');
  }

  // GAP1：按阶段/组上报实时进度（对齐 app1 video.worker.ts reportProgress），让前端进度条
  // 从"0% running"变实时%+阶段文案。fire-and-forget（ctx.reportProgress 内部 POST /progress 不阻断）。
  const report = (
    progress: number,
    stage: string,
    groupClip?: { shotIds: string[]; videoUrl: string },
  ): void => {
    ctx.reportProgress?.(progress, stage, groupClip);
  };
  report(2, '准备镜头分组');

  // 派发 VIDEO_GENERATE 任务所需的项目 ID（enqueueAiTask dedupe 按 projectId 分组，防同用户
  // 不同 chain 项目的组互相误复用）。来自 input.filmMeta.projectId（chain-generate route 写入）；
  // 缺省时端点走全局 dedupe 分支（有跨项目误复用风险，但不崩）。
  const projectId = input.filmMeta?.projectId;

  // Completion stats surfaced in result.meta (对齐 app1 video.worker.ts:1206-1210 的
  // totalGroups/reusedGroups/generatedGroups/failedGroups)，让前端完成卡片区分复用/生成/失败。
  //   - totalGroups: 本次 chain 处理的组总数（与 entries.length 等价）。
  //   - reusedGroups: params===undefined 的 pass-through 组，复用既有视频（=已完成，未调云端）。
  //   - generatedGroups: 本次真调云端生成成功的组数（orderedGroups 中 params 非空者）。
  //   - failedGroups: strict 串行下云端失败/被跳过的组数（ChainGroupSkippedError 降级，
  //     对齐 app1 video.worker.ts:1170-1180）；fast 模式遇审核整链死，恒为 0。
  const totalGroups = entries.length;
  const reusedGroups = entries.reduce(
    (acc, e) => acc + (e.params === undefined ? 1 : 0),
    0,
  );
  let failedGroups = 0;
  // 每组失败的具体错误（shotIds + 文案），随结果回传；服务端 failed_validation 把它写到对应
  // 镜头 metadata.videoError，前端在失败的镜头组旁展示（"把报错详细内容写在出现错误的镜头组
  // 旁边"）。strict 跳过的组收集于此；fast 首败即整链抛错无结果，不收集。
  const failedGroupErrors: Array<{ shotIds: string[]; error: string }> = [];

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-chain-'));
  ctx.logger.info('chainCompile start', {
    groupCount: entries.length,
    machineId: ctx.machineId,
  });

  try {
    const executeEntry = async (
      entry: ChainGroupEntry,
      index: number,
      previousReference?: string,
      groupSignal?: AbortSignal,
    ): Promise<string> => {
      // groupSignal（per-group 预算）与 ctx.signal（任务取消）组合：任一 abort 都打断子操作。
      // 入口与 catch 只检查 ctx.signal（任务取消才杀链）；groupSignal 的预算超时由 catch 转成跳过。
      const combined = groupSignal && ctx.signal
        ? AbortSignal.any([ctx.signal, groupSignal])
        : (groupSignal ?? ctx.signal);
      const effCtx: OrchestratorContext = { ...ctx, signal: combined };
      throwIfAborted(ctx.signal);
      effCtx.logger.info('chainCompile group', { index, total: entries.length });
      if (entry.params === undefined) {
        effCtx.logger.info('chainCompile group pass-through (no params)', { index, url: entry.url });
        return entry.url;
      }
      const body: Record<string, unknown> = { ...entry.params };
      // 异步派发字段：chainMode 让 ai-worker handleVideoGenerate 跳过服务端 persistVideo
      // （dramaforge-assets-client-local）+ 跳过 shot 回写（归 CHAIN_COMPILE render_job G3 体系）；
      // projectId 供 enqueueAiTask dedupe 分组；dedupeKey="jobId:groupIndex" 防同任务同组重试/
      // 并发重复派发（enqueueAiTask 复用活跃任务 + BullMQ jobId=taskId 双重防重）。计费由
      // ai-worker processor 用每镜头独立 task.id 扣费（天然幂等，避开 chain duplicate 死循环），
      // 不再需要同步路径的 billingTaskId/billingUnitId。
      body.chainMode = true;
      if (projectId) body.projectId = projectId;
      body.dedupeKey = `${effCtx.jobId ?? 'chain'}:${index}`;
      if (previousReference) {
        body.referenceImageBase64 = previousReference;
      } else {
        // 无末帧衔接（首组 / 上一组末帧提取失败或被跳过 / 上一组云端失败）：
        // 删除提示词里的「首尾衔接」整句——该句含精确编号「图片N」（N=参考图总数+1，
        // 见 group-preview.ts combineGroupPrompts），末帧不存在时留着会让模型引用
        // 一张不存在的参考图（幻觉/错位）。仅删单行（该句是独立段落），不伤其余排版。
        if (typeof body.prompt === 'string' && body.prompt.includes('首尾衔接：')) {
          body.prompt = body.prompt.replace(/\n?首尾衔接：[^\n]*\n?/, '\n').replace(/\n{3,}/g, '\n\n');
        }
      }
      const groupLabel = `组#${index + 1}${
        entry.shotIds && entry.shotIds.length > 0 ? `(shots:${entry.shotIds.join(',')})` : ''
      }`;
      await applyCharacterAssetGridOverlay(body, effCtx, groupLabel);
      // REFERENCE_VIDEO 转绘：本地参考视频切片经短 TTL relay 中转成云端可拉的 downloadUrl，注入
      // body.referenceVideoUrls（ark 作为 reference_video content）；relay 用完即删，组生成结束后
      // releaseReferenceVideoClip() best-effort DELETE（失败不报错）。无 referenceVideoClip 时为 no-op。
      const releaseReferenceVideoClip = await applyReferenceVideoClip(body, effCtx, projectId);
      await applyReferenceAudioFiles(body, effCtx);
      let url: string;
      try {
        url = await dispatchAndPollCloudVideo(body, effCtx);
      } catch (e) {
        // 任务取消：必须传播，绝不降级（取消后不应继续拼部分片）。groupSignal 预算超时不在此列。
        throwIfAborted(ctx.signal);
        // 单组云端任何失败（内容审核/ark超时/502/504/5xx/网络重试耗尽/缺url/预算超时）→ 跳过该组继续，
        // 出部分成片（对齐 app1 video.worker.ts:1170-1180 continue，扩展到所有云端失败）。
        // 网格/音频/参考视频 relay fatal（applyCharacterAssetGridOverlay / applyReferenceVideoClip 等）
        // 不在本 try 内（缺图/缺切片=用户数据问题，该杀，Plan agent R8）—— 此 catch 只对 callCloudVideoAI。
        throw new ChainGroupSkippedError(index, e);
      } finally {
        // 组生成完（成功/失败/跳过都算完）：fire-and-forget 删 relay 对象，避免遗留。
        void releaseReferenceVideoClip();
      }
      effCtx.logger.info('chainCompile group AI done', { index, url });
      return url;
    };

    // C per-group wall-clock 预算：包住 executeEntry 的所有子操作（callCloudVideoAI + 网格/音频/末帧），
    // 到期强制 abort 跳过该组——覆盖 ark hang / "fetch failed" 重试 / downloadClips / ffmpeg 全部 hang 点。
    // 预算 abort（groupSignal）区别于任务取消（ctx.signal）：前者跳过该组出部分片，后者杀链。
    const executeEntryWithBudget = async (
      entry: ChainGroupEntry,
      index: number,
      previousReference?: string,
    ): Promise<string> => {
      const budget = new AbortController();
      const timer = setTimeout(
        () => budget.abort(
          new Error(`chainCompile group #${index + 1} 预算超时(${PER_GROUP_BUDGET_MS}ms)，判定挂起`),
        ),
        PER_GROUP_BUDGET_MS,
      );
      try {
        return await executeEntry(entry, index, previousReference, budget.signal);
      } catch (e) {
        // executeEntry 内 callCloudVideoAI 阶段的预算 abort 已被转成 ChainGroupSkippedError；
        // 这里兜底网格/音频/末帧阶段的预算 abort（同样转跳过）。任务取消传播。
        throwIfAborted(ctx.signal);
        if (budget.signal.aborted) throw new ChainGroupSkippedError(index, e);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };

    // 成功组的 {原始 index, 视频 url}，保序。strict 审核跳过的组不进此数组（concat/
    // persistedShotGroups 据此对齐：localFiles 用连续下标 i，localKey 用原始 g.index+1）。
    let groupResults: ({ index: number; url: string } | null)[];
    if (input.execution?.mode === 'parallel') {
      const concurrency = Math.min(12, Math.max(1, input.execution.concurrency ?? 3));
      ctx.logger.info('chainCompile parallel (fast) mode', { concurrency });
      let fastCompleted = 0;
      report(5, `并行生成中 0/${totalGroups}`);
      // 对齐 app1 runChainGenerateFast（video.worker.ts:1284+）：组间并发 + 末帧尽力衔接
      // （不阻塞等上一组）。worker 处理组 i 时取 groupLastFrameCache[i-1]（上一组已完成则
      // 命中），未命中则无衔接独立生成；组完成后提取末帧存缓存供后续组取用。结果按 index
      // 严格保序。这是 app1 "又快又连贯" 的核心——并发不被末帧依赖重新串行化。
      const groupLastFrameCache = new Map<number, string>();
      groupResults = new Array<{ index: number; url: string } | null>(entries.length).fill(null);
      let next = 0;
      const extractTailFrame = async (index: number, url: string): Promise<string | undefined> => {
        try {
          const tmpFrame = path.join(tmpDir, `group-${index}-lastframe.jpg`);
          const refFrame = path.join(tmpDir, `group-${index}-ref.png`);
          const localGroupInput = resolveLocalMediaInput(url, ctx);
          if (ctx.signal) await ctx.ffmpeg.extractLastFrame(localGroupInput, tmpFrame, ctx.signal);
          else await ctx.ffmpeg.extractLastFrame(localGroupInput, tmpFrame);
          await ctx.ffmpeg.gridOverlay([tmpFrame], refFrame, gridOptsFromParams(entries[index].params));
          return (await fs.readFile(refFrame)).toString('base64');
        } catch (e) {
          ctx.logger.warn('chainCompile parallel 末帧提取失败，后续组无衔接(尽力而为)', {
            index,
            error: e instanceof Error ? e.message : String(e),
          });
          return undefined;
        }
      };
      // D fast = all-or-nothing（对齐 app1 video.worker.ts:1691-1703 完整性门禁）：任一组失败 →
      // abortFlag 停派发新组 + allSettled 等在飞组收敛 → 整链报错，不出残缺成片。要部分片用 strict。
      // allSettled（非 Promise.all）：首败后不让其余 worker 沦为 detached 孤儿 ark 调用（烧钱 + unhandled）。
      let abortFlag = false;
      const failures: { index: number; error: unknown }[] = [];
      const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
        while (true) {
          throwIfAborted(ctx.signal);
          if (abortFlag) return;            // 首败后不再认领新组（对齐 app1 L1345/L1647）
          const index = next++;
          if (index >= entries.length) return;
          // 尽力衔接：只取已完成的上一组末帧，绝不 await 等待（否则退回串行）
          const prevRef = index > 0 ? groupLastFrameCache.get(index - 1) : undefined;
          try {
            const url = await executeEntryWithBudget(entries[index], index, prevRef);
            groupResults[index] = { index, url };
            fastCompleted += 1;
            // 渐进回传(并行模式同样每组完成即推前端)。
            const progressiveClip = await persistGroupClipForProgressiveDisplay(
              index, url, entries, ctx, tmpDir,
            );
            report(
              5 + Math.round((fastCompleted / totalGroups) * 80),
              `并行生成中 ${fastCompleted}/${totalGroups}`,
              progressiveClip ?? undefined,
            );
            if (index < entries.length - 1) {
              const frame = await extractTailFrame(index, url);
              if (frame) groupLastFrameCache.set(index, frame);
            }
          } catch (e) {
            throwIfAborted(ctx.signal);     // 任务取消仍传播（allSettled 收敛后由外层处理）
            // fast 不降级出部分片（app1 完整性门禁）：记首败、停派发、让在飞组收敛。
            if (failures.length === 0) failures.push({ index, error: e });
            abortFlag = true;
            return;
          }
        }
      });
      // allSettled：等所有在飞 worker 收敛，绝不留 detached 孤儿 ark 调用。
      await Promise.allSettled(workers);
      if (failures.length > 0) {
        const f = failures[0];
        const e = f.error;
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `chainCompile fast 完整性校验失败：组#${f.index + 1} 失败(${msg.slice(0, 120)})；已中止，不出残缺成片`,
        );
      }
    } else {
      groupResults = [];
      let previousReference: string | undefined;
      let firstSkipCause: unknown = null;
      for (let index = 0; index < entries.length; index++) {
        // 段1：executeEntryWithBudget。任何单组云端失败（审核/ark超时/502/5xx/网络/预算超时）
        // → executeEntry 内已转 ChainGroupSkippedError → 跳过该组继续（对齐 app1 L1170-1180 continue）。
        report(
          5 + Math.round((index / totalGroups) * 80),
          `生成第 ${index + 1}/${totalGroups} 组`,
        );
        let groupUrl: string;
        try {
          groupUrl = await executeEntryWithBudget(entries[index], index, previousReference);
        } catch (e) {
          if (e instanceof ChainGroupSkippedError) {
            if (firstSkipCause === null) firstSkipCause = e.cause;
            failedGroups++;
            previousReference = undefined;  // 末帧降级，下一组无衔接独立生成
            ctx.logger.warn('chainCompile group 云端失败，跳过该组继续后续组', {
              index,
              error: e.cause instanceof Error ? e.cause.message : String(e.cause),
            });
            {
              const skipMsg = e.cause instanceof Error ? e.cause.message : String(e.cause);
              const skipShotIds = Array.isArray(entries[index].shotIds)
                ? [...(entries[index].shotIds as string[])]
                : [];
              failedGroupErrors.push({ shotIds: skipShotIds, error: skipMsg.slice(0, 500) });
            }
            report(
              5 + Math.round(((index + 1) / totalGroups) * 80),
              `第 ${index + 1}/${totalGroups} 组跳过`,
            );
            continue;  // 不 push groupResults
          }
          throw e;
        }
        groupResults.push({ index, url: groupUrl });
        // 渐进回传:组片落本地 + 随本次进度下发 groupClip,前端镜头卡片即时显示(不等整链)。
        const progressiveClip = await persistGroupClipForProgressiveDisplay(
          index, groupUrl, entries, ctx, tmpDir,
        );
        report(
          5 + Math.round(((index + 1) / totalGroups) * 80),
          `第 ${index + 1}/${totalGroups} 组完成`,
          progressiveClip ?? undefined,
        );
        if (index < entries.length - 1) {
          // P0 段2：末帧提取。必须独立 try/catch（合并会让末帧 throw 落进上面的
          // ChainGroupSkippedError catch → instanceof 不成立 → re-throw → P0 失效，Plan agent R2）。
          // 失败置 undefined（下一组无衔接独立生成），不杀链（对齐 app1 L1139-1153 + dramaforge fast extractTailFrame）。
          const tmpFrame = path.join(tmpDir, `group-${index}-lastframe.jpg`);
          const refFrame = path.join(tmpDir, `group-${index}-ref.png`);
          ctx.logger.info('chainCompile extract+grid', { index });
          try {
            const localGroupInput = resolveLocalMediaInput(groupUrl, ctx);
            if (ctx.signal) await ctx.ffmpeg.extractLastFrame(localGroupInput, tmpFrame, ctx.signal);
            else await ctx.ffmpeg.extractLastFrame(localGroupInput, tmpFrame);
            await ctx.ffmpeg.gridOverlay([tmpFrame], refFrame, gridOptsFromParams(entries[index].params));
            throwIfAborted(ctx.signal);
            previousReference = (await fs.readFile(refFrame)).toString('base64');
          } catch (e) {
            throwIfAborted(ctx.signal);  // 取消仍传播（extractLastFrame 因 signal abort 抛时）
            ctx.logger.warn('chainCompile 末帧提取失败，后续组无衔接(尽力而为)', {
              index,
              error: e instanceof Error ? e.message : String(e),
            });
            previousReference = undefined;
          }
        }
      }
      // R3 全跳过 guard：strict 所有组都被跳过（审核/ark超时/网络/预算）→ groupResults 空。
      // 带首败 cause（诊断不能丢原始错误：502 降级文案、rate limited 码等）。
      if (groupResults.length === 0) {
        const causeMsg = firstSkipCause instanceof Error
          ? firstSkipCause.message
          : String(firstSkipCause);
        throw new Error(`chainCompile: 所有组均失败/被跳过，无法产出成片。首败：${causeMsg.slice(0, 200)}`);
      }
    }

    // Download all group videos locally, then ffmpeg-concat them.
    // orderedGroups：保序的成功组（strict 审核跳过的组已剔除）。downloadClips 1:1 保序
    // （ffmpeg-pipeline.ts），故 localFiles[i] ↔ orderedGroups[i]。
    const orderedGroups = groupResults.filter(
      (g): g is { index: number; url: string } => !!g,
    );
    // generatedGroups：成功组里"本次真生成"的（params 非空）；reused（pass-through）已计入 reusedGroups。
    const generatedGroups = orderedGroups.filter(
      (g) => entries[g.index]?.params !== undefined,
    ).length;
    report(88, '下载组视频');
    ctx.logger.info('chainCompile downloading', { count: orderedGroups.length, failed: failedGroups });
    // 88% 拼接：ark/TOS 过期 URL 优先用渐进回传已落盘的本地副本（避免重拉 403），
    // 见 resolveGroupConcatInput；sf-asset:// 与持久 URL 走原 resolveLocalMediaInput。
    const groupMediaInputs = orderedGroups.map((g) => resolveGroupConcatInput(g, ctx));
    const localFiles = ctx.signal
      ? await ctx.ffmpeg.downloadClips(groupMediaInputs, tmpDir, ctx.signal)
      : await ctx.ffmpeg.downloadClips(groupMediaInputs, tmpDir);
    const localOut = path.join(tmpDir, 'chain-out.mp4');
    report(92, '拼接组视频');
    ctx.logger.info('chainCompile concat', { count: localFiles.length });
    if (ctx.signal) {
      await ctx.ffmpeg.execFfmpegConcat(
        localFiles.map((f) => ({ url: f })),
        localOut,
        ctx.signal,
      );
    } else {
      await ctx.ffmpeg.execFfmpegConcat(
        localFiles.map((f) => ({ url: f })),
        localOut,
      );
    }

    // Batch 7 OP1 (dramaforge-assets-client-local): chain films are CLIENT-LOCAL —
    // NO MinIO upload. Mirror CONCAT (executor.ts CONCAT case): copy the
    // concat output to <filmsDir>/<jobId>.mp4 (persisted, not tmp) and surface
    // an sf-asset:// URL the renderer can <video>. The server is never in the
    // byte path; result.meta.localKey lets the UI/server reference the local
    // film by key. copyFile is preferred over rename because tmpDir may live
    // on a different device than filmsDir (rename across devices throws).
    if (!ctx.filmsDir || !ctx.toAssetUrl || !ctx.jobId) {
      throw new Error(
        'chainCompile: filmsDir/toAssetUrl/jobId required on OrchestratorContext (batch 7 OP1 client-local write)',
      );
    }
    const filmKey = `${ctx.jobId}.mp4`;
    const finalPath = path.join(ctx.filmsDir, filmKey);
    await fs.mkdir(ctx.filmsDir, { recursive: true });
    ctx.logger.info('chainCompile written locally', { filmKey });
    await fs.copyFile(localOut, finalPath);
    try {
      throwIfAborted(ctx.signal);
    } catch (error) {
      // copyFile 本身不可中断；若复制期间收到取消，删除刚落下的孤儿影片。
      await fs.rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }

    const persistedShotGroups: PersistedShotGroup[] = [];
    const persistedGroupPaths: string[] = [];
    try {
      for (let i = 0; i < orderedGroups.length; i++) {
        const g = orderedGroups[i];
        const shotIds = entries[g.index].shotIds;
        // 历史 CHAIN_COMPILE 没有 shotIds，保持原结果契约且不制造无归属组片。
        if (!Array.isArray(shotIds) || shotIds.length === 0) continue;
        // localKey 用原始 g.index+1（可追溯、与 shotIds 对齐）；localFiles[i] 用连续下标
        // （对应 orderedGroups[i]，失败组已剔除，Plan agent Q1）。
        const localKey = `${ctx.jobId}-group-${g.index + 1}.mp4`;
        const groupPath = path.join(ctx.filmsDir, localKey);
        await fs.copyFile(localFiles[i], groupPath);
        persistedGroupPaths.push(groupPath);
        throwIfAborted(ctx.signal);
        persistedShotGroups.push({
          shotIds: [...shotIds],
          videoUrl: ctx.toAssetUrl(localKey),
          localKey,
        });
      }
    } catch (error) {
      // 组片必须与整集结果一起成功；中途失败时清掉本任务刚写入的本地孤儿文件。
      await Promise.all([
        fs.rm(finalPath, { force: true }).catch(() => undefined),
        ...persistedGroupPaths.map((groupPath) =>
          fs.rm(groupPath, { force: true }).catch(() => undefined)),
      ]);
      throw error;
    }

    report(100, '全部完成');
    return {
      outputUrl: ctx.toAssetUrl(filmKey),
      meta: {
        localKey: filmKey,
        // 完成统计（对齐 app1 video.worker.ts:1206-1210；RenderJobResult.meta 是
        // Record<string, unknown>，服务端 markResult 按 JSON.stringify 透传，前端
        // 直接从 task.result.meta.totalGroups/reusedGroups/generatedGroups/failedGroups 读取）。
        totalGroups,
        reusedGroups,
        generatedGroups,
        failedGroups,
        // 历史兼容：旧 UI/外部消费者仍读 skippedGroups；与 reusedGroups 同值。
        skippedGroups: reusedGroups,
        // 只在新任务携带 shotIds 时扩展结果，确保旧客户端/旧任务仍保持原 JSON 形状。
        ...(persistedShotGroups.length > 0 ? { groupClips: persistedShotGroups } : {}),
        ...(failedGroupErrors.length > 0 ? { failedGroupErrors } : {}),
      },
    };
  } finally {
    // Best-effort cleanup — never let a temp-file removal mask the real result.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
