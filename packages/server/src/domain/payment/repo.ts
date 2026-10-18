// ============================================================
// payment/repo — payment_orders 表 CRUD + 原子状态转移（幂等核心）
// ============================================================
//
// 移植自 app1 PaymentService 的 Prisma 调用，改为手写 pg repo（对齐
// dramaforge render-job-repo 风格：@server/infra query/tx + mapRow snake→驼峰）。
//
// 幂等核心：claimPaid 用单条原子 UPDATE ... WHERE status='PENDING' RETURNING *。
//   - 抢到（rowCount=1）→ 返回 claimed 行（含 userId/credits，供 service 发积分）
//   - 未抢到（已被它路处理 / 状态不符）→ 返回 null，service 跳过 credit
// 轮询 / notify / 手动重试三路并发天然收敛到「只发一次」（与 render_jobs 的
// FOR UPDATE SKIP LOCKED 同一原子更新思路，但这里是单行状态守卫，无需 SKIP LOCKED）。
//
// 零 ffmpeg 依赖；纯 DB 读写。
// ============================================================

import { query } from '@server/infra';
import { genId } from '@shared/utils';
import type { PaymentOrder } from './types';

/** payment_orders 表行（pg 返回的原始 snake_case row） */
export interface PaymentOrderRow {
  id: string;
  out_trade_no: string;
  user_id: string;
  amount_yuan: unknown; // pg 对 NUMERIC(10,2) 返回 string（避免精度损失），需 Number()
  credits: number;
  status: string;
  trade_no: string | null;
  pay_url: string | null;
  paid_at: unknown; // TIMESTAMPTZ → Date | string | null
  credited_at: unknown;
  ledger_id: string | null;
  metadata: unknown; // JSONB → 对象 | null
  created_at: unknown;
  updated_at: unknown;
}

/** JSONB 字段解析：pg 返对象则原样，返字符串则 parse（兼容 mock） */
function parseJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'string') return JSON.parse(v) as Record<string, unknown>;
  return v as Record<string, unknown>;
}

/** TIMESTAMPTZ → ISO 字符串；null 透传（pg 返 Date，mock 可能返 string） */
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * snake_case DB 行 → 驼峰 PaymentOrder 契约
 * amount_yuan: pg NUMERIC 返回 string → Number()
 */
export function mapRow(row: PaymentOrderRow): PaymentOrder {
  return {
    id: row.id,
    outTradeNo: row.out_trade_no,
    userId: row.user_id,
    amountYuan: Number(row.amount_yuan),
    credits: row.credits,
    status: row.status as PaymentOrder['status'],
    tradeNo: row.trade_no,
    payUrl: row.pay_url,
    paidAt: toIsoOrNull(row.paid_at),
    creditedAt: toIsoOrNull(row.credited_at),
    ledgerId: row.ledger_id,
    metadata: parseJson(row.metadata),
    createdAt: toIsoOrNull(row.created_at) ?? '',
    updatedAt: toIsoOrNull(row.updated_at) ?? '',
  };
}

/**
 * 建一个 PENDING 订单
 *
 * @returns 新建的 PaymentOrder（含生成的 id）
 */
export async function create(input: {
  outTradeNo: string;
  userId: string;
  amountYuan: number;
  credits: number;
}): Promise<PaymentOrder> {
  const id = genId();
  const result = await query(
    `INSERT INTO payment_orders (id, out_trade_no, user_id, amount_yuan, credits, status)
     VALUES ($1, $2, $3, $4, $5, 'PENDING')
     RETURNING *`,
    [id, input.outTradeNo, input.userId, input.amountYuan, input.credits],
  );
  return mapRow(result.rows[0] as PaymentOrderRow);
}

/** 按 id 查单 */
export async function findById(id: string): Promise<PaymentOrder | null> {
  const result = await query(`SELECT * FROM payment_orders WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0] as PaymentOrderRow) : null;
}

/** 按商户订单号查单（notify 回调用） */
export async function findByOutTradeNo(outTradeNo: string): Promise<PaymentOrder | null> {
  const result = await query(`SELECT * FROM payment_orders WHERE out_trade_no = $1`, [
    outTradeNo,
  ]);
  return result.rows[0] ? mapRow(result.rows[0] as PaymentOrderRow) : null;
}

/**
 * 找「陈年 PENDING」单——对账 sweep 用（防漏单兜底，见 ./sweep）。
 *
 * 只返回 id（sweep 逐个喂给幂等的 syncOrderStatus，不需要整行）。
 * 阈值由调用方算好传入（通常 now - SWEEP_AGE_MS），保持本函数纯+可测。
 * LIMIT 上界一次 tick 的工作量，避免极端积压时单次 trade.query 过多撞支付宝限频。
 */
export async function findStalePending(
  threshold: Date,
  limit: number = 100,
): Promise<{ id: string }[]> {
  const result = await query(
    `SELECT id FROM payment_orders
     WHERE status = 'PENDING' AND created_at < $1
     ORDER BY created_at
     LIMIT $2`,
    [threshold, limit],
  );
  return (result.rows as Array<{ id: string }>).map((r) => ({ id: r.id }));
}

/**
 * 幂等核心：原子抢占 PENDING→PAID。
 *
 * 单条 UPDATE 天然原子：仅当当前 status='PENDING' 才置 PAID 并回填 trade_no/paid_at。
 * 抢到（RETURNING 有行）→ 返回该行（含 userId/credits 供 service 发积分）；
 * 未抢到（状态已是 PAID/CLOSED 或单不存在）→ 返回 null，service 据此跳过 credit。
 *
 * 轮询 / notify / 手动重试并发均安全：只有第一次成功转移返回行，其余返回 null。
 */
export async function claimPaid(
  id: string,
  tradeNo: string | null,
): Promise<PaymentOrder | null> {
  const result = await query(
    `UPDATE payment_orders
       SET status = 'PAID', trade_no = $1, paid_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND status = 'PENDING'
     RETURNING *`,
    [tradeNo, id],
  );
  return result.rows[0] ? mapRow(result.rows[0] as PaymentOrderRow) : null;
}

/** 回填 page.pay 跳转链接（调试 / 兜底用） */
export async function updatePayUrl(id: string, payUrl: string): Promise<void> {
  await query(`UPDATE payment_orders SET pay_url = $1, updated_at = NOW() WHERE id = $2`, [
    payUrl,
    id,
  ]);
}

/** 置 CLOSED（trade.query 返回 TRADE_CLOSED / 超时关单） */
export async function markClosed(id: string): Promise<void> {
  await query(`UPDATE payment_orders SET status = 'CLOSED', updated_at = NOW() WHERE id = $1`, [
    id,
  ]);
}

/** 发积分后回填 ledger_id + credited_at（与 claimPaid 分离：发积分失败不影响状态机已置 PAID） */
export async function updateAfterCredit(id: string, ledgerId: string): Promise<void> {
  await query(
    `UPDATE payment_orders SET ledger_id = $1, credited_at = NOW(), updated_at = NOW() WHERE id = $2`,
    [ledgerId, id],
  );
}

/** payment-order 仓储对象（聚合函数，便于整体注入/mock） */
export const paymentOrderRepo = {
  create,
  findById,
  findByOutTradeNo,
  findStalePending,
  claimPaid,
  updatePayUrl,
  markClosed,
  updateAfterCredit,
};
