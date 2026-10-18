// ============================================================
// ③ server/domain/concurrency — 用户并发任务门控
// ============================================================
//
// 文件职责：
//   控制单用户同时执行的任务数，防止单用户耗尽系统资源。
//   acquireSlot(userId, limit)：原子 INCR，超限回滚。
//   releaseSlot(userId)：DECR，floor 在 0。
//
// 设计要点：
//   - Redis 计数器（INCR/DECR）per user：key = concurrency:user:{userId}
//   - acquire 原子性：INCR 后若 > limit 立即 DECR 回滚，保证不超限
//   - 安全 TTL：每次 acquire 成功后 EXPIRE 1 小时，防止进程崩溃导致计数永不清零
//     （僵尸槽位最多存活 1 小时，覆盖单任务最长执行时间）
//   - release floor 在 0：DECR 后若 < 0（重复 release / 崩溃后重启）SET 回 0，自纠正
//
// 与 app1 的差异：
//   app1 的 user-concurrency-gate.ts 用 ZSET（score=acquire 时间戳，slotId=taskId），
//   支持 per-slot 独立过期与 cleanupStale。本实现按任务签名简化为计数器
//   （acquireSlot(userId, limit) / releaseSlot(userId)），更轻量；
//   僵尸槽位靠 key 级 TTL 兜底，不追踪具体 slotId。
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import { getRedis, query } from '@server/infra';

/** 并发槽位 Redis key 前缀 */
const USER_CONCURRENT_KEY_PREFIX = 'concurrency:user:';

/**
 * 单个槽位的安全存活时间（秒）。
 * 进程崩溃未 release 时，整个用户的计数 key 在 TTL 后过期，自纠正。
 *
 * 40min：必须 > 单任务最长执行时间（EPISODE_SPLIT handler 30min / video handler 25min）。
 * 旧值 15min < 长 video / EPISODE_SPLIT 任务时长 → 任务仍在跑时 key TTL 到期、count 归 0，
 * 用户可再 acquire 满 limit → 实际并发 = 2× limit（过并发，加速 Redis/服务器 OOM）。
 * 40min 覆盖最长任务 + 余量；崩溃泄漏的计数虽多存活 40min，但有 worker 启动重算
 * （recomputeAllFromDb）+ task-heal sweep 双保险兜底。
 */
const SLOT_TTL_SECONDS = 40 * 60;

/**
 * 重置孤儿 RUNNING 时回拨 updatedAt 的量（ms）。
 * 需 > task-heal-sweep 的 STALE_QUEUED_MS(5min)，确保 recompute 重置后下个 heal tick 立即重派，不等 5min。
 */
const ORPHAN_BACKDATE_MS = 6 * 60 * 1000;

/** acquire 结果 */
export interface AcquireSlotResult {
  /** 是否允许执行 */
  allowed: boolean;
  /** 当前该用户的并发数（acquire 后；拒绝时为回滚后的值） */
  current: number;
  /** 该用户的并发上限（即传入的 limit） */
  max: number;
  /** 拒绝时的原因（allowed=false 时存在） */
  reason?: string;
}

/** 构造 per-user 的 Redis key */
function redisKey(userId: string): string {
  return `${USER_CONCURRENT_KEY_PREFIX}${userId}`;
}

/**
 * 尝试为某用户获取一个并发槽位
 *
 * 原子性流程：
 *   1. INCR `concurrency:user:{userId}` → current
 *   2. 若 current > limit：DECR 回滚，返回拒绝
 *   3. 若 current <= limit：EXPIRE 安全 TTL，返回允许
 *
 * @param userId - 用户 ID
 * @param limit  - 该用户的并发上限（正整数）
 * @returns 获取结果（allowed / current / max / reason）
 */
export async function acquireSlot(
  userId: string,
  limit: number,
): Promise<AcquireSlotResult> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      allowed: false,
      current: 0,
      max: limit,
      reason: `并发上限非法（${limit}），必须为正整数`,
    };
  }

  const redis = getRedis();
  const key = redisKey(userId);

  // 1. 原子 INCR
  const current = await redis.incr(key);

  // 2. 超限回滚
  if (current > limit) {
    await redis.decr(key);
    return {
      allowed: false,
      current: limit, // 回滚后实际占用数 = limit（满）
      max: limit,
      reason: `用户并发任务数已达上限（${limit}/${limit}），请等待当前任务完成`,
    };
  }

  // 3. 安全 TTL（每次成功 acquire 刷新，防止崩溃后计数永不清零）
  await redis.expire(key, SLOT_TTL_SECONDS);

  return {
    allowed: true,
    current,
    max: limit,
  };
}

/**
 * 释放某用户的并发槽位
 *
 * 流程：
 *   1. DECR `concurrency:user:{userId}` → after
 *   2. 若 after < 0（重复 release 或崩溃后重启）：SET 回 0，自纠正
 *
 * 幂等：多次调用不会让计数变成负数（floor 在 0）。
 *
 * @param userId - 用户 ID
 */
export async function releaseSlot(userId: string): Promise<void> {
  const redis = getRedis();
  const key = redisKey(userId);

  const after = await redis.decr(key);
  if (after < 0) {
    // 重复 release 或崩溃残留：纠正为 0
    await redis.set(key, 0);
  }
}

/**
 * 获取某用户当前并发数（只读，不修改）
 *
 * @param userId - 用户 ID
 * @returns 当前占用槽数（key 不存在时为 0）
 */
export async function getStatus(userId: string): Promise<{ current: number }> {
  const redis = getRedis();
  const key = redisKey(userId);
  const v = await redis.get(key);
  return { current: v ? Math.max(0, parseInt(v, 10) || 0) : 0 };
}

/**
 * 清零某用户的所有并发槽位（管理员强制释放 / 测试重置）
 *
 * @param userId - 用户 ID
 */
export async function clearAll(userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(redisKey(userId));
}

/**
 * 基于 DB 真值重算所有用户的并发计数器（worker 启动时调用一次）。
 *
 * ⚠ 单 worker 前提：本函数的 Step1 会**无条件**重置 DB 里所有 status='RUNNING' 的任务，
 * 仅在「整个部署只有一个 ai-worker 进程」的前提下才正确。多 worker 部署（滚动重启 / 多副本）
 * 下，Worker B 启动调用本函数时会把 Worker A 正在跑的活任务也重置成 QUEUED → A 的
 * handleTask 仍在跑 + B 重新派发同一任务 → 双重执行。**上多 worker 前必须先按底部
 * 「多 worker 改造方向」改 Step1 的作用域。** 当前单 worker 生产部署不触发此问题。
 *
 * 两步：
 *   1. 启动恢复（仅单 worker 安全）——此刻 BullMQ worker 尚未消费（本函数在 createAllWorkers
 *      之前调），单 worker 部署下 DB 里任何 status='RUNNING' 都是上一进程遗留的孤儿（worker
 *      已退出，finally 未跑 releaseSlot）。先把它们重置为 QUEUED，否则下一步按 RUNNING 重算
 *      Redis 计数会把孤儿算进去 → 新 worker 启动后额度被僵尸占满 → QUEUED 永远过不了 slot-gate
 *      （生产死循环根因：计数=N 但实跑<M，每次 release 被 delayed job 立刻 acquire 回 N，
 *      本该并发 7 实际压成串行 1）。updatedAt 回拨 > STALE_QUEUED_MS 让 task-heal 下个
 *      tick 立即重派，不等 5min。
 *   2. 清崩溃残留——常态下（Step1 成功）此时 DB 已无 RUNNING，故本步对每个 user 的
 *      `SELECT count(*) ... status='RUNNING'` 恒返回 0，`real > 0 → SET` 分支不会触发，
 *      所有 key 走 DEL 清除崩溃残留的虚高计数。
 *      ⚠ 此处的 `real > 0 → SET` 分支**不是**「按真值重算以兼容多 worker」——只要 Step1
 *      成功，Step2 看不到任何 RUNNING，无法靠它救活多 worker 场景下被误伤的活任务。该分支
 *      实际只在 Step1 UPDATE 抛错的兜底路径下才会触发（DB 仍有 RUNNING，按真值把计数写回）。
 *      要真正支持多 worker，必须改 Step1 的 WHERE 作用域（见底部）。
 *
 * 在 startAllWorkers 的 createAllWorkers 之前调用，确保新 worker 读到正确计数。
 *
 * 多 worker 改造方向（未实现，上多 worker 前必须做；当前单 worker 部署不需要）：
 *   - worker 启动时把自身 WORKER_ID（`ai-worker-${process.pid}`，见 ai-worker/processor.ts）
 *     写入 Redis SET `concurrency:alive-workers`，带短 TTL（如 60s），并以心跳每 ~20s 刷新；
 *   - worker 优雅关闭时 SREM 自身；进程崩溃则靠 TTL 自然过期，被后续 recompute 视为死;
 *   - 把 Step1 的 UPDATE 改为只重置 workerId 不在存活注册表里的孤儿：
 *       `WHERE status='RUNNING' AND
 *          ("workerId" IS NULL OR "workerId" <> ALL($2::text[]))`，
 *       $2 = SMEMBERS(`concurrency:alive-workers`)；
 *   - 此时 Step2 的 `real > 0 → SET` 分支才会对活 worker 的 RUNNING 真正生效（把活 worker
 *     占用的槽位写回 Redis 计数），完成真正的「按真值重算」。
 *
 * @returns checked=扫描的 key 数；reset=重置为 QUEUED 的孤儿 RUNNING 数；cleared=DEL 的计数 key 数
 */
export async function recomputeAllFromDb(): Promise<{
  checked: number;
  reset: number;
  cleared: number;
}> {
  const redis = getRedis();

  // 1. 启动恢复：重置孤儿 RUNNING → QUEUED（释放僵尸占的额度，否则会被下一步算进计数）。
  //    ⚠ 无 workerId 作用域——重置所有 RUNNING，仅在单 worker 部署下安全（详见函数 JSDoc）。
  let reset = 0;
  try {
    const stale = await query(
      `UPDATE tasks
          SET status='QUEUED', "startedAt"=NULL, "workerId"=NULL,
              "updatedAt"=NOW() - make_interval(secs => $1::double precision / 1000.0)
        WHERE status='RUNNING'
        RETURNING id`,
      [ORPHAN_BACKDATE_MS],
    );
    reset = stale.rowCount ?? 0;
  } catch (e) {
    console.error('[recompute] 重置孤儿 RUNNING 失败（继续按真值重算）', e);
  }

  // 2. SCAN 所有 concurrency:user:* key，清崩溃残留的虚高计数。
  //    常态下（Step1 成功）每个 SELECT count(*) RUNNING 恒为 0 → 全部 DEL；
  //    `real > 0 → SET` 仅在 Step1 失败的兜底路径下触发，详见函数 JSDoc。
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [next, batch] = await redis.scan(
      cursor,
      'MATCH',
      `${USER_CONCURRENT_KEY_PREFIX}*`,
      'COUNT',
      200,
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  let cleared = 0;
  for (const key of keys) {
    const userId = key.slice(USER_CONCURRENT_KEY_PREFIX.length);
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM tasks WHERE "userId"=$1 AND status='RUNNING'`,
      [userId],
    );
    const row = rows[0] as { n?: number } | undefined;
    const real = row?.n ?? 0;
    if (real > 0) {
      await redis.set(key, real);
      await redis.expire(key, SLOT_TTL_SECONDS);
    } else {
      await redis.del(key);
      cleared++;
    }
  }
  return { checked: keys.length, reset, cleared };
}
