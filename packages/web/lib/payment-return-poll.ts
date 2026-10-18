// ============================================================
// payment-return-poll — 付款回跳页轮询结果分类 + 文案（纯函数，可测）
// ============================================================
// /payment/return 每 2s 轮询 /api/payment/orders/[id]/status。本模块把"响应 →
// 页面该做什么"的判定抽成纯函数，使逻辑可不依赖 DOM 测试（web 无 RTL）。
//
// 关键 UX 决策：
//   - 401（登录过期）→ auth-error：停轮询，提示重登（不再静默死转）
//   - 其余非 ok / envelope 失败 → transient-error：保持轮询（单次抖动不中止）
//   - PAID → 带 credits/amountYuan，UI 显示"+N 积分"
// 支付宝官方：同步跳转仅供展示，真实到账以 notify/trade.query 为准，故回跳页
// 只做"展示 + 轮询兜底"，永不替服务器决定发货（那在 service.claimPaid 原子做）。
// ============================================================

export type PollOutcome =
  | { kind: 'pending' }
  | { kind: 'paid'; credits?: number; amountYuan?: number }
  | { kind: 'closed' }
  | { kind: 'auth-error' }
  | { kind: 'transient-error' };

export interface PollResponseBody {
  success?: boolean;
  data?: { status?: string; credits?: number; amountYuan?: number };
  error?: string;
}

/**
 * 把一次轮询响应归类为页面动作。
 *
 * @param httpStatus - fetch 的 HTTP 状态码
 * @param body - 解析后的 GC-4 信封（可能为 null 表示 JSON 解析失败）
 */
export function classifyPollResponse(
  httpStatus: number,
  body: PollResponseBody | null,
): PollOutcome {
  // 401：登录过期。不再静默重试死转，交给 UI 提示重登。
  if (httpStatus === 401) return { kind: 'auth-error' };

  // 其余非 ok 或信封失败 → 瞬时错误，保持轮询（单次抖动不中止确认）。
  const ok = httpStatus >= 200 && httpStatus < 300;
  if (!ok || !body?.success) return { kind: 'transient-error' };

  const st = body.data?.status;
  if (st === 'PAID') {
    return {
      kind: 'paid',
      credits: body.data?.credits,
      amountYuan: body.data?.amountYuan,
    };
  }
  if (st === 'CLOSED' || st === 'FAILED') return { kind: 'closed' };
  return { kind: 'pending' };
}

/** 轮询中给用户看的进度文案（带查询次数，缓解"是不是卡住了"焦虑） */
export function pollingMessage(attempt: number): string {
  return `正在确认支付结果…（已查询 ${attempt} 次，通常几秒内到账）`;
}

/** PAID 成功文案（带积分，若有） */
export function paidMessage(credits?: number): string {
  return typeof credits === 'number' && credits > 0
    ? `充值成功！+${credits} 积分，即将返回…`
    : '充值成功！即将返回…';
}
