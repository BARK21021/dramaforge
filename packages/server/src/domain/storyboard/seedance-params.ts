// ============================================================
// ③ server/domain/storyboard — Seedance 高级参数校验/清洗
// ============================================================
//
// 文件职责：
//   校验并清洗 seedanceGroupParams 对象，仅保留白名单字段且类型/枚举合法的项。
//   被 preset API、批量更新 API、撤销 API 复用。
//
// 移植自 app1 src/core/shot/seedance-params.ts（无改动，纯函数，零外部依赖）。
// ============================================================

const RESOLUTIONS = ['480p', '720p', '1080p', '4k'];
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

/**
 * 校验并清洗 seedanceGroupParams 对象。
 *
 * 仅保留白名单字段（seed/resolution/aspectRatio/generateAudio/watermark/returnLastFrame）
 * 且类型/枚举合法的项。
 *
 * @returns 清洗后的对象；若无有效字段返回 null
 */
export function sanitizeSeedanceParams(params: unknown): Record<string, unknown> | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  if (typeof p.seed === 'number' && Number.isFinite(p.seed)) {
    cleaned.seed = Math.trunc(p.seed);
  }
  if (typeof p.resolution === 'string' && RESOLUTIONS.includes(p.resolution)) {
    cleaned.resolution = p.resolution;
  }
  if (typeof p.aspectRatio === 'string' && ASPECT_RATIOS.includes(p.aspectRatio)) {
    cleaned.aspectRatio = p.aspectRatio;
  }
  if (typeof p.generateAudio === 'boolean') cleaned.generateAudio = p.generateAudio;
  if (typeof p.watermark === 'boolean') cleaned.watermark = p.watermark;
  if (typeof p.returnLastFrame === 'boolean') cleaned.returnLastFrame = p.returnLastFrame;
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/** 历史快照单条记录 */
export interface ParamsHistoryEntry {
  params: Record<string, unknown> | null;
  savedAt: string;
}

/** 从 shot.metadata 读取参数历史栈 */
export function readParamsHistory(metadata: unknown): ParamsHistoryEntry[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const m = metadata as Record<string, unknown>;
  return Array.isArray(m.seedanceGroupParamsHistory)
    ? (m.seedanceGroupParamsHistory as ParamsHistoryEntry[])
    : [];
}

/** 历史栈最大长度 */
export const MAX_HISTORY_LENGTH = 20;

/** 分镜允许的画幅白名单 */
export const SHOT_ASPECT_RATIOS = ASPECT_RATIOS;

/** 分镜允许的分辨率白名单 */
export const SHOT_RESOLUTIONS = RESOLUTIONS;
