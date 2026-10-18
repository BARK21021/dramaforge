// Migrated from D:\app1\src\core\video\long-video-plan.ts.
// Pure browser/client-safe — no ffmpeg / db / redis / server-only imports.
// 转绘 X1 补齐：原迁移漏了 calculateKimiSegmentPlan + 2 常量（Kimi Files API
// 字节约束版分段），现按 app1 原样补回。两个纯函数 + 类型，零依赖。

/** A browser-safe, balanced segmentation plan for long videos. */
export interface BalancedSegmentPlan {
  totalDurationSec: number;
  maxSegmentSec: number;
  segmentCount: number;
  segmentDurationSec: number;
}

/** Kimi Files API 单文件上限 100 MiB，生产默认留足码率波动余量。 */
const DEFAULT_KIMI_TARGET_SEGMENT_BYTES = 48 * 1024 * 1024;
/** 单段最多 10 分钟，兼顾视频理解质量与上传请求数量。 */
export const DEFAULT_KIMI_MAX_SEGMENT_SEC = 600;

/**
 * 同时按时长和文件大小规划 Kimi 视频片段。
 * 以原文件平均码率计算分片数，避免过去固定 150 秒并转成 4 Mbps 后
 * 把低码率长视频膨胀数倍再上传。
 */
export function calculateKimiSegmentPlan(
  totalDurationSec: number,
  totalBytes: number,
  maxSegmentSec: number = DEFAULT_KIMI_MAX_SEGMENT_SEC,
  targetSegmentBytes: number = DEFAULT_KIMI_TARGET_SEGMENT_BYTES,
): BalancedSegmentPlan {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error('视频文件大小必须为正数');
  }
  if (!Number.isFinite(targetSegmentBytes) || targetSegmentBytes <= 0) {
    throw new Error('片段目标大小必须为正数');
  }
  const durationPlan = calculateBalancedSegmentPlan(totalDurationSec, maxSegmentSec);
  const segmentCount = Math.max(
    durationPlan.segmentCount,
    Math.ceil(totalBytes / targetSegmentBytes),
  );
  return {
    totalDurationSec,
    maxSegmentSec,
    segmentCount,
    segmentDurationSec: totalDurationSec / segmentCount,
  };
}

/**
 * Split a duration into the fewest equal segments that do not exceed the
 * requested maximum duration. The actual segment duration is total / count.
 */
function calculateBalancedSegmentPlan(
  totalDurationSec: number,
  maxSegmentSec: number = 150,
): BalancedSegmentPlan {
  if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) {
    throw new Error('视频总时长必须为正数');
  }
  if (!Number.isFinite(maxSegmentSec) || maxSegmentSec <= 0) {
    throw new Error('片段目标时长必须为正数');
  }

  const segmentCount = Math.max(1, Math.ceil(totalDurationSec / maxSegmentSec));
  return {
    totalDurationSec,
    maxSegmentSec,
    segmentCount,
    segmentDurationSec: totalDurationSec / segmentCount,
  };
}

// ============================================================
// 转绘 X3.1：长视频整剧重写类型（从 app1 long-video-service.ts:38-110 + 1459-1476 抽取）
// 剥离 Prisma/DB 依赖；类型字段名照 app1 verbatim。
// ============================================================

/** 长视频处理阶段（联合字面量；持久化进 project.longVideoProgress JSONB）。 */
export type LongVideoStage =
  | 'splitting'     // 视频拆分中
  | 'transcribing'  // Whisper 转写中
  | 'outlining'     // 大纲生成中
  | 'scripting'     // 完整剧本生成中
  | 'episoding'     // 自动分集中
  | 'completed'     // 全部完成
  | 'failed';       // 失败

/** 长视频处理进度（持久化到 project.longVideoProgress）。 */
export interface LongVideoProgress {
  /** 关联后台任务 ID（上传完成后用于刷新恢复进度卡） */
  taskId?: string;
  /** 当前阶段 */
  stage: LongVideoStage;
  /** 整体进度（0-100） */
  progress: number;
  /** 当前步骤描述 */
  currentStep?: string;
  /** 总步骤数 */
  totalSteps?: number;
  /** 当前步骤序号 */
  currentStepIndex?: number;
  /** 错误信息（失败时） */
  error?: string;
  /** 更新时间戳 */
  updatedAt: string;
}

/**
 * 长视频分段方案（持久化进 scriptData.longVideoRewrite.segmentPlan）。
 * 字段与 BalancedSegmentPlan 同形，但作为独立类型保留以便后续业务字段独立演进。
 */
interface LongVideoSegmentPlan {
  segmentCount: number;
  segmentDurationSec: number;
  totalDurationSec: number;
  maxSegmentSec: number;
}

/** 长视频整剧重写各阶段实测耗时（毫秒）。 */
export type LongVideoTimingsMs = Record<
  'splitting' | 'kimi' | 'reducing' | 'outlining' | 'scripting',
  number
>;

/**
 * 长视频整剧重写产物（持久化进 project.scriptData.longVideoRewrite）。
 * 来源：app1 long-video-service.ts:1459-1476 写入字段。
 * 仅声明 X3.1 需要的核心字段；rewriteParts/rewriteBatches/generationStrategy/
 * stageRanges/completedAt 等运行期统计字段不纳入 X3.1 契约（按需后续补）。
 */
export interface LongVideoRewriteResult {
  /** 按时间顺序拼接的 Kimi 片段剧本 */
  sourceScript: string;
  /** DeepSeek 生成的初始大纲（merge 连续性板前的版本） */
  initialOutline: string;
  /** 已合并连续性板的最终大纲 */
  outline: string;
  /** 重写后的完整剧本文本 */
  rewrittenScript: string;
  /** 全局导演连续性板（canonical） */
  directorBoard?: string;
  /** 各生产批次的分段连续性板（按 stageRanges 顺序） */
  stageDirectorBoards?: string[];
  /** 全剧目标集数（由 inferTargetEpisodeCount 推导） */
  targetEpisodeCount: number;
  /** 用于断点恢复的指纹（视频文件特征） */
  analysisFingerprint: string;
  /** 源视频文件字节数 */
  sourceFileSizeBytes: number;
  /** 客户端受控 original-uploads 路径；项目迁移时会连同源视频一起改写。 */
  sourceVideoUrl?: string;
  /** 原始文件名，仅用于界面展示。 */
  sourceFilename?: string;
  /** 实际等长拆分方案 */
  segmentPlan?: LongVideoSegmentPlan;
  /** 各阶段实测耗时（毫秒） */
  timingsMs?: LongVideoTimingsMs;
}
