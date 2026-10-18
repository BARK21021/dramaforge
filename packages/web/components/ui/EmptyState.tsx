/**
 * @file EmptyState.tsx
 * @description 统一空状态组件（移植自 F:\app1\src\components\ui\EmptyState.tsx）
 *
 * 替代散落各处的临时空状态实现（无分集、无资产、无镜头、无视频、无成片等）。
 * 提供一致的视觉语言：图标 + 标题 + 描述 + 可选操作按钮。
 *
 * 与 app1 差异：无（纯移植）。CSS 变量 / cn 路径与 dramaforge 一致，无需改动。
 *
 * @example
 * // 全屏空状态
 * <EmptyState
 *   icon={<svg ... />}
 *   title="还没有分集"
 *   description="点击「AI 自动分集」开始"
 *   action={<Button variant="primary">开始分集</Button>}
 *   size="lg"
 * />
 *
 * // 卡片内紧凑空状态
 * <EmptyState icon="📭" title="暂无资产" size="sm" />
 */

import { type ReactNode } from "react";
import { cn } from "./cn";

export interface EmptyStateProps {
  /** 图标（emoji 字符串或 SVG 元素） */
  icon?: ReactNode;
  /** 主标题 */
  title: string;
  /** 副标题描述 */
  description?: string;
  /** 操作按钮区域 */
  action?: ReactNode;
  /** 尺寸：lg 全屏空状态 / md 默认 / sm 卡片内紧凑 */
  size?: "sm" | "md" | "lg";
  /** 容器额外类名 */
  className?: string;
}

/**
 * 统一空状态组件
 *
 * 图标 + 标题 + 描述 + 可选操作，居中排列。
 * 使用 --text-3 中性色保持克制，不强行使用品牌色。
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = "md",
  className,
}: EmptyStateProps) {
  const sizeStyles = {
    sm: {
      container: "py-8",
      icon: "text-2xl mb-2",
      title: "text-sm font-medium",
      description: "text-xs",
      gap: "gap-3",
    },
    md: {
      container: "py-12",
      icon: "text-4xl mb-3",
      title: "text-base font-semibold",
      description: "text-sm",
      gap: "gap-4",
    },
    lg: {
      container: "py-20 sm:py-28",
      icon: "text-5xl mb-4",
      title: "text-lg font-semibold",
      description: "text-sm",
      gap: "gap-5",
    },
  };

  const s = sizeStyles[size];

  return (
    <div className={cn("flex flex-col items-center justify-center text-center", s.container, s.gap, className)}>
      {icon && (
        <div className={cn("text-[var(--text-3)] opacity-60 flex items-center justify-center", s.icon)}>
          {icon}
        </div>
      )}
      <h3 className={cn("text-[var(--text)]", s.title)}>{title}</h3>
      {description && (
        <p className={cn("text-[var(--text-3)] max-w-sm leading-relaxed", s.description)}>
          {description}
        </p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
