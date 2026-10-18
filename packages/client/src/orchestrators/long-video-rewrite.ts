// ============================================================
// ⑩ client/orchestrators — LONG_VIDEO_REWRITE (转绘 X3.4)
// ============================================================
//
// 整剧重写 orchestrator：app1 processLongVideo 的 C/S 端口（port of
// F:\app1\src\core\video\long-video-service.ts:517-1503）。app1 在服务器进程
// 内直接调 Kimi/DeepSeek；本 orchestrator 在客户端 render-worker 内运行，所有
// AI 调用走云端 HTTP（GC-1：AI key 只在服务器）。
//
// 主链（对齐 app1 5 阶段，进度百分比照搬）：
//   1. splitting   (0-8%)   ffmpeg.splitVideoForKimi 本地切片（stream-copy first）
//   2. transcribing(10-55%) 并发 Kimi 视频理解（concurrency 4 via
//                            resolveKimiUploadConcurrency），concat → sourceScript；
//                            若 sourceScript >180k 字符则 DeepSeek Flash 分层 Reduce
//                            （70k 字符 chunks 并发归纳）
//   3. outlining   (55-74%) DeepSeek 全剧大纲（[[GLOBAL_OUTLINE_COMPLETE]] 续写循环）
//                            → 动态目标集数结构门禁（无缺集/增集）→ inferTargetEpisodeCount
//                            → buildThreeStageEpisodeRanges → 导演连续性板
//                            → authoritativeOutlineParts
//   4. scripting   (78-96%) 3 段顺序重写（NOT 并行；每段 buildRewriteFromOutlinePrompt
//                            + [[RANGE_COMPLETE:start-end]] 续写循环 +
//                            appendOnlyMissingEpisodes + stalledParts≥2 break +
//                            maxParts=16 cap）→ inspectScriptRangeStructure /
//                            inspectScriptSemanticDuplicates 结构门禁 + 最多 3 次
//                            返修（buildEpisodeRanges 切批）→ 段间导演板冻结
//   5. completed   (100%)   POST /result 落库 novelText/videoScriptDraft/
//                            longVideoRewrite/status=SCREENWRITING
//
// C/S 适配要点：
//   - app1 `analyzeVideoSegment(path, model, {segIndex,...})` → multipart POST
//     /api/generate/text（segment 字节作为 `video` File，加 segmentIndex/
//     segmentCount/startSec/endSec/model 字段；comrade 已把该 route 从 JSON-
//     base64 改为 multipart/form-data 降 OOM）
//   - app1 `gateway.request({messages, model, maxTokens})` → JSON POST
//     /api/generate/long-video-text（route 内置 retryable 退避 2 次 + Kimi 熔断
//     回退；orchestrator 不再加外层 withRetry，避免指数放大）
//   - app1 `prisma.project.update({longVideoProgress})` → PUT
//     /api/projects/{id}/long-video-rewrite/progress
//   - app1 `prisma.project.update({novelText, videoScriptDraft, scriptData:
//     {longVideoRewrite}, status})` → POST
//     /api/projects/{id}/long-video-rewrite/result
//   - HTTP headers: JSON `Content-Type: application/json` + Cookie when present
//     (mirror chain-generate.ts jsonHeaders)。FormData 不设 Content-Type（fetch
//     自动加 boundary），但设 Cookie。
//
// 心跳：render-worker 30s 轮询循环期间持续刷 task lease，DeepSeek 单次 15-30min
// 长调用天然被覆盖。本 orchestrator **不**加内部心跳定时器（recon 决定）。
//
// 断点：每段 Kimi 分析 JSON + 生成 JSON 持久化进 workingDir（Electron
// userData/long-video-checkpoints/<safeProjectId>-<fingerprint>/）。失败保留
// 断点供重跑复用；成功后清空。fingerprint = sha256(projectId|size|duration|
// segCount|segDurationSec).slice(0,20)（照搬 app1）。input.checkpointDir 不设时
// fallback 到 os.tmpdir()。
//
// Leaf module: no @server/* imports（cloud via HTTP only）。允许 import：@client/
// ffmpeg、@client/render-worker（uploadArtifact + OrchestratorContext 类型）、
// @shared、node built-ins。
//
// 输出契约：RenderJobResult { outputUrl?, meta }。result/progress 走 HTTP route
// 持久化；outputUrl 仅在 input.outputUploadUrl 设了（legacy MinIO 上传）时返回，
// 否则 undefined。meta 带 segmentCount/sourceScript/outline/rewrittenScript 便于
// 调用方（render-worker）日志展示。uploadArtifact 仅在 input.outputUploadUrl 存
// 在时调（保留旧链路兼容；新链路不传）。
// ============================================================

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import type {
  LongVideoRewriteInput,
  LongVideoRewriteResult,
  LongVideoProgress,
  LongVideoStage,
  LongVideoTimingsMs,
  RenderJobResult,
  EpisodeRange,
} from '@dramaforge/shared';
import {
  DEFAULT_KIMI_MAX_SEGMENT_SEC,
  buildOutlinePrompt,
  buildRewriteFromOutlinePrompt,
  buildThreeStageEpisodeRanges,
  buildEpisodeRanges,
  extractEpisodeNumbers,
  extractOutlineStoryBible,
  extractOutlineEpisodeRange,
  extractScriptEpisodeRange,
  sliceSourceForEpisodeRange,
  replaceScriptEpisodeRange,
  episodeRangeCompletionMarker,
  appendModelContinuation,
  appendOnlyMissingEpisodes,
  normalizeOutlineContinuationHeadings,
  normalizeInBodyEpisodeReferences,
  normalizeCanonicalCharacterNames,
  inspectScriptRangeStructure,
  inspectScriptSemanticDuplicates,
  inferTargetEpisodeCount,
  stripMetaCommentary,
  resolveKimiSegmentConcurrency,
  resolveKimiUploadConcurrency,
  resolveDeepSeekReduceConcurrency,
} from '@dramaforge/shared';
import { uploadArtifact } from '../render-worker';
import type { OrchestratorContext } from '../render-worker';
import type { VideoSegment } from '../ffmpeg/ffmpeg-pipeline';
import { throwIfAborted, withAbortableRetry } from '../abort';

// ============================================================
// 常量（照搬 app1 processLongVideo 内的默认值）
// ============================================================

/** Kimi Files API 单段视频理解的默认模型（route 端默认）。 */
const DEFAULT_KIMI_MODEL = 'kimi-k2.6';
/** DeepSeek 大纲 / 分层归纳 / 导演板 默认模型（app1 LONG_VIDEO_OUTLINE_MODEL 默认）。 */
const DEFAULT_OUTLINE_MODEL = 'deepseek/deepseek-v4-flash';
/** DeepSeek 三段剧本重写默认模型（app1 LONG_VIDEO_REWRITE_MODEL 默认）。 */
const DEFAULT_REWRITE_MODEL = 'deepseek/deepseek-v4-flash';
/** Kimi 文本熔断回退模型（route 端默认值）。 */
const DEFAULT_FALLBACK_MODEL = 'kimi/kimi-k2.6';

/** 大纲/归纳/导演板单次输出 token 上限（app1 默认 16_384）。 */
const DEFAULT_OUTLINE_MAX_TOKENS = 16_384;
/** 导演板 token 上限（app1 默认 4_096）。 */
const DEFAULT_BOARD_MAX_TOKENS = 4_096;

/** 全剧大纲完成标记（app1 同名常量）。 */
const OUTLINE_COMPLETION_MARKER = '[[GLOBAL_OUTLINE_COMPLETE]]';
/** 大纲 + 重写 续写循环单批上限（app1 LONG_VIDEO_MAX_CONTINUATIONS 默认 16）。 */
const MAX_CONTINUATION_PARTS = 16;
/** 单段重写结构返修上限（app1 LONG_VIDEO_SCRIPT_STRUCTURE_RETRIES 默认 3）。 */
const MAX_STRUCTURE_RETRIES = 3;
/** 超长拼接稿 Reduce 触发阈值（字符数，app1 同值）。 */
const REDUCE_THRESHOLD_CHARS = 180_000;
/** Reduce 单 chunk 字符数（app1 同值）。 */
const REDUCE_CHUNK_CHARS = 70_000;
/** 语义重复门禁起始集号（app1 LONG_VIDEO_SEMANTIC_DUPLICATE_GATE_FROM_EPISODE 默认 1）。 */
const SEMANTIC_GATE_START_EPISODE = 1;
/** 单段重写触顶续写连续无进展次数上限（app1 同值，stalledParts>=2 break）。 */
const STALLED_PARTS_BREAK = 2;

/** Kimi 单段视频理解 multipart POST 重试策略（48MiB 上传网络抖动常见）。 */
const KIMI_RETRY = { tries: 3, backoffMs: 1_000 } as const;

// ============================================================
// HTTP / 契约 helpers
// ============================================================

/** JSON 请求头 + Cookie（当 ctx.authCookie 存在）。FormData 请求勿用。 */
function jsonHeaders(ctx: OrchestratorContext): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.authCookie) h['Cookie'] = ctx.authCookie;
  return h;
}

/** 仅 Cookie 头（用于 multipart/form-data，Content-Type 由 fetch 自动加 boundary）。 */
function cookieHeader(ctx: OrchestratorContext): Record<string, string> {
  return ctx.authCookie ? { Cookie: ctx.authCookie } : {};
}

/** Compute the per-video checkpoint fingerprint（照搬 app1 sha256 slice 20）。 */
function computeFingerprint(
  projectId: string,
  sizeBytes: number,
  durationSec: number,
  segmentCount: number,
  segmentDurationSec: number,
): string {
  return createHash('sha256')
    .update(
      [
        projectId,
        sizeBytes,
        durationSec.toFixed(3),
        segmentCount,
        segmentDurationSec.toFixed(6),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 20);
}

/** 把 projectId 压成文件系统安全的目录名段。 */
function safeProjectIdSeg(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface GenerationCheckpoint {
  version: 2;
  fingerprint: string;
  initialOutline?: string;
  initialOutlineComplete?: boolean;
  canonicalDirectorBoard?: string;
  targetEpisodeCount?: number;
  authoritativeOutlineParts?: string[];
  rewriteStageContents?: string[];
  rewriteRepairDrafts?: string[];
  stageDirectorBoards?: string[];
  updatedAt: string;
}

/**
 * Rebuild a client checkpoint from completed project text after verifying the source fingerprint.
 * Production still uses three coarse ranges, so an episode inside a range regenerates that whole range.
 */
export function buildRegenerationCheckpoint(input: {
  fingerprint: string;
  regenerateFromEpisode: number;
  previousScript: string;
  saved: Record<string, unknown>;
  reuseTargetStageDraft?: boolean;
  now?: string;
}): GenerationCheckpoint {
  const savedFingerprint = String(input.saved.analysisFingerprint ?? '');
  const completedOutline = String(input.saved.outline ?? '');
  const savedInitialOutline = String(input.saved.initialOutline ?? '');
  const legacyDirectorMarker = completedOutline.search(/^## 导演连续性板\s*$/m);
  const recoverableInitialOutline = savedInitialOutline || (
    legacyDirectorMarker > 0 ? completedOutline.slice(0, legacyDirectorMarker).trim() : ''
  );
  const directorBoard = String(input.saved.directorBoard ?? '');
  const targetEpisodeCount = Number(input.saved.targetEpisodeCount);
  if (
    savedFingerprint !== input.fingerprint
    || !recoverableInitialOutline
    || !directorBoard
    || !Number.isInteger(targetEpisodeCount)
    || targetEpisodeCount <= 0
    || !input.previousScript.trim()
  ) {
    throw new Error('无法从指定集恢复：源视频指纹或已存大纲/剧本不完整，请执行完整重写');
  }

  const ranges = buildThreeStageEpisodeRanges(targetEpisodeCount);
  const preservedRanges = ranges.filter((range) => range.end < input.regenerateFromEpisode);
  return {
    version: 2,
    fingerprint: input.fingerprint,
    initialOutline: recoverableInitialOutline,
    initialOutlineComplete: true,
    canonicalDirectorBoard: directorBoard,
    targetEpisodeCount,
    rewriteStageContents: preservedRanges.map((range) =>
      extractScriptEpisodeRange(input.previousScript, range)),
    rewriteRepairDrafts: input.reuseTargetStageDraft
      ? ranges.map((range) => range.start === input.regenerateFromEpisode
        ? extractScriptEpisodeRange(input.previousScript, range)
        : '')
      : [],
    stageDirectorBoards: (Array.isArray(input.saved.stageDirectorBoards)
      ? input.saved.stageDirectorBoards.filter((value): value is string => typeof value === 'string')
      : []).slice(0, preservedRanges.length),
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

interface SegmentCheckpoint {
  version: 1;
  fingerprint: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  completedAt: string;
}

/** 原子写 JSON（tmp 文件 + rename，partial write 不暴露）。 */
async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(payload), 'utf8');
  await fs.rm(filePath, { force: true });
  await fs.rename(temporary, filePath);
}

/** 读 generation-checkpoint.json；不存在或指纹不匹配返回空白断点。 */
async function readGenerationCheckpoint(
  filePath: string,
  fingerprint: string,
): Promise<GenerationCheckpoint> {
  const fallback: GenerationCheckpoint = {
    version: 2,
    fingerprint,
    updatedAt: new Date().toISOString(),
  };
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const value = JSON.parse(raw) as GenerationCheckpoint;
    if (value.version !== 2 || value.fingerprint !== fingerprint) return fallback;
    return value;
  } catch {
    return fallback;
  }
}

/** 读单段 Kimi 分析断点；版本/指纹/索引/空文本任一不符返回 null。 */
async function readSegmentCheckpoint(
  filePath: string,
  fingerprint: string,
  index: number,
): Promise<SegmentCheckpoint | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as SegmentCheckpoint;
    if (
      value.version !== 1
      || value.fingerprint !== fingerprint
      || value.index !== index
      || typeof value.text !== 'string'
      || !value.text.trim()
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

// ============================================================
// Cloud AI HTTP wrappers
// ============================================================

/**
 * 上报进度到 PUT /api/projects/{projectId}/long-video-rewrite/progress。
 * 失败只记日志（不阻塞主流程；UI 进度卡顿 < 误判任务失败）。
 */
async function reportProgress(
  ctx: OrchestratorContext,
  projectId: string,
  state: LongVideoProgress,
): Promise<void> {
  try {
    // 粘住 taskId：dispatch 初始化 longVideoProgress 时写入 taskId，但 progress
    // route 整列覆盖；若 PUT body 不带 taskId 会把它冲掉，UI（OriginalRewriteStage）
    // 刷新后读 progress.taskId 还原轮询会失败。ctx.jobId === render job id ===
    // dispatch 的 taskId，每次 PUT 都带上保持粘性。
    const body: LongVideoProgress = ctx.jobId ? { ...state, taskId: ctx.jobId } : state;
    const res = await globalThis.fetch(
      `${ctx.apiBase}/api/projects/${projectId}/long-video-rewrite/progress`,
      {
        method: 'PUT',
        headers: jsonHeaders(ctx),
        body: JSON.stringify(body),
        signal: ctx.signal,
      },
    );
    if (!res.ok) {
      ctx.logger.warn('longVideoRewrite: progress PUT non-2xx', {
        status: res.status,
        stage: state.stage,
      });
    }
  } catch (err) {
    // 取消不是“进度上报失败”；必须向主流程传播，阻止后续 AI/FFmpeg 阶段。
    throwIfAborted(ctx.signal);
    ctx.logger.warn('longVideoRewrite: progress PUT failed', {
      error: err instanceof Error ? err.message : String(err),
      stage: state.stage,
    });
  }
}

/** 进度回调工厂；totalSteps 默认 segmentCount + 3（split/kimi/outline/script/result）。 */
function makeReporter(
  ctx: OrchestratorContext,
  projectId: string,
  totalSteps: number,
) {
  return async (
    stage: LongVideoStage,
    progress: number,
    currentStep: string,
    currentStepIndex?: number,
  ): Promise<void> => {
    await reportProgress(ctx, projectId, {
      stage,
      progress,
      currentStep,
      totalSteps,
      currentStepIndex,
      updatedAt: new Date().toISOString(),
    });
  };
}

/** POST /api/projects/{projectId}/long-video-rewrite/result 落库最终产物。 */
async function postResult(
  ctx: OrchestratorContext,
  projectId: string,
  body: {
    novelText?: string;
    videoScriptDraft?: string;
    longVideoRewrite?: Record<string, unknown>;
    targetStatus?: string;
    completedAt?: string;
  },
): Promise<void> {
  const res = await globalThis.fetch(
    `${ctx.apiBase}/api/projects/${projectId}/long-video-rewrite/result`,
    {
      method: 'POST',
      headers: jsonHeaders(ctx),
      body: JSON.stringify(body),
      signal: ctx.signal,
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(
      `longVideoRewrite: result POST HTTP ${res.status} ${res.statusText} ${detail}`,
    );
  }
}

/**
 * Kimi 单段视频理解：multipart POST /api/generate/text。
 *
 * 读 segment 文件字节为 Blob 附作 `video`，加 segmentIndex/segmentCount/
 * startSec/endSec/model 字段。响应 envelope `{success, data:{content}}`。
 * 不重置 Content-Type（让 fetch 设 multipart boundary）。
 *
 * 失败（网络/非 2xx/缺 content）抛错；外层 withRetry 重试 3 次后交主流程 surface。
 */
async function callKimiSegment(
  ctx: OrchestratorContext,
  seg: VideoSegment,
  segmentCount: number,
  kimiModel: string,
): Promise<string> {
  return withAbortableRetry(async () => {
    const buf = await fs.readFile(seg.path);
    const form = new FormData();
    form.append(
      'video',
      new Blob([buf], { type: 'video/mp4' }),
      path.basename(seg.path),
    );
    form.append('segmentIndex', String(seg.index));
    form.append('segmentCount', String(segmentCount));
    form.append('startSec', String(seg.startSec));
    form.append('endSec', String(seg.endSec));
    form.append('model', kimiModel);
    if (ctx.machineId) form.append('machineId', ctx.machineId);
    const res = await globalThis.fetch(`${ctx.apiBase}/api/generate/text`, {
      method: 'POST',
      headers: cookieHeader(ctx),
      body: form,
      signal: ctx.signal,
    });
    if (!res.ok) {
      throw new Error(
        `longVideoRewrite: Kimi HTTP ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as {
      success?: boolean;
      data?: { content?: string };
      content?: string;
    };
    if (json.success === false) {
      throw new Error(
        `longVideoRewrite: Kimi segment ${seg.index + 1}/${segmentCount} success=false`,
      );
    }
    const content = json.data?.content ?? json.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(
        `longVideoRewrite: Kimi segment ${seg.index + 1}/${segmentCount} missing content`,
      );
    }
    return content;
  }, KIMI_RETRY, ctx.signal);
}

/** DeepSeek 调用返回（route envelope 解出来的字段）。 */
interface DeepSeekOutcome {
  content: string;
  finishReason?: string;
  provider?: string;
}

/**
 * DeepSeek 文本生成：JSON POST /api/generate/long-video-text。
 *
 * route 内部已做 retryable 退避 2 次 + Kimi 熔断回退；orchestrator 不再加外层
 * withRetry。仅 non-2xx / success=false / 空 content 抛错（交调用方决定是否续写）。
 *
 * @param prompt   {system, user} 拼 messages
 * @param model    模型 ID（如 deepseek/deepseek-v4-flash）
 * @param options  maxTokens? / temperature? / contextWindow?
 */
async function callDeepSeekText(
  ctx: OrchestratorContext,
  prompt: { system: string; user: string },
  model: string,
  options: { maxTokens?: number; temperature?: number; contextWindow?: number } = {},
): Promise<DeepSeekOutcome> {
  const body: Record<string, unknown> = {
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    model,
    fallbackModel: DEFAULT_FALLBACK_MODEL,
  };
  if (options.maxTokens) body.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.contextWindow !== undefined) body.contextWindow = options.contextWindow;
  if (ctx.machineId) body.machineId = ctx.machineId;

  const res = await globalThis.fetch(`${ctx.apiBase}/api/generate/long-video-text`, {
    method: 'POST',
    headers: jsonHeaders(ctx),
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(
      `longVideoRewrite: DeepSeek HTTP ${res.status} ${res.statusText} ${detail}`,
    );
  }
  const json = (await res.json()) as {
    success?: boolean;
    error?: string;
    data?: { content?: string; finishReason?: string; provider?: string };
  };
  if (json.success === false) {
    throw new Error(`longVideoRewrite: DeepSeek success=false ${json.error ?? ''}`);
  }
  const content = json.data?.content ?? '';
  if (!content.trim()) {
    throw new Error('longVideoRewrite: DeepSeek 返回空内容');
  }
  return {
    content: content.trim(),
    finishReason: json.data?.finishReason,
    provider: json.data?.provider,
  };
}

/**
 * 单段（连续集号区间）DeepSeek 重写 + 自动续写循环。
 *
 * - 给 prompt 末尾追加 `[[RANGE_COMPLETE:start-end]]` 完成标记要求
 * - 首次调用若 finishReason=length / 缺集 / 缺标记 → 续写循环
 *   - 续写时 appendOnlyMissingEpisodes（缺集场景）/ appendModelContinuation（截断场景）
 *   - stalledParts（连续无进展）≥2 → break 并交结构门禁处理
 *   - maxParts=16 上限
 * - 退出循环时若仍未完成 → throw（保留断点不保存截断稿）
 *
 * 直接照搬 app1 callDeepSeekForEpisodeRange 的循环逻辑；仅 gateway.request →
 * callDeepSeekText。outline 阶段不用此函数（用全局标记 [[GLOBAL_OUTLINE_COMPLETE]]）。
 */
async function callDeepSeekForEpisodeRange(
  ctx: OrchestratorContext,
  prompt: { system: string; user: string },
  model: string,
  range: EpisodeRange,
  options: {
    stage: 'outlining' | 'scripting';
    progress: number;
    label: string;
    report: (
      stage: LongVideoStage,
      progress: number,
      step: string,
      stepIndex?: number,
    ) => Promise<void>;
    maxTokens?: number;
  },
): Promise<{ content: string; partCount: number }> {
  const completionMarker = episodeRangeCompletionMarker(range);
  const completionRequirement =
    options.stage === 'outlining'
      ? `第 ${range.end} 集的大纲条目、详细事件、关键对白和结尾钩子全部写完`
      : `第 ${range.end} 集的全部正文、全部场次和最后一个完整动作全部写完`;
  const markedPrompt = {
    ...prompt,
    user: `${prompt.user}\n\n只有在${completionRequirement}后，才在最后单独输出一行 ${completionMarker}。不得只写出末集标题就输出标记。`,
  };
  const rangeCallOptions = options.maxTokens ? { maxTokens: options.maxTokens } : {};

  let result = await callDeepSeekText(ctx, markedPrompt, model, rangeCallOptions);
  let content = stripMetaCommentary(result.content);
  let partCount = 1;

  const expectedEpisodes = Array.from(
    { length: range.end - range.start + 1 },
    (_, i) => range.start + i,
  );
  let missingEpisodes = expectedEpisodes.filter(
    (ep) => !extractEpisodeNumbers(content).includes(ep),
  );
  let markerMissing = !content.includes(completionMarker);
  let previousProgressKey = `${missingEpisodes.join(',')}|${markerMissing}`;
  let stalledParts = 0;

  while (
    (result.finishReason === 'length' || missingEpisodes.length > 0 || markerMissing)
    && partCount < MAX_CONTINUATION_PARTS
  ) {
    partCount += 1;
    await options.report(
      options.stage,
      Math.min(96, options.progress + partCount),
      result.finishReason === 'length'
        ? `${options.label}达到模型单次输出上限，正在无缝续写第 ${partCount} 段`
        : missingEpisodes.length > 0
          ? `${options.label}检测到缺少第 ${missingEpisodes.join('、')} 集，正在自动补全`
          : `${options.label}末集正文尚未完整收束，正在续写完成最后场次`,
    );
    const tail = content.slice(-24_000);
    const wasFillingMissingEpisodes = missingEpisodes.length > 0;
    result = await callDeepSeekText(
      ctx,
      {
        system: markedPrompt.system,
        user: `${markedPrompt.user}\n\n--- 本批次已经生成的末尾（用于定位续写点和避免重复）---\n${tail}\n--- 已生成末尾结束 ---\n\n本批次尚未完整结束。${missingEpisodes.length > 0 ? `必须补全这些集数：第 ${missingEpisodes.join('、')} 集。` : '请从最后一个完整行之后无缝续写。'}只输出尚未生成的正文；不得重头开始、不得重复已有集数或场次、不得总结、不得省略。完成${completionRequirement}后，最后单独输出 ${completionMarker}。`,
      },
      model,
      rangeCallOptions,
    );
    const cleanedContinuation = stripMetaCommentary(result.content);
    content = wasFillingMissingEpisodes
      ? appendOnlyMissingEpisodes(content, cleanedContinuation)
      : appendModelContinuation(content, cleanedContinuation);
    missingEpisodes = expectedEpisodes.filter(
      (ep) => !extractEpisodeNumbers(content).includes(ep),
    );
    markerMissing = !content.includes(completionMarker);
    const progressKey = `${missingEpisodes.join(',')}|${markerMissing}`;
    stalledParts =
      result.finishReason !== 'length' && progressKey === previousProgressKey
        ? stalledParts + 1
        : 0;
    previousProgressKey = progressKey;
    if (stalledParts >= STALLED_PARTS_BREAK) break;
  }

  if (result.finishReason === 'length' || missingEpisodes.length > 0 || markerMissing) {
    const reason =
      result.finishReason === 'length'
        ? `连续 ${MAX_CONTINUATION_PARTS} 段仍触及模型输出上限`
        : missingEpisodes.length > 0
          ? `仍缺少第 ${missingEpisodes.join('、')} 集`
          : '末集正文没有返回完整收束标记';
    throw new Error(
      `${options.label}${reason}，任务不会保存截断稿；可提高 LONG_VIDEO_MAX_CONTINUATIONS 后重试`,
    );
  }
  return { content: content.split(completionMarker).join('').trim(), partCount };
}

// ============================================================
// 并发原语
// ============================================================

/**
 * 顺序保序的并发执行器：N 个 item，最多 concurrency 个同时 in-flight，结果按
 * item 原顺序返回。失败不提前中断（错误归入 results）；调用方决定如何处理。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: Error }> = new Array(
    items.length,
  );
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      // 每次领取下一项前检查，取消后不再启动新的云端调用。
      throwIfAborted(signal);
      const index = cursor++;
      try {
        const value = await fn(items[index], index);
        results[index] = { ok: true, value };
      } catch (err) {
        results[index] = {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
  };
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: poolSize }, worker));
  return results;
}

// ============================================================
// 主入口
// ============================================================

/**
 * Run the LONG_VIDEO_REWRITE orchestration:
 *   split → Kimi → reduce → outline → 3 段顺序 rewrite → result POST。
 *
 * @param input - LongVideoRewriteInput
 * @param ctx   - OrchestratorContext (apiBase + authCookie? + machineId? + ffmpeg + logger)
 * @returns RenderJobResult；outputUrl 仅在 input.outputUploadUrl 设了时存在（legacy）。
 *   meta 带 segmentCount/sourceScript/outline/rewrittenScript/targetEpisodeCount。
 * @throws 当输入非法、split 段数不符、Kimi 全段重试耗尽、DeepSeek 续写超上限、
 *   结构门禁失败、或 result POST 非 2xx。
 */
export async function longVideoRewrite(
  input: LongVideoRewriteInput,
  ctx: OrchestratorContext,
): Promise<RenderJobResult> {
  throwIfAborted(ctx.signal);
  // ---- 输入校验（早期 fail；必须在任何 totalDurationSec/totalBytes 使用之前，否则
  //      下游 toFixed/fingerprint 会对 undefined 崩）。throw 由 render-worker loop 捕获
  //      并 POST /api/render/jobs/[id]/failed → GenerationProgress 见 FAILED 终止 UI；
  //      OriginalRewriteStage 的进度轮询另有 R4 容错兜底。无需在此 report('failed')。
  //      ----
  if (!Number.isInteger(input.segments) || input.segments < 1) {
    throw new Error(`longVideoRewrite: invalid segment count ${input.segments}`);
  }
  if (!input.projectId) {
    throw new Error('longVideoRewrite: missing input.projectId (X3.4 requires /progress + /result routes)');
  }
  if (!input.totalDurationSec || input.totalDurationSec <= 0) {
    throw new Error(`longVideoRewrite: invalid totalDurationSec ${input.totalDurationSec}`);
  }
  if (!input.totalBytes || input.totalBytes <= 0) {
    throw new Error(`longVideoRewrite: invalid totalBytes ${input.totalBytes}`);
  }
  // Capture as narrowed consts so closures below inherit the non-undefined narrowing.
  const totalDurationSec = input.totalDurationSec;
  const totalBytes = input.totalBytes;

  const startedAt = Date.now();
  const projectId = input.projectId;

  // ---- 分段方案 ----
  // dispatch route (original-video-upload) 已用 calculateKimiSegmentPlan 算出
  // input.segments 并写入 render_job.input；orchestrator 信任该值，不重算（避免
  // 双源真理）。仅推导 segmentDurationSec + maxSegmentSec 用于 fingerprint / payload。
  const segmentCount = input.segments;
  const maxSegmentSec = input.segmentSec ?? DEFAULT_KIMI_MAX_SEGMENT_SEC;
  const segmentDurationSec = totalDurationSec / segmentCount;

  // ---- 断点目录 + fingerprint ----
  const fingerprint = computeFingerprint(
    projectId,
    totalBytes,
    totalDurationSec,
    segmentCount,
    segmentDurationSec,
  );
  const baseDir = input.checkpointDir ?? os.tmpdir();
  const workingDir = path.join(
    baseDir,
    'dramaforge-long-video-checkpoints',
    `${safeProjectIdSeg(projectId)}-${fingerprint}`,
  );
  const analysisCheckpointDir = path.join(workingDir, 'analysis-checkpoints');
  await fs.mkdir(workingDir, { recursive: true });
  await fs.mkdir(analysisCheckpointDir, { recursive: true });
  const generationCheckpointPath = path.join(workingDir, 'generation-checkpoint.json');

  // ---- 进度回调 ----
  const report = makeReporter(ctx, projectId, segmentCount + 3);

  // ---- 模型选择（input 默认 → app1 env 默认）----
  const kimiModel = input.kimiModel ?? DEFAULT_KIMI_MODEL;
  const outlineModel = input.outlineModel ?? DEFAULT_OUTLINE_MODEL;
  const rewriteModel = input.rewriteModel ?? DEFAULT_REWRITE_MODEL;

  const timingsMs: LongVideoTimingsMs = {
    splitting: 0,
    kimi: 0,
    reducing: 0,
    outlining: 0,
    scripting: 0,
  };
  let completedSuccessfully = false;
  // 失败时 report 一次 failed；finally 清场。
  let reportedFailed = false;

  // 读生成断点（initialOutline / canonicalDirectorBoard / rewriteStageContents 等）
  let generationCheckpoint = await readGenerationCheckpoint(
    generationCheckpointPath,
    fingerprint,
  );
  const persistGenerationCheckpoint = async (): Promise<void> => {
    generationCheckpoint.updatedAt = new Date().toISOString();
    await atomicWriteJson(generationCheckpointPath, generationCheckpoint);
  };

  // C/S 恢复：route 只注入已存文本元数据，客户端校验同一视频指纹后重建断点。
  // 媒体仍留在本机；指纹不匹配时绝不把旧剧本拼到新视频上。
  const regenerateFromEpisode = Number(input.regenerateFromEpisode);
  if (
    Number.isInteger(regenerateFromEpisode)
    && regenerateFromEpisode > 1
    && !generationCheckpoint.initialOutline
  ) {
    generationCheckpoint = buildRegenerationCheckpoint({
      fingerprint,
      regenerateFromEpisode,
      previousScript: input.previousNovelText?.trim() ?? '',
      saved: input.previousLongVideoRewrite ?? {},
      reuseTargetStageDraft: input.reuseTargetStageDraft,
    });
    await persistGenerationCheckpoint();
    await report(
      'outlining',
      60,
      `已恢复第 1-${Math.max(0, regenerateFromEpisode - 1)} 集之前的完整生产阶段，将从第 ${regenerateFromEpisode} 集所在阶段重新生成`,
    );
  }

  let sourceScript = input.sourceScriptOverride?.trim() || '';

  try {
    // ============================================================
    // 阶段 1+2：splitting (0-8%) + transcribing (10-55%)
    // ============================================================
    if (sourceScript) {
      // 已有 Kimi 分析稿 → 跳过 split + Kimi，直接进 reduce/outline。
      await report(
        'splitting',
        8,
        '已复用当前视频保存的 Kimi 分析稿，无需重新拆分或上传',
      );
      await report(
        'transcribing',
        55,
        '已恢复完整视频分析稿，直接重新生成大纲与剧本',
        segmentCount,
      );
    } else {
      // ---------- 阶段 1：splitting ----------
      await report(
        'splitting',
        3,
        `按 ${segmentCount} 段等长拆分，每段约 ${segmentDurationSec.toFixed(2)} 秒`,
      );

      // 断点复用：workingDir 已有 N 段 segment-NNN.mp4 且非空 → 直接用
      const existingSegmentNames = (await fs.readdir(workingDir))
        .filter((name) => /^segment-\d+\.mp4$/.test(name))
        .sort();
      const canReuseSplit =
        existingSegmentNames.length === segmentCount
        && (
          await Promise.all(
            existingSegmentNames.map(async (name) => {
              const stat = await fs.stat(path.join(workingDir, name)).catch(() => null);
              return Boolean(stat && stat.size > 0);
            }),
          )
        ).every(Boolean);

      const splitStartedAt = Date.now();
      const segments: VideoSegment[] = canReuseSplit
        ? existingSegmentNames.map((name, index) => ({
            path: path.join(workingDir, name),
            startSec: index * segmentDurationSec,
            endSec: Math.min(totalDurationSec, (index + 1) * segmentDurationSec),
            index,
          }))
        : ctx.signal
          ? await ctx.ffmpeg.splitVideoForKimi(
              input.videoUrl,
              segmentCount,
              segmentDurationSec,
              workingDir,
              ctx.signal,
            )
          : await ctx.ffmpeg.splitVideoForKimi(
              input.videoUrl,
              segmentCount,
              segmentDurationSec,
              workingDir,
            );
      timingsMs.splitting = Date.now() - splitStartedAt;

      if (segments.length !== segmentCount) {
        throw new Error(
          `视频拆分数量异常：预计 ${segmentCount} 段，实际 ${segments.length} 段`,
        );
      }
      if (canReuseSplit) {
        await report(
          'splitting',
          8,
          `已恢复 ${segments.length} 个本地视频分片，无需重新拆分`,
        );
      } else {
        await report('splitting', 8, `已拆分为 ${segments.length} 段`);
      }

      // ---------- 阶段 2：transcribing（并发 Kimi）----------
      const kimiConcurrency = resolveKimiSegmentConcurrency(segments.length, {
        // 客户端不知服务器 Kimi tier；默认 tier1=50，实际由 upload concurrency 卡 4。
        tier: 1,
      });
      const uploadConcurrency = resolveKimiUploadConcurrency(segments.length);

      const segmentScripts = new Array<string>(segments.length);
      const checkpointPath = (index: number): string =>
        path.join(
          analysisCheckpointDir,
          `segment-${String(index + 1).padStart(3, '0')}.json`,
        );
      const formatSegmentScript = (index: number, text: string): string => {
        const seg = segments[index];
        return `\n\n# 全片片段 ${index + 1}/${segments.length}（${seg.startSec.toFixed(3)}s-${seg.endSec.toFixed(3)}s）\n${text.trim()}`;
      };

      // 先把已断点段读出来
      let finished = 0;
      for (let i = 0; i < segments.length; i += 1) {
        const cp = await readSegmentCheckpoint(checkpointPath(i), fingerprint, i);
        if (!cp) continue;
        segmentScripts[i] = formatSegmentScript(i, cp.text);
        finished += 1;
      }

      await report(
        'transcribing',
        10 + Math.round((finished / segments.length) * 45),
        `Kimi：模型分析并发 ${kimiConcurrency}，文件上传并发 ${uploadConcurrency}；已恢复 ${finished}/${segments.length} 段`,
        finished,
      );

      const kimiStartedAt = Date.now();
      const outcomes = await mapWithConcurrency(segments, uploadConcurrency, async (seg) => {
        // 已断点段跳过（不重传 48MiB）
        if (segmentScripts[seg.index]) return { skipped: true as const, index: seg.index };
        const text = await callKimiSegment(ctx, seg, segments.length, kimiModel);
        // 持久化断点（原子写）
        const cp: SegmentCheckpoint = {
          version: 1,
          fingerprint,
          index: seg.index,
          startSec: seg.startSec,
          endSec: seg.endSec,
          text,
          completedAt: new Date().toISOString(),
        };
        await atomicWriteJson(checkpointPath(seg.index), cp);
        return { skipped: false as const, index: seg.index, text };
      }, ctx.signal);

      // 统计失败 + 填 segmentScripts
      const failures: Array<{ index: number; error: string }> = [];
      for (const res of outcomes) {
        if (res.ok) {
          const v = res.value;
          if (!v.skipped) {
            segmentScripts[v.index] = formatSegmentScript(v.index, v.text);
            finished += 1;
            await report(
              'transcribing',
              10 + Math.round((finished / segments.length) * 45),
              `Kimi 已完成 ${finished}/${segments.length} 段`,
              finished,
            );
          }
        } else {
          failures.push({ index: -1, error: res.error.message });
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `Kimi 分片处理失败 ${failures.length}/${segments.length}，已完成 ${finished}/${segments.length} 并保存断点；重试会跳过成功分片。${failures
            .slice(0, 8)
            .map((f) => f.error)
            .join('；')}`,
        );
      }
      timingsMs.kimi = Date.now() - kimiStartedAt;
      sourceScript = segmentScripts.join('');
    }

    // ============================================================
    // 阶段 3：outlining (55-74%)
    // ============================================================
    // 3a. Reduce（超长拼接稿）
    let reducedSource = sourceScript;
    const reductionStartedAt = Date.now();
    if (sourceScript.length > REDUCE_THRESHOLD_CHARS) {
      const chunks: string[] = [];
      for (let start = 0; start < sourceScript.length; start += REDUCE_CHUNK_CHARS) {
        chunks.push(sourceScript.slice(start, start + REDUCE_CHUNK_CHARS));
      }
      const reduceConcurrency = resolveDeepSeekReduceConcurrency(chunks.length);
      await report(
        'outlining',
        55,
        `DeepSeek Flash 分层归纳超长稿件 ${chunks.length} 段，并发 ${reduceConcurrency}`,
      );
      const reduceOutcomes = await mapWithConcurrency(
        chunks,
        reduceConcurrency,
        (chunk, i) =>
          callDeepSeekText(
            ctx,
            {
              system: '你是长视频剧本 MapReduce 的局部归纳器。忠实整理当前连续区间，不重写剧情。保留绝对时间码、角色别名与外貌线索、全部事件因果、关键对白、道具状态、秘密知情范围、段首/段尾未完成动作；继续剔除广告和重复回顾。不设置字数上限，不得为缩短输出而省略剧情。',
              user: `这是全剧拼接稿第 ${i + 1}/${chunks.length} 个连续区间：\n\n${chunk}`,
            },
            outlineModel,
            { maxTokens: DEFAULT_OUTLINE_MAX_TOKENS },
          ),
        ctx.signal,
      );
      const summaries: string[] = new Array(chunks.length);
      const reduceFailures: string[] = [];
      for (const [i, res] of reduceOutcomes.entries()) {
        if (res.ok) {
          summaries[i] = `# 连续区间 ${i + 1}/${chunks.length}\n${res.value.content}`;
        } else {
          reduceFailures.push(`区间 ${i + 1}: ${res.error.message}`);
        }
      }
      if (reduceFailures.length > 0) {
        throw new Error(
          `DeepSeek 分层归纳失败 ${reduceFailures.length}/${chunks.length} 段：${reduceFailures.slice(0, 4).join('；')}`,
        );
      }
      reducedSource = summaries.join('\n\n');
      await report(
        'outlining',
        59,
        `DeepSeek 分层归纳完成 ${chunks.length}/${chunks.length} 段`,
        chunks.length,
      );
    }
    timingsMs.reducing = Date.now() - reductionStartedAt;

    // 3b. 全剧大纲（[[GLOBAL_OUTLINE_COMPLETE]] 续写循环）
    await report('outlining', 60, 'DeepSeek 正在分析拼接剧本并生成详细大纲');
    const outlineStartedAt = Date.now();

    const checkpointTarget = Number(generationCheckpoint.targetEpisodeCount);
    const outlineEpisodeTarget = Number.isInteger(checkpointTarget) && checkpointTarget > 0
      ? checkpointTarget
      : generationCheckpoint.initialOutlineComplete && generationCheckpoint.initialOutline?.trim()
        ? inferTargetEpisodeCount(generationCheckpoint.initialOutline, totalDurationSec)
        : inferTargetEpisodeCount('', totalDurationSec);

    const outlinePrompt = buildOutlinePrompt(
      reducedSource,
      totalDurationSec,
      undefined,
      '这是供后三段正文使用的全局事件蓝图，不是正式剧本。每集只需明确本集事件、角色状态变化、关键因果和结尾钩子；不要扩写镜头动作、环境描写或完整对白。必须把全部集数连续规划到终章，并确保授衔、抓捕、身份揭露、枪战、婚礼等事件只分配一次，后续集只能承接结果，不得换集重演。集号是生产标记，关键对白内禁止让角色说"第X集"或"从第1集到现在"。',
    );
    const markedOutlinePrompt = {
      ...outlinePrompt,
      user: `${outlinePrompt.user}\n\n全剧目标为 ${outlineEpisodeTarget} 集。必须从第001集连续规划到第${String(outlineEpisodeTarget).padStart(3, '0')}集，并把该集写成完整终局；不得缺集、增集或为凑数注水。只有目标末集的全部事件与结尾钩子写完后，才在末尾单独输出一行 ${OUTLINE_COMPLETION_MARKER}。`,
    };

    let initialOutlineContent: string;
    if (
      generationCheckpoint.initialOutline
      && generationCheckpoint.initialOutlineComplete
    ) {
      initialOutlineContent = generationCheckpoint.initialOutline;
      await report('outlining', 62, '已从断点恢复全剧大纲');
    } else {
      let outlineContent = generationCheckpoint.initialOutline || '';
      let outlinePartCount = outlineContent ? 1 : 0;
      if (!outlineContent) {
        const result = await callDeepSeekText(ctx, markedOutlinePrompt, outlineModel, {
          maxTokens: DEFAULT_OUTLINE_MAX_TOKENS,
        });
        outlineContent = stripMetaCommentary(result.content);
        outlinePartCount = 1;
        generationCheckpoint.initialOutline = outlineContent;
        generationCheckpoint.initialOutlineComplete = false;
        await persistGenerationCheckpoint();
      } else {
        await report(
          'outlining',
          62,
          '检测到未完成的全剧大纲断点，正在从原文末尾续写',
        );
      }
      while (
        !outlineContent.includes(OUTLINE_COMPLETION_MARKER)
        && outlinePartCount < MAX_CONTINUATION_PARTS
      ) {
        outlinePartCount += 1;
        const tail = outlineContent.slice(-24_000);
        const lastEpisode = Math.max(0, ...extractEpisodeNumbers(outlineContent));
        await report(
          'outlining',
          Math.min(72, 60 + outlinePartCount),
          `全剧大纲尚未到终章，正在无缝续写第 ${outlinePartCount} 段`,
        );
        const result = await callDeepSeekText(
          ctx,
          {
            system: markedOutlinePrompt.system,
            user: `${markedOutlinePrompt.user}\n\n--- 已生成大纲末尾开始 ---\n${tail}\n--- 已生成大纲末尾结束 ---\n\n上文目前写到第 ${lastEpisode} 集附近，但尚未完整到终局。请从最后一个完整行之后无缝续写，不得重头开始、不得重复已有集数或事件；先补完被截断的当前集，再按连续集号完成后续集数和全剧终章。只有终局全部写完后，最后单独输出 ${OUTLINE_COMPLETION_MARKER}。`,
          },
          outlineModel,
          { maxTokens: DEFAULT_OUTLINE_MAX_TOKENS },
        );
        outlineContent = appendModelContinuation(
          outlineContent,
          stripMetaCommentary(result.content),
        );
        generationCheckpoint.initialOutline = outlineContent;
        generationCheckpoint.initialOutlineComplete = false;
        await persistGenerationCheckpoint();
      }
      if (!outlineContent.includes(OUTLINE_COMPLETION_MARKER)) {
        throw new Error(
          `全剧大纲连续 ${MAX_CONTINUATION_PARTS} 段仍未完成终局，任务不会使用截断大纲`,
        );
      }
      const completedInitialOutline = outlineContent
        .split(OUTLINE_COMPLETION_MARKER)
        .join('')
        .trim();
      const outlineEpisodes = extractEpisodeNumbers(completedInitialOutline);
      const lastOutlineEpisode = Math.max(0, ...outlineEpisodes);
      const missingOutlineEpisodes = Array.from(
        { length: outlineEpisodeTarget },
        (_, i) => i + 1,
      ).filter((ep) => !outlineEpisodes.includes(ep));
      if (
        lastOutlineEpisode !== outlineEpisodeTarget
        || missingOutlineEpisodes.length > 0
      ) {
        throw new Error(
          `全剧大纲结构不完整：动态目标为 ${outlineEpisodeTarget} 集，实际末集为第 ${lastOutlineEpisode} 集，缺少第 ${missingOutlineEpisodes.join('、') || '无'} 集`,
        );
      }
      initialOutlineContent = completedInitialOutline;
      generationCheckpoint.initialOutline = completedInitialOutline;
      generationCheckpoint.initialOutlineComplete = true;
      // 蓝图补全后保留本次权威目标集数，其余下游缓存必须全部失效。
      generationCheckpoint.canonicalDirectorBoard = undefined;
      generationCheckpoint.targetEpisodeCount = outlineEpisodeTarget;
      generationCheckpoint.authoritativeOutlineParts = undefined;
      generationCheckpoint.rewriteStageContents = undefined;
      generationCheckpoint.rewriteRepairDrafts = undefined;
      generationCheckpoint.stageDirectorBoards = undefined;
      await persistGenerationCheckpoint();
    }

    // 大纲去重（续写可能重打 第N集 标题）
    const normalizedInitialOutline = normalizeOutlineContinuationHeadings(
      initialOutlineContent,
    );
    if (normalizedInitialOutline !== initialOutlineContent) {
      initialOutlineContent = normalizedInitialOutline;
      generationCheckpoint.initialOutline = normalizedInitialOutline;
      generationCheckpoint.canonicalDirectorBoard = undefined;
      generationCheckpoint.authoritativeOutlineParts = undefined;
      generationCheckpoint.rewriteStageContents = undefined;
      generationCheckpoint.rewriteRepairDrafts = undefined;
      generationCheckpoint.stageDirectorBoards = undefined;
      await persistGenerationCheckpoint();
    }

    const storyBible = extractOutlineStoryBible(initialOutlineContent);
    const targetEpisodeCount = inferTargetEpisodeCount(
      initialOutlineContent,
      totalDurationSec,
    );
    generationCheckpoint.targetEpisodeCount = targetEpisodeCount;
    const outlineRanges = buildThreeStageEpisodeRanges(targetEpisodeCount);

    // 3c. 导演连续性板（canonical）
    let canonicalDirectorBoard = generationCheckpoint.canonicalDirectorBoard || '';
    if (!canonicalDirectorBoard) {
      const boardResult = await callDeepSeekText(
        ctx,
        {
          system: [
            '你是影视项目的场记总监，只整理事实，不创作新剧情。',
            '建立一份全剧唯一权威的导演连续性板：统一角色正式姓名与所有别名，明确不可漂移的亲属/婚恋/敌对关系、身份职业、年龄与外貌锚点。',
            '按全局分集蓝图记录重大事件只能在哪一段发生，尤其是死亡、重伤、入狱/释放、身份揭露、关系确认、道具易主等不可逆状态。',
            '同名或近名角色若证据不足，不得擅自合并；存在冲突时列入"待确认冲突"，后续剧本不得自行改变身份来消解冲突。',
            '输出可直接给编剧和场记使用的 Markdown 表格与状态清单，不要前言、不要改写故事。',
          ].join('\n'),
          user: `全剧目标 ${targetEpisodeCount} 集。请根据以下全局大纲建立导演连续性板。\n\n${initialOutlineContent}`,
        },
        outlineModel,
        { maxTokens: DEFAULT_BOARD_MAX_TOKENS },
      );
      canonicalDirectorBoard = boardResult.content;
      generationCheckpoint.canonicalDirectorBoard = canonicalDirectorBoard;
      await persistGenerationCheckpoint();
      await report('outlining', 63, 'DeepSeek Flash 正在建立全剧导演连续性板');
    } else {
      await report('outlining', 63, '已从断点恢复全剧导演连续性板');
    }

    // 3d. authoritativeOutlineParts（按集号从全局大纲切三段）
    const authoritativeOutlineParts = outlineRanges.map(
      (range) =>
        `### 权威分集大纲：第${range.start}-${range.end}集\n${extractOutlineEpisodeRange(
          initialOutlineContent,
          range,
          targetEpisodeCount,
        )}`,
    );
    generationCheckpoint.authoritativeOutlineParts = authoritativeOutlineParts;
    await persistGenerationCheckpoint();
    for (const [index, range] of outlineRanges.entries()) {
      await report(
        'outlining',
        64 + Math.round(((index + 1) / outlineRanges.length) * 10),
        `已从全剧蓝图锁定第 ${range.start}-${range.end} 集（${index + 1}/${outlineRanges.length}）`,
        index + 1,
      );
    }
    const completedOutline = `${storyBible}\n\n## 导演连续性板\n${canonicalDirectorBoard}\n\n${authoritativeOutlineParts.join('\n\n')}`;
    timingsMs.outlining = Date.now() - outlineStartedAt;

    // ============================================================
    // 阶段 4：scripting (78-96%) — 3 段顺序重写
    // ============================================================
    await report(
      'scripting',
      78,
      `DeepSeek 正在三段顺序生成完整 ${targetEpisodeCount} 集剧本`,
    );
    const scriptingStartedAt = Date.now();
    const rewriteRanges = buildThreeStageEpisodeRanges(targetEpisodeCount);
    const rewriteStageContents: string[] = generationCheckpoint.rewriteStageContents || [];
    const rewriteRepairDrafts: string[] = generationCheckpoint.rewriteRepairDrafts || [];
    const stageDirectorBoards: string[] = generationCheckpoint.stageDirectorBoards || [];
    let rewritePartCount = rewriteStageContents.filter(Boolean).length;

    for (const [index, range] of rewriteRanges.entries()) {
      const sourceSlice = sliceSourceForEpisodeRange(reducedSource, range, targetEpisodeCount);
      const currentOutline = `${storyBible}\n\n## 全剧导演连续性板\n${canonicalDirectorBoard}\n\n${authoritativeOutlineParts[index]}`;
      const priorScript = rewriteStageContents.slice(0, index).filter(Boolean).join('\n\n');
      const priorStageBoard = stageDirectorBoards[index - 1] || '';
      const priorTail = priorScript.slice(-12_000);

      const inspectStageIssues = (content: string): string[] => [
        ...inspectScriptRangeStructure(content, range),
        ...(range.end >= SEMANTIC_GATE_START_EPISODE
          ? inspectScriptSemanticDuplicates(content, range, priorScript)
          : []),
      ];

      const continuityRequirement =
        index === 0
          ? '这是第一段。只展开完整分集蓝图与原始剧情的前1/3，建立稳定的人物关系和状态；故事概要中的终局不得提前发生。'
          : `这是第 ${index + 1}/3 段。开场必须从上一段最后场景的准确地点、时段、人物站位、服装、手中道具和未完成动作继续；如需跳时空，必须先写出明确转场。任何在押人物不得无释放/保释过程出现在家中，任何死亡人物不得复活，已经完成的抓捕、身份揭露、手术或关系确认不得重新当作首次事件。\n\n--- 上一段导演板（最高优先级状态快照）---\n${priorStageBoard}\n--- 上一段导演板结束 ---\n\n--- 上一段末尾原文（必须逐镜承接）---\n${priorTail}\n--- 上一段末尾结束 ---\n\n以下已生成的前 ${index}/3 剧本全文是不可推翻的连续性事实；导演板未列出的历史状态以全文为准。\n\n--- 已生成前文全文开始 ---\n${priorScript}\n--- 已生成前文全文结束 ---`;

      const rewritePrompt = buildRewriteFromOutlinePrompt(
        sourceSlice,
        currentOutline,
        totalDurationSec,
        continuityRequirement,
        { ...range, total: targetEpisodeCount },
      );

      // 若断点中已有此段稿，先 normalize + 结构门禁；不合格则丢回 repairDrafts 等重做。
      let stageContent = normalizeInBodyEpisodeReferences(
        rewriteStageContents[index] || rewriteRepairDrafts[index] || '',
      );
      let structureIssues = stageContent ? inspectStageIssues(stageContent) : [];
      if (stageContent && structureIssues.length > 0) {
        rewriteStageContents.splice(index);
        rewriteRepairDrafts[index] = stageContent;
        rewriteRepairDrafts.splice(index + 1);
        stageDirectorBoards.splice(index);
        generationCheckpoint.rewriteStageContents = rewriteStageContents;
        generationCheckpoint.rewriteRepairDrafts = rewriteRepairDrafts;
        generationCheckpoint.stageDirectorBoards = stageDirectorBoards;
        await persistGenerationCheckpoint();
        await report(
          'scripting',
          78 + index * 6,
          `断点中的第 ${range.start}-${range.end} 集未通过结构门禁，正在自动返修：${structureIssues.slice(0, 4).join('；')}`,
          index,
        );
      }

      if (!stageContent) {
        const result = await callDeepSeekForEpisodeRange(
          ctx,
          rewritePrompt,
          rewriteModel,
          range,
          {
            stage: 'scripting',
            progress: 78 + index * 6,
            label: `第 ${range.start}-${range.end} 集剧本`,
            report,
          },
        );
        stageContent = normalizeInBodyEpisodeReferences(result.content);
        rewritePartCount += result.partCount;
      } else if (structureIssues.length === 0) {
        await report(
          'scripting',
          80 + index * 6,
          `已从断点恢复第 ${index + 1}/${rewriteRanges.length} 段完整剧本`,
          index + 1,
        );
      }

      // 结构门禁 + 最多 MAX_STRUCTURE_RETRIES 次 return repair
      structureIssues = inspectStageIssues(stageContent);
      if (structureIssues.length > 0) {
        rewriteRepairDrafts[index] = stageContent;
        generationCheckpoint.rewriteRepairDrafts = rewriteRepairDrafts;
        await persistGenerationCheckpoint();
      }
      for (
        let repairAttempt = 1;
        structureIssues.length > 0 && repairAttempt <= MAX_STRUCTURE_RETRIES;
        repairAttempt += 1
      ) {
        const issueEpisodes = structureIssues
          .map((issue) => Number(issue.match(/^第(\d+)集/)?.[1]))
          .filter((ep) => Number.isFinite(ep));
        const targetableIssues = structureIssues.every((issue) => !issue.includes('标题数量'));
        const repairRanges =
          targetableIssues && issueEpisodes.length > 0
            ? buildEpisodeRanges(issueEpisodes, 12)
            : [range];

        for (const repairRange of repairRanges) {
          const currentIssueEpisodes = new Set(
            structureIssues
              .map((issue) => Number(issue.match(/^第(\d+)集/)?.[1]))
              .filter((ep) => Number.isFinite(ep)),
          );
          if (
            targetableIssues
            && !Array.from(currentIssueEpisodes).some(
              (ep) => ep >= repairRange.start && ep <= repairRange.end,
            )
          ) {
            continue;
          }
          const repairIssues = structureIssues.filter((issue) => {
            const ep = Number(issue.match(/^第(\d+)集/)?.[1]);
            return (
              !Number.isFinite(ep) || (ep >= repairRange.start && ep <= repairRange.end)
            );
          });
          const repairOutline = `${storyBible}\n\n## 全剧导演连续性板\n${canonicalDirectorBoard}\n\n${extractOutlineEpisodeRange(
            authoritativeOutlineParts[index],
            repairRange,
            targetEpisodeCount,
          )}`;
          const repairSource = sliceSourceForEpisodeRange(
            reducedSource,
            repairRange,
            targetEpisodeCount,
          );
          const repairDraftContext = extractScriptEpisodeRange(stageContent, {
            start: Math.max(range.start, repairRange.start - 1),
            end: Math.min(range.end, repairRange.end + 1),
          });
          const repairContinuity = [
            continuityRequirement,
            '',
            '## 结构返修（最高优先级）',
            `上一版未通过生产门禁：${repairIssues.join('；')}。`,
            `只完整重写第 ${repairRange.start}-${repairRange.end} 集，不要输出范围外集数；这不是补写摘要，而是可直接替换原稿的完整正文。`,
            '每集至少写足 650 个中文字符，并保持 3~6 个可拍场次；动作、人物反应和完整对白都必须展开，禁止越往后越简略。',
            '不得改变上一版已经确定的事件顺序、人物身份、因果结果和本区间首尾衔接；只增加完成拍摄所需的动作、反应、对白和场面细节。',
            ...(repairIssues.some((issue) => issue.includes('重复已完成情节'))
              ? [
                  '重复门禁说明：被点名的早期集数已经真实发生，不得再复演其场景、动作或对白。把本集大纲中的重复描述视为历史回顾，只写该事件造成的新后果、新阻力和通往下一集的新行动。',
                  '禁止用换地点、换措辞或回忆闪回包装同一事件；本集必须让人物状态和剧情事实相对上一集向前变化。',
                ]
              : []),
            ...(repairIssues.some((issue) => issue.includes('以本人姓名称呼自己'))
              ? ['核对每句对白的说话人；角色不得以第二人称直呼自己的姓名，纠正明显对调的说话人标签。']
              : []),
            '',
            '--- 未通过门禁的上一版正文开始 ---',
            repairDraftContext,
            '--- 未通过门禁的上一版正文结束 ---',
          ].join('\n');
          const repairPrompt = buildRewriteFromOutlinePrompt(
            repairSource,
            repairOutline,
            totalDurationSec,
            repairContinuity,
            { ...repairRange, total: targetEpisodeCount },
          );
          const repairResult = await callDeepSeekForEpisodeRange(
            ctx,
            repairPrompt,
            rewriteModel,
            repairRange,
            {
              stage: 'scripting',
              progress: 79 + index * 6,
              label: `第 ${repairRange.start}-${repairRange.end} 集返修稿`,
              report,
            },
          );
          rewritePartCount += repairResult.partCount;
          stageContent =
            repairRange.start === range.start && repairRange.end === range.end
              ? repairResult.content
              : replaceScriptEpisodeRange(stageContent, repairResult.content, repairRange);
          stageContent = normalizeInBodyEpisodeReferences(stageContent);
          structureIssues = inspectStageIssues(stageContent);
          if (structureIssues.length > 0) {
            rewriteRepairDrafts[index] = stageContent;
            generationCheckpoint.rewriteRepairDrafts = rewriteRepairDrafts;
            await persistGenerationCheckpoint();
          }
        }
      }
      if (structureIssues.length > 0) {
        throw new Error(
          `第 ${range.start}-${range.end} 集生产结构校验失败：${structureIssues.slice(0, 12).join('；')}`,
        );
      }

      rewriteStageContents[index] = stageContent;
      rewriteRepairDrafts[index] = '';
      generationCheckpoint.rewriteStageContents = rewriteStageContents;
      generationCheckpoint.rewriteRepairDrafts = rewriteRepairDrafts;
      await persistGenerationCheckpoint();

      // 段间导演板冻结（最后一段不需要）
      if (index < rewriteRanges.length - 1 && !stageDirectorBoards[index]) {
        const stageBoardResult = await callDeepSeekText(
          ctx,
          {
            system: [
              '你是影视剧场记总监。只从已完成正文提取段尾事实，不续写、不评价、不修改剧情。',
              '输出一份供下一段直接继承的导演板：最后一场的地点/时段/人物站位/服装/手中物/未完成动作；每个出场人物的生死、伤病、在押/释放、最后位置；已确认的身份关系与知情范围；关键道具归属；已经完成且绝不能再次作为首次发生的事件。',
              '姓名和关系必须服从全剧导演连续性板。正文若与全剧板冲突，明确列入"正文冲突警报"，不得自行改名或改关系。',
              '不要省略配角的在押、住院、死亡和失踪状态。只输出 Markdown 状态表与清单。',
            ].join('\n'),
            user: `--- 全剧导演连续性板 ---\n${canonicalDirectorBoard}\n--- 全剧导演板结束 ---\n\n${priorStageBoard ? `--- 上一段继承状态 ---\n${priorStageBoard}\n--- 上一段状态结束 ---\n\n` : ''}--- 刚完成的第 ${range.start}-${range.end} 集正文 ---\n${stageContent}\n--- 本段正文结束 ---`,
          },
          outlineModel,
          { maxTokens: DEFAULT_BOARD_MAX_TOKENS },
        );
        stageDirectorBoards[index] = stageBoardResult.content;
        generationCheckpoint.stageDirectorBoards = stageDirectorBoards;
        await persistGenerationCheckpoint();
        await report(
          'scripting',
          83 + index * 6,
          `DeepSeek Flash 正在冻结第 ${index + 1}/${rewriteRanges.length} 段导演板`,
        );
      }
      await report(
        'scripting',
        78 + Math.round(((index + 1) / rewriteRanges.length) * 18),
        `DeepSeek Pro 已完成三段式剧本 ${index + 1}/${rewriteRanges.length} 段（无总字数上限）`,
        index + 1,
      );
    }

    // 最终合并 + 角色名规范化（导演板优先）+ 集完整性校验
    const rewrittenContent = normalizeCanonicalCharacterNames(
      rewriteStageContents
        .map((content, index) =>
          index === 0
            ? content
            : content.replace(/^《[^》+]+》第\d+-\d+集正式剧本\s*/u, ''),
        )
        .join('\n\n')
        .trim(),
      canonicalDirectorBoard,
    );
    const missingScriptEpisodes = Array.from(
      { length: targetEpisodeCount },
      (_, i) => i + 1,
    ).filter((ep) => !extractEpisodeNumbers(rewrittenContent).includes(ep));
    if (missingScriptEpisodes.length > 0) {
      throw new Error(
        `完整剧本校验失败，仍缺少第 ${missingScriptEpisodes.join('、')} 集；任务不会保存截断稿`,
      );
    }
    timingsMs.scripting = Date.now() - scriptingStartedAt;

    // ============================================================
    // 阶段 5：completed (100%) — POST /result 落库
    // ============================================================
    const completedAt = new Date().toISOString();
    const longVideoRewritePayload: LongVideoRewriteResult = {
      sourceScript,
      initialOutline: initialOutlineContent,
      outline: completedOutline,
      rewrittenScript: rewrittenContent,
      directorBoard: canonicalDirectorBoard,
      stageDirectorBoards,
      targetEpisodeCount,
      analysisFingerprint: fingerprint,
      sourceFileSizeBytes: totalBytes,
      sourceVideoUrl: input.videoUrl,
      sourceFilename: input.sourceFilename,
      segmentPlan: {
        segmentCount,
        segmentDurationSec,
        totalDurationSec,
        maxSegmentSec,
      },
      timingsMs,
    };
    await postResult(ctx, projectId, {
      novelText: rewrittenContent,
      videoScriptDraft: sourceScript,
      longVideoRewrite: longVideoRewritePayload as unknown as Record<string, unknown>,
      targetStatus: 'SCREENWRITING',
      completedAt,
    });
    await report('completed', 100, '视频转剧本、大纲与完整重写已完成');
    completedSuccessfully = true;

    // legacy MinIO 上传（仅 input.outputUploadUrl 设了时；新链路不传）
    let outputUrl: string | undefined;
    if (input.outputUploadUrl) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-longvideo-out-'));
      const localOut = path.join(tmpDir, 'long-video-rewrite.txt');
      try {
        await fs.writeFile(localOut, rewrittenContent, 'utf8');
        if (ctx.signal) {
          await uploadArtifact(localOut, input.outputUploadUrl, ctx.signal);
        } else {
          await uploadArtifact(localOut, input.outputUploadUrl);
        }
        outputUrl = input.outputUploadUrl;
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    ctx.logger.info('longVideoRewrite completed', {
      projectId,
      segmentCount,
      targetEpisodeCount,
      durationMs: Date.now() - startedAt,
      rewriteParts: rewritePartCount,
    });

    return {
      outputUrl,
      meta: {
        segmentCount,
        sourceScript,
        outline: completedOutline,
        rewrittenScript: rewrittenContent,
        targetEpisodeCount,
        initialOutline: initialOutlineContent,
        directorBoard: canonicalDirectorBoard,
        fingerprint,
        rewriteParts: rewritePartCount,
        timingsMs,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // 服务端取消属于预期终止，不把项目进度误写成 FAILED。
    if (!ctx.signal?.aborted && !reportedFailed) {
      reportedFailed = true;
      await report('failed', 0, message).catch(() => undefined);
    }
    throw err;
  } finally {
    if (completedSuccessfully) {
      await fs.rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      ctx.logger.warn('longVideoRewrite 未完成，保留断点目录供重试复用', { workingDir });
    }
  }
}
