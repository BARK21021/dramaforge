// ============================================================
// ⑨ client/render-worker — job executor
// ============================================================
//
// Dispatches a RenderJob to the right @client/ffmpeg function (or to an
// injected orchestrator for the composite job types). Output handling:
//   - CONCAT (P5): writes the film to the client-local filmsDir and returns an
//     sf-asset:// URL + meta.localKey — NO upload (constraint
//     dramaforge-assets-client-local; the server stores zero media bytes).
//   - EXTRACT_FRAME：仅在显式提供 upload URL 的兼容任务中上传。
//   - CHAIN_COMPILE：orchestrator 把成片写入客户端 filmsDir 并返回 sf-asset://。
//   - LONG_VIDEO_REWRITE：只向服务器回写文本/进度，源视频和切片始终留在客户端。
//
// Decoupling: `ffmpeg` and `orchestrators` are injected as deps. The executor
// NEVER imports @client/orchestrators (Task ⑩, not built yet) — it only knows
// the Orchestrators interface shape, so Task ⑩ can be built/replaced without
// touching this file. The executor also NEVER imports @server/* (the
// render-worker talks to the server ONLY via HTTP).
//
// SPLIT_BY_DURATION / SPLIT_EVENLY：切片写客户端目录并以 outputs 返回；这是
// C/S 的隐私边界，不向服务器申请分段上传 URL。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import type {
  RenderJob,
  RenderJobResult,
  ChainCompileInput,
  LongVideoRewriteInput,
  ConcatInput,
  ExtractFrameInput,
  SplitByDurationInput,
  SplitEvenlyInput,
} from '@dramaforge/shared';
import { uploadArtifact } from './uploader';
import { throwIfAborted } from '../abort';

/**
 * Logger shape required by the executor. Structurally compatible with the
 * ops-logger's Logger (which also has flush); flush is not needed here.
 */
export interface ExecutorLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

/**
 * Context handed to orchestrator hooks. Carries everything an orchestrator
 * needs to (a) call the cloud AI over HTTP (apiBase + authCookie) and
 * (b) run ffmpeg locally (ffmpeg + logger). `machineId` is forwarded for
 * logging/identification purposes (e.g. per-machine AI billing attribution).
 *
 * `apiBase` is required: orchestrators always need to reach the cloud AI.
 * `authCookie` is optional (some installs may run unauthenticated).
 * `machineId` is optional (forwarded when present).
 *
 * Batch 7 OP1 (CHAIN_COMPILE client-local write): `filmsDir`/`toAssetUrl`/
 * `jobId` mirror CONCAT's pattern — chainCompile writes the final film to
 * `<filmsDir>/<jobId>.mp4` and surfaces an `sf-asset://<jobId>.mp4` URL via
 * `toAssetUrl`. The server stores ZERO media bytes
 * (dramaforge-assets-client-local). LONG_VIDEO_REWRITE is threaded for symmetry
 * (its text output is still MinIO-uploaded today; future migration reuses
 * this ctx without re-shifting executeJob).
 */
export interface OrchestratorContext {
  ffmpeg: typeof import('../ffmpeg');
  logger: ExecutorLogger;
  apiBase: string;
  authCookie?: string;
  machineId?: string;
  /** Local directory where chain films are persisted. Required for CHAIN_COMPILE. */
  filmsDir?: string;
  /** Packaged preset-voice directory used to resolve Seedance reference_audio files. */
  voicesDir?: string;
  /** Builds the sf-asset:// URL for a client-local film key. Required for CHAIN_COMPILE. */
  toAssetUrl?: (key: string) => string;
  /** Render job ID — used as the local film's filename stem (`<jobId>.mp4`). */
  jobId?: string;
  /** 服务端取消任务或租约失效时，由 worker 触发的统一中断信号。 */
  signal?: AbortSignal;
  /**
   * 链式/复合编排器按阶段/组上报实时进度（progress 0-100 + 人类可读 stage 文案）。
   * fire-and-forget：实现内部 POST /api/render/jobs/[jobId]/progress 并发 SSE 给前端，
   * 不阻断编排（对齐 app1 video.worker.ts reportProgress）。缺省时编排静默（兼容旧调用方/测试）。
   */
  reportProgress?: (progress: number, stage: string, groupClip?: { shotIds: string[]; videoUrl: string }) => void;
}

/**
 * Hooks for the composite job types (Task ⑩). Both optional — if a composite
 * job is dispatched but its hook is absent, executeJob throws. This keeps the
 * render-worker decoupled from @client/orchestrators.
 */
export interface Orchestrators {
  chainCompile?: (
    input: ChainCompileInput,
    ctx: OrchestratorContext,
  ) => Promise<RenderJobResult>;
  longVideoRewrite?: (
    input: LongVideoRewriteInput,
    ctx: OrchestratorContext,
  ) => Promise<RenderJobResult>;
}

export interface ExecuteJobDeps {
  ffmpeg: typeof import('../ffmpeg');
  orchestrators?: Orchestrators;
  logger: ExecutorLogger;
  /** Cloud server base URL (e.g. https://your-domain.example.com). Forwarded into the
   *  OrchestratorContext so composite job orchestrators can call /api/generate/*. */
  apiBase: string;
  /** Optional Cookie header for cloud AI auth. Forwarded into OrchestratorContext. */
  authCookie?: string;
  /** Optional machine id for per-machine attribution. Forwarded into OrchestratorContext. */
  machineId?: string;
  /**
   * Directory on the user's LOCAL disk where CONCAT writes the final film
   * (`<filmsDir>/<jobId>.mp4`). constraint dramaforge-assets-client-local: the
   * server stores NO media bytes — the film is persisted only here, then
   * served back to the renderer via `sf-asset://` (see `toAssetUrl`).
   * Injected by the shell (main process) as `userData/clips/`.
   */
  filmsDir: string;
  /** Packaged preset-voice directory; bytes stay client-local until a generation request. */
  voicesDir?: string;
  /**
   * Build the `sf-asset://<key>` URL the renderer's `<video>` loads for a
   * client-local film. Injected by the shell (P4 `resolveClipUrl`).
   */
  toAssetUrl: (key: string) => string;
  /** 每个已认领任务独立的中断信号，禁止跨任务复用。 */
  signal?: AbortSignal;
  /**
   * 编排器实时进度上报回调（由 render-worker loop.ts 注入：POST progress 路由 + 发 SSE）。
   * 链式生成按阶段/组调用，让前端进度条从"0% running"变实时%+阶段（对齐 app1）。
   */
  reportProgress?: (progress: number, stage: string, groupClip?: { shotIds: string[]; videoUrl: string }) => void;
}

/** Build a unique temp output path under os.tmpdir() with the given extension. */
function tmpOutputPath(ext: string): string {
  const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return path.join(os.tmpdir(), `sf-render-${rand}.${ext}`);
}

const SF_ASSET_PREFIX = 'sf-asset://';
/** 本地 CONCAT 只接受 clips 目录中的裸 MP4 key，镜像主进程协议白名单。 */
const LOCAL_VIDEO_KEY_RE = /^[a-z0-9-]+\.mp4$/i;

/**
 * 把 Electron 私有的 sf-asset URL 安全转换为 ffmpeg 可读取的本地绝对路径。
 *
 * 服务器只转发 key、不接触媒体字节；解析必须在持有 userData/clips 的客户端完成。
 * URL 只允许 `sf-asset://<裸文件名>.mp4`，并再次校验 resolve 后仍位于 filmsDir，
 * 防止目录穿越、查询串、片段标识或非视频扩展名进入 ffmpeg。
 */
function resolveConcatClipInputs(
  clips: ConcatInput['clips'],
  filmsDir: string,
): ConcatInput['clips'] {
  const root = path.resolve(filmsDir);
  return clips.map((clip) => {
    if (!clip.url.startsWith(SF_ASSET_PREFIX)) return clip;

    let parsed: URL;
    try {
      parsed = new URL(clip.url);
    } catch {
      throw new Error(`CONCAT 本地素材地址非法: ${clip.url}`);
    }
    const pathPart = parsed.pathname;
    const key = parsed.hostname;
    if (
      parsed.protocol !== 'sf-asset:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || (pathPart !== '' && pathPart !== '/')
      || parsed.search !== ''
      || parsed.hash !== ''
      || !LOCAL_VIDEO_KEY_RE.test(key)
    ) {
      throw new Error(`CONCAT 本地素材地址非法: ${clip.url}`);
    }

    const localPath = path.resolve(root, key);
    if (path.dirname(localPath) !== root) {
      throw new Error(`CONCAT 本地素材越界: ${clip.url}`);
    }
    return { ...clip, url: localPath };
  });
}

/**
 * Execute a single render job locally. Dispatches by `job.type`:
 *   CONCAT              → ffmpeg.execFfmpegConcat → upload
 *   EXTRACT_FRAME       → ffmpeg.extractLastFrame → upload
 *   SPLIT_BY_DURATION   → ffmpeg.splitVideoByDuration (local outputs)
 *   SPLIT_EVENLY        → ffmpeg.splitVideoEvenly  (local outputs)
 *   CHAIN_COMPILE       → orchestrators.chainCompile (throws if absent)
 *   LONG_VIDEO_REWRITE  → orchestrators.longVideoRewrite (throws if absent)
 *
 * @returns RenderJobResult with outputUrl (for uploaded types) or outputs
 *   (for split types). Throws on ffmpeg/upload failure or a missing orchestrator.
 */
export async function executeJob(
  job: RenderJob,
  deps: ExecuteJobDeps,
): Promise<RenderJobResult> {
  const { ffmpeg, orchestrators, logger, apiBase, authCookie, machineId } = deps;
  throwIfAborted(deps.signal);

  switch (job.type) {
    case 'CONCAT': {
      const input = job.input as ConcatInput;
      // Films are CLIENT-LOCAL (constraint dramaforge-assets-client-local): no MinIO
      // upload. Write the concat output directly to <filmsDir>/<jobId>.mp4
      // (persisted — NOT tmp), then surface an sf-asset:// URL the renderer
      // can <video>. The server is never in the byte path; result.meta.localKey
      // lets the UI/server reference the local film by key.
      const filmKey = `${job.id}.mp4`;
      const localOut = path.join(deps.filmsDir, filmKey);
      await fs.mkdir(deps.filmsDir, { recursive: true });
      logger.info('executing CONCAT (client-local)', {
        jobId: job.id,
        clips: input.clips.length,
        filmKey,
      });
      // ffmpeg/Node fetch 不认识 Electron 私有协议；媒体仍留在客户端，只把安全 key
      // 映射为本机 clips 目录路径，不经过服务器、更不转 base64。
      const concatClips = resolveConcatClipInputs(input.clips, deps.filmsDir);
      if (deps.signal) {
        await ffmpeg.execFfmpegConcat(concatClips, localOut, deps.signal);
      } else {
        await ffmpeg.execFfmpegConcat(concatClips, localOut);
      }
      throwIfAborted(deps.signal);
      return {
        outputUrl: deps.toAssetUrl(filmKey),
        meta: { localKey: filmKey },
      };
    }

    case 'EXTRACT_FRAME': {
      const input = job.input as ExtractFrameInput;
      const localOut = tmpOutputPath('jpg');
      logger.info('executing EXTRACT_FRAME', { jobId: job.id });
      if (deps.signal) {
        await ffmpeg.extractLastFrame(input.videoUrl, localOut, deps.signal);
        await uploadArtifact(localOut, input.outputUploadUrl, deps.signal);
      } else {
        await ffmpeg.extractLastFrame(input.videoUrl, localOut);
        await uploadArtifact(localOut, input.outputUploadUrl);
      }
      throwIfAborted(deps.signal);
      await fs.rm(localOut, { force: true }).catch(() => {});
      return { outputUrl: input.outputUploadUrl };
    }

    case 'SPLIT_BY_DURATION': {
      const input = job.input as SplitByDurationInput;
      const prefix = tmpOutputPath('mp4').replace(/\.[^.]+$/, '');
      logger.info('executing SPLIT_BY_DURATION', {
        jobId: job.id,
        durationSec: input.durationSec,
      });
      const outputs = deps.signal
        ? await ffmpeg.splitVideoByDuration(
            input.videoUrl,
            input.durationSec,
            prefix,
            deps.signal,
          )
        : await ffmpeg.splitVideoByDuration(
            input.videoUrl,
            input.durationSec,
            prefix,
          );
      throwIfAborted(deps.signal);
      return { outputs, meta: { outputPrefix: input.outputPrefix } };
    }

    case 'SPLIT_EVENLY': {
      const input = job.input as SplitEvenlyInput;
      const prefix = tmpOutputPath('mp4').replace(/\.[^.]+$/, '');
      logger.info('executing SPLIT_EVENLY', { jobId: job.id, segments: input.segments });
      const outputs = deps.signal
        ? await ffmpeg.splitVideoEvenly(
            input.videoUrl,
            input.segments,
            prefix,
            deps.signal,
          )
        : await ffmpeg.splitVideoEvenly(
            input.videoUrl,
            input.segments,
            prefix,
          );
      throwIfAborted(deps.signal);
      return { outputs, meta: { outputPrefix: input.outputPrefix } };
    }

    case 'CHAIN_COMPILE': {
      if (!orchestrators?.chainCompile) {
        throw new Error('orchestrator not configured for CHAIN_COMPILE');
      }
      const input = job.input as ChainCompileInput;
      logger.info('executing CHAIN_COMPILE', { jobId: job.id });
      const result = await orchestrators.chainCompile(input, {
        ffmpeg,
        logger,
        apiBase,
        authCookie,
        machineId,
        filmsDir: deps.filmsDir,
        voicesDir: deps.voicesDir,
        toAssetUrl: deps.toAssetUrl,
        jobId: job.id,
        signal: deps.signal,
        reportProgress: deps.reportProgress,
      });
      throwIfAborted(deps.signal);
      return result;
    }

    case 'LONG_VIDEO_REWRITE': {
      if (!orchestrators?.longVideoRewrite) {
        throw new Error('orchestrator not configured for LONG_VIDEO_REWRITE');
      }
      const input = job.input as LongVideoRewriteInput;
      logger.info('executing LONG_VIDEO_REWRITE', { jobId: job.id });
      const result = await orchestrators.longVideoRewrite(input, {
        ffmpeg,
        logger,
        apiBase,
        authCookie,
        machineId,
        filmsDir: deps.filmsDir,
        voicesDir: deps.voicesDir,
        toAssetUrl: deps.toAssetUrl,
        jobId: job.id,
        signal: deps.signal,
      });
      throwIfAborted(deps.signal);
      return result;
    }

    default: {
      // Exhaustiveness guard: if a new RenderJobType is added without a case,
      // this line fails to compile (`job.type` is no longer `never` here).
      const _exhaustive: never = job.type;
      throw new Error(`executeJob: unknown job type ${String(_exhaustive)}`);
    }
  }
}
