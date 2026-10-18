// ============================================================
// useVideoUpload.ts — 转剧本上传的导航无关订阅 Hook
// ============================================================
//
// 把 video-upload-store（模块级单例，跨路由存活）接到 React：
//   - useSyncExternalStore 订阅 store 快照（taskId/uploading/error/...）
//   - mount / 切集时 seedFromStorage 灌入 sessionStorage 恢复指针（整页刷新兜底）
//   - useTaskStatus(taskId) 取服务端真实进度（模块级 SSE 单例，跨导航存活）
//   - 终态（COMPLETED/FAILED）单一所有者：markVideoUploadTerminal + onCompleted/onFailed
//
// 组件用法：
//   const { progress, busy, error, transportNotice, start, reportError } =
//     useVideoUpload(projectId, episodeId, { api, onCompleted, onFailed });
//
// 关键：onCompleted/onFailed 用 ref 持有最新闭包，避免内联回调导致 effect 重建。
// ============================================================

"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useTaskStatus } from "./useTaskStatus";
import { resolveVideoTaskProgress } from "../lib/video-to-script-progress";
import {
  getVideoUploadServerSnapshot,
  getVideoUploadState,
  markVideoUploadTerminal,
  reportVideoUploadError,
  seedFromStorage,
  startVideoUpload,
  subscribeVideoUpload,
} from "../lib/video-upload-store";

export interface UseVideoUploadOpts {
  /** useApi 装配的请求函数（透传给 store 发起上传）。 */
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  /** 任务 COMPLETED 时触发（锁已清）。script 非空时可即时回填，省一次重载。 */
  onCompleted?: (result: { script: string | null }) => void;
  /** 任务 FAILED/CANCELLED/TIMEOUT 时触发（锁已清，error 已落 store）。 */
  onFailed?: (error: string | null) => void;
}

export interface UseVideoUploadReturn {
  /** ProgressBar 展示模型（progress/stage/completed/busy）。 */
  progress: { progress: number; stage: string; completed: boolean; busy: boolean };
  /** 是否有在途任务（上传中 或 服务端处理中）。 */
  busy: boolean;
  /** 硬错误文案（前置校验 / 终态 FAILED）。 */
  error: string | null;
  /** 上传连接中断中性提示。 */
  transportNotice: string | null;
  /** 当前 taskId（供需要直查的调用方；一般用 progress 即可）。 */
  taskId: string | null;
  /** 启动上传（前置校验通过后调用）。sourceDurationSeconds 来自 readVideoDurationSeconds；model 为选中的 Kimi 模型 id（带前缀，可选）。 */
  start: (file: File, sourceDurationSeconds: number | null, model?: string) => void;
  /** 前置校验失败 / 重试前清错。msg=null 清空。 */
  reportError: (msg: string | null) => void;
}

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"] as const;

export function useVideoUpload(
  projectId: string,
  episodeId: string | null | undefined,
  opts: UseVideoUploadOpts,
): UseVideoUploadReturn {
  const { api } = opts;

  // 订阅 store 快照（稳定引用，仅本 key 变更时换新）。
  const state = useSyncExternalStore(
    subscribeVideoUpload,
    () => getVideoUploadState(projectId, episodeId ?? ""),
    getVideoUploadServerSnapshot,
  );

  // mount / 切集时灌入 sessionStorage 恢复指针（仅当内存无任务）。
  useEffect(() => {
    if (!episodeId) return;
    seedFromStorage(projectId, episodeId);
  }, [projectId, episodeId]);

  // 进度：useTaskStatus 背靠模块级 SSE 单例，跨导航存活。
  const { task } = useTaskStatus(state.taskId);
  const progress = resolveVideoTaskProgress(
    task,
    state.uploading,
    Boolean(state.taskId),
  );

  // ref 持有最新回调，避免内联闭包导致终态 effect 重建。
  const onCompletedRef = useRef(opts.onCompleted);
  onCompletedRef.current = opts.onCompleted;
  const onFailedRef = useRef(opts.onFailed);
  onFailedRef.current = opts.onFailed;
  // script 也走 ref：终态触发时读最新值（store 已 patch script）。
  const scriptRef = useRef(state.script);
  scriptRef.current = state.script;

  // 终态单一所有者：useTaskStatus 报终态且未处理过 → markTerminal + 回调。
  useEffect(() => {
    if (!episodeId || !state.taskId || state.handledTerminal) return;
    if (!task) return;
    const status = task.status;
    if (!TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number])) {
      return;
    }
    if (status === "COMPLETED") {
      markVideoUploadTerminal(projectId, episodeId, { status: "completed" });
      onCompletedRef.current?.({ script: scriptRef.current });
    } else {
      markVideoUploadTerminal(projectId, episodeId, {
        status: "failed",
        error: task.error,
      });
      onFailedRef.current?.(task.error ?? null);
    }
  }, [
    episodeId,
    projectId,
    state.taskId,
    state.handledTerminal,
    task,
  ]);

  const start = useCallback(
    (file: File, sourceDurationSeconds: number | null, model?: string) => {
      if (!episodeId) return;
      startVideoUpload(projectId, episodeId, file, api, { sourceDurationSeconds, model });
    },
    [api, episodeId, projectId],
  );

  const reportError = useCallback(
    (msg: string | null) => {
      if (!episodeId) return;
      reportVideoUploadError(projectId, episodeId, msg);
    },
    [episodeId, projectId],
  );

  return {
    progress,
    busy: progress.busy,
    error: state.error,
    transportNotice: state.transportNotice,
    taskId: state.taskId,
    start,
    reportError,
  };
}
