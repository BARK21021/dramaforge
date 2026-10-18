/**
 * @file CreditsBadge.tsx
 * @description 顶部积分徽标（P6 移植 F:\app1，批1 接 RechargeProvider）
 *
 * 展示当前用户积分余额 + 充值入口。拉取 /api/user/balance，30s 轮询 + 窗口聚焦
 * 刷新（AI 消耗后 + 支付宝到账后余额及时更新）。
 *
 * 批1 变更：点「充值」改为调 useRecharge().showRecharge()，由 layout.tsx 的
 * RechargeProvider 单点挂 PlatformRechargeModal；本组件不再自挂弹窗。余额刷新
 * 由 30s 轮询 + focus 监听负责（跳转收银台后回跳页 /payment/return 也会触发）。
 *
 * 与 app1 差异：authFetch → 原生 fetch（dramaforge 无 authFetch hook；同源 credentials
 * 自动带 cookie，失败静默；401 由 useSession 三态门处理跳登录）。
 */
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRecharge } from "./RechargeProvider";

/** 余额刷新间隔（毫秒） */
const REFRESH_INTERVAL = 30_000;

/** CreditsBadge 尺寸规格 */
type CreditsBadgeSize = "sm" | "lg";

interface CreditsBadgeProps {
  /** sm 紧凑（默认）；lg 右上角醒目展示 */
  size?: CreditsBadgeSize;
}

export function CreditsBadge({ size = "sm" }: CreditsBadgeProps = {}) {
  // 登录态守卫：未登录时不发 balance 请求，避免 401
  const { status } = useSession();
  const [credits, setCredits] = useState<number | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const inFlight = useRef(false);
  const { showRecharge } = useRecharge();

  const isLg = size === "lg";

  const fetchCredits = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/user/balance", { credentials: "include" });
      const json = (await res.json()) as {
        success?: boolean;
        data?: { credits?: number; unlimited?: boolean };
      };
      if (json.success && json.data) {
        setCredits(json.data.credits ?? 0);
        setUnlimited(json.data.unlimited === true);
      }
    } catch {
      // 静默失败，不打扰用户
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetchCredits();
    const timer = setInterval(fetchCredits, REFRESH_INTERVAL);
    const onFocus = () => fetchCredits();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchCredits, status]);

  return (
    <>
      <div
        className={`flex items-center gap-1.5 rounded-lg bg-[var(--accent-dim)] border border-[var(--accent)]/20 transition-all hover:border-[var(--accent)]/40 ${
          isLg ? "px-3.5 py-2 gap-2" : "px-2.5 py-1.5"
        }`}
      >
        {/* 积分图标 */}
        <svg
          width={isLg ? 20 : 16}
          height={isLg ? 20 : 16}
          viewBox="0 0 24 24"
          fill="none"
          className="text-[var(--accent)] flex-shrink-0"
        >
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 7v10M9.5 9.5h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {/* 积分数值 */}
        <span
          className={`font-bold text-[var(--accent)] tabular-nums ${isLg ? "text-base" : "text-sm"}`}
        >
          {credits === null ? "—" : unlimited ? "∞" : credits.toLocaleString()}
        </span>
        <span className={`text-[var(--text-3)] ${isLg ? "text-sm" : "text-xs hidden sm:inline"}`}>
          积分
        </span>
        {/* 充值按钮（ADMIN 无限额时隐藏）；点击走全局 RechargeProvider */}
        {!unlimited && (
          <button
            type="button"
            onClick={() => showRecharge()}
            className={`ml-1 font-medium text-[var(--accent)] hover:text-[var(--text)] transition-colors flex items-center gap-0.5 rounded hover:bg-[var(--accent)]/10 ${
              isLg ? "text-sm px-2 py-1" : "text-xs px-1.5 py-0.5"
            }`}
            title="充值积分"
            aria-label="充值积分"
          >
            <svg width={isLg ? 15 : 13} height={isLg ? 15 : 13} viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span className={isLg ? "inline" : "hidden sm:inline"}>充值</span>
          </button>
        )}
      </div>
    </>
  );
}
