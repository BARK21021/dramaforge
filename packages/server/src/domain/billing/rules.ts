// ============================================================
// ③ server/domain/billing — 计费换算规则（纯函数）
// ============================================================
//
// 文件职责：
//   提供元→积分的纯函数换算（含加价、向上取整、最小 1 积分）。
//   全部为纯函数，无副作用，无 I/O，可直接单测。
//
// 移植自 app1 src/core/billing/rules.ts（无改动）。
// ============================================================

import { API_PRICE_MARKUP, CREDITS_TO_YUAN } from './constants';

/**
 * 元 → 积分（原始值，未取整）
 *
 * 公式：yuan × API_PRICE_MARKUP / CREDITS_TO_YUAN
 * 即先把元价加价 20%，再除以 0.1 转积分（1 元 = 10 积分 → 加价后 12 积分）。
 *
 * 非正数或非有限数返回 0（避免 NaN/Infinity 污染账本）。
 */
export function rawYuanToCredits(yuan: number): number {
  if (!Number.isFinite(yuan) || yuan <= 0) return 0;
  return (yuan * API_PRICE_MARKUP) / CREDITS_TO_YUAN;
}

/**
 * 归一化为可扣减的积分（向上取整，最小 1）
 *
 * - 非正数或非有限数返回 0（用于 no-op 账本条目）
 * - 正数返回 max(1, ceil(credits))，确保扣费至少 1 积分
 */
export function normalizeBillableCredits(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  return Math.max(1, Math.ceil(credits));
}

/**
 * 元 → 积分（已取整，最小 1）
 *
 * 组合 rawYuanToCredits + normalizeBillableCredits。
 * 任何传入 gateway 实际成本（元）的扣费路径都应通过此函数转积分。
 */
export function yuanToCredits(yuan: number): number {
  return normalizeBillableCredits(rawYuanToCredits(yuan));
}

/**
 * 格式化积分为字符串（向上取整，最小 1）
 *
 * 用于前端展示或日志输出。
 */
export function formatCredits(credits: number): string {
  return normalizeBillableCredits(credits).toString();
}
