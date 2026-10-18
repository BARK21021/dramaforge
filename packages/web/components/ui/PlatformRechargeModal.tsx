/**
 * @file PlatformRechargeModal.tsx
 * @description 平台积分充值模态框（P6，移植 F:\app1）
 *
 * 选挡位（50/100/200/500 或自定义）→ 点「去付款」→ POST /api/payment/orders
 * 建单 → 拿 payUrl → 跳转支付宝收银台：
 *   - Electron 桌面客户端：window.sfShell.openExternal(payUrl) 在系统浏览器打开
 *   - 浏览器：window.location.href = payUrl 整页跳转
 * 付款后回跳 /payment/return 轮询订单状态、CreditsBadge 靠 30s 轮询+聚焦刷余额。
 *
 * 与 app1 差异：electronAPI.openExternal → window.sfShell?.openExternal（dramaforge 桥名）。
 *
 * 双色方案铁律：到账积分提示用 --accent（琥珀），挡位+按钮用 --action（蓝）。
 */
"use client";

import * as React from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input } from "./Input";
import { useToast } from "./Toast";
import { cn } from "./cn";

export interface PlatformRechargeModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: (open: boolean) => void;
  /** 充值成功回调（跳转收银台流程下组件在跳转后卸载，本回调不会被调用；
   *  余额刷新由 /payment/return 回跳页 + CreditsBadge 轮询负责。保留以兼容调用方）。 */
  onSuccess?: () => void;
}

/** 预置挡位（元） */
const PRESET_AMOUNTS = [50, 100, 200, 500] as const;
/** 单次充值金额上下限（与后端 PAYMENT_ORDER_MIN/MAX_YUAN 对齐） */
const MAX_AMOUNT_YUAN = 10000;
const MIN_AMOUNT_YUAN = 1;
/** 积分兑换比例：1 元 = 10 积分（CREDITS_TO_YUAN = 0.1） */
const CREDITS_PER_YUAN = 10;

/** dramaforge 桌面客户端桥（preload 注入 window.sfShell） */
interface SfShellBridge {
  openExternal?: (url: string) => Promise<void>;
}
function getSfShell(): SfShellBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { sfShell?: SfShellBridge }).sfShell ?? null;
}

export function PlatformRechargeModal({ open, onClose }: PlatformRechargeModalProps) {
  const toast = useToast();
  const [selectedAmount, setSelectedAmount] = React.useState<number | null>(100);
  const [customAmount, setCustomAmount] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);

  const effectiveAmount = selectedAmount ?? (customAmount ? Number(customAmount) : 0);
  const expectedCredits = Math.round(effectiveAmount * CREDITS_PER_YUAN);
  const isAmountValid =
    Number.isFinite(effectiveAmount) &&
    effectiveAmount >= MIN_AMOUNT_YUAN &&
    effectiveAmount <= MAX_AMOUNT_YUAN;

  React.useEffect(() => {
    if (open) {
      setSelectedAmount(100);
      setCustomAmount("");
      setSubmitting(false);
    }
  }, [open]);

  /**
   * 建单 + 跳转支付宝收银台（page.pay）。
   * orderId 存 sessionStorage 供 /payment/return 兜底查询。
   */
  const handleSubmit = async () => {
    if (!isAmountValid) {
      toast.error(`金额需在 ${MIN_AMOUNT_YUAN}-${MAX_AMOUNT_YUAN} 元之间`);
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch("/api/payment/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ amountYuan: effectiveAmount }),
      });
      const json = (await resp.json()) as {
        success?: boolean;
        data?: { payUrl?: string; orderId?: string };
        error?: string;
      };
      if (!resp.ok || !json?.success || !json?.data?.payUrl) {
        throw new Error(json?.error || "创建订单失败");
      }
      const { payUrl, orderId } = json.data as { payUrl: string; orderId: string };
      try {
        sessionStorage.setItem("pendingPaymentOrderId", orderId);
      } catch {
        // sessionStorage 不可用时忽略（隐私模式等）
      }
      // 跳转：Electron 走 sfShell.openExternal（系统浏览器），浏览器整页跳转
      const sfShell = getSfShell();
      if (sfShell?.openExternal) {
        await sfShell.openExternal(payUrl);
      } else {
        window.location.href = payUrl;
      }
    } catch (err) {
      toast.error(`提交失败: ${(err as Error)?.message || "未知错误"}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="积分充值"
      description="点击「去付款」跳转支付宝收银台完成支付"
      maxWidthClassName="max-w-md"
    >
      <div className="space-y-5">
        {/* 挡位选择 */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-2)] mb-2">选择金额</label>
          <div className="grid grid-cols-4 gap-2">
            {PRESET_AMOUNTS.map((amt) => {
              const selected = selectedAmount === amt;
              return (
                <button
                  key={amt}
                  type="button"
                  onClick={() => {
                    setSelectedAmount(amt);
                    setCustomAmount("");
                  }}
                  className={cn(
                    "h-10 rounded-[var(--radius-sm)] text-sm font-semibold transition-all",
                    selected
                      ? "bg-[var(--action)] text-white ring-2 ring-[var(--action)]/30"
                      : "bg-[var(--bg-input)] text-[var(--text-2)] border border-[var(--border-strong)] hover:border-[var(--action)]/50",
                  )}
                  aria-pressed={selected}
                >
                  ¥{amt}
                </button>
              );
            })}
          </div>
        </div>

        {/* 自定义金额 */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-2)] mb-2">自定义金额</label>
          <Input
            type="number"
            min={MIN_AMOUNT_YUAN}
            max={MAX_AMOUNT_YUAN}
            placeholder={`输入 ${MIN_AMOUNT_YUAN}-${MAX_AMOUNT_YUAN} 元`}
            value={customAmount}
            onChange={(e) => {
              setCustomAmount(e.target.value);
              setSelectedAmount(null);
            }}
            prefix={<span className="text-xs">¥</span>}
            invalid={!isAmountValid && customAmount !== ""}
          />
        </div>

        {/* 预计到账积分 */}
        {isAmountValid && (
          <div className="flex items-center justify-between px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--accent-dim)] border border-[var(--accent)]/20">
            <span className="text-xs text-[var(--text-3)]">预计到账</span>
            <span className="text-sm font-bold text-[var(--accent)] tabular-nums">
              {expectedCredits.toLocaleString()} 积分
            </span>
          </div>
        )}

        {/* 跳转提示 */}
        <div className="flex flex-col items-center py-3 rounded-[var(--radius-sm)] bg-[var(--bg-input)] border border-[var(--border-strong)]">
          <p className="text-sm font-medium text-[var(--text)] text-center">
            点击「去付款」跳转支付宝完成支付
          </p>
          {isAmountValid && (
            <p className="mt-1 text-xs text-[var(--accent)] text-center">
              支付 ¥{effectiveAmount}，预计到账 {expectedCredits.toLocaleString()} 积分
            </p>
          )}
          <p className="mt-2 text-[11px] text-[var(--text-3)] text-center">付完将自动返回并确认到账</p>
        </div>

        {/* 底部操作 */}
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="ghost" onClick={() => onClose(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} loading={submitting} disabled={!isAmountValid}>
            去付款
          </Button>
        </div>
      </div>
    </Modal>
  );
}
