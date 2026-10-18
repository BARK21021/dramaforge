/**
 * @file RechargeProvider.tsx
 * @description 全局充值弹窗 Provider（批1 traceId 幂等 + 批5 错误弹窗 RechargeModal 接入）
 *
 * 提供 showRecharge / closeRecharge，任何组件可通过 useRecharge() 调用。Context
 * 单点挂载两套充值 UI：
 *   1. PlatformRechargeModal —— 平台自营积分商城（4 桡位 + 支付宝）。
 *      CreditsBadge 主动点击 showRecharge() 触发。
 *   2. RechargeModal —— 第三方 AI 提供商额度不足的错误弹窗（QR + 官网跳转）。
 *      showRecharge({providerName, rechargeUrl, ...}) 触发，常用于 SSE / fetch
 *      错误链路（后端透传 providerName + rechargeUrl）。
 *
 * 幂等性（对齐 app1 RechargeProvider）：
 * 1. traceId 去重 — 同一 traceId 的错误只弹一次。同步 fetch + 异步 SSE 双链路
 *    同时触发同一错误时防重复弹。traceId 在两套 UI 间通用。
 * 2. 弹窗已开不覆盖 — openRef 跟踪任意一个弹窗的打开状态。已开时新调用静默
 *    忽略，避免覆盖用户正在操作的弹窗（含 retry 回调）。
 * 3. retry 回调用 ref 存储 — 避免状态变更 re-render 时丢失。handleRetry 时清空
 *    traceId 集合（重试可能产生新失败，应允许再次弹）。
 * 4. traceId 集合上限 100 — 超阈值清空，避免长跑内存泄漏。
 *
 * 路由：showRecharge({providerName | rechargeUrl | errorMessage}) → 错误弹窗；
 *       showRecharge() / showRecharge({traceId}) → 平台积分弹窗。
 *
 * 挂载：app/layout.tsx，在 ToastProvider 内层、AppShell 外层。
 *
 * @example
 * ```tsx
 * // 任意组件
 * const { showRecharge } = useRecharge();
 * showRecharge();                       // CreditsBadge：平台积分弹窗
 * showRecharge({ traceId: err.traceId }); // 错误链路（无 provider 信息）→ 平台弹窗
 * showRecharge({                        // 错误链路（有 provider 信息）→ 错误弹窗
 *   providerName: "DeepSeek",
 *   rechargeUrl: "https://platform.deepseek.com/usage",
 *   retry: () => refetchData(),
 *   traceId: err.traceId,
 * });
 * ```
 */
"use client";

import * as React from "react";
import { PlatformRechargeModal } from "./PlatformRechargeModal";
import { RechargeModal } from "./RechargeModal";

interface ShowRechargeOptions {
  /** AI 提供商展示名（传入任一错误字段即切到 RechargeModal） */
  providerName?: string;
  /** 提供商官方充值页 URL（存在时 RechargeModal 显示 QR） */
  rechargeUrl?: string;
  /** 错误消息（rechargeUrl 缺失时 RechargeModal 展示） */
  errorMessage?: string;
  /** 已充值后的重试回调（仅 RechargeModal 显示按钮；PlatformRechargeModal 无重试） */
  retry?: () => void;
  /** 去重标识（traceId），同一 traceId 只弹一次（错误链路用） */
  traceId?: string;
}

interface RechargeContextValue {
  /** 打开充值弹窗（无错误字段→平台积分弹窗；有错误字段→提供商额度错误弹窗） */
  showRecharge: (opts?: ShowRechargeOptions) => void;
  /** 关闭充值弹窗 */
  closeRecharge: () => void;
}

/** 当前打开的弹窗类型（决定渲染哪个 Modal） */
type RechargeMode = "platform" | "error" | null;

interface RechargeState {
  mode: RechargeMode;
  providerName?: string;
  rechargeUrl?: string;
  errorMessage?: string;
}

const RechargeContext = React.createContext<RechargeContextValue | null>(null);

/** traceId 去重集合上限，超阈值清空避免内存泄漏（对齐 app1） */
const MAX_SHOWN_TRACE_IDS = 100;

export function RechargeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<RechargeState>({ mode: null });
  /** retry 回调 ref（避免 re-render 丢失；仅 error 模式使用） */
  const retryRef = React.useRef<(() => void) | null>(null);
  /** traceId 去重集合（错误链路防重复） */
  const shownTraceIds = React.useRef<Set<string>>(new Set());
  /** 弹窗打开状态 ref（任意 mode 打开时为 true；避免依赖 state 导致 callback 重建） */
  const openRef = React.useRef(false);

  const showRecharge = React.useCallback((opts?: ShowRechargeOptions) => {
    // 幂等 1：traceId 去重（同一错误只弹一次；traceId 在两套 UI 间通用）
    if (opts?.traceId) {
      if (shownTraceIds.current.has(opts.traceId)) return;
      shownTraceIds.current.add(opts.traceId);
      // 上限保护：超阈值清空（traceId 是 UUID，清空后最坏同错误弹两次，可接受）
      if (shownTraceIds.current.size > MAX_SHOWN_TRACE_IDS) {
        shownTraceIds.current.clear();
      }
    }
    // 幂等 2：弹窗已开不覆盖（避免覆盖用户正在操作的弹窗和 retry 回调）
    if (openRef.current) return;

    // 路由：传入任一错误字段 → RechargeModal（提供商额度不足）；
    //       否则 → PlatformRechargeModal（平台积分商城，CreditsBadge 主动点击）
    const isErrorModal = Boolean(
      opts && (opts.providerName || opts.rechargeUrl || opts.errorMessage),
    );

    openRef.current = true;
    if (isErrorModal) {
      retryRef.current = opts?.retry || null;
      setState({
        mode: "error",
        providerName: opts?.providerName,
        rechargeUrl: opts?.rechargeUrl,
        errorMessage: opts?.errorMessage,
      });
    } else {
      retryRef.current = null;
      setState({ mode: "platform" });
    }
  }, []);

  const closeRecharge = React.useCallback(() => {
    openRef.current = false;
    setState({ mode: null });
    retryRef.current = null;
    // 不清 shownTraceIds：用户主动关闭后，同一 traceId 的延迟错误不应再弹
  }, []);

  /**
   * 「已充值，重试」按钮回调（仅 RechargeModal 模式）。
   * 关闭弹窗 + 清空 traceId 集合（重试可能产生新失败，应允许再次弹）+ 触发 retry。
   */
  const handleRetry = React.useCallback(() => {
    const fn = retryRef.current;
    openRef.current = false;
    setState({ mode: null });
    retryRef.current = null;
    shownTraceIds.current.clear();
    if (fn) fn();
  }, []);

  const value = React.useMemo<RechargeContextValue>(
    () => ({ showRecharge, closeRecharge }),
    [showRecharge, closeRecharge],
  );

  return (
    <RechargeContext.Provider value={value}>
      {children}
      <PlatformRechargeModal
        open={state.mode === "platform"}
        onClose={() => closeRecharge()}
      />
      <RechargeModal
        open={state.mode === "error"}
        providerName={state.providerName}
        rechargeUrl={state.rechargeUrl}
        errorMessage={state.errorMessage}
        onRetry={retryRef.current ? handleRetry : undefined}
        onClose={closeRecharge}
      />
    </RechargeContext.Provider>
  );
}

/**
 * 获取充值弹窗上下文
 *
 * 必须在 RechargeProvider 内部使用，否则抛错。
 */
export function useRecharge(): RechargeContextValue {
  const ctx = React.useContext(RechargeContext);
  if (!ctx) {
    throw new Error("useRecharge must be used within RechargeProvider");
  }
  return ctx;
}
