// ============================================================
// web/lib/video-to-script — 单集视频转剧本共享 helper（转绘 X2/X4.1/X4.2）
// ============================================================
//
// 把 X2 route 的 callAI('kimi', video_to_script) + 结果抽取逻辑抽成纯函数，供：
//   - X2  /api/projects/[id]/episodes/[episodeId]/video-to-script（单集，只写 videoScriptDraft）
//   - X4.1 /api/projects/[id]/video-to-script-full（项目级，自动建集 + 写 scriptData + 推进 stage）
//   - X4.2 /api/projects/[id]/video-batch-process（多集 for 循环复用）
//
// 设计：helper 只做 AI 调用 + meta 抽取 + 空剧本校验，**不落库**——调用方决定写哪些
// episode 字段（X2 只 videoScriptDraft；X4.1 额外 scriptData + stageStatus）。避免不同
// 路由对落库字段的诉求耦合进公共件。
//
// 抛错：EmptyScriptError（Kimi 返空）+ GatewayError（AI 上游失败）交调用方映射 HTTP。
// GC-1：Kimi key 只在 server（callAI cred 直传）。dramaforge-assets-client-local：新链路以
// ReadableStream 背压接力到 Kimi，不落盘也不整段驻留 RAM；Buffer 仅保留给旧调用兼容。
// ============================================================

import { callAI } from '@dramaforge/server';

/** Kimi 返回空剧本（调用方映射 502 EMPTY_SCRIPT）。 */
export class EmptyScriptError extends Error {
  readonly code = 'EMPTY_SCRIPT';
  constructor() {
    super('Kimi 未返回有效剧本，请重试或换一段视频');
    this.name = 'EmptyScriptError';
  }
}

export interface VideoToScriptOutcome {
  script: string;
  characters: unknown[];
  locations: unknown[];
  timePeriod: string | null;
  fileId: string | null;
  /** 平台成本（元），由 callAI 按视频转剧本 token 用量归因；null/0 不扣费。 */
  cost: number | null;
}

/** Kimi 单集视频处理的真实边界事件；route 将其映射到持久化任务百分比。 */
export interface VideoToScriptProgressEvent {
  stage:
    | 'file_received'
    | 'extracting_context'
    | 'context_extracted'
    | 'generating_script'
    | 'script_generated';
}

/**
 * 单集视频转剧本：callAI Kimi video_to_script → 抽取 script/characters/locations/
 * timePeriod/fileId。空剧本抛 EmptyScriptError。
 *
 * @param input.userId     计费/凭证归属
 * @param input.videoBytes 旧调用的内存字节；与 videoStream 二选一
 * @param input.videoStream 新调用的视频流（直接接力到 Kimi，不整段缓冲）
 * @param input.filename   原始文件名（Kimi Files API 上传用）
 * @param input.mimeType   MIME（mp4/webm/mov/mkv）
 * @param input.model      Kimi 模型 ID（默认由调用方给 'kimi-k2.6'）
 * @param input.onProgress Kimi 文件接收/两次 chat 的真实边界回调（不含正文或凭证）
 */
export async function runVideoToScript(input: {
  userId: string;
  videoBytes?: Buffer;
  videoStream?: ReadableStream<Uint8Array>;
  videoSize?: number;
  filename: string;
  mimeType: string;
  model: string;
  /** 仅传阶段事件，不传模型正文、文件内容或凭证。 */
  onProgress?: (event: VideoToScriptProgressEvent) => void | Promise<void>;
}): Promise<VideoToScriptOutcome> {
  const result = await callAI('kimi', input.model, {
    capability: 'video_to_script',
    userId: input.userId,
    input: {
      videoBytes: input.videoBytes,
      videoStream: input.videoStream,
      videoSize: input.videoSize,
      filename: input.filename,
      mimeType: input.mimeType,
      onProgress: input.onProgress,
    },
  });

  const meta = (result.meta ?? {}) as Record<string, unknown>;
  const script = typeof meta.script === 'string' ? meta.script : '';
  if (!script.trim()) throw new EmptyScriptError();
  return {
    script,
    characters: Array.isArray(meta.characters) ? meta.characters : [],
    locations: Array.isArray(meta.locations) ? meta.locations : [],
    timePeriod: typeof meta.timePeriod === 'string' ? meta.timePeriod : null,
    fileId: typeof meta.fileId === 'string' ? meta.fileId : null,
    cost: typeof result.cost === 'number' && result.cost > 0 ? result.cost : null,
  };
}
