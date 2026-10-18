// ============================================================
// payment/sweep — 陈年 PENDING 单对账兜底（防漏单，P6.1-C）
// ============================================================
// 为什么需要：支付宝异步通知 notify 到达率 99.9999%，但剩 0.0001% 会丢；加上
// 用户可能在收银台关掉浏览器（官方明确「同步跳转不可靠」正指此），若此时 notify
// 也没到，订单会永久停在 PENDING——用户付了钱却没到账。
//
// 本模块是资金安全的「第三层兜底」（支付宝官方推荐架构）：
//   主：handleNotify（异步通知验签，99.9999% 到达）
//   辅：syncOrderStatus（回跳页轮询 trade.query，用户在线时）
//   兜底：本 sweep——常驻 worker 每 SWEEP_INTERVAL_MS 扫一次 created_at 超过
//        SWEEP_AGE_MS 仍 PENDING 的单，逐个 syncOrderStatus（幂等）补单。
//
// 安全保证：syncOrderStatus 内部走原子 claimPaid，sweep / notify / 轮询三路
// 并发只发一次积分；sweep 永不抛（单笔出错计 errored 继续下一笔）。
// 零 ffmpeg 依赖；仅 DB + alipay-sdk（经 service）。
// ============================================================

import { findStalePending } from './repo';
import { getPaymentService } from './service';

/** PENDING 超过此时长才算「陈年」（默认 10min——给 notify + 回跳页轮询充足窗口） */
export const SWEEP_AGE_MS = 10 * 60 * 1000;
/** sweep 节拍（默认 60s） */
export const SWEEP_INTERVAL_MS = 60 * 1000;
/** 单次 tick 最多处理多少单（限 trade.query 调用量，防撞支付宝限频） */
export const SWEEP_BATCH_LIMIT = 100;

export interface SweepResult {
  scanned: number;
  credited: number; // 本 tick 变 PAID
  closed: number; // 本 tick 变 CLOSED
  unchanged: number; // 仍 PENDING（WAIT_BUYER_PAY 等）
  errored: number; // 单笔异常
}

/** 依赖注入（测试用；默认接真实 repo + service） */
export interface SweepDeps {
  findStale?: (threshold: Date, limit: number) => Promise<{ id: string }[]>;
  syncOrder?: (id: string) => Promise<{ status: string }>;
  now?: () => Date;
  log?: (msg: string, meta?: unknown) => void;
}

/** 默认日志走 stdout（生产审计）；测试注入静默 log 避免噪音 */
function defaultLog(msg: string, meta?: unknown): void {
  console.log(msg, meta ?? '');
}

/**
 * 单次扫描：找陈年 PENDING 单，逐个幂等查单推进状态机。永不抛。
 *
 * 返回统计；单笔出错计 errored 并继续下一笔——sweep 绝不能因一笔坏单停摆。
 */
export async function sweepStalePendingOrders(deps: SweepDeps = {}): Promise<SweepResult> {
  const findStale = deps.findStale ?? findStalePending;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;

  const result: SweepResult = { scanned: 0, credited: 0, closed: 0, unchanged: 0, errored: 0 };

  let ids: { id: string }[];
  try {
    const threshold = new Date(now().getTime() - SWEEP_AGE_MS);
    ids = await findStale(threshold, SWEEP_BATCH_LIMIT);
  } catch (err) {
    log('[payment-sweep] findStale 失败，本 tick 跳过', { err: String(err) });
    return result;
  }

  result.scanned = ids.length;
  if (ids.length === 0) return result;

  const syncOrder = deps.syncOrder ?? ((id: string) => getPaymentService().syncOrderStatus(id));

  for (const { id } of ids) {
    try {
      const r = await syncOrder(id);
      if (r.status === 'PAID') result.credited++;
      else if (r.status === 'CLOSED') result.closed++;
      else result.unchanged++;
    } catch (err) {
      result.errored++;
      log('[payment-sweep] 单笔查单失败，跳过', { id, err: String(err) });
    }
  }

  log('[payment-sweep] tick 完成', result);
  return result;
}

/** sweep 定时器句柄 */
export interface SweepHandle {
  stop: () => void;
}

/**
 * 启动定时对账 sweep（常驻 worker 调一次）。返回 stop 句柄。
 *
 * overlap guard：上一 tick 没跑完不起新 tick（syncOrder 幂等，重叠无害，但避免
 * 不必要的 trade.query 并发）。tick 内部已 try/catch，定时器层再兜底 catch。
 */
export function startPaymentSweep(
  opts: { intervalMs?: number; deps?: SweepDeps } = {},
): SweepHandle {
  const intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
  const deps: SweepDeps = { log: defaultLog, ...opts.deps };
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await sweepStalePendingOrders(deps);
    } catch (err) {
      // 兜底：sweepStalePendingOrders 本不应抛，但定时器层绝不能因它死掉
      console.error('[payment-sweep] tick 未捕获异常', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
