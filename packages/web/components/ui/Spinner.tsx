/**
 * @file Spinner.tsx
 * @description 非确定进度条
 *
 * 保留旧组件名以兼容现有调用点，但视觉统一为横向流动进度条，
 * 不再显示圆形转圈。
 *
 * @example
 * <Spinner size={16} />                  // 紧凑进度条
 * <Spinner className="text-[var(--action)]" />  // 自定义颜色
 */
import { cn } from "./cn";

export interface SpinnerProps {
  /** 旧直径参数；现在用于推导进度条宽度（px） */
  size?: number;
  /** 进度条高度（px），默认 2 */
  thickness?: number;
  /** 额外类名（可覆盖颜色） */
  className?: string;
  /** 无障碍标签 */
  label?: string;
}

/**
 * 非确定进度条（兼容旧 Spinner API）
 */
export function Spinner({ size = 20, thickness = 2, className, label = "加载中" }: SpinnerProps) {
  const width = Math.max(48, size * 3);
  const height = Math.max(2, thickness);

  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("relative inline-block overflow-hidden rounded-full", className)}
      style={{
        width,
        height,
        backgroundColor: "color-mix(in srgb, currentColor 20%, transparent)",
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 block rounded-full bg-current"
        style={{
          width: "35%",
          animation: "loadingbar 1.2s ease-in-out infinite",
        }}
      />
    </span>
  );
}
