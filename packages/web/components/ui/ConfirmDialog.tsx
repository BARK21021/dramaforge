/**
 * @file ConfirmDialog.tsx
 * @description 确认对话框组件（移植自 F:\app1\src\components\ui\ConfirmDialog.tsx）
 *
 * 支持 danger / warning / default 三种语义变体。
 *
 * 与 app1 差异：
 *   - app1 通过 `<Modal>` + `<ModalFooter>` 包装；dramaforge 现有 Modal.tsx 是无 Radix
 *     的极简版本（且无 ModalFooter 导出），按协调方指示「Modal.tsx 暂不动」，
 *     这里直接内联 @radix-ui/react-dialog primitives（Root/Portal/Overlay/Content），
 *     视觉与 app1 Modal 一致（fixed inset-0 遮罩 + 居中卡片 + ESC + 遮罩点击关闭 +
 *     焦点陷阱 + aria 自动注入）。
 *   - lucide-react 已引入，图标直接用（与 app1 完全一致：AlertTriangle /
 *     AlertCircle / Info）。
 *   - 其余 props / 视觉 / CSS 变量完全保留。
 *
 * @example
 * <ConfirmDialog
 *   open={open}
 *   title="确认删除"
 *   message="此操作不可恢复"
 *   variant="danger"
 *   onConfirm={handleConfirm}
 *   onCancel={handleCancel}
 * />
 */
"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, AlertCircle, Info } from "lucide-react";
import { Button } from "./Button";
import { cn } from "./cn";

export interface ConfirmDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 标题 */
  title: string;
  /** 消息内容 */
  message: string;
  /** 确认按钮文字，默认 "确定" */
  confirmLabel?: string;
  /** 取消按钮文字，默认 "取消" */
  cancelLabel?: string;
  /** 语义变体 */
  variant?: "danger" | "warning" | "default";
  /** 确认回调 */
  onConfirm: () => void;
  /** 取消回调（同时是 Dialog 关闭回调） */
  onCancel: () => void;
  /** 异步确认正在处理：显示按钮进度条，并禁止关闭或重复确认。 */
  loading?: boolean;
  /** 已知的真实进度（0–100）；缺省时显示横向不定进度。 */
  progress?: number;
}

const variantConfig = {
  danger: {
    icon: AlertTriangle,
    iconBg: "bg-[var(--error-dim)] text-[var(--error)]",
    confirmVariant: "danger" as const,
  },
  warning: {
    icon: AlertCircle,
    iconBg: "bg-[var(--warning-dim)] text-[var(--warning)]",
    confirmVariant: "primary" as const,
  },
  default: {
    icon: Info,
    iconBg: "bg-[var(--accent-dim)] text-[var(--accent)]",
    confirmVariant: "primary" as const,
  },
};

/**
 * 确认对话框组件
 *
 * 用于需要二次确认的危险/重要操作。
 * 自带焦点陷阱、ESC 关闭、遮罩点击关闭等无障碍特性（Radix Dialog 提供）。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  variant = "default",
  onConfirm,
  onCancel,
  loading = false,
  progress,
}: ConfirmDialogProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100%-1.5rem)] sm:w-auto sm:max-w-sm",
            "max-h-[calc(100vh-2rem)] overflow-y-auto",
            "bg-[var(--bg-card)] border border-[var(--border-strong)]",
            "rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] p-5 sm:p-6",
            "animate-scale-in focus:outline-none",
          )}
          aria-label={title}
          aria-busy={loading || undefined}
          onEscapeKeyDown={(event) => {
            if (loading) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (loading) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (loading) event.preventDefault();
          }}
        >
          {/* 语义图标 */}
          <div
            className={cn(
              "w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4",
              config.iconBg,
            )}
          >
            <Icon size={24} />
          </div>
          {/* 标题 */}
          <h3
            className="text-xl font-bold text-[var(--text)] mb-2 text-center"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {title}
          </h3>
          {/* 消息 */}
          <p className="text-sm text-[var(--text-2)] text-center leading-relaxed">
            {message}
          </p>
          {/* 操作按钮（ModalFooter 等价：flex 容器，两端对齐） */}
          <div className="flex gap-3 justify-end mt-6">
            <Button variant="ghost" onClick={onCancel} disabled={loading} className="flex-1">
              {cancelLabel}
            </Button>
            <Button
              variant={config.confirmVariant}
              onClick={onConfirm}
              loading={loading}
              progress={progress}
              className="flex-1"
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
