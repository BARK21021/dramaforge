// ============================================================
// payment — barrel（支付宝充值子域，P6）
// ============================================================
// 订单状态机 + AlipaySdk 封装 + 金额规则 + payment_orders 仓储。
// 服务器禁止 import ffmpeg；本子域零 ffmpeg 依赖。
// web 的 /api/payment/* 路由通过 @dramaforge/server barrel 取 getPaymentService /
// paymentOrderRepo。
// ============================================================

export {
  PaymentService,
  PaymentError,
  getPaymentService,
  setPaymentServiceForTest,
  type CreateOrderInput,
  type CreateOrderResult,
  type OrderStatusResult,
} from './service';
export {
  getAlipayClient,
  setAlipayClient,
  type AlipayClient,
  type CreatePaymentResult,
  type QueryTradeResult,
} from './client';
export { yuanToRechargeCredits, validateAmountYuan, type AmountValidation } from './rules';
export {
  sweepStalePendingOrders,
  startPaymentSweep,
  SWEEP_AGE_MS,
  SWEEP_INTERVAL_MS,
  SWEEP_BATCH_LIMIT,
  type SweepResult,
  type SweepDeps,
  type SweepHandle,
} from './sweep';
export {
  sweepPendingCharges,
  sweepPendingDebits,
  startPendingChargeSweep,
  findPendingChargeTasks,
  clearPendingCharge,
  PENDING_CHARGE_SWEEP_INTERVAL_MS,
  PENDING_CHARGE_SWEEP_BATCH_LIMIT,
  type PendingCharge,
  type PendingChargeRow,
  type PendingChargeSweepResult,
  type PendingChargeSweepDeps,
  type PendingChargeSweepHandle,
  type PendingDebitSweepResult,
  type PendingDebitSweepDeps,
} from './pending-charge-sweep';
// 注意：repo 的 mapRow / PaymentOrderRow 是内部 helper，不进 barrel ——
// domain/index.ts 的 `export *` 会与 project 子域的 mapRow 撞名（TS2308）。
// service.ts 直接从 './repo' 取函数，不经 barrel。
export { paymentOrderRepo } from './repo';
export { type PaymentOrder, type PaymentOrderStatus } from './types';
