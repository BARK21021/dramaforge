"use client";

/**
 * useEpisodeTask — 按 episodeId + type 从 localStorage 读 taskId，喂给 useTaskStatus。
 *
 * 流程（F3 两路 taskId 传递）：
 *   1. 触发点击（InputStage handleSaveAndAnalyze / AnalyzingStage handleReanalyze /
 *      StoryboardStage runGenerate）：POST 202 返回 taskId → setTaskId 写 store。
 *   2. 本 hook 挂载（AnalyzingStage / StoryboardStage / InputStage 侧栏）时
 *      从 store 读 taskId → 喂 useTaskStatus → SSE 实时进度。
 *   3. 任务终态（COMPLETED/FAILED/CANCELLED/TIMEOUT）→ 自动 clearTaskId 防残留。
 *   4. 刷新后进 ANALYZING（内存 taskId 丢失）→ store 仍存 taskId → 本 hook
 *      读出 → useTaskStatus 校验：仍 RUNNING → GenerationProgress 接管；
 *      已终态 → 丢弃 key。
 *
 * 每次渲染都从 localStorage 读 taskId（getItem 同步 + 快），这让组件在同一
 * 挂载周期内 setTaskId 后能立即在下一次渲染读到新值（如 AnalyzingStage 点
 * 「重新分析」setTaskId → 触发 re-render → 本 hook 读到新 taskId → 进度条接管）。
 */

import * as React from "react";
import { useTaskStatus } from "./useTaskStatus";
import { getTaskId, clearTaskId } from "../lib/episode-task-store";

export type EpisodeTaskType = "STORY_ANALYZE" | "SHOT_AI";

export interface UseEpisodeTaskResult {
  /** 当前绑定的 taskId（store 中读出，终态后清空）。null = 无在途任务。 */
  taskId: string | null;
  /** useTaskStatus 返回的任务状态（COMPLETED/FAILED/RUNNING/...）。 */
  status: string | null;
  /** 进度百分比 0-100（SSE 驱动）。 */
  progress: number;
  /** 当前阶段标签（SSE stage 事件）。 */
  stage: string | null;
  /** useTaskStatus 仍在首次加载中（用于判断 task===null 是初始 vs 404）。 */
  loading: boolean;
}

const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
]);

export function useEpisodeTask(
  episodeId: string | null | undefined,
  type: EpisodeTaskType,
): UseEpisodeTaskResult {
  // 每次渲染从 store 读 taskId（同步 getItem，开销极低）。
  const taskId = episodeId ? getTaskId(type, episodeId) : null;

  // useTaskStatus 内部订阅 SSE + 5s 兜底轮询；taskId 为 null 时不发请求。
  const { task, loading } = useTaskStatus(taskId);

  const status = task?.status ?? null;
  const progress = task?.progress ?? 0;
  const stage = task?.stage ?? null;

  // 终态（COMPLETED/FAILED/CANCELLED/TIMEOUT）→ 清 store key。
  // 注意：不在「task===null && !loading」时清——useTaskStatus 初始 state 就是
  // task=null/loading=false，组件一挂载（刷新/切集回来）就会命中该条件把 taskId
  // 误清，导致刷新后进度条丢失（活跃会话靠 React state activeTaskId 才没暴露此 bug）。
  // 只在 fetch 回明确的终态 status 时才清；陈旧/找不到的 taskId 由用户「清除状态」按钮兜底。
  React.useEffect(() => {
    if (!taskId || !episodeId) return;
    if (status && TERMINAL_STATUSES.has(status)) {
      clearTaskId(type, episodeId);
    }
  }, [taskId, episodeId, type, status]);

  return { taskId, status, progress, stage, loading };
}
