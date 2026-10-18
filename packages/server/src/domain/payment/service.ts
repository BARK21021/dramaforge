// ============================================================
// payment/service — PaymentService：订单状态机 + 幂等到账
// ============================================================
// 移植自 app1 src/core/payment/service.ts；差异：Prisma → 手写 pg repo
// （./repo 的 paymentOrderRepo 函数），billing.credit → billing.creditPurchase。
//
// 到账路径（对齐支付宝官方推荐三通道，三路均幂等收敛到「只发一次积分」）：
//   主：handleNotify（异步通知验签，99.9999% 到达）—— /api/payment/notify
//   辅：syncOrderStatus（回跳页轮询 trade.query）—— /api/payment/orders/[id]/status
//   兜底：sweep（陈年 PENDING 单定时对账，防 notify 丢失/用户关页漏单）—— payment/sweep
// 同步跳转 return_url 仅供展示、不可作发货依据（支付宝官方明确）。
// 幂等：markPaidAndCredit 调 repo.claimPaid（原子 UPDATE WHERE status='PENDING'
//   RETURNING *），只有抢到行的那次调 creditPurchase；并发安全。
// ============================================================

import { env } from '@server/infra/env';
import { genId } from '@shared/utils';
import { creditPurchase } from '../billing';
import {
  create as createOrderRow,
  findById,
  findByOutTradeNo,
  claimPaid,
  updatePayUrl,
  markClosed,
  updateAfterCredit,
} from './repo';
import { getAlipayClient, type AlipayClient } from './client';
import { validateAmountYuan, yuanToRechargeCredits } from './rules';
import type { PaymentOrder, PaymentOrderStatus } from './types';

const SUBJECT = 'DramaForge 积分充值';

/** 携带 HTTP 状态码的支付错误（handleApiError 会读 statusCode） */
export class PaymentError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'PaymentError';
    this.statusCode = statusCode;
  }
}

export interface CreateOrderInput {
  userId: string;
  amountYuan: number;
}
export interface CreateOrderResult {
  order: PaymentOrder;
  payUrl: string;
}
export interface OrderStatusResult {
  status: PaymentOrderStatus;
  amountYuan: number;
  credits: number;
}

export class PaymentService {
  constructor(private readonly client: AlipayClient) {}

  /** 校验金额 → 建 PENDING 单 → 调 page.pay 拿跳转 URL */
  async createOrder({ userId, amountYuan }: CreateOrderInput): Promise<CreateOrderResult> {
    // 缺失配置直接抛 500，避免下游抛出难以理解的 SDK 加密错误
    this.assertAlipayConfigured();

    const v = validateAmountYuan(amountYuan);
    if (!v.ok) throw new PaymentError(v.message, 400);

    const credits = yuanToRechargeCredits(amountYuan);
    const outTradeNo = genId(); // 商户订单号（唯一，传给支付宝）
    const e = env();

    const order = await createOrderRow({ outTradeNo, userId, amountYuan, credits });

    const { payUrl } = await this.client.createPaymentUrl({
      outTradeNo,
      totalAmount: amountYuan.toFixed(2),
      subject: SUBJECT,
      returnUrl: e.ALIPAY_RETURN_URL || undefined,
      notifyUrl: e.ALIPAY_NOTIFY_URL || undefined,
    });

    await updatePayUrl(order.id, payUrl);
    return { order, payUrl };
  }

  /** 主动查单并推进状态机（轮询主路径） */
  async syncOrderStatus(orderId: string): Promise<OrderStatusResult> {
    const order = await findById(orderId);
    if (!order) throw new PaymentError('订单不存在', 404);

    if (order.status === 'PENDING') {
      const res = await this.client.queryTrade(order.outTradeNo);
      if (res.tradeStatus === 'TRADE_SUCCESS' || res.tradeStatus === 'TRADE_FINISHED') {
        await this.markPaidAndCredit(orderId, res.tradeNo);
      } else if (res.tradeStatus === 'TRADE_CLOSED') {
        await markClosed(orderId);
      }
    }

    const fresh = await findById(orderId);
    return {
      status: (fresh?.status ?? 'PENDING') as PaymentOrderStatus,
      amountYuan: fresh?.amountYuan ?? 0,
      credits: fresh?.credits ?? 0,
    };
  }

  /** 异步通知路径：验签后幂等到账。返回值表示是否"应回 success" */
  async handleNotify(params: Record<string, unknown>): Promise<boolean> {
    if (!this.client.verifyNotify(params)) return false;
    const tradeStatus = params.trade_status as string | undefined;
    if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') return true;

    const outTradeNo = params.out_trade_no as string | undefined;
    const tradeNo = (params.trade_no as string | undefined) ?? null;
    if (!outTradeNo) return false;

    const order = await findByOutTradeNo(outTradeNo);
    if (!order) return false; // 未知订单：回 false（支付宝会重试，但我们无单可对）
    await this.markPaidAndCredit(order.id, tradeNo);
    return true;
  }

  /**
   * 幂等核心：原子抢占 PENDING→PAID，只有抢到的那次发积分。
   * 轮询 / notify / 手动重试并发均安全（claimPaid 返回行 → 发；返回 null → 跳过）。
   *
   * 已知窗口：claim 成功后到 creditPurchase 写入之间若进程崩溃，订单会停在 PAID 但
   * creditedAt 为空。本期不做自动对账（YAGNI）；后续可加 sweep 扫 PAID 且 ledger_id
   * IS NULL 的单补发。
   */
  private async markPaidAndCredit(orderId: string, tradeNo: string | null): Promise<void> {
    const claimed = await claimPaid(orderId, tradeNo);
    if (!claimed) return; // 已被其他路径处理或状态不符

    const entry = await creditPurchase(
      claimed.userId,
      claimed.credits,
      claimed.id,
    );
    await updateAfterCredit(orderId, entry.id);
  }

  /**
   * 配置守卫：支付宝三项密钥任一缺失则抛 500。
   * 放在 createOrder（用户侧入口）最前面，把 SDK 隐晦的加签名错误转成可读提示。
   * handleNotify 不守卫：密钥缺失时 verifyNotify 自然返回 false，行为已正确。
   */
  private assertAlipayConfigured(): void {
    const e = env();
    if (!e.ALIPAY_APP_ID || !e.ALIPAY_APP_PRIVATE_KEY || !e.ALIPAY_PUBLIC_KEY) {
      throw new PaymentError('支付宝支付未配置，请联系管理员', 500);
    }
  }
}

// ============================================================
// 单例 + 测试注入
// ============================================================
let _service: PaymentService | null = null;

export function getPaymentService(): PaymentService {
  if (!_service) _service = new PaymentService(getAlipayClient());
  return _service;
}
export function setPaymentServiceForTest(s: PaymentService | null): void {
  _service = s;
}
