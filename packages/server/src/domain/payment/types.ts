// ============================================================
// payment/types — 支付订单契约类型（移植 app1 core/payment/types.ts）
// ============================================================
//
// PaymentOrder 为 repo.mapRow 还原后的驼峰契约对象（DB 列为 snake_case，
// 见 0002-payment-orders.sql）。日期字段统一 ISO 字符串（对齐 render_jobs 风格）。
// ============================================================

/** 支付订单状态机 */
export type PaymentOrderStatus = 'PENDING' | 'PAID' | 'CLOSED' | 'FAILED';

/** payment_orders 行映射（驼峰契约；repo 从 snake_case 列还原） */
export interface PaymentOrder {
  id: string;
  /** 商户订单号，传给支付宝（DB UNIQUE） */
  outTradeNo: string;
  userId: string;
  /** 付款金额（元） */
  amountYuan: number;
  /** 应到账积分（= amountYuan * 10） */
  credits: number;
  status: PaymentOrderStatus;
  /** 支付宝交易号（查单/回调后回填） */
  tradeNo: string | null;
  /** page.pay 跳转链接（调试用） */
  payUrl: string | null;
  paidAt: string | null;
  creditedAt: string | null;
  /** 关联 billing_ledger 条目 ID */
  ledgerId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
