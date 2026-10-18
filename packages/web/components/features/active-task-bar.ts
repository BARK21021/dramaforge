/**
 * @file active-task-bar.ts
 * @description 分集「当前后台任务」聚合条的纯逻辑
 *
 * 与组件解耦（无 React 依赖），便于在 vitest node 环境单测。
 * 被 ActiveTaskStatusBar（GenerationProgress.tsx）消费。
 *
 * 移植自 F:\app1\src\components\features\active-task-bar.ts；dramaforge 额外登记
 * VIDEO_TO_SCRIPT，保证同步流式任务刷新恢复后仍显示明确业务名称。
 */

/** 活跃（非终态）任务状态：聚合整体进度时只统计这些。与 TaskStatus 对应。 */
export const ACTIVE_TASK_STATUSES = ["PENDING", "QUEUED", "RUNNING"] as const;

/**
 * TaskType → 中文展示标签。未命中者由 getTaskLabel 回退。
 * 取值与 app1 src/core/types/task.ts 的 TaskType 联合类型一一对应。
 */
const TASK_TYPE_LABELS: Record<string, string> = {
  STORY_ANALYZE: "剧本分析",
  SCRIPT_CONVERT: "剧本转换",
  EPISODE_SPLIT: "分集拆分",
  CHARACTER_PROFILE: "角色档案",
  SHOT_AI: "AI 分镜",
  STORY_EXPAND: "故事扩写",
  IMAGE_GENERATE: "图片生成",
  IMAGE_MODIFY: "图片修改",
  IMAGE_UNDO: "图片撤销",
  VIDEO_GENERATE: "视频生成",
  VIDEO_TO_SCRIPT: "视频转剧本",
  VIDEO_COMPOSITE: "视频合成",
  VOICE_GENERATE: "语音合成",
  LLM_CHAT: "AI 对话",
  LLM_STREAM: "AI 对话",
  LONG_VIDEO_REWRITE: "长视频重写",
  ASSET_IMAGE_GENERATE: "资产图片生成",
  FILM_EXPORT: "成片导出",
  CHAIN_GENERATE: "串联生成",
};

/**
 * 任务展示标签。
 * 已知类型用中文；未知 / 空类型回退「后台任务 {id 前 8 位}」，避免空白。
 */
export function getTaskLabel(type: string, taskId: string): string {
  if (type && TASK_TYPE_LABELS[type]) return TASK_TYPE_LABELS[type];
  return `后台任务 ${taskId.slice(0, 8)}`;
}

/**
 * 聚合多个任务进度为整体进度。
 *
 * - 单条进度先 clamp 到 [0,100]，再取平均并四舍五入。
 * - 无有效进度（空数组 / 全 NaN）时 percent 为 null，
 *   调用方据此切换为「脉冲态」展示（不显示数字）。
 */
export function computeOverallProgress(progresses: number[]): {
  count: number;
  percent: number | null;
} {
  const valid = progresses.filter((p) => Number.isFinite(p));
  if (valid.length === 0) return { count: 0, percent: null };
  const clamped = valid.map((p) => Math.min(100, Math.max(0, p)));
  const sum = clamped.reduce((acc, p) => acc + p, 0);
  return { count: valid.length, percent: Math.round(sum / valid.length) };
}
