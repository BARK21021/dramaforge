// ============================================================
// ⑥ server/ai-worker/processed-cache — stall 重投幂等缓存（P0-3）
// ============================================================
//
// 文件职责：
//   提供「任务已成功 process()」的 Redis 短期缓存，封堵 BullMQ stalled
//   重投导致的重复 handleTask（重复 provider 调用烧 key 烧钱）。
//
// 背景：
//   processor.ts 开头的 getTaskStatus 终态早退只识别 COMPLETED/FAILED。
//   任务处于 RUNNING（markRunning 后、markCompleted 前）时，stalled 重投会
//   绕过该检查再次 handleTask。本模块在 process() 成功后立即写「已处理」
//   标记，重投时命中即跳过 gateway 调用与扣费。
//
// 移植自 app1 src/workers/base.ts:380-421（PROCESSED_KEY_PREFIX /
//   markProcessCompleted / getCachedProcessResult），语义对齐。
//
// 设计要点：
//   - key 按 taskId 隔离（stall 重投同 taskId 才命中；用户重生任务是新 taskId）
//   - TTL 3600s 覆盖 BullMQ stalledInterval + lockDuration 的重试窗口
//   - Redis 不可用 / JSON 损坏 → 降级为正常执行（GET 返回 null；SET 静默跳过），
//     不阻断业务（与 app1 行为一致）
// ============================================================

import { getRedis } from '@server/infra';
import type { HandlerResult } from './types';

/** 幂等标记 Redis key 前缀（按 taskId 隔离；stall 重试同 taskId 命中） */
const PROCESSED_KEY_PREFIX = 'task:processed:';
/**
 * 幂等标记存活时间（秒）。
 * 3600s 覆盖 BullMQ stalledInterval(30s) + lockDuration(300s) 的重试窗口，
 * 留足余量应对多次 stall 重投。
 */
const PROCESSED_TTL_SECONDS = 3600;

/**
 * 读取「已处理」标记（stall 重投幂等）。
 *
 * @returns 上次成功执行的 HandlerResult；不存在 / 解析失败 / Redis 不可用时返回 null
 */
export async function getCachedProcessResult(
  taskId: string,
): Promise<HandlerResult | null> {
  try {
    const raw = await getRedis().get(`${PROCESSED_KEY_PREFIX}${taskId}`);
    if (!raw) return null;
    return JSON.parse(raw) as HandlerResult;
  } catch (err) {
    // Redis 不可用或 JSON 损坏 → 降级为正常执行（不阻断业务）
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ai-worker] 读取幂等标记失败，降级为正常执行 (taskId=${taskId}): ${msg}`,
    );
    return null;
  }
}

/**
 * 写入「已处理」标记（process() 成功后立即写，先于 markCompleted / 扣费）。
 *
 * 即便后续 markCompleted 或扣费崩溃触发 stall 重投，重投也会命中标记 →
 * 跳过 gateway 调用与扣费。极端情况（本行之后、扣费之前崩溃）用户可能
 * 少扣一次——可接受，远优于重复扣费。
 *
 * 失败时静默跳过（不影响本次执行，但 stall 重投可能重复扣费）。
 */
export async function markProcessCompleted(
  taskId: string,
  result: HandlerResult,
): Promise<void> {
  try {
    await getRedis().set(
      `${PROCESSED_KEY_PREFIX}${taskId}`,
      JSON.stringify(result),
      'EX',
      PROCESSED_TTL_SECONDS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ai-worker] 写入幂等标记失败（不影响本次执行，但 stall 重投可能重复扣费） (taskId=${taskId}): ${msg}`,
    );
  }
}
