// ============================================================
// POST /api/payment/orders — 创建充值订单（支付宝 page.pay）
// ============================================================
//
// 用户选金额 → 建 PENDING 单 + 调支付宝 page.pay → 返回跳转 URL。
// 移植自 app1 api/payment/orders/route.ts；差异：requireAuth→requireUser、
// apiError→apiFail，限流复用 dramaforge Redis 滑动窗口。
//
// 鉴权：session → userId。响应（GC-4 envelope）：
//   200 { success:true, data:{ orderId, payUrl, credits, amountYuan } }
//   400 { success:false, error, code:'VALIDATION_ERROR'|'INVALID_JSON'|'PAYMENT_ERROR' }
//   401 { success:false, error, code:'UNAUTHORIZED' }
//   500 { success:false, error, code:'PAYMENT_ERROR'(未配置)|'INTERNAL_ERROR' }
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getPaymentService, PaymentError, rateLimitAllow } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

const bodySchema = z.object({
  amountYuan: z.number().positive(),
});

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    // 建单会触发外部支付签名；按用户限制 60 秒 10 次，防重复点击和接口刷单。
    const allowed = await rateLimitAllow(`payment:orders:user:${auth.userId}`, 60_000, 10);
    if (!allowed) {
      return apiFail({
        error: '创建支付订单过于频繁，请稍后重试',
        code: 'RATE_LIMITED',
        retryable: true,
      }, 429);
    }
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await req.json());
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const { order, payUrl } = await getPaymentService().createOrder({
      userId: auth.userId,
      amountYuan: body.amountYuan,
    });
    return apiSuccess({
      orderId: order.id,
      payUrl,
      credits: order.credits,
      amountYuan: order.amountYuan,
    });
  } catch (err) {
    // PaymentError 携 statusCode（400 金额非法 / 500 未配置 / 404 等），
    // dramaforge handleApiError 不识别它（只认 AuthError/ZodError），此处显式映射。
    if (err instanceof PaymentError) {
      return apiFail({ error: err.message, code: 'PAYMENT_ERROR' }, err.statusCode);
    }
    return handleApiError(err, 'POST /api/payment/orders');
  }
}
