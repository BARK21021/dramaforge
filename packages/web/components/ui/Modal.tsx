/**
 * @file Modal.tsx
 * @description 极简模态对话框（P6 新增，供 PlatformRechargeModal 用）
 *
 * app1 的 Modal 基于 @radix-ui/react-dialog + lucide-react；dramaforge web 未装这两个
 * 依赖。为控制依赖面，这里实现一个极简 Modal：固定遮罩 + 居中卡片 + ESC 关闭 +
 * 点遮罩关闭 + 可选标题/描述/关闭按钮。无障碍用了 role/aria-modal（焦点陷阱等
 * 高级无障碍特性留作后续，若引入 Radix 再升级）。
 *
 * @example
 * <Modal open={open} onClose={setOpen} title="积分充值" maxWidthClassName="max-w-md">
 *   ...children...
 * </Modal>
 */
"use client";

import * as React from "react";
import { cn } from "./cn";

export interface ModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调（参数与 app1 一致：open=false） */
  onClose: (open: boolean) => void;
  /** 标题 */
  title?: string;
  /** 描述（可选） */
  description?: string;
  /** 内容 */
  children: React.ReactNode;
  /** 是否隐藏右上角关闭按钮 */
  hideClose?: boolean;
  /** 最大宽度类名，默认 max-w-sm */
  maxWidthClassName?: string;
}

/** 极简模态对话框：ESC 关闭 + 点遮罩关闭 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  hideClose = false,
  maxWidthClassName = "max-w-sm",
}: ModalProps) {
  // ESC 关闭（仅 open 时挂监听）
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", onKey);
    // 打开时锁背景滚动
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* 遮罩：点击关闭 */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onClose(false)}
      />
      {/* 卡片 */}
      <div
        className={cn(
          "relative z-10 w-full max-h-[calc(100vh-2rem)] overflow-y-auto",
          "bg-[var(--bg-card)] border border-[var(--border-strong)]",
          "rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] p-5 sm:p-6",
          maxWidthClassName,
        )}
      >
        {title && (
          <h2 className="text-base font-semibold text-[var(--text)] mb-2">{title}</h2>
        )}
        {description && (
          <p className="text-sm text-[var(--text-2)] leading-relaxed mb-4">{description}</p>
        )}
        {children}
        {!hideClose && (
          <button
            type="button"
            onClick={() => onClose(false)}
            className={cn(
              "absolute top-4 right-4 w-7 h-7 rounded-[var(--radius-sm)]",
              "flex items-center justify-center",
              "text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]",
              "transition-colors",
            )}
            aria-label="关闭"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
