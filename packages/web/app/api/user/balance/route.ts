// ============================================================
// GET /api/user/balance — 当前用户积分余额
// ============================================================
//
// CreditsBadge 每 30s + 窗口聚焦轮询本端点刷新余额显示。
// 移植自 app1（app1 在 /api/user/balance 暴露 getBalance）。
//
// 鉴权：session → userId。响应（GC-4 envelope）：
//   200 { success:true, data:{ credits, unlimited } }
//   401 UNAUTHORIZED
// unlimited=true 时前端 CreditsBadge 隐藏充值按钮（ADMIN 无限额）。
// ============================================================

import { getBalance, BillingError } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function GET(): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }
    const b = await getBalance(auth.userId);
    return apiSuccess({ credits: b.credits, unlimited: b.unlimited });
  } catch (err) {
    // BillingError 携 statusCode（404 用户不存在等），显式映射（同 payment 的处理）
    if (err instanceof BillingError) {
      return apiFail({ error: err.message, code: 'BILLING_ERROR' }, err.statusCode);
    }
    return handleApiError(err, 'GET /api/user/balance');
  }
}
