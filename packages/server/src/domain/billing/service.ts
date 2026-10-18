// ============================================================
// ③ server/domain/billing — 计费服务（扣费 / 退款 / 余额查询）
// ============================================================
//
// 文件职责：
//   提供用户积分的全生命周期管理：
//   1. getBalance(userId)        — 查询用户积分余额（可用 / 冻结）
//   2. chargeCredits(userId, amount) — 扣减积分（原子条件 UPDATE 防双花）
//   3. refundTaskDebit(userId, taskId) — 渲染失败时按原任务扣费幂等退款
//   4. creditRefund(userId, amount, taskId) — 通用退款 / 充值积分
//
// 数据模型（见 0001-init.sql）：
//   - users 表的 credits 字段存储当前可用积分（INTEGER）
//   - billing_ledger 表记录每一笔变动（扣费 / 退款 / 充值），含操作后余额快照
//   - 所有写操作通过 @server/infra 的 tx() 保证原子性（更新余额 + 写账本同事务）
//
// 与 app1 的差异：
//   - app1 用 Prisma（prisma.user.updateMany / prisma.$transaction），
//     本实现改用手写 pg：条件 UPDATE ... WHERE credits >= $1 RETURNING credits，
//     单条 UPDATE 天然原子，rowCount=0 即余额不足。
//   - app1 的 debitByCost 接收元价（cost）并内部 yuanToCredits 加价转积分；
//     本实现的 chargeCredits 直接接收积分数（amount），由调用方决定换算时机，
//     职责更清晰（gateway 路径在调用前自行 yuanToCredits）。
//   - 错误模型保持一致：BillingError 携带 statusCode（402 余额不足 / 404 用户不存在）。
//
// 安全约束：
//   - 零 ffmpeg 依赖（本模块零 ffmpeg import）
//   - 余额变更全在事务内，余额不足抛错触发 ROLLBACK，账本不写
// ============================================================

import { genId } from '@shared/utils';
import { query, tx } from '@server/infra';
import { yuanToCredits } from './rules';

// ============================================================
// 类型定义
// ============================================================

/** 账本条目类型（与 billing_ledger.type 对齐） */
export type LedgerEntryType =
  | 'TASK_DEBIT' // 任务扣费
  | 'REFUND' // 退款（任务失败回退）
  | 'PURCHASE_CREDIT' // 用户充值
  | 'ADMIN_CREDIT' // 管理员充值
  | 'QUOTA_CREDIT' // 系统补偿
  | 'PENDING_DEBIT'; // 扣费失败欠费待补扣（sync direct 路径兜底）

/** 用户余额视图 */
export interface UserBalance {
  userId: string;
  /** 当前积分余额 */
  credits: number;
  /** 冻结积分（当前无冻结机制，恒为 0） */
  frozenCredits: number;
  /** 可用积分 = credits - frozenCredits */
  availableCredits: number;
  /** ADMIN 用户无限额（扣费走 no-op 账本） */
  unlimited: boolean;
}

/** 账本条目（与 billing_ledger 行对齐） */
export interface BillingEntry {
  id: string;
  userId: string;
  taskId: string | null;
  type: LedgerEntryType;
  /** 变动金额（正=扣费，负=充值，与 billing_ledger.amount 对齐） */
  amount: number;
  /** 操作后余额 */
  balance: number;
  /** 积分变动（正=增加，负=减少，与 billing_ledger.credits 对齐） */
  credits: number;
  description: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ============================================================
// 错误类型
// ============================================================

/**
 * 计费错误
 *
 * 携带 statusCode 属性，供 API 层映射到 HTTP 状态码。
 * - 402 余额不足
 * - 404 用户不存在
 */
export class BillingError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'BillingError';
    this.statusCode = statusCode;
  }
}

// ============================================================
// 内部辅助
// ============================================================

/** users 表行（仅取所需列） */
interface UserRow {
  credits: number;
  role: string;
}

/** 把 SQL 行映射为 UserBalance（frozenCredits 恒 0，unlimited = role==='ADMIN'） */
function toUserBalance(userId: string, row: UserRow): UserBalance {
  const credits = row.credits ?? 0;
  const frozenCredits = 0;
  return {
    userId,
    credits,
    frozenCredits,
    availableCredits: credits - frozenCredits,
    unlimited: row.role === 'ADMIN',
  };
}

// ============================================================
// 公共 API
// ============================================================

/**
 * 查询用户余额
 *
 * @param userId - 用户 ID
 * @returns 余额信息（credits / frozenCredits / availableCredits / unlimited）
 * @throws BillingError(404) 用户不存在
 */
export async function getBalance(userId: string): Promise<UserBalance> {
  const result = await query(
    'SELECT credits, role FROM users WHERE id = $1',
    [userId],
  );
  const row = result.rows[0] as UserRow | undefined;
  if (!row) {
    throw new BillingError('用户不存在', 404);
  }
  return toUserBalance(userId, row);
}

/**
 * 扣减积分
 *
 * 原子条件 UPDATE：`UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1`
 * - 单条 UPDATE 天然原子：余额够则扣（rowCount=1），不够则 rowCount=0 → 抛 402
 * - 同事务写 billing_ledger（type=TASK_DEBIT, amount=正, credits=负）
 * - ADMIN 用户（unlimited）不扣费，仅写 no-op 账本条目
 * - amount <= 0：no-op 账本条目，不动余额
 *
 * @param userId  - 用户 ID
 * @param amount  - 扣减积分数（正整数）
 * @param options - 可选：taskId / description / metadata
 * @returns 账本条目（含操作后余额）
 * @throws BillingError(402) 余额不足
 * @throws BillingError(404) 用户不存在
 */
export async function chargeCredits(
  userId: string,
  amount: number,
  options: {
    taskId?: string | null;
    description?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<BillingEntry> {
  const description = options.description ?? '任务扣费';
  const taskId = options.taskId ?? null;

  // 查用户（含 unlimited 判定）
  const balance = await getBalance(userId);

  // ADMIN 无限额：no-op 账本
  if (balance.unlimited) {
    return writeLedgerEntry({
      userId,
      taskId,
      type: 'TASK_DEBIT',
      amount: 0,
      credits: 0,
      description,
      metadata: { adminUnlimited: true, requestedAmount: amount, ...(options.metadata ?? {}) },
    });
  }

  // 非正数：no-op 账本
  if (!Number.isFinite(amount) || amount <= 0) {
    return writeLedgerEntry({
      userId,
      taskId,
      type: 'TASK_DEBIT',
      amount: 0,
      credits: 0,
      description,
      metadata: { noOp: true, ...(options.metadata ?? {}) },
    });
  }

  const creditsToDebit = Math.max(1, Math.ceil(amount));

  // 事务：原子条件扣减 + 写账本
  return tx(async (q) => {
    const updateResult = await q.query(
      'UPDATE users SET credits = credits - $1, "updatedAt" = NOW() WHERE id = $2 AND credits >= $1 RETURNING credits',
      [creditsToDebit, userId],
    );
    if (updateResult.rowCount === 0 || updateResult.rows.length === 0) {
      throw new BillingError('积分余额不足，请充值后重试', 402);
    }
    const newBalance = (updateResult.rows[0] as { credits: number }).credits;
    const entryId = genId();
    await q.query(
      `INSERT INTO billing_ledger
        (id, "userId", "taskId", type, amount, balance, credits, description, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
      [
        entryId,
        userId,
        taskId,
        'TASK_DEBIT',
        creditsToDebit, // amount 正=扣费
        newBalance,
        -creditsToDebit, // credits 负=减少
        description,
        JSON.stringify({
          billedCredits: creditsToDebit,
          requestedAmount: amount,
          ...(options.metadata ?? {}),
        }),
      ],
    );
    return {
      id: entryId,
      userId,
      taskId,
      type: 'TASK_DEBIT' as const,
      amount: creditsToDebit,
      balance: newBalance,
      credits: -creditsToDebit,
      description,
      metadata: { billedCredits: creditsToDebit, requestedAmount: amount, ...(options.metadata ?? {}) },
      createdAt: new Date().toISOString(),
    };
  });
}

/**
 * 把同一 C/S 视频任务的多次供应商调用按 app1 的任务边界累计结算。
 *
 * 客户端一键出片会逐组调用云端生成；若每组各自向上取整，会比 app1“先汇总成本，
 * 最后取整一次”多扣。这里用 taskId advisory lock 串行累计 raw cost，再只扣
 * `yuanToCredits(累计成本)` 相对上次账单的差额。unitId 同时令 HTTP 重试幂等，
 * 避免响应丢失后同一段视频被重复计费。
 */
export async function chargeAggregatedTaskCost(
  userId: string,
  taskId: string,
  unitId: string,
  costYuan: number,
  description = '视频任务累计扣费',
): Promise<BillingEntry> {
  const normalizedTaskId = taskId.trim();
  const normalizedUnitId = unitId.trim();
  if (!normalizedTaskId || !normalizedUnitId) {
    throw new BillingError('累计计费缺少 taskId 或 unitId', 400);
  }
  const normalizedCost = Number.isFinite(costYuan) && costYuan > 0 ? costYuan : 0;

  return tx(async (q) => {
    // hashtextextended 只用于事务锁键，不进入业务数据；同一 task 的并行组会顺序结算。
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [normalizedTaskId]);
    // 客户端可能已上报失败，但断开的旧 HTTP 请求仍在模型侧完成；终态后拒绝迟到扣费。
    // ⚠ 必须按 task_id 查（非主键 id）：chargeAggregatedTaskCost 的 normalizedTaskId =
    // billingTaskId = render_jobs.task_id（chain-generate route 派发的 taskId，写入
    // render_jobs.task_id 列；render_jobs.id 是另一次 genId 主键）。若按主键 id 查永远
    // 查不到 → renderStatus 恒 undefined → 409 终态门形同虚设 → FAILED/CANCELLED 后迟到
    // 结算仍被扣费（资损，曾因 job.id 与 task_id 混淆导致）。
    const renderStateResult = await q.query(
      'SELECT status FROM render_jobs WHERE task_id = $1 AND user_id = $2 LIMIT 1',
      [normalizedTaskId, userId],
    );
    const renderStatus = (renderStateResult.rows[0] as { status?: string } | undefined)?.status;
    if (renderStatus === 'FAILED' || renderStatus === 'CANCELLED') {
      throw new BillingError('任务已进入失败或取消终态，拒绝迟到结算', 409);
    }
    const userResult = await q.query(
      'SELECT credits, role FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const user = userResult.rows[0] as UserRow | undefined;
    if (!user) throw new BillingError('用户不存在', 404);

    const existingResult = await q.query(
      `SELECT id, amount, balance, credits, description, metadata, "createdAt"
         FROM billing_ledger
        WHERE "userId" = $1 AND "taskId" = $2 AND type = 'TASK_DEBIT'
        LIMIT 1`,
      [userId, normalizedTaskId],
    );
    const existing = existingResult.rows[0] as {
      id: string;
      amount: number;
      balance: number;
      credits: number;
      description: string;
      metadata: string | Record<string, unknown> | null;
      createdAt: string | Date;
    } | undefined;
    const existingMeta = existing?.metadata
      ? (typeof existing.metadata === 'string'
          ? JSON.parse(existing.metadata) as Record<string, unknown>
          : existing.metadata)
      : {};
    const unitCosts = existingMeta.unitCosts && typeof existingMeta.unitCosts === 'object'
      && !Array.isArray(existingMeta.unitCosts)
      ? existingMeta.unitCosts as Record<string, number>
      : {};

    // 同一客户端请求重试命中已结算 unit：直接返回历史快照，不再次扣费。
    if (Object.prototype.hasOwnProperty.call(unitCosts, normalizedUnitId) && existing) {
      return {
        id: existing.id,
        userId,
        taskId: normalizedTaskId,
        type: 'TASK_DEBIT' as const,
        amount: Number(existing.amount) || 0,
        balance: Number(existing.balance) || user.credits,
        credits: Number(existing.credits) || 0,
        description: existing.description,
        metadata: existingMeta,
        createdAt: new Date(existing.createdAt).toISOString(),
      };
    }

    const previousCost = Math.max(0, Number(existingMeta.cost) || 0);
    const cumulativeCost = previousCost + normalizedCost;
    const targetCredits = user.role === 'ADMIN' ? 0 : yuanToCredits(cumulativeCost);
    const previousCredits = user.role === 'ADMIN' ? 0 : Math.max(0, Number(existing?.amount) || 0);
    const deltaCredits = Math.max(0, targetCredits - previousCredits);
    let newBalance = user.credits;
    if (deltaCredits > 0) {
      const updateResult = await q.query(
        'UPDATE users SET credits = credits - $1, "updatedAt" = NOW() WHERE id = $2 AND credits >= $1 RETURNING credits',
        [deltaCredits, userId],
      );
      if (updateResult.rowCount === 0 || updateResult.rows.length === 0) {
        throw new BillingError('积分余额不足，请充值后重试', 402);
      }
      newBalance = Number((updateResult.rows[0] as { credits: number }).credits);
    }

    const metadata = {
      ...existingMeta,
      cost: cumulativeCost,
      platformCostYuan: cumulativeCost,
      billedCredits: targetCredits,
      billingMode: 'aggregate-video-task',
      unitCosts: { ...unitCosts, [normalizedUnitId]: normalizedCost },
      ...(user.role === 'ADMIN' ? { adminUnlimited: true } : {}),
    };
    const entryId = existing?.id ?? genId();
    if (existing) {
      await q.query(
        `UPDATE billing_ledger
            SET amount = $1, balance = $2, credits = $3, description = $4,
                metadata = $5::jsonb, "updatedAt" = NOW()
          WHERE id = $6`,
        [targetCredits, newBalance, -targetCredits, description, JSON.stringify(metadata), entryId],
      );
    } else {
      await q.query(
        `INSERT INTO billing_ledger
          (id, "userId", "taskId", type, amount, balance, credits, description, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'TASK_DEBIT', $4, $5, $6, $7, $8::jsonb, NOW(), NOW())`,
        [entryId, userId, normalizedTaskId, targetCredits, newBalance, -targetCredits, description, JSON.stringify(metadata)],
      );
    }
    return {
      id: entryId,
      userId,
      taskId: normalizedTaskId,
      type: 'TASK_DEBIT' as const,
      amount: targetCredits,
      balance: newBalance,
      credits: -targetCredits,
      description,
      metadata,
      createdAt: existing ? new Date(existing.createdAt).toISOString() : new Date().toISOString(),
    };
  });
}

/**
 * 写入一条 PENDING_DEBIT 欠费账本（扣费失败留痕，待补扣 sweep 重试）。
 *
 * 用于同步直连生成路径（web/lib/direct-media-generation.billDirectGeneration）
 * 的扣费失败兜底：当 chargeCredits / chargeAggregatedTaskCost 因非 402 异常失败
 * （PG 连接抖动、redis 超时、事务冲突等）时，平台已付供应商 token，用户拿到了
 * 产物——不能因基础设施抖动浪费一次成功生成。但漏扣必须留痕可审计、可补扣，
 * 否则高并发/DB 抖动时批量免费、零审计。
 *
 * 与 ai-worker 路径的差异：
 *   - ai-worker（processor.ts）走 tasks 任务行：扣费失败写 tasks.pendingCharge JSONB，
 *     补扣 sweep 扫 `pendingCharge IS NOT NULL`。
 *   - 同步直连路径**不创建 tasks 行**（无处写 pendingCharge），改写一条独立的
 *     billing_ledger 欠费记录 type='PENDING_DEBIT'。补扣 sweep 扫此 type 重试扣费，
 *     成功后写入对应 TASK_DEBIT 并将本 PENDING_DEBIT 标记 settled（删行或加 settledAt，
 *     由 sweep 自行决定）。
 *
 * 不动 users.credits：欠费记录仅用于审计 + 补扣输入，实际扣减发生在补扣 sweep
 * 成功后由 chargeCredits / chargeAggregatedTaskCost 写 TASK_DEBIT 行时完成。
 *
 * 幂等：本函数由 billDirectGeneration 在 chargeCredits 抛非 402 后调用一次。
 * 多次调用会产生多条 PENDING_DEBIT（每条 id 唯一），但同一次失败只调一次；
 * 补扣 sweep 必须自带幂等（按 PENDING_DEBIT id 去重，成功后标记 / 删除）。
 *
 * 永不抛错：本函数自身也处于异常分支（chargeCredits 已失败），任何写入异常
 * 仅 console.error 并返回 null，避免污染上层 try/catch。返回写入的账本条目
 * （含 id）便于调用方日志追踪；返回 null 表示连欠费记录都没写成（极端 DB 不可用）。
 *
 * @returns 写入的账本条目（含 id）；写入失败返回 null
 */
export async function recordPendingDebit(input: {
  userId: string;
  /** 应扣积分数（正数，由调用方 yuanToCredits 算好）。 */
  credits: number;
  /** 原始成本（元，含平台加价前的供应商成本）。 */
  costYuan: number;
  description: string;
  taskType: string;
  /** 累计计费模式：aggregate 时 sweep 应调 chargeAggregatedTaskCost；否则 chargeCredits。 */
  billingTaskId?: string;
  billingUnitId?: string;
  /** 失败原因（error.message 或字符串化）。 */
  reason: string;
  /** 来源标记（如 'sync-direct'），便于与 TASK_DEBIT 行的 metadata.source 对齐。 */
  source?: string;
}): Promise<BillingEntry | null> {
  const creditsToDebit =
    Number.isFinite(input.credits) && input.credits > 0
      ? Math.max(1, Math.ceil(input.credits))
      : 0;
  const useAggregate = Boolean(input.billingTaskId && input.billingUnitId);
  const metadata: Record<string, unknown> = {
    pendingDebit: true,
    costYuan: input.costYuan,
    credits: creditsToDebit,
    taskType: input.taskType,
    reason: input.reason,
    source: input.source ?? 'sync-direct',
    billingMode: useAggregate ? 'aggregate' : 'simple',
    ...(input.billingTaskId ? { billingTaskId: input.billingTaskId } : {}),
    ...(input.billingUnitId ? { billingUnitId: input.billingUnitId } : {}),
  };

  // 拿当前余额作 balance 快照（失败也写 0 + balanceUnknown=true，不阻断欠费记录）。
  // 注：chargeCredits 失败可能是 DB 瞬断；getBalance 也可能失败——但即使读不到余额，
  // 仍要写欠费记录（至少留 reason / costYuan / credits 给运维与补扣 sweep）。
  let balanceSnapshot = 0;
  let balanceUnknown = false;
  try {
    const balance = await getBalance(input.userId);
    balanceSnapshot = balance.credits;
  } catch (balErr) {
    balanceUnknown = true;
    metadata.balanceReadError = balErr instanceof Error ? balErr.message : String(balErr);
  }
  if (balanceUnknown) metadata.balanceUnknown = true;

  const entryId = genId();
  const description = input.description
    ? `${input.description}（欠费待补扣）`
    : '扣费失败欠费待补扣';
  try {
    await query(
      `INSERT INTO billing_ledger
        (id, "userId", "taskId", type, amount, balance, credits, description, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'PENDING_DEBIT', $4, $5, $6, $7, $8::jsonb, NOW(), NOW())`,
      [
        entryId,
        input.userId,
        input.billingTaskId ?? null,
        creditsToDebit, // amount 正=欠费（待扣）
        balanceSnapshot, // balance：失败时余额快照（占位 0 if unknown）
        -creditsToDebit, // credits 负=减少
        description,
        JSON.stringify(metadata),
      ],
    );
  } catch (writeErr) {
    // 连欠费账本都写不进：极端 DB 不可用。仅记 error 不抛（已在异常分支）。
    console.error(
      `[billing] 写 PENDING_DEBIT 失败 (userId=${input.userId}, ` +
        `taskType=${input.taskType}, credits=${creditsToDebit}): ` +
        `${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
    );
    return null;
  }

  return {
    id: entryId,
    userId: input.userId,
    taskId: input.billingTaskId ?? null,
    type: 'PENDING_DEBIT',
    amount: creditsToDebit,
    balance: balanceSnapshot,
    credits: -creditsToDebit,
    description,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 按任务退回其 TASK_DEBIT，供渲染任务失败补偿。
 *
 * 同一个 task advisory lock 同时覆盖累计扣费与退款，因而能正确处理“失败上报”和
 * “断线请求迟到结算”的竞态；已有 REFUND 时直接返回历史条目，保证接口重试幂等。
 * 找不到扣费或扣费为 0 时返回 null，不制造无意义账本。
 */
export async function refundTaskDebit(
  userId: string,
  taskId: string,
): Promise<BillingEntry | null> {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    throw new BillingError('任务退款缺少 taskId', 400);
  }

  return tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [normalizedTaskId]);

    const existingRefundResult = await q.query(
      `SELECT id, amount, balance, credits, description, metadata, "createdAt"
         FROM billing_ledger
        WHERE "userId" = $1 AND "taskId" = $2 AND type = 'REFUND'
        LIMIT 1`,
      [userId, normalizedTaskId],
    );
    const existingRefund = existingRefundResult.rows[0] as {
      id: string;
      amount: number;
      balance: number;
      credits: number;
      description: string;
      metadata: string | Record<string, unknown> | null;
      createdAt: string | Date;
    } | undefined;
    if (existingRefund) {
      const metadata = typeof existingRefund.metadata === 'string'
        ? JSON.parse(existingRefund.metadata) as Record<string, unknown>
        : existingRefund.metadata;
      return {
        id: existingRefund.id,
        userId,
        taskId: normalizedTaskId,
        type: 'REFUND',
        amount: Number(existingRefund.amount) || 0,
        balance: Number(existingRefund.balance) || 0,
        credits: Number(existingRefund.credits) || 0,
        description: existingRefund.description,
        metadata,
        createdAt: new Date(existingRefund.createdAt).toISOString(),
      };
    }

    const debitResult = await q.query(
      `SELECT amount
         FROM billing_ledger
        WHERE "userId" = $1 AND "taskId" = $2 AND type = 'TASK_DEBIT'
        LIMIT 1`,
      [userId, normalizedTaskId],
    );
    const debitCredits = Math.max(
      0,
      Number((debitResult.rows[0] as { amount?: number } | undefined)?.amount) || 0,
    );
    if (debitCredits <= 0) return null;

    const updateResult = await q.query(
      'UPDATE users SET credits = credits + $1, "updatedAt" = NOW() WHERE id = $2 RETURNING credits',
      [debitCredits, userId],
    );
    if (updateResult.rowCount === 0 || updateResult.rows.length === 0) {
      throw new BillingError('用户不存在', 404);
    }

    const newBalance = Number((updateResult.rows[0] as { credits: number }).credits);
    const entryId = genId();
    const description = `任务失败退款 (${normalizedTaskId})`;
    const metadata = {
      refundCredits: debitCredits,
      taskId: normalizedTaskId,
      reason: 'render-job-failed',
    };
    await q.query(
      `INSERT INTO billing_ledger
        (id, "userId", "taskId", type, amount, balance, credits, description, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'REFUND', $4, $5, $6, $7, $8::jsonb, NOW(), NOW())`,
      [
        entryId,
        userId,
        normalizedTaskId,
        -debitCredits,
        newBalance,
        debitCredits,
        description,
        JSON.stringify(metadata),
      ],
    );
    return {
      id: entryId,
      userId,
      taskId: normalizedTaskId,
      type: 'REFUND',
      amount: -debitCredits,
      balance: newBalance,
      credits: debitCredits,
      description,
      metadata,
      createdAt: new Date().toISOString(),
    };
  });
}

/**
 * 退款 / 充值积分
 *
 * 原子 UPDATE：`UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits`
 * - 同事务写 billing_ledger（type=REFUND, taskId, amount=负, credits=正）
 * - amount <= 0：no-op 账本条目，不动余额
 *
 * 用于任务失败时回退已扣积分（taskId 关联防重放，依赖 billing_ledger 的
 * 部分唯一索引 idx_billing_ledger_user_task_type_unique）。
 *
 * @param userId - 用户 ID
 * @param amount - 退款积分数（正数）
 * @param taskId - 关联任务 ID（可选，用于防重放）
 * @returns 账本条目（含操作后余额）
 * @throws BillingError(404) 用户不存在
 */
export async function creditRefund(
  userId: string,
  amount: number,
  taskId: string | null = null,
): Promise<BillingEntry> {
  // 查用户（确认存在）
  await getBalance(userId);

  const description = taskId ? `任务退款 (${taskId})` : '退款';

  // 非正数：no-op 账本
  if (!Number.isFinite(amount) || amount <= 0) {
    return writeLedgerEntry({
      userId,
      taskId,
      type: 'REFUND',
      amount: 0,
      credits: 0,
      description,
      metadata: { noOp: true },
    });
  }

  const creditsToRefund = Math.max(1, Math.ceil(amount));

  // 事务：原子增加余额 + 写账本
  return tx(async (q) => {
    const updateResult = await q.query(
      'UPDATE users SET credits = credits + $1, "updatedAt" = NOW() WHERE id = $2 RETURNING credits',
      [creditsToRefund, userId],
    );
    const newBalance = (updateResult.rows[0] as { credits: number }).credits;
    const entryId = genId();
    await q.query(
      `INSERT INTO billing_ledger
        (id, "userId", "taskId", type, amount, balance, credits, description, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
      [
        entryId,
        userId,
        taskId,
        'REFUND',
        -creditsToRefund, // amount 负=充值
        newBalance,
        creditsToRefund, // credits 正=增加
        description,
        JSON.stringify({ refundCredits: creditsToRefund, taskId }),
      ],
    );
    return {
      id: entryId,
      userId,
      taskId,
      type: 'REFUND' as const,
      amount: -creditsToRefund,
      balance: newBalance,
      credits: creditsToRefund,
      description,
      metadata: { refundCredits: creditsToRefund, taskId },
      createdAt: new Date().toISOString(),
    };
  });
}

/**
 * 充值积分（支付宝到账发放，P6）
 *
 * 原子 UPDATE：`UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits`
 * - 同事务写 billing_ledger（type=PURCHASE_CREDIT, amount=负, credits=正）
 * - credits <= 0：no-op 账本条目，不动余额
 *
 * 幂等由调用方保证：PaymentService.markPaidAndCredit 的订单状态机 PENDING→PAID
 * 原子抢占（repo.claimPaid）只让抢到的那次订单调本函数，故不依赖 billing_ledger
 * 的 task 防重放唯一索引（该索引是 (userId,taskId,type) 维度，taskId 对充值恒 NULL，
 * 不适用）。metadata.orderId 记关联订单便于对账。
 *
 * @param userId  - 用户 ID
 * @param credits - 充值积分数（正数）
 * @param orderId - 关联 payment_orders.id（对账用）
 * @returns 账本条目（含操作后余额）
 * @throws BillingError(404) 用户不存在
 */
export async function creditPurchase(
  userId: string,
  credits: number,
  orderId: string,
): Promise<BillingEntry> {
  // 查用户（确认存在）
  await getBalance(userId);

  const description = `支付宝充值（订单 ${orderId}）`;

  // 非正数：no-op 账本
  if (!Number.isFinite(credits) || credits <= 0) {
    return writeLedgerEntry({
      userId,
      taskId: null,
      type: 'PURCHASE_CREDIT',
      amount: 0,
      credits: 0,
      description,
      metadata: { noOp: true, orderId },
    });
  }

  const creditsToCredit = Math.max(1, Math.ceil(credits));

  // 事务：原子增加余额 + 写账本
  return tx(async (q) => {
    const updateResult = await q.query(
      'UPDATE users SET credits = credits + $1, "updatedAt" = NOW() WHERE id = $2 RETURNING credits',
      [creditsToCredit, userId],
    );
    const newBalance = (updateResult.rows[0] as { credits: number }).credits;
    const entryId = genId();
    await q.query(
      `INSERT INTO billing_ledger
        (id, "userId", "taskId", type, amount, balance, credits, description, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
      [
        entryId,
        userId,
        null,
        'PURCHASE_CREDIT',
        -creditsToCredit, // amount 负=充值
        newBalance,
        creditsToCredit, // credits 正=增加
        description,
        JSON.stringify({ rechargeCredits: creditsToCredit, orderId }),
      ],
    );
    return {
      id: entryId,
      userId,
      taskId: null,
      type: 'PURCHASE_CREDIT' as const,
      amount: -creditsToCredit,
      balance: newBalance,
      credits: creditsToCredit,
      description,
      metadata: { rechargeCredits: creditsToCredit, orderId },
      createdAt: new Date().toISOString(),
    };
  });
}

/**
 * 手动充值积分（管理员后台，对齐 app1 POST /api/user/recharge）
 *
 * 与 creditPurchase 同构（原子加余额 + 写 PURCHASE_CREDIT 账本），但不绑定订单：
 * 管理员手动给用户加积分，无 payment_orders 记录（故不计入「氪金总金额」指标——
 * 手动充值不是用户真实付款）。description 由调用方传（含金额/备注/凭证）。
 *
 * credits <= 0：no-op 账本条目，不动余额。
 *
 * 幂等（dramaforge 增量，超出 app1）：
 *   metadata.idempotencyKey 提供时（管理员后台表单每次提交生成 UUID），先 SELECT
 *   billing_ledger 中相同 (userId, idempotencyKey, adminUserId) 的成功记录，命中则
 *   直接返回历史条目，**不再加积分、不再写新账本**——防止管理员双击/重试导致双扣。
 *   app1 原版无此机制；dramaforge 加它是因管理员手动操作不可逆，需更保守。
 *   幂等 SELECT 与 INSERT 不在同一事务（无唯一索引），存在理论 race window；但
 *   管理员场景非对抗性，check-then-write 已覆盖典型双击/网络重试场景。完全并发
 *   安全需后续加 billing_ledger 部分唯一索引（expand-and-contract 迁移）。
 *
 * @param userId      - 目标用户 ID
 * @param credits     - 充值积分数（正数）
 * @param description - 账本描述
 * @param metadata    - 额外 metadata（adminUserId / note / idempotencyKey 等，便于对账）
 * @returns 账本条目（含操作后余额；幂等命中时为历史条目快照）
 * @throws BillingError(404) 用户不存在
 */
export async function creditManual(
  userId: string,
  credits: number,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<BillingEntry> {
  // 查用户（确认存在）
  await getBalance(userId);

  // 提取幂等键（来自 metadata.idempotencyKey）+ adminUserId 形成复合维度
  const idempotencyKey =
    metadata &&
    typeof metadata.idempotencyKey === 'string' &&
    metadata.idempotencyKey.trim().length > 0
      ? metadata.idempotencyKey.trim()
      : undefined;
  const adminUserId =
    metadata && typeof metadata.adminUserId === 'string' ? metadata.adminUserId : '';

  // 幂等检查：命中历史成功记录直接返回，不再加积分
  if (idempotencyKey) {
    const existing = await query(
      `SELECT id, amount, balance, credits, description, metadata, "createdAt"
         FROM billing_ledger
        WHERE "userId" = $1
          AND type = 'PURCHASE_CREDIT'
          AND metadata->>'idempotencyKey' = $2
          AND metadata->>'adminUserId' = $3
        LIMIT 1`,
      [userId, idempotencyKey, adminUserId],
    );
    if (existing.rows.length > 0) {
      const r = existing.rows[0] as {
        id: string;
        amount: number;
        balance: number;
        credits: number;
        description: string;
        metadata: unknown;
        createdAt: string;
      };
      const parsedMeta =
        typeof r.metadata === 'string'
          ? (JSON.parse(r.metadata) as Record<string, unknown>)
          : (r.metadata as Record<string, unknown>);
      return {
        id: r.id,
        userId,
        taskId: null,
        type: 'PURCHASE_CREDIT',
        amount: r.amount,
        balance: r.balance,
        credits: r.credits,
        description: r.description,
        metadata: parsedMeta,
        createdAt: r.createdAt,
      };
    }
  }

  // 非正数：no-op 账本
  if (!Number.isFinite(credits) || credits <= 0) {
    return writeLedgerEntry({
      userId,
      taskId: null,
      type: 'PURCHASE_CREDIT',
      amount: 0,
      credits: 0,
      description,
      metadata: { noOp: true, source: 'admin_manual', ...(metadata ?? {}) },
    });
  }

  const creditsToCredit = Math.max(1, Math.ceil(credits));
  const persistedMeta = {
    rechargeCredits: creditsToCredit,
    source: 'admin_manual',
    ...(metadata ?? {}),
  };

  // 事务：原子增加余额 + 写账本
  return tx(async (q) => {
    const updateResult = await q.query(
      'UPDATE users SET credits = credits + $1, "updatedAt" = NOW() WHERE id = $2 RETURNING credits',
      [creditsToCredit, userId],
    );
    const newBalance = (updateResult.rows[0] as { credits: number }).credits;
    const entryId = genId();
    await q.query(
      `INSERT INTO billing_ledger
        (id, "userId", "taskId", type, amount, balance, credits, description, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
      [
        entryId,
        userId,
        null,
        'PURCHASE_CREDIT',
        -creditsToCredit, // amount 负=充值
        newBalance,
        creditsToCredit, // credits 正=增加
        description,
        JSON.stringify(persistedMeta),
      ],
    );
    return {
      id: entryId,
      userId,
      taskId: null,
      type: 'PURCHASE_CREDIT' as const,
      amount: -creditsToCredit,
      balance: newBalance,
      credits: creditsToCredit,
      description,
      metadata: persistedMeta,
      createdAt: new Date().toISOString(),
    };
  });
}

// ============================================================
// PENDING_DEBIT 补扣支持（sync direct 路径欠费 sweep 用）
// ============================================================

/**
 * 一条未结清的 PENDING_DEBIT 欠费行（补扣 sweep 的输入）。
 *
 * 与 recordPendingDebit 写入对齐：amount = 欠费积分数（正数），
 * metadata 含 {credits, costYuan, billingMode, billingTaskId?, billingUnitId?, reason, ...}。
 */
export interface PendingDebitRow {
  id: string;
  userId: string;
  taskId: string | null;
  /** 欠费积分数（正数）；与 metadata.credits 对齐，作为 chargeCredits 的 fallback 输入。 */
  amount: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * 查未结清的 PENDING_DEBIT 行（补扣 sweep 输入）。
 *
 * "未结清"定义：metadata->>'settled' 不为 true。settled 标记由 markPendingDebitSettled
 * 写入（jsonb merge `{settled:true, settledAt:...}`），保证幂等——已结清的行不再被扫出，
 * 不会重复扣费。COALESCE 容忍 metadata 无 settled 键（新写入的 PENDING_DEBIT 均无）。
 *
 * ORDER BY "createdAt" → 先补最早的欠费（FIFO，对齐 pendingCharge sweep 的 createdAt 排序）。
 * 不删行：PENDING_DEBIT 是审计痕迹，结清后仅打 settled 标记保留。
 *
 * @param limit - 单次上界
 */
export async function findPendingDebitEntries(
  limit: number,
): Promise<PendingDebitRow[]> {
  const result = await query(
    `SELECT id, "userId", "taskId", amount, metadata, "createdAt"
     FROM billing_ledger
     WHERE type = 'PENDING_DEBIT'
       AND COALESCE((metadata->>'settled')::boolean, false) = false
     ORDER BY "createdAt"
     LIMIT $1`,
    [limit],
  );
  return (result.rows ?? []) as PendingDebitRow[];
}

/**
 * 标记一条 PENDING_DEBIT 已结清（补扣成功后调用）。
 *
 * 用 jsonb `||` 合并 `{settled:true, settledAt:NOW()}` 进 metadata——保留原 metadata
 * 全部字段（credits / reason / source / ...）作为审计痕迹，仅追加结清标记。
 * 可选 note 携带 waive 信息（如任务终态 409 不扣的豁免原因）。
 *
 * 不改 type、不删行：审计需要保留 PENDING_DEBIT 行可追溯。
 *
 * @param entryId - billing_ledger.id
 * @param note    - 可选追加字段（如 {waived:true, waiveReason:'task-terminal-409'}）
 */
export async function markPendingDebitSettled(
  entryId: string,
  note?: Record<string, unknown>,
): Promise<void> {
  const extraJson = JSON.stringify(note ?? {});
  await query(
    `UPDATE billing_ledger
        SET metadata = metadata
              || jsonb_build_object('settled', true, 'settledAt', NOW())
              || $2::jsonb,
            "updatedAt" = NOW()
      WHERE id = $1`,
    [entryId, extraJson],
  );
}

/**
 * 记一次补扣尝试（失败时调用，写 lastAttemptAt + lastError 便于审计/对账）。
 *
 * 不作 gating（不阻止下个 tick 重试）——补扣"永不放弃"。lastAttemptAt 仅用于：
 *   1. 审计：看一行最后被尝试的时间；
 *   2. 未来若需要 cross-tick backoff 可基于此字段判断。
 * 当前 tick 间隔（60s）本身就是天然节流。
 *
 * 失败自身不抛：本就处于失败分支，再失败仅 log，行仍 unsettled 等下 tick 重试。
 */
export async function markPendingDebitAttempted(
  entryId: string,
  errMsg: string,
): Promise<void> {
  try {
    await query(
      `UPDATE billing_ledger
          SET metadata = metadata
                || jsonb_build_object('lastAttemptAt', NOW(), 'lastError', $2::text),
              "updatedAt" = NOW()
        WHERE id = $1`,
      [entryId, errMsg],
    );
  } catch {
    // 占位 catch：markAttempted 失败不能让 sweep 死；行仍在（unsettled）下 tick 重试
  }
}

// ============================================================
// 内部：写 no-op 账本条目（不动余额）
// ============================================================

interface LedgerEntryInput {
  userId: string;
  taskId: string | null;
  type: LedgerEntryType;
  amount: number;
  credits: number;
  description: string;
  metadata: Record<string, unknown>;
}

/**
 * 写一条 0 变动账本条目（ADMIN / amount<=0 时使用）。
 *
 * 不更新 users.credits，仅记录用于审计追踪。
 * 需要先读当前余额作为 balance 快照。
 */
async function writeLedgerEntry(input: LedgerEntryInput): Promise<BillingEntry> {
  const balance = await getBalance(input.userId);
  const entryId = genId();
  await query(
    `INSERT INTO billing_ledger
      (id, "userId", "taskId", type, amount, balance, credits, description, metadata, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
    [
      entryId,
      input.userId,
      input.taskId,
      input.type,
      input.amount,
      balance.credits,
      input.credits,
      input.description,
      JSON.stringify(input.metadata),
    ],
  );
  return {
    id: entryId,
    userId: input.userId,
    taskId: input.taskId,
    type: input.type,
    amount: input.amount,
    balance: balance.credits,
    credits: input.credits,
    description: input.description,
    metadata: input.metadata,
    createdAt: new Date().toISOString(),
  };
}

/** 内部导出，供单测重置缓存（无缓存，占位） */
export function _resetBillingForTests(): void {
  // 无单例缓存，占位以保持与 infra 模块一致的测试钩子风格
}
