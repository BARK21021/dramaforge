/**
 * @file GenerationProgress.tsx
 * @description 生成进度组件
 *
 * 单个任务进度展示：进度条 + ETA + 取消/重试。
 * 数据来源：useTaskStatus（初始拉取 + 手动刷新）+ useSSE（实时事件）。
 *
 * 功能：
 *   - 实时进度百分比（SSE progress 事件 + 兜底轮询）
 *   - ETA 估算（基于 estimatedDuration + 已用时间 + 当前进度）
 *   - 阶段标签（SSE stage 事件，如"连接ARK API"、"生成中(第12/15镜头)"）
 *   - 取消按钮（DELETE /api/render/jobs/[taskId]，仅 RUNNING/QUEUED 状态显示）
 *   - 重试按钮（POST /api/render/jobs/[taskId]/retry，仅 FAILED 状态显示）
 *   - compact 模式：紧凑内联展示（用于卡片内嵌）
 *
 * GlobalGenerationStatus：全局生成状态条，展示当前所有 RUNNING 任务数 + 整体进度。
 * 固定在工作区顶部，无 props。
 *
 * ActiveTaskStatusBar：分集「当前后台任务」聚合折叠条，默认 1 行汇总，点击展开明细。
 *
 * 双色方案铁律：
 *   - 进度条使用 --action 蓝（可点击行为相关，表示"正在进行"）
 *   - 完成态使用 --success 绿
 *   - 失败态使用 --error 红
 *
 * dramaforge 适配点（vs app1 F:\app1\src\components\features\GenerationProgress.tsx）：
 *   - 相对路径 import（dramaforge 无 @/ alias）。
 *   - 取消/重试调用 dramaforge hooks 暴露的 cancelTask / retryTask 助手（已封装
 *     /api/render/jobs/{id} 路径 + 错误抛出）。
 *   - GlobalGenerationStatus 用 useTaskList({status:"RUNNING"}) 轮询当前用户作业。
 *   - 其余视觉 / ETA 算法 / 状态机 / SSE 订阅逻辑原样照搬 app1。
 *
 * @example
 * <GenerationProgress taskId="task-123" label="视频生成中" compact estimatedDuration={270} />
 */

"use client";

import * as React from "react";
import { cn } from "../ui/cn";
import { ProgressBar } from "../ui/ProgressBar";
import { Spinner } from "../ui/Spinner";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import {
  useSSE,
  useTaskStatus,
  useTaskList,
  trackTaskId,
  untrackTaskId,
  cancelTask,
  retryTask,
} from "../../hooks/useTaskStatus";
import {
  getTaskLabel,
  computeOverallProgress,
  ACTIVE_TASK_STATUSES,
} from "./active-task-bar";

// ============================================================
// 类型定义
// ============================================================

export interface GenerationProgressProps {
  /** 任务 ID */
  taskId: string;
  /** 进度标签（如"视频生成中"、"AI 生成图片中"） */
  label?: string;
  /** 是否紧凑模式（内联展示，用于卡片内嵌） */
  compact?: boolean;
  /** 预估总时长（秒，用于 ETA 计算） */
  estimatedDuration?: number;
  /** 容器额外类名 */
  className?: string;
  /** 任务完成回调（可选，用于父组件刷新数据） */
  onComplete?: () => void;
  /** 任务失败回调（可选） */
  onFailure?: (error: string | null) => void;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 格式化秒为 mm:ss
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * 计算已用时间（秒）
 */
function elapsedSince(createdAt: string | undefined): number {
  if (!createdAt) return 0;
  try {
    return (Date.now() - new Date(createdAt).getTime()) / 1000;
  } catch {
    return 0;
  }
}

/**
 * 估算剩余时间（ETA）
 *
 * 策略：
 *   1. 有 estimatedDuration + progress>0：eta = estimatedDuration * (1 - progress/100)
 *   2. 有 estimatedDuration + progress==0：eta = estimatedDuration
 *   3. 无 estimatedDuration：基于已用时间 + progress 估算（progress>0 时）
 *   4. 兜底：返回 null（不展示 ETA）
 */
function estimateETA(
  progress: number,
  estimatedDuration: number | undefined,
  elapsed: number,
): number | null {
  if (progress >= 100) return 0;
  if (estimatedDuration && estimatedDuration > 0) {
    if (progress > 0) {
      // 基于预估时长 + 当前进度线性插值
      return Math.max(0, estimatedDuration * (1 - progress / 100));
    }
    return estimatedDuration;
  }
  if (progress > 0 && elapsed > 0) {
    // 基于已用时间反推：总时长 = elapsed / (progress/100)，eta = 总时长 - elapsed
    const totalEstimated = elapsed / (progress / 100);
    return Math.max(0, totalEstimated - elapsed);
  }
  return null;
}

// ============================================================
// GenerationProgress 组件
// ============================================================

/**
 * 单个任务生成进度
 */
export function GenerationProgress({
  taskId,
  label = "生成中",
  compact = false,
  estimatedDuration,
  className,
  onComplete,
  onFailure,
}: GenerationProgressProps) {
  const toast = useToast();
  const { task, refetch } = useTaskStatus(taskId);
  const { events } = useSSE();

  /** 取消中 */
  const [cancelling, setCancelling] = React.useState(false);
  /** 重试中 */
  const [retrying, setRetrying] = React.useState(false);
  /** 是否已回调过完成/失败（避免重复触发） */
  const reportedRef = React.useRef<"completed" | "failed" | null>(null);

  // 注册 taskId 到全局跟踪（SSE 断线兜底轮询）
  React.useEffect(() => {
    if (taskId) {
      trackTaskId(taskId);
      return () => {
        untrackTaskId(taskId);
      };
    }
  }, [taskId]);

  // 监听 SSE 事件：匹配本 taskId 时刷新
  React.useEffect(() => {
    if (!taskId || events.length === 0) return;
    // 共享事件缓冲区按“最新在前”存放，必须找当前 taskId 的最新事件；
    // 旧实现取数组末尾，会长时间读到最旧事件，造成界面不刷新。
    const lastEvent = events.find((event) => event.taskId === taskId);
    if (!lastEvent) return;

    if (lastEvent.type === "status_change") {
      const status = lastEvent.status;
      if (status === "COMPLETED") {
        if (reportedRef.current !== "completed") {
          reportedRef.current = "completed";
          onComplete?.();
        }
        untrackTaskId(taskId);
      } else if (
        status === "FAILED" ||
        status === "CANCELLED" ||
        status === "TIMEOUT"
      ) {
        if (reportedRef.current !== "failed") {
          reportedRef.current = "failed";
          onFailure?.(lastEvent.error || null);
        }
        untrackTaskId(taskId);
      }
      refetch();
    } else if (lastEvent.type === "progress") {
      refetch();
    }
  }, [events, taskId, refetch, onComplete, onFailure]);

  // 页面刷新后可能直接读取到终态任务，此时不会再收到历史 SSE 事件。
  // 根据 HTTP 查询结果补发一次回调，确保持久化锁能够被清理。
  React.useEffect(() => {
    const status = task?.status;
    if (status === "COMPLETED" && reportedRef.current !== "completed") {
      reportedRef.current = "completed";
      onComplete?.();
      untrackTaskId(taskId);
    } else if (
      (status === "FAILED" ||
        status === "CANCELLED" ||
        status === "TIMEOUT") &&
      reportedRef.current !== "failed"
    ) {
      reportedRef.current = "failed";
      onFailure?.(task?.error || null);
      untrackTaskId(taskId);
    }
  }, [task?.status, task?.error, taskId, onComplete, onFailure]);

  // 派生状态
  const status = task?.status || "RUNNING";
  const progress = task?.progress ?? 0;
  const roundedProgress = Math.floor(Math.min(100, Math.max(0, progress)));
  const isCompleted = status === "COMPLETED";
  const isFailed =
    status === "FAILED" || status === "CANCELLED" || status === "TIMEOUT";
  const isRunning =
    status === "PENDING" ||
    status === "QUEUED" ||
    status === "CLAIMED" ||
    status === "RUNNING" ||
    status === "PROCESSING";
  const backend = task?.backend;
  // AI 任务取消走 DELETE /api/tasks（cancelTask 按 backend 分流）；AI 重试未实现故仅 render 可重试。
  const canCancel = backend === "render" || backend === "ai";
  const canRetry = backend === "render";
  const elapsed = elapsedSince(task?.createdAt);
  const eta = estimateETA(progress, estimatedDuration, elapsed);
  const stage =
    events.find((e) => e.taskId === taskId && e.stage)?.stage ||
    task?.stage ||
    task?.type;

  /**
   * 取消任务（dramaforge 适配：调用 hooks 暴露的 cancelTask 助手）
   */
  const handleCancel = async () => {
    if (!taskId || cancelling) return;
    if (!window.confirm("确认取消该生成任务？此操作不可撤销。")) return;
    setCancelling(true);
    try {
      await cancelTask(taskId, task?.backend);
      toast.success("任务已取消");
      refetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`取消失败：${msg}`);
    } finally {
      setCancelling(false);
    }
  };

  /**
   * 重试任务（dramaforge 适配：调用 hooks 暴露的 retryTask 助手）
   */
  const handleRetry = async () => {
    if (!taskId || retrying) return;
    setRetrying(true);
    reportedRef.current = null;
    try {
      await retryTask(taskId);
      toast.success("任务已重新提交");
      trackTaskId(taskId);
      refetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`重试失败：${msg}`);
    } finally {
      setRetrying(false);
    }
  };

  // 紧凑模式
  if (compact) {
    return (
      <div className={cn("w-full", className)}>
        <ProgressBar
          progress={roundedProgress}
          label={label}
          stage={stage}
          variant={isCompleted ? "success" : isFailed ? "danger" : "action"}
          size="sm"
          pulse={isRunning && progress < 100}
          completed={isCompleted}
          showPercent
        >
          {isRunning && canCancel && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              loading={cancelling}
              className="h-auto px-1 py-0 text-[10px] text-[var(--text-3)] hover:text-[var(--error)] transition-colors"
              title="取消任务"
            >
              {cancelling ? "取消中..." : "取消"}
            </Button>
          )}
        </ProgressBar>
        <div className="flex items-center justify-between mt-1 text-[10px] text-[var(--text-3)] tabular-nums">
          <span>
            {isCompleted ? (
              <span className="text-[var(--success)]">
                已完成 · 用时 {formatTime(elapsed)}
              </span>
            ) : isFailed ? (
              <span className="text-[var(--error)]">
                {status === "CANCELLED" ? "已取消" : "失败"}
                {task?.error ? `：${task.error}` : ""}
              </span>
            ) : (
              <span>
                已用 {formatTime(elapsed)}
                {eta !== null ? ` · 预计剩余 ${formatTime(eta)}` : ""}
              </span>
            )}
          </span>
          {isFailed && canRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              loading={retrying}
              className="h-auto px-1 py-0 text-[10px] text-[var(--action)] hover:text-[var(--action-hover)] transition-colors"
            >
              {retrying ? "重试中..." : "重试"}
            </Button>
          )}
        </div>
      </div>
    );
  }

  // 完整模式
  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--border-light)] bg-[var(--bg-2)] p-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* 状态图标 */}
          {isRunning ? (
            <Spinner size={16} label="任务生成中" className="flex-shrink-0 text-[var(--action)]" />
          ) : isCompleted ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              className="text-[var(--success)] flex-shrink-0"
            >
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              className="text-[var(--error)] flex-shrink-0"
            >
              <path
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span className="text-sm font-medium text-[var(--text)] truncate">
            {label}
          </span>
          {stage && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--action-dim)] text-[var(--action)] font-medium flex-shrink-0">
              {stage}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isRunning && canCancel && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              loading={cancelling}
              className="h-auto px-1 py-0 text-xs text-[var(--text-3)] hover:text-[var(--error)] transition-colors"
              title="取消任务"
            >
              {cancelling ? "取消中..." : "取消"}
            </Button>
          )}
          {isFailed && canRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              loading={retrying}
              className="h-auto px-1 py-0 text-xs text-[var(--action)] hover:text-[var(--action-hover)] transition-colors"
            >
              {retrying ? "重试中..." : "重试"}
            </Button>
          )}
        </div>
      </div>

      <ProgressBar
        progress={roundedProgress}
        variant={isCompleted ? "success" : isFailed ? "danger" : "action"}
        size="md"
        pulse={isRunning && progress < 100}
        completed={isCompleted}
        showPercent
      />

      <div className="flex items-center justify-between mt-2 text-xs text-[var(--text-3)] tabular-nums">
        <span>
          {isCompleted ? (
            <span className="text-[var(--success)]">
              已完成 · 用时 {formatTime(elapsed)}
            </span>
          ) : isFailed ? (
            <span className="text-[var(--error)]">
              {status === "CANCELLED" ? "已取消" : "生成失败"}
              {task?.error ? `：${task.error}` : ""}
            </span>
          ) : (
            <span>
              已用 {formatTime(elapsed)}
              {eta !== null ? ` · 预计剩余 ${formatTime(eta)}` : ""}
            </span>
          )}
        </span>
        {isRunning && estimatedDuration && (
          <span className="text-[var(--text-3)]">
            预估 {formatTime(estimatedDuration)}
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================
// GlobalGenerationStatus 组件
// ============================================================

/**
 * 全局生成状态条
 *
 * 固定在工作区顶部，展示当前用户所有 RUNNING 任务的数量与整体进度。
 * 无 props，自行通过 useTaskList({status:"RUNNING"}) 拉取并监听 SSE。
 *
 * dramaforge 适配：app1 原用内联 authFetch("/api/tasks?status=RUNNING") + 10s 轮询；
 * dramaforge 改用 useTaskList({status:"RUNNING"})；SSE 进度展示逻辑保持原样。
 */
export function GlobalGenerationStatus() {
  const { events } = useSSE();
  /** 运行中任务列表；页面刷新后由列表端点恢复。 */
  const { tasks } = useTaskList({ status: "RUNNING" });
  /** 运行中任务数（来自 useTaskList；空时回退 0） */
  const runningCount = tasks.length;
  /** 最近一次进度事件（用于显示动态进度条） */
  const [latestProgress, setLatestProgress] = React.useState<{
    taskId: string;
    progress: number;
    stage?: string;
  } | null>(null);

  // 监听 SSE 事件更新进度
  React.useEffect(() => {
    if (events.length === 0) return;
    const last = events[0];
    if (last.type === "progress") {
      setLatestProgress({
        taskId: last.taskId,
        progress: last.progress ?? 0,
        stage: last.stage,
      });
    } else if (last.type === "status_change") {
      // 状态变化时清掉最新进度展示（useTaskList 的下次轮询会刷新计数）
      if (
        last.status === "COMPLETED" ||
        last.status === "FAILED" ||
        last.status === "CANCELLED"
      ) {
        setLatestProgress(null);
      }
    }
  }, [events]);

  // 无运行中任务时不渲染
  if (runningCount === 0 && !latestProgress) return null;

  return (
    <div className="flex items-center gap-2 px-3 sm:px-6 py-1.5 border-b border-[var(--border-light)] bg-[var(--action-dim)]/30 flex-shrink-0">
      <Spinner size={14} label="后台任务生成中" className="flex-shrink-0 text-[var(--action)]" />
      <span className="text-xs text-[var(--text-2)]">
        {runningCount > 0 ? (
          <>
            <span className="font-semibold text-[var(--action)]">
              {runningCount}
            </span>
            <span className="ml-1">个任务生成中</span>
          </>
        ) : (
          <span>任务进行中</span>
        )}
      </span>
      {/* 动态进度条 */}
      {latestProgress && (
        <div className="flex items-center gap-2 ml-2 min-w-0 flex-1 max-w-xs">
          <div className="h-1 flex-1 rounded-full bg-[var(--border)] overflow-hidden">
            <div
              className="h-full bg-[var(--action)] transition-all duration-300 rounded-full"
              style={{
                width: `${Math.floor(Math.min(100, Math.max(0, latestProgress.progress)))}%`,
              }}
            />
          </div>
          {latestProgress.stage && (
            <span className="text-[10px] text-[var(--text-3)] truncate flex-shrink-0">
              {latestProgress.stage}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ActiveTaskStatusBar 组件
// ============================================================

/**
 * 分集「当前后台任务」聚合折叠条。
 *
 * 解决：原 EpisodeWorkspace 为每个活跃任务各渲染一条 GenerationProgress，
 * 多任务时垂直堆叠挤压内容区。
 *
 * 形态：默认 1 行汇总（N 个任务生成中 + 整体进度条），点击展开逐任务明细。
 * - 汇总进度：useTaskList({ projectId }) 批量拉取 → 过滤活跃态 → computeOverallProgress。
 * - 展开明细：复用 GenerationProgress compact（保留取消/重试/ETA/stage）。
 * - 任务计数 N 以 activeTaskIds.size 为权威（与展开项数量一致）。
 *
 * dramaforge 适配：useTaskList 按 projectId 恢复任务，activeTaskIds 仍作为当前分集
 * 实时任务的权威集合，避免历史作业混入。
 */
export interface ActiveTaskStatusBarProps {
  /** 本集当前活跃的后台任务 ID 集合（与 EpisodeWorkspace 的 activeTaskIds 同源） */
  activeTaskIds: Set<string>;
  /** 当前项目 ID（用于按项目过滤任务列表） */
  projectId: string;
  /** 任务完成/失败/取消时从集合移除（驱动 size 归零后整个条消失） */
  onRemoveTask: (taskId: string) => void;
}

export function ActiveTaskStatusBar({
  activeTaskIds,
  projectId,
  onRemoveTask,
}: ActiveTaskStatusBarProps) {
  /** 折叠状态：默认折叠（消除挤压的核心） */
  const [expanded, setExpanded] = React.useState(false);
  /** 本项目任务列表（列表端点每 5 秒恢复一次持久状态）。 */
  const { tasks } = useTaskList({ projectId });

  const ids = Array.from(activeTaskIds);
  const activeTasks = tasks.filter(
    (t) =>
      activeTaskIds.has(t.id) &&
      ACTIVE_TASK_STATUSES.includes(
        t.status as (typeof ACTIVE_TASK_STATUSES)[number],
      ),
  );
  const { percent } = computeOverallProgress(
    activeTasks.map((t) => t.progress ?? 0),
  );

  const labelFor = (id: string): string => {
    const matched = activeTasks.find((x) => x.id === id);
    return getTaskLabel(matched?.type ?? "", id);
  };

  return (
    <section
      className="flex-shrink-0 border-b border-[var(--border-light)] bg-[var(--action-dim)]/20"
      aria-label="当前后台任务"
    >
      {/* 汇总行：恒 1 行，整行可点击切换展开 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-[var(--bg-hover)]/40 transition-colors"
        aria-expanded={expanded}
      >
        <Spinner size={14} label="后台任务生成中" className="flex-shrink-0 text-[var(--action)]" />
        <span className="text-xs text-[var(--text-2)] flex-shrink-0">
          <span className="font-semibold text-[var(--action)]">
            {ids.length}
          </span>
          <span className="ml-1">个任务生成中</span>
        </span>

        {/* 整体进度条：与 GlobalGenerationStatus 动态条样式一致 */}
        <div className="flex items-center gap-2 ml-1 min-w-0 flex-1 max-w-xs">
          <div className="h-1 flex-1 rounded-full bg-[var(--border)] overflow-hidden">
            {percent === null ? (
              <div className="h-full w-1/3 rounded-full bg-[var(--action)]/60 animate-pulse" />
            ) : (
              <div
                className="h-full bg-[var(--action)] transition-all duration-300 rounded-full"
                style={{ width: `${percent}%` }}
              />
            )}
          </div>
          <span className="text-[10px] text-[var(--text-3)] tabular-nums flex-shrink-0">
            {percent === null ? "生成中" : `${percent}%`}
          </span>
        </div>

        {/* 折叠箭头：展开时翻转 */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          className={`text-[var(--text-3)] flex-shrink-0 transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* 展开明细：折叠时不占空间 */}
      {expanded && (
        <div className="px-4 pb-2 mx-auto grid max-w-5xl gap-2">
          {ids.map((id) => (
            <GenerationProgress
              key={id}
              taskId={id}
              compact
              label={labelFor(id)}
              onComplete={() => onRemoveTask(id)}
              onFailure={() => onRemoveTask(id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
