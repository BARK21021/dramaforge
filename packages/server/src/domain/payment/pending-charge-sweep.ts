// ============================================================
// payment/pending-charge-sweep — 任务补扣兜底（防漏收，P1-5 / P0-2）
// ============================================================
// 两路欠费，同一 tick 内顺序补扣：
//
// ① sweepPendingCharges —— ai-worker 任务路径（P1-5）：
//    processor.ts 扣费失败时写 tasks."pendingCharge"（JSONB {credits,reason,createdAt}），
//    markCompleted 完成扣费时清空。本 sweep 扫 pendingCharge 非空且 status='COMPLETED'
//    的任务，逐条重试 chargeCredits，成功则清空 pendingCharge，失败留待下次 tick。
//
// ② sweepPendingDebits —— 同步直连生成路径（P0-2，sync direct 路由）：
//    web/lib/direct-media-generation.ts 的 7 个 sync direct 路由扣费失败（非 402）时，
//    另一 agent (a472ddb7) 的 recordPendingDebit 写一条 billing_ledger type='PENDING_DEBIT'
//    行（不动 users.credits，仅留痕待补）。本 sweep 扫未结清（metadata.settled != true）
//    的 PENDING_DEBIT 行，按 metadata.billingMode 分派：
//      - 'simple'    → chargeCredits(userId, credits, ...)
//      - 'aggregate' → chargeAggregatedTaskCost(userId, billingTaskId, billingUnitId, costYuan, ...)
//    成功 → markPendingDebitSettled（jsonb 合并 {settled:true, settledAt}，保留审计行不删）。
//    409 终态（任务 FAILED/CANCELLED，已退款）→ 标 settled + {waived:true} 避免无限重试。
//    其他失败 → markPendingDebitAttempted（写 lastAttemptAt/lastError，不作 gating）留下 tick 重试。
//
// 与 payment/sweep.ts 同构（纯逻辑 + SweepHandle + startSweep + deps 注入），
// 挂载点 ai-worker/index.ts startAllWorkers（单一 startPendingChargeSweep 内部双 sweep）。
// 安全保证：单笔出错计 errored 继续下一笔；sweep 永不抛；chargeCredits 原子条件 UPDATE
// 防双花；status='COMPLETED' 守卫避免与 processor 成功路径竞态；metadata.settled 标记保证
// PENDING_DEBIT 幂等（同 id 永不被二次扣）。
// 零 ffmpeg 依赖；仅 DB + chargeCredits/chargeAggregatedTaskCost（经 billing）。
// ============================================================

import { query } from '@server/infra';
import {
  chargeCredits,
  chargeAggregatedTaskCost,
  findPendingDebitEntries,
  markPendingDebitSettled,
  markPendingDebitAttempted,
  type PendingDebitRow,
} from '../billing';

/** 从错误对象上取 statusCode（兼容真实 BillingError 与测试 mock）。 */
function getErrorStatusCode(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const v = (err as { statusCode: unknown }).statusCode;
    return typeof v === 'number' ? v : undefined;
  }
  return undefined;
}

/** sweep 节拍（默认 60s，对齐 payment sweep / key-pool reap / task-heal） */
export const PENDING_CHARGE_SWEEP_INTERVAL_MS = 60 * 1000;
/** 单次 tick 最多处理多少条（限扣费并发，防积压时单次压垮计费） */
export const PENDING_CHARGE_SWEEP_BATCH_LIMIT = 100;

/** pendingCharge JSONB 行结构（与 task-repo.setPendingCharge 写入对齐） */
export interface PendingCharge {
  credits: number;
  reason: string;
  createdAt: string;
}

/** sweep 扫出的任务行 */
export interface PendingChargeRow {
  id: string;
  userId: string;
  pendingCharge: PendingCharge;
}

export interface PendingChargeSweepResult {
  scanned: number;
  charged: number; // 本 tick 成功补扣并清空 pendingCharge
  errored: number; // 单笔异常（留待下次 tick）
}

/** 依赖注入（测试用；默认接真实 repo + chargeCredits） */
export interface PendingChargeSweepDeps {
  findPending?: (limit: number) => Promise<PendingChargeRow[]>;
  charge?: (row: PendingChargeRow) => Promise<void>;
  clear?: (taskId: string) => Promise<void>;
  log?: (msg: string, meta?: unknown) => void;
}

/** 默认日志走 stdout（生产审计）；测试注入静默 log 避免噪音 */
function defaultLog(msg: string, meta?: unknown): void {
  console.log(msg, meta ?? '');
}

/**
 * 查 pendingCharge 非空且 status='COMPLETED' 的任务（扣费失败留痕待补）。
 *
 * 只扫 COMPLETED：pendingCharge 仅在 processor 成功路径（markCompleted 之后扣费失败）
 * 写入，任务仍在 RUNNING/QUEUED 时其最终扣费由 markCompleted 完成；FAILED 任务不扣费。
 * status='COMPLETED' 守卫避免与 processor 成功路径竞态（若 sweep 与 markCompleted
 * 同时跑，后者先 CAS 置 COMPLETED 并清空 pendingCharge，sweep 这条便查不到）。
 * ORDER BY pendingCharge.createdAt → 先补最早的欠费。
 *
 * @param limit - 单次上界（默认 PENDING_CHARGE_SWEEP_BATCH_LIMIT）
 */
export async function findPendingChargeTasks(
  limit: number = PENDING_CHARGE_SWEEP_BATCH_LIMIT,
): Promise<PendingChargeRow[]> {
  const result = await query(
    `SELECT id, "userId", "pendingCharge"
     FROM tasks
     WHERE "pendingCharge" IS NOT NULL AND status = 'COMPLETED'
     ORDER BY "pendingCharge"->>'createdAt'
     LIMIT $1`,
    [limit],
  );
  return (result.rows ?? []) as PendingChargeRow[];
}

/**
 * 清空 pendingCharge（补扣成功后标记欠费已收）。CAS 不必要——chargeCredits 已原子扣成功。
 */
export async function clearPendingCharge(taskId: string): Promise<void> {
  await query(
    `UPDATE tasks SET "pendingCharge" = NULL, "updatedAt" = NOW() WHERE id = $1`,
    [taskId],
  );
}

/**
 * 默认补扣动作：调 chargeCredits 原子扣减积分。
 *
 * 失败（余额不足等）抛 BillingError → sweep 捕获计 errored，留待下次 tick 重试。
 * metadata 标 source=pending-charge-sweep 便于账本审计区分即时扣费 vs 补扣。
 */
async function defaultCharge(row: PendingChargeRow): Promise<void> {
  const credits = Number(row.pendingCharge?.credits ?? 0);
  const reason = String(row.pendingCharge?.reason ?? '未知原因');
  await chargeCredits(row.userId, credits, {
    taskId: row.id,
    description: '任务补扣（pendingCharge sweep）',
    metadata: { source: 'pending-charge-sweep', originalReason: reason },
  });
}

/**
 * 单次扫描：找 pendingCharge 非空的 COMPLETED 任务，逐条重试扣费。
 * 成功则清空 pendingCharge；失败留待下次 tick。永不抛。
 *
 * 返回统计；单笔出错计 errored 并继续下一笔——sweep 绝不能因一笔坏单停摆。
 */
export async function sweepPendingCharges(
  deps: PendingChargeSweepDeps = {},
): Promise<PendingChargeSweepResult> {
  const findPending = deps.findPending ?? findPendingChargeTasks;
  const log = deps.log ?? defaultLog;

  const result: PendingChargeSweepResult = { scanned: 0, charged: 0, errored: 0 };

  let rows: PendingChargeRow[];
  try {
    rows = await findPending(PENDING_CHARGE_SWEEP_BATCH_LIMIT);
  } catch (err) {
    log('[pending-charge-sweep] findPending 失败，本 tick 跳过', { err: String(err) });
    return result;
  }

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const charge = deps.charge ?? defaultCharge;
  const clear = deps.clear ?? clearPendingCharge;

  for (const row of rows) {
    try {
      await charge(row);
      await clear(row.id);
      result.charged++;
    } catch (err) {
      result.errored++;
      log('[pending-charge-sweep] 单笔补扣失败，留待下次', {
        taskId: row.id,
        err: String(err),
      });
    }
  }

  log('[pending-charge-sweep] tick 完成', result);
  return result;
}

// ============================================================
// ② billing_ledger PENDING_DEBIT 补扣（sync direct 路径，P0-2）
// ============================================================

/** PENDING_DEBIT 补扣单次 tick 统计 */
export interface PendingDebitSweepResult {
  scanned: number;
  /** 本 tick 成功补扣并标 settled（含 409 终态豁免）。 */
  settled: number;
  /** 单笔异常（留待下次 tick 重试）。 */
  errored: number;
}

/** 依赖注入（测试用；默认接真实 billing 辅助函数 + chargeAggregated/chargeCredits） */
export interface PendingDebitSweepDeps {
  findPending?: (limit: number) => Promise<PendingDebitRow[]>;
  charge?: (row: PendingDebitRow) => Promise<void>;
  markSettled?: (entryId: string, note?: Record<string, unknown>) => Promise<void>;
  markAttempted?: (entryId: string, errMsg: string) => Promise<void>;
  log?: (msg: string, meta?: unknown) => void;
}

/**
 * 默认补扣动作：按 metadata.billingMode 分派到对应 charge 函数。
 *
 * - 'aggregate'（billingTaskId + billingUnitId 齐备）→ chargeAggregatedTaskCost，
 *   该函数按 unitId 幂等（已结算的 unit 直接返回历史快照不重扣），天然防 sweep 重入双扣。
 * - 其他（'simple' 或缺省）→ chargeCredits 原子条件 UPDATE 扣减；metadata.source 标
 *   'pending-debit-sweep' 并附 pendingDebitId 便于账本审计回溯到原欠费行。
 *
 * credits 取 metadata.credits（recordPendingDebit 写入时已 ceil），fallback 到 row.amount。
 * 失败抛 BillingError → sweep 捕获按 statusCode 分类处理（409=豁免，其他=重试）。
 */
async function defaultChargePendingDebit(row: PendingDebitRow): Promise<void> {
  const meta = row.metadata ?? {};
  const mode = String(meta.billingMode ?? 'simple');
  if (mode === 'aggregate') {
    const taskId = String(meta.billingTaskId ?? '');
    const unitId = String(meta.billingUnitId ?? '');
    if (!taskId || !unitId) {
      // metadata 标 aggregate 但缺 id —— 数据异常，不可恢复，抛错让 sweep 当 errored 跳过
      throw new Error(
        `PENDING_DEBIT ${row.id} billingMode=aggregate 但缺 billingTaskId/billingUnitId`,
      );
    }
    const costYuan = Number.isFinite(Number(meta.costYuan)) ? Number(meta.costYuan) : 0;
    await chargeAggregatedTaskCost(
      row.userId,
      taskId,
      unitId,
      costYuan,
      '视频任务累计补扣（PENDING_DEBIT sweep）',
    );
    return;
  }
  const creditsRaw = Number(meta.credits);
  const credits = Number.isFinite(creditsRaw) && creditsRaw > 0 ? creditsRaw : row.amount;
  const reason = String(meta.reason ?? '未知原因');
  await chargeCredits(row.userId, credits, {
    taskId: row.taskId,
    description: '同步生成补扣（PENDING_DEBIT sweep）',
    metadata: {
      source: 'pending-debit-sweep',
      originalReason: reason,
      pendingDebitId: row.id,
    },
  });
}

/**
 * 单次扫描：找未结清 PENDING_DEBIT 行，逐条按 billingMode 补扣。
 *
 * 成功 → markSettled（settled=true）。409 终态（任务 FAILED/CANCELLED 已退款，不可再扣）
 *        → markSettled + {waived:true, waiveReason} 避免下 tick 无限重试。
 * 其他失败 → markAttempted（写 lastAttemptAt/lastError，留行 unsettled）等下个 tick。
 * 永不抛。返回统计 {scanned, settled, errored}。
 *
 * 幂等保证：markSettled 后 metadata.settled=true，findPendingDebitEntries 下 tick 查不到。
 * chargeAggregatedTaskCost 自身按 unitId 幂等（crash 在 charge 与 markSettled 之间时，
 * 下 tick 重入 charge 不会双扣——同 unitId 返回历史快照）；chargeCredits crash-window
 * 理论上可能双扣（与原 sweepPendingCharges 同限制），但单 worker + overlap guard 下可接受。
 */
export async function sweepPendingDebits(
  deps: PendingDebitSweepDeps = {},
): Promise<PendingDebitSweepResult> {
  const findPending = deps.findPending ?? findPendingDebitEntries;
  const log = deps.log ?? defaultLog;

  const result: PendingDebitSweepResult = { scanned: 0, settled: 0, errored: 0 };

  let rows: PendingDebitRow[];
  try {
    rows = await findPending(PENDING_CHARGE_SWEEP_BATCH_LIMIT);
  } catch (err) {
    log('[pending-debit-sweep] findPending 失败，本 tick 跳过', { err: String(err) });
    return result;
  }

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const charge = deps.charge ?? defaultChargePendingDebit;
  const markSettled = deps.markSettled ?? markPendingDebitSettled;
  const markAttempted = deps.markAttempted ?? markPendingDebitAttempted;

  for (const row of rows) {
    try {
      await charge(row);
      await markSettled(row.id);
      result.settled++;
    } catch (err) {
      const status = getErrorStatusCode(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (status === 409) {
        // 任务已 FAILED/CANCELLED 终态（render_jobs 状态守卫拒绝迟到结算）——
        // 已退款，不可再扣。标 settled + waived 避免下 tick 无限重试同一拒绝。
        try {
          await markSettled(row.id, { waived: true, waiveReason: 'task-terminal-409' });
          result.settled++;
        } catch (markErr) {
          result.errored++;
          log('[pending-debit-sweep] 409 豁免 markSettled 失败，留下次', {
            id: row.id,
            err: String(markErr),
          });
        }
        continue;
      }
      result.errored++;
      // 写 lastAttemptAt/lastError 便于审计。包 try/catch：DI 注入的 markAttempted
      // 可能抛（默认实现自身已吞，但不能假设注入版也吞）；此处再兜底防止单笔的
      // markAttempted 失败击穿整个 tick。行仍 unsettled，下 tick 会再扫到。
      try {
        await markAttempted(row.id, errMsg);
      } catch {
        // 静默：markAttempted 失败不影响 errored 计数与下 tick 重试
      }
      log('[pending-debit-sweep] 单笔补扣失败，留待下次', { id: row.id, err: errMsg });
    }
  }

  log('[pending-debit-sweep] tick 完成', result);
  return result;
}

/** sweep 定时器句柄 */
export interface PendingChargeSweepHandle {
  stop: () => void;
}

/**
 * 启动 pendingCharge 补扣定时（常驻 worker 调一次）。返回 stop 句柄。
 *
 * 单一 interval 内顺序跑两个 sweep（共享 overlap guard / 节拍，避免双 interval 复杂化运维）：
 *   1. sweepPendingCharges —— 扫 tasks.pendingCharge（ai-worker 任务路径欠费）
 *   2. sweepPendingDebits  —— 扫 billing_ledger PENDING_DEBIT（sync direct 路径欠费）
 * 两者数据源隔离、互不依赖，任一抛错另一仍跑（各自 try/catch 兜底）。
 *
 * overlap guard：上一 tick 没跑完不起新 tick。tick 内部已 try/catch，定时器层再兜底 catch。
 *
 * @param opts.intervalMs      - 节拍（默认 60s）
 * @param opts.deps            - sweepPendingCharges DI（测试用）
 * @param opts.pendingDebitDeps - sweepPendingDebits DI（测试用）
 */
export function startPendingChargeSweep(
  opts: {
    intervalMs?: number;
    deps?: PendingChargeSweepDeps;
    pendingDebitDeps?: PendingDebitSweepDeps;
  } = {},
): PendingChargeSweepHandle {
  const intervalMs = opts.intervalMs ?? PENDING_CHARGE_SWEEP_INTERVAL_MS;
  const deps: PendingChargeSweepDeps = { log: defaultLog, ...opts.deps };
  const pendingDebitDeps: PendingDebitSweepDeps = { log: defaultLog, ...opts.pendingDebitDeps };
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      try {
        await sweepPendingCharges(deps);
      } catch (err) {
        // sweepPendingCharges 自身不应抛，但即使抛了也不能让 sweepPendingDebits 跑不到
        console.error('[pending-charge-sweep] sweepPendingCharges 未捕获异常', err);
      }
      try {
        await sweepPendingDebits(pendingDebitDeps);
      } catch (err) {
        console.error('[pending-charge-sweep] sweepPendingDebits 未捕获异常', err);
      }
    } catch (err) {
      // 最外层兜底（理论上到不了这里）
      console.error('[pending-charge-sweep] tick 未捕获异常', err);
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
