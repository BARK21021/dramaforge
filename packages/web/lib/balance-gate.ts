// ============================================================
// web/lib/balance-gate — 生成路由的余额前置预检
// ============================================================
//
// 对齐 app1 BillingService.precheckBalance：AI 调用**前**余额 ≤ 0 直接失败，避免坏账
// （app1 在 chain-generate / analyze / generate-storyboard / asset extraction /
//  start-workflow / shots / original-video-upload / generate-image 均如此）。
//
// dramaforge 与 app1 的差异：
//   - app1 precheckBalance 抛 BillingError(402)，经 handleApiError 归类 QUOTA_INSUFFICIENT。
//   - dramaforge 的 handleApiError 不识别 BillingError（会落 500 INTERNAL_ERROR），故采用
//     generate-image 已验证的「返回 Response | null」风格：null = 放行，Response = 直接 return。
//
// 非精确预检——不冻结、不预扣；实际扣费仍在生成成功后由 billDirectGeneration /
// ai-worker 按“真实成本”结算。ADMIN（unlimited）放行。
// ============================================================

import { getBalance } from '@dramaforge/server';
import { apiFail } from '@web/lib/response';

/**
 * 余额前置预检：余额 ≤ 0（且非 ADMIN unlimited）→ 返回 402 INSUFFICIENT_BALANCE；否则 null。
 *
 * 用法（在 requireUser + ownership 之后、昂贵 AI 调用之前）：
 *   const blocked = await requireBalanceOrFail(auth.userId);
 *   if (blocked) return blocked;
 *
 * @returns null 表示放行；否则为可直接 return 的 402 响应。
 */
export async function requireBalanceOrFail(userId: string): Promise<Response | null> {
  if (process.env.DRAMAFORGE_LOCAL_MODE === '1') return null; // 本地不计费，直通
  const balance = await getBalance(userId);
  if (!balance.unlimited && balance.credits <= 0) {
    return apiFail(
      { error: '积分余额不足，请充值后重试', code: 'INSUFFICIENT_BALANCE' },
      402,
    );
  }
  return null;
}
