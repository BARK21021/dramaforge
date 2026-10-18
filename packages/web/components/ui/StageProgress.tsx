/**
 * @file StageProgress.tsx
 * @description 阶段进度组件（移植自 F:\app1\src\components\ui\StageProgress.tsx）
 *
 * 提供统一的阶段进度可视化，替代散落各处的手写进度条 + 阶段文案。
 * 包含两个组件：
 *   - StageProgress：紧凑的行内进度条（含阶段文案、位置指示、动态进度条）
 *   - StageProgressCard：卡片式包装（标题 + 描述 + StageProgress）
 *
 * 与 app1 差异：无（纯移植）。CSS 变量 / cn 路径与 dramaforge 完全一致。
 * 双色方案铁律：进行中使用 --action（蓝色），完成状态使用 --success。
 *
 * @example
 * <StageProgress progress={60} stage="资产图片生成中" position="6/10 已确认" pulse />
 * <StageProgressCard title="资产设计" stage="..." progress={60} />
 */
import * as React from "react";
import { cn } from "./cn";

// ============================================================
// 类型定义
// ============================================================

/** 阶段定义（用于多阶段流程展示，如「输入 → 分析 → 资产 → 分镜 → 生产」） */
export interface StageDef {
  /** 阶段唯一 key */
  key: string;
  /** 阶段展示文案 */
  label: string;
  /** 阶段状态：pending 未开始 / active 进行中 / done 已完成 / error 出错 */
  status?: "pending" | "active" | "done" | "error";
}

/** 进度条变体 */
type StageProgressVariant = "action" | "accent" | "success" | "warning" | "error";

/** 进度条尺寸 */
type StageProgressSize = "sm" | "md" | "lg";

export interface StageProgressProps {
  /** 当前进度（0-100） */
  progress?: number;
  /** 当前阶段文案（如"资产图片生成中"） */
  stage?: React.ReactNode;
  /** 位置/计数指示（如"6/10 已确认"） */
  position?: React.ReactNode;
  /** 是否完成（完成时显示 ✓ 标识并切换为成功色） */
  completed?: boolean;
  /** 是否脉冲动画（进行中视觉提示） */
  pulse?: boolean;
  /** 进度条变体（默认 action 蓝色） */
  variant?: StageProgressVariant;
  /** 尺寸 */
  size?: StageProgressSize;
  /** 自定义阶段列表（用于多阶段指示器，可选） */
  stages?: StageDef[];
  /** 容器额外类名 */
  className?: string;
}

export interface StageProgressCardProps extends StageProgressProps {
  /** 卡片标题 */
  title?: React.ReactNode;
  /** 卡片描述 */
  description?: React.ReactNode;
  /** 右上角额外操作区 */
  action?: React.ReactNode;
}

// ============================================================
// 变体 → 颜色映射
// ============================================================

const variantBarColor: Record<StageProgressVariant, string> = {
  action: "bg-[var(--action)]",
  accent: "bg-[var(--accent)]",
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
  error: "bg-[var(--error)]",
};

const variantTextColor: Record<StageProgressVariant, string> = {
  action: "text-[var(--action)]",
  accent: "text-[var(--accent)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  error: "text-[var(--error)]",
};

const sizeStyles: Record<StageProgressSize, { bar: string; text: string; gap: string }> = {
  sm: { bar: "h-1", text: "text-xs", gap: "gap-2" },
  md: { bar: "h-1.5", text: "text-sm", gap: "gap-2.5" },
  lg: { bar: "h-2", text: "text-sm", gap: "gap-3" },
};

// ============================================================
// StageProgress
// ============================================================

/**
 * 紧凑的行内阶段进度条
 *
 * 上方一行展示阶段文案 + 位置指示，下方为进度条。
 * 完成态自动切换为 success 色，无论传入 variant 如何。
 */
export function StageProgress({
  progress = 0,
  stage,
  position,
  completed = false,
  pulse = false,
  variant = "action",
  size = "md",
  stages,
  className,
}: StageProgressProps) {
  const s = sizeStyles[size];
  // 完成时强制 success 色并锁定 100%
  const effectiveVariant: StageProgressVariant = completed ? "success" : variant;
  const clampedProgress = Math.max(0, Math.min(100, completed ? 100 : progress));
  const roundedProgress = Math.floor(clampedProgress);

  // 多阶段指示器模式（若传入 stages 则渲染步骤点）
  if (stages && stages.length > 0) {
    return (
      <div className={cn("flex flex-col", s.gap, className)}>
        <div className={cn("flex items-center justify-between", s.text)}>
          <span className={cn("font-medium text-[var(--text-2)]", completed && variantTextColor.success)}>
            {stage}
          </span>
          {position && <span className="text-[var(--text-3)] tabular-nums">{position}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {stages.map((st, idx) => {
            const status = st.status ?? "pending";
            const dotColor =
              status === "done"
                ? "bg-[var(--success)]"
                : status === "active"
                  ? "bg-[var(--action)]"
                  : status === "error"
                    ? "bg-[var(--error)]"
                    : "bg-[var(--border-strong)]";
            return (
              <React.Fragment key={st.key}>
                <div className="flex flex-col items-center gap-1">
                  <div className={cn("w-2 h-2 rounded-full", dotColor, status === "active" && pulse && "animate-pulse")} />
                  <span className={cn("text-[10px]", status === "pending" ? "text-[var(--text-3)]" : "text-[var(--text-2)]")}>
                    {st.label}
                  </span>
                </div>
                {idx < stages.length - 1 && (
                  <div className="flex-1 h-px bg-[var(--border-strong)]" aria-hidden="true" />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    );
  }

  // 默认单进度条模式
  return (
    <div className={cn("flex flex-col", s.gap, className)}>
      {(stage || position) && (
        <div className={cn("flex items-center justify-between", s.text)}>
          <span className={cn("font-medium text-[var(--text-2)] flex items-center gap-1.5", completed && variantTextColor.success)}>
            {completed && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="flex-shrink-0">
                <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {stage}
          </span>
          {position && <span className="text-[var(--text-3)] tabular-nums">{position}</span>}
        </div>
      )}
      <div className={cn("w-full overflow-hidden rounded-full bg-[var(--bg-hover)]", s.bar)}>
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300 ease-out",
            variantBarColor[effectiveVariant],
            pulse && !completed && "animate-pulse",
          )}
          style={{ width: `${roundedProgress}%` }}
          role="progressbar"
          aria-valuenow={roundedProgress}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

// ============================================================
// StageProgressCard
// ============================================================

/**
 * 卡片式阶段进度包装
 *
 * 顶部为标题 + 描述 + 可选操作区，底部为 StageProgress。
 * 用于工作区各阶段的头部状态展示。
 */
export function StageProgressCard({
  title,
  description,
  action,
  progress,
  stage,
  position,
  completed,
  pulse,
  variant,
  size = "md",
  stages,
  className,
}: StageProgressCardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--bg-card)] p-4 sm:p-5",
        className,
      )}
    >
      {(title || description || action) && (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>}
            {description && <p className="text-xs text-[var(--text-3)] mt-0.5">{description}</p>}
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      )}
      <StageProgress
        progress={progress}
        stage={stage}
        position={position}
        completed={completed}
        pulse={pulse}
        variant={variant}
        size={size}
        stages={stages}
      />
    </div>
  );
}
