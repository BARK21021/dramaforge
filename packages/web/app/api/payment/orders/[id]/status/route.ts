// ============================================================
// GET /api/payment/orders/[id]/status — 轮询订单状态
// ============================================================
//
// 轮询入口：返回最新状态，PENDING 时内部驱动 trade.query 推进状态机。
// 归属校验：先读单确认属于当前用户，再驱动查单（避免替他人触发查单 + 到账）。
// 移植自 app1 api/payment/orders/[id]/status/route.ts；prisma→paymentOrderRepo。
//
// 鉴权：session → userId + 归属。响应（GC-4 envelope）：
//   200 { success:true, data:{ status, amountYuan, credits } }
//   401 UNAUTHORIZED / 404 NOT_FOUND(订单不存在或不属于该用户)
// ============================================================

import type { NextRequest } from 'next/server';
import { getPaymentService, paymentOrderRepo, PaymentError } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }
    const { id } = await params;

    // 归属校验：先读单确认属于当前用户，再驱动查单。
    // ⚠ 入参 id 实际是支付宝回跳带的 out_trade_no（createOrder 时单独 genId，与行 id
    // 是两个不同 UUID）。先按 out_trade_no 查；回退按行 id 查以兼容直接传 id 的调用方。
    // 命中后必须用真实 order.id 喂 syncOrderStatus（其内部 findById + trade.query），
    // 否则按 out_trade_no 当 id 查会 404 → 页面死转到超时（P6.2 修复的回归）。
    let order = await paymentOrderRepo.findByOutTradeNo(id);
    if (!order) order = await paymentOrderRepo.findById(id);
    if (!order || order.userId !== auth.userId) {
      return apiFail({ error: '订单不存在', code: 'NOT_FOUND' }, 404);
    }

    const result = await getPaymentService().syncOrderStatus(order.id);
    return apiSuccess(result);
  } catch (err) {
    if (err instanceof PaymentError) {
      return apiFail({ error: err.message, code: 'PAYMENT_ERROR' }, err.statusCode);
    }
    return handleApiError(err, 'GET /api/payment/orders/[id]/status');
  }
}
