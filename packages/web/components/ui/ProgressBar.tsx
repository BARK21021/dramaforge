/**
 * @file ProgressBar.tsx
 * @description 进度条 + 步骤指示器（移植自 F:\app1\src\components\ui\ProgressBar.tsx）
 *
 * - ProgressBar：0-100 进度 + label/stage/showPercent + pulse + variant + completed
 * - StepIndicator：多步骤流程的状态点（pending/active/done/error）
 *
 * 与 app1 差异：
 *   - 删除 app1 末尾运行时注入 `@keyframes shimmer` 的 <script> 块——dramaforge 的
 *     app/globals.css 已在全局定义了同名 @keyframes（shimmer 1.5s linear），
 *     此处无需重复注入，避免重复 DOM 操作与潜在冲突。
 *   - 其余 props / 视觉 / CSS 变量完全保留。dramaforge 全部变量（--bg-input /
 *     --action / --success / --warning / --error 等）均存在。
 *
 * @example
 * <ProgressBar progress={60} label="生成中" stage="文生图" variant="action" pulse />
 * <StepIndicator steps={[{label:"输入",status:"done"},{label:"分析",status:"active"}]} />
 */
"use client";

interface ProgressBarProps {
  /** 进度百分比 0-100 */
  progress: number;
  /** 状态标签 */
  label?: string;
  /** 颜色主题 */
  variant?: "action" | "accent" | "success" | "warning" | "danger";
  /** 尺寸 */
  size?: "sm" | "md" | "lg";
  /** 是否显示百分比数字 */
  showPercent?: boolean;
  /** 是否脉动动画（生成中） */
  pulse?: boolean;
  /** 是否已完成状态 */
  completed?: boolean;
  /** 是否取消状态（显示红色边框和斜条纹背景） */
  cancellable?: boolean;
  /** 当前阶段标签（如"生成中"、"拼接中"） */
  stage?: string;
  /** 子内容（右侧额外信息） */
  children?: React.ReactNode;
}

export function ProgressBar({
  progress,
  label,
  variant = "action",
  size = "md",
  showPercent = true,
  pulse = false,
  completed = false,
  cancellable = false,
  stage,
  children,
}: ProgressBarProps) {
  const clampedProgress = Math.min(100, Math.max(0, progress));
  const roundedProgress = Math.floor(clampedProgress);
  const indeterminate = pulse && !completed && !cancellable && roundedProgress === 0;

  const heightMap = { sm: "h-1", md: "h-1.5", lg: "h-2.5" };
  const height = heightMap[size];

  const colorMap = {
    action: "bg-[var(--action)]",
    accent: "bg-[var(--accent)]",
    success: "bg-[var(--success)]",
    warning: "bg-[var(--warning)]",
    danger: "bg-[var(--error)]",
  };
  const color = colorMap[variant];

  const textColorMap = {
    action: "text-[var(--action)]",
    accent: "text-[var(--accent)]",
    success: "text-[var(--success)]",
    warning: "text-[var(--warning)]",
    danger: "text-[var(--error)]",
  };

  return (
    <div className="w-full">
      {(label || showPercent) && (
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-2)]">{label || ""}</span>
            {/* 阶段标签 */}
            {stage && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--action-dim)] text-[var(--action)] font-medium">
                {stage}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {children}
            {showPercent && (
              <span
                className={`text-xs font-mono font-semibold tabular-nums ${completed ? textColorMap.success : textColorMap[variant]}`}
              >
                {completed ? (
                  <span className="inline-flex items-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M3 8l3.5 3.5L13 5"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    100%
                  </span>
                ) : (
                  `${roundedProgress}%`
                )}
              </span>
            )}
          </div>
        </div>
      )}
      <div
        role="progressbar"
        aria-label={label || stage || "处理中"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : roundedProgress}
        className={`w-full ${height} rounded-full overflow-hidden ${
          cancellable ? "border border-[var(--error)] bg-[var(--error)]/10" : "bg-[var(--bg-input)]"
        }`}
      >
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${color} ${
            pulse && !completed && !cancellable ? "animate-pulse" : ""
          } ${completed ? "!bg-[var(--success)]" : ""}`}
          style={{
            width: indeterminate ? "35%" : `${roundedProgress}%`,
            animation: indeterminate
              ? "loadingbar 1.2s ease-in-out infinite"
              : undefined,
            transition: indeterminate
              ? undefined
              : "width 0.7s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        >
          {/* 取消状态：斜条纹背景 */}
          {cancellable && clampedProgress > 0 && (
            <div
              className="h-full w-full rounded-full"
              style={{
                background:
                  "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(239,68,68,0.15) 4px, rgba(239,68,68,0.15) 8px)",
              }}
            />
          )}
          {/* 光泽条纹（仅生成中显示，取消状态下停止） - 透明度降低，更克制 */}
          {!completed && !cancellable && clampedProgress > 0 && (
            <div
              className="h-full w-full rounded-full"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 40%, rgba(255,255,255,0.12) 60%, transparent 100%)",
                backgroundSize: "200% 100%",
                animation: "shimmer 1.8s ease-in-out infinite",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 生成步骤指示器
 * 用于展示多步骤生成流程的当前状态
 */
interface StepIndicatorProps {
  steps: { label: string; status: "pending" | "active" | "done" | "error" }[];
  className?: string;
}

export function StepIndicator({ steps, className = "" }: StepIndicatorProps) {
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-1">
          <div
            className={`w-2 h-2 rounded-full transition-all duration-300 ${
              step.status === "done"
                ? "bg-[var(--success)] scale-100"
                : step.status === "active"
                  ? "bg-[var(--action)] scale-125 animate-pulse"
                  : step.status === "error"
                    ? "bg-[var(--error)] scale-100"
                    : "bg-[var(--border)] scale-75"
            }`}
            title={step.label}
          />
          <span
            className={`text-[10px] transition-colors duration-300 ${
              step.status === "active"
                ? "text-[var(--action)] font-medium"
                : step.status === "done"
                  ? "text-[var(--success)]"
                  : step.status === "error"
                    ? "text-[var(--error)]"
                    : "text-[var(--text-3)]"
            }`}
          >
            {step.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// 注：app1 在此运行时注入 `@keyframes shimmer`；dramaforge globals.css 已全局定义该
// 关键帧（用于 .skeleton），无需重复注入。
