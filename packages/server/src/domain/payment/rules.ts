// ============================================================
// payment/rules — 金额校验 + 元→积分换算（纯函数，移植 app1 core/payment/rules.ts）
// ============================================================
//
// 移植自 app1；唯一差异：env import 从 @core/config/env → @server/infra/env。
// PAYMENT_ORDER_MIN/MAX_YUAN 在 env 里是 optional string（未配默认 1 / 10000）。
// ============================================================

import { env } from '@server/infra/env';

/**
 * 元 → 充值积分：1 元 = 10 积分（与 billing CREDITS_TO_YUAN=0.1 一致）。
 * 等价于 Math.round(amountYuan / 0.1)。
 */
export function yuanToRechargeCredits(yuan: number): number {
  return Math.round(yuan * 10);
}

/** 金额校验结果 */
export type AmountValidation =
  | { ok: true }
  | { ok: false; message: string };

/** 按 env 的 [PAYMENT_ORDER_MIN_YUAN, PAYMENT_ORDER_MAX_YUAN] 校验充值金额 */
export function validateAmountYuan(yuan: number): AmountValidation {
  // env 里是 optional string（未配则取默认）；Number(undefined ?? '1') = 1
  const min = Number(env().PAYMENT_ORDER_MIN_YUAN ?? 1);
  const max = Number(env().PAYMENT_ORDER_MAX_YUAN ?? 10000);
  if (!Number.isFinite(yuan)) {
    return { ok: false, message: '充值金额无效' };
  }
  if (yuan < min) {
    return { ok: false, message: `充值金额不能少于 ${min} 元` };
  }
  if (yuan > max) {
    return { ok: false, message: `单笔充值金额不能超过 ${max} 元` };
  }
  return { ok: true };
}
