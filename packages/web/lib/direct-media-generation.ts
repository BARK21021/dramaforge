import {
  chargeCredits,
  chargeAggregatedTaskCost,
  recordPendingDebit,
  BillingError,
  getShot,
  projectRepo,
  yuanToCredits,
  type GatewayResult,
  type ShotRecord,
} from '@dramaforge/server';

/** Split the public `provider/model` identifier without importing worker-only code. */
export function parseProviderModel(model: string): { provider: string; model: string } {
  const normalized = model.trim();
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new Error('model 必须使用 provider/model 格式');
  }
  return { provider: normalized.slice(0, separator), model: normalized };
}

/** Verify all three ownership boundaries before an expensive provider call. */
export async function requireOwnedShot(input: {
  userId: string;
  projectId: string;
  episodeId: string;
  shotId: string;
}): Promise<ShotRecord | null> {
  const [project, shot] = await Promise.all([
    projectRepo.getById(input.projectId),
    getShot(input.shotId),
  ]);
  if (
    !project
    || project.userId !== input.userId
    || !shot
    || shot.projectId !== input.projectId
    || shot.episodeId !== input.episodeId
  ) {
    return null;
  }
  return shot;
}

/**
 * Bill a completed direct generation.
 *
 * 余额不足（BillingError 402）**不再吞**——"不够扣就不让用"：向上抛让路由经
 * handleApiError 返回 402、不把生成结果交给客户端（上游 AI 成本已沉，但用户拿不到产物，
 * 需充值后重试；chargeCredits 原子条件 UPDATE 已回滚，不会部分扣）。
 *
 * 其他扣费异常（PG 连接抖动、redis 超时、tx 失败等）不阻断交付——任务已成功，
 * 不应因基础设施抖动浪费一次生成。但漏扣必须留痕可审计、可补扣（P0-2）：
 * 写一条 billing_ledger 欠费记录（type='PENDING_DEBIT'，不动 users.credits），
 * 补扣 sweep 后续扫此 type 重试 chargeCredits / chargeAggregatedTaskCost。
 *
 * 与 ai-worker 路径的差异：worker 走 tasks 行，扣费失败写 tasks.pendingCharge JSONB；
 * 同步直连路径不创建 tasks 行（无处写 pendingCharge），故写独立 billing_ledger 行。
 */
export async function billDirectGeneration(input: {
  userId: string;
  result: GatewayResult;
  description: string;
  taskType: string;
  /** C/S 一键出片任务 ID；存在时按 app1 的任务边界累计 raw cost。 */
  billingTaskId?: string;
  /** 同一任务内稳定的调用单元 ID，用于客户端 HTTP 重试防重复扣费。 */
  billingUnitId?: string;
}): Promise<void> {
  if (process.env.DRAMAFORGE_LOCAL_MODE === '1') return; // 本地不计费，no-op
  const costYuan = typeof input.result.cost === 'number' && input.result.cost > 0
    ? input.result.cost
    : 0;
  if (costYuan <= 0) return;
  try {
    if (input.billingTaskId && input.billingUnitId) {
      await chargeAggregatedTaskCost(
        input.userId,
        input.billingTaskId,
        input.billingUnitId,
        costYuan,
        input.description,
      );
      return;
    }
    await chargeCredits(input.userId, yuanToCredits(costYuan), {
      description: input.description,
      metadata: {
        cost: costYuan,
        taskType: input.taskType,
        source: 'sync-direct',
      },
    });
  } catch (error) {
    // 余额不足（402）：不吞——向上抛 → 路由 handleApiError → 402，不交付结果。
    if (error instanceof BillingError && error.statusCode === 402) throw error;
    // 其他异常（账本 DB 抖动等）：任务已成功，不阻断交付。但漏扣必须留痕（P0-2）：
    // 写 PENDING_DEBIT 欠费账本（不动 users.credits）让补扣 sweep 后续重试。
    const message = error instanceof Error ? error.message : String(error);
    const creditsToDebit = yuanToCredits(costYuan);
    console.warn(
      `[direct-media] ${input.description}扣费失败 (${costYuan}元 / ${creditsToDebit}积分): ${message}，写 PENDING_DEBIT 待补扣`,
    );
    try {
      await recordPendingDebit({
        userId: input.userId,
        credits: creditsToDebit,
        costYuan,
        description: input.description,
        taskType: input.taskType,
        billingTaskId: input.billingTaskId,
        billingUnitId: input.billingUnitId,
        reason: message,
        source: 'sync-direct',
      });
    } catch (pendingErr) {
      // recordPendingDebit 自身已吞异常返回 null；走到这里的 pendingErr 是未预期的二次抛。
      console.error(
        `[direct-media] 写 PENDING_DEBIT 也失败 (userId=${input.userId}): ` +
          `${pendingErr instanceof Error ? pendingErr.message : String(pendingErr)}`,
      );
    }
  }
}

/** Decode only well-formed base64 data URLs; media bytes are never written to a DB. */
export function decodeMediaDataUrl(url: string): { mimeType: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
  if (!match) return null;
  return {
    mimeType: match[1],
    bytes: Uint8Array.from(Buffer.from(match[2], 'base64')),
  };
}
