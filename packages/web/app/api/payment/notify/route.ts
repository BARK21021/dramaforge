// ============================================================
// POST /api/payment/notify — 支付宝异步回调
// ============================================================
//
// 支付宝服务器异步 POST 通知（application/x-www-form-urlencoded）。
// 验签 + 幂等到账。响应必须为纯文本 "success"（支付宝约定），否则会重试。
// 移植自 app1 api/payment/notify/route.ts（几乎原样）。
//
// 无 session 鉴权：支付宝服务器调用，安全性靠 SDK checkNotifySign 验签。
// 本地无公网时打不到这里（不影响 trade.query 轮询到账）；
// 生产公网 HTTPS + ALIPAY_NOTIFY_URL 配置后自动生效。
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getPaymentService } from '@dramaforge/server';

export async function POST(request: NextRequest): Promise<Response> {
  try {
    // 支付宝回调为 application/x-www-form-urlencoded。URLSearchParams 还原 "+"→空格、
    // %xx→字节，且容错空/缺 "=" 段。
    const text = await request.text();
    const params: Record<string, unknown> = Object.fromEntries(
      new URLSearchParams(text),
    );

    const ok = await getPaymentService().handleNotify(params);
    // 无论验签是否通过都按支付宝约定回纯文本；验签失败内部不发货
    return new NextResponse(ok ? 'success' : 'fail', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    console.error('[payment/notify] error:', err);
    return new NextResponse('fail', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
