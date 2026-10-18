// ============================================================
// ③ server/domain/billing — barrel
// ============================================================
// 计费子域统一导出：常量、换算规则、计费服务（扣费 / 退款 / 余额）。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
// ============================================================

export { CREDITS_TO_YUAN, API_PRICE_MARKUP } from './constants';
export {
  rawYuanToCredits,
  normalizeBillableCredits,
  yuanToCredits,
  formatCredits,
} from './rules';
export {
  getBalance,
  chargeCredits,
  chargeAggregatedTaskCost,
  refundTaskDebit,
  creditRefund,
  creditPurchase,
  creditManual,
  recordPendingDebit,
  findPendingDebitEntries,
  markPendingDebitSettled,
  markPendingDebitAttempted,
  BillingError,
  _resetBillingForTests,
  type UserBalance,
  type BillingEntry,
  type LedgerEntryType,
  type PendingDebitRow,
} from './service';
