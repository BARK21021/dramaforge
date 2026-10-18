/**
 * @file Button.tsx
 * @description 统一按钮组件
 *
 * 替代散落各处的 .btn-primary / .btn-ghost CSS 类用法。
 * 支持 variant、size、loading 态、图标槽位，并自带无障碍属性。
 *
 * @example
 * <Button variant="primary" size="md" onClick={...}>保存</Button>
 * <Button variant="ghost" loading>提交中</Button>
 * <Button asChild><Link href="/x">跳转</Link></Button>
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "brand" | "ghost" | "outline" | "danger" | "subtle";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 样式变体 */
  variant?: ButtonVariant;
  /** 尺寸 */
  size?: ButtonSize;
  /** 加载态（显示底部进度条并禁用） */
  loading?: boolean;
  /** 处理中可用的真实进度；缺省时显示流动的非确定进度条 */
  progress?: number;
  /** 作为子元素渲染（用于包裹 Link 等） */
  asChild?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  brand: "btn-brand",
  ghost: "btn-ghost",
  outline: "bg-transparent text-[var(--text)] border border-[var(--border-strong)] hover:bg-[var(--bg-hover)] hover:border-[var(--text-3)]",
  danger: "bg-[var(--error)] text-white font-semibold hover:brightness-110 disabled:opacity-40",
  subtle: "bg-[var(--bg-hover)] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--bg-input)] font-medium",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-7 px-3 text-xs rounded-[var(--radius-sm)] gap-1.5",
  md: "h-9 px-4 text-sm rounded-[var(--radius-sm)] gap-2",
  lg: "h-11 px-5 text-sm rounded-[var(--radius-sm)] gap-2",
  icon: "h-8 w-8 rounded-[var(--radius-sm)]",
};

/**
 * 统一按钮组件
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", loading = false, progress, asChild = false, className, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const normalizedProgress = Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Number(progress)))
      : null;
    const progressBar = loading ? (
      <span
        role="progressbar"
        aria-label="处理中"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={normalizedProgress ?? undefined}
        className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-black/15"
      >
        <span
          className="block h-full bg-current opacity-80"
          style={
            normalizedProgress === null
              ? { width: "30%", animation: "loadingbar 1.2s ease-in-out infinite" }
              : { width: `${normalizedProgress}%`, transition: "width 300ms ease-out" }
          }
        />
      </span>
    ) : null;

    let content = children;
    if (asChild && React.isValidElement<{ children?: React.ReactNode }>(children)) {
      content = React.cloneElement(
        children,
        undefined,
        <>
          {children.props.children}
          {progressBar}
        </>,
      );
    } else if (loading) {
      content = (
        <>
          {children}
          {progressBar}
        </>
      );
    }

    return (
      <Comp
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center font-semibold select-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          variantClasses[variant],
          sizeClasses[size],
          loading && "relative overflow-hidden",
          className,
        )}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {content}
      </Comp>
    );
  },
);
Button.displayName = "Button";
