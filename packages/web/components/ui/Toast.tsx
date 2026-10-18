/**
 * @file Toast.tsx
 * @description Toast 通知系统组件
 * 
 * 该文件实现了一个全局的 Toast 通知系统，用于显示成功、错误、信息、警告等类型的消息。
 * 
 * 核心功能：
 * - ToastProvider: 提供全局的 Toast 上下文
 * - useToast: Hook 用于在组件中调用 Toast 通知
 * - 支持多种通知类型（success/error/info/warning）
 * - 自动在 4 秒后消失，支持手动关闭
 * 
 * 使用方式：
 * 1. 在应用根部包裹 ToastProvider
 * 2. 在组件中使用 useToast() 获取通知方法
 * 3. 调用 toast.success("消息") 等方法显示通知
 */

"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

// ============================================================
// 类型定义
// ============================================================

/**
 * Toast 通知类型
 */
export type ToastType = "success" | "error" | "info" | "warning";

/**
 * Toast 通知项接口
 */
interface ToastItem {
  /** 通知的唯一标识 */
  id: number;
  /** 通知类型 */
  type: ToastType;
  /** 通知消息内容 */
  message: string;
}

/** 同一条仍在屏幕上的通知不重复堆叠。 */
export function shouldAddToast(
  active: ReadonlyArray<{ type: ToastType; message: string }>,
  type: ToastType,
  message: string,
): boolean {
  return !active.some((item) => item.type === type && item.message === message);
}

/**
 * Toast 上下文值接口
 * 提供发送各种类型通知的方法
 */
interface ToastContextValue {
  /** 发送指定类型的通知 */
  push: (type: ToastType, message: string) => void;
  /** 发送成功通知 */
  success: (msg: string) => void;
  /** 发送错误通知 */
  error: (msg: string) => void;
  /** 发送信息通知 */
  info: (msg: string) => void;
  /** 发送警告通知 */
  warning: (msg: string) => void;
}

/**
 * Toast 上下文
 * 用于在组件树中传递 Toast 功能
 */
const ToastContext = createContext<ToastContextValue | null>(null);

// ============================================================
// Hook: useToast
// ============================================================

/**
 * 获取 Toast 通知 Hook
 * 
 * 用于在组件中发送 Toast 通知。如果组件未被 ToastProvider 包裹，
 * 会返回一个 fallback 实现（仅输出到控制台），避免崩溃。
 * 
 * @returns Toast 上下文对象，包含 push/success/error/info/warning 方法
 * 
 * @example
 * ```tsx
 * const toast = useToast();
 * toast.success("操作成功");
 * toast.error("操作失败");
 * ```
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // 开发环境 fallback，避免未包裹时崩溃
    return {
      push: (t: ToastType, m: string) => console.log(`[Toast:${t}]`, m),
      success: (m: string) => console.log("[Toast:success]", m),
      error: (m: string) => console.log("[Toast:error]", m),
      info: (m: string) => console.log("[Toast:info]", m),
      warning: (m: string) => console.log("[Toast:warning]", m),
    };
  }
  return ctx;
}

// ============================================================
// 样式配置
// ============================================================

/**
 * 各类型 Toast 的样式配置
 * 包含背景色、边框色、图标
 */
const STYLES: Record<ToastType, { bg: string; border: string; icon: string }> = {
  success: { bg: "rgba(52, 211, 153, 0.12)", border: "rgba(52, 211, 153, 0.3)", icon: "✓" },
  error: { bg: "rgba(248, 113, 113, 0.12)", border: "rgba(248, 113, 113, 0.3)", icon: "✕" },
  info: { bg: "rgba(229, 168, 37, 0.12)", border: "rgba(229, 168, 37, 0.3)", icon: "i" },
  warning: { bg: "rgba(251, 191, 36, 0.12)", border: "rgba(251, 191, 36, 0.3)", icon: "!" },
};

/**
 * 各类型 Toast 的文字颜色
 */
const COLORS: Record<ToastType, string> = {
  success: "#34d399",
  error: "#f87171",
  info: "#e5a825",
  warning: "#fbbf24",
};

/** 全局 Toast ID 计数器，用于生成唯一 ID */
let toastId = 0;

// ============================================================
// 组件: ToastProvider
// ============================================================

/**
 * ToastProvider 组件属性
 */
interface ToastProviderProps {
  /** 子组件 */
  children: ReactNode;
}

/**
 * Toast 提供者组件
 * 
 * 提供全局的 Toast 通知功能。所有需要使用 useToast 的组件
 * 都必须在此组件内部。
 * 
 * 功能：
 * - 管理 Toast 通知的显示和移除
 * - 自动在 4 秒后移除通知
 * - 支持手动点击关闭
 * 
 * @param props - 组件属性
 * @returns 包裹了 Toast 上下文的子组件，以及 Toast 容器
 * 
 * @example
 * ```tsx
 * // 在 layout.tsx 中使用
 * <ToastProvider>
 *   <YourApp />
 * </ToastProvider>
 * ```
 */
export function ToastProvider({ children }: ToastProviderProps) {
  /** Toast 通知列表 */
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  /**
   * 移除指定 ID 的 Toast
   * @param id - 要移除的 Toast ID
   */
  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /**
   * 添加新的 Toast 通知
   * @param type - 通知类型
   * @param message - 通知消息
   */
  const push = useCallback((type: ToastType, message: string) => {
    const id = ++toastId;
    setToasts((prev) =>
      shouldAddToast(prev, type, message)
        ? [...prev, { id, type, message }]
        : prev,
    );
    // 4 秒后自动移除
    setTimeout(() => remove(id), 4000);
  }, [remove]);

  /**
   * Toast 上下文值（必须 memo —— 见下方注释）
   *
   * 为什么必须 useMemo：useToast() 的 consumer（如 lib/api.ts 的 useApi）会把
   * toast 放进 useCallback 依赖。若 value 每次 render 都是新对象（toasts 增删
   * 导致 Provider 重渲染时），会污染下游所有 useCallback → EpisodeWorkspace 的
   * 数据加载 effect 自激重跑 → web 502 时形成 7次/秒 请求风暴把后端打爆
   * （2026-07-23 事故根因）。push 是 useCallback([remove])、remove 是
   * useCallback([])，皆稳定，故 value 以 [push] 为依赖可保持引用稳定。
   * 改 push 依赖链时务必保持稳定；回归测试见 Toast.stability.test.tsx。
   */
  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
      warning: (m) => push("warning", m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast 容器 - 固定在右下角 */}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 pointer-events-none">
        {toasts.map((t) => {
          const s = STYLES[t.type];
          const color = COLORS[t.type];
          return (
            <div
              key={t.id}
              className="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl backdrop-blur-xl animate-slide-in-right"
              style={{
                background: s.bg,
                border: `1px solid ${s.border}`,
                minWidth: "280px",
                maxWidth: "400px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
              }}
            >
              {/* 图标 */}
              <span
                className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
                style={{ background: color, color: "#0a0a0f" }}
              >
                {s.icon}
              </span>
              {/* 消息内容 */}
              <span className="text-sm flex-1" style={{ color }}>
                {t.message}
              </span>
              {/* 关闭按钮 */}
              <button
                onClick={() => remove(t.id)}
                className="flex-shrink-0 opacity-50 hover:opacity-100 text-xs"
                style={{ color }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
