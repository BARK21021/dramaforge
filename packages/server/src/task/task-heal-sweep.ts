// ============================================================
// ④ server/task/task-heal-sweep — 卡死 AI 任务自愈（防 worker 重启/崩溃后图永久卡死）
// ============================================================
//
// 为什么需要：worker 进程崩溃/重启时，正在处理的任务会卡在 QUEUED/RUNNING：
//   - 并发拒绝 throw 在 try 外（processor.ts），不写 FAILED → DB 永远 QUEUED
//   - BullMQ failed job 不自动重投 → DB 卡 QUEUED 前端永远转圈
//   - RUNNING 孤儿无人 reconcile（stalled-check 依赖活 worker）
// 本 sweep 常驻 ai-worker，每 60s 扫一次"卡死的非终态任务"，重新派发或标 FAILED。
//
// 设计完全照抄 domain/payment/sweep.ts 三件套：
//   - sweepStuckTasks(deps) 单次扫描纯逻辑（永不抛，单笔出错计 errored 继续）
//   - TaskHealHandle { stop() }
//   - startTaskHealSweep(intervalMs, deps) overlap guard + setInterval + 双层 try/catch
//   - TaskHealDeps 依赖注入（测试用 mock findStuck/redispatch/failTask）
//
// 重派发复用 dispatchAiTask（taskId 不变，新 BullMQ job）；type→queueName 用
// ai-worker/types 的 IMAGE/TEXT/VIDEO/VOICE_TASK_TYPES 常量映射。
// 零 ffmpeg 依赖；仅 DB + BullMQ 入队。
// ============================================================

import { query } from '@server/infra';
import { dispatchAiTask } from './dispatch';
import type { QueueName } from './queues';
import {
  IMAGE_TASK_TYPES,
  TEXT_TASK_TYPES,
  VIDEO_TASK_TYPES,
  VOICE_TASK_TYPES,
} from '../ai-worker/types';

/** QUEUED/PENDING 超过此时长未动判为"卡死"（默认 5min，覆盖正常入队→消费间隙） */
export const STALE_QUEUED_MS = 5 * 60 * 1000;
/**
 * RUNNING 孤儿阈值（秒）—— 按任务类型分档，每档必须严格 > 对应 handler 超时
 * （见 processor.ts timeoutForType）。
 *
 * 曾经是单一 STALE_RUNNING_MS=15min，但 video handler 25min / EPISODE_SPLIT handler 30min
 * 都 > 15min：健康长任务跑过 15min 即被 heal 当孤儿，每 tick（60s）bump retryCount，
 * 18min（4 tick）后 retryCount(3)>=maxRetries(3) 假 FAILED；原 worker 仍跑到成功，
 * markCompleted 的 CAS（status NOT IN COMPLETED,FAILED,CANCELLED）拒绝回写 → 用户看
 * FAILED 但 ARK key 已烧 + shots 已 COMPLETED（资损 + tasks/shots 状态分裂）。
 * 分档后每类任务的孤儿阈值 > 其 handler 超时，正常任务不再被误判。
 */
export const STALE_RUNNING_SECONDS_BY_TYPE: Record<string, number> = {
  VIDEO_GENERATE: 30 * 60, // > handler 25min（ark pollAsync 内部 20min + 余量）
  EPISODE_SPLIT: 35 * 60,  // > handler 30min（split + extract 各最长 15min DeepSeek 流式）
};
/** 默认 RUNNING 孤儿阈值（image ≤8min / text ≤3min / voice ≤5min）：12min 覆盖 + 余量。 */
export const STALE_RUNNING_DEFAULT_SECONDS = 12 * 60;

/** 某任务类型的 RUNNING 孤儿阈值（秒）；未知类型走默认。纯函数，供单测。 */
export function staleRunningSecondsForType(type: string): number {
  return STALE_RUNNING_SECONDS_BY_TYPE[type] ?? STALE_RUNNING_DEFAULT_SECONDS;
}
/** sweep 节拍（默认 60s） */
export const HEAL_INTERVAL_MS = 60 * 1000;
/** 单次 tick 最多处理多少任务 */
export const HEAL_BATCH_LIMIT = 50;

/** 卡死任务视图（sweep 工作所需字段子集） */
export interface StuckTask {
  id: string;
  userId: string;
  type: string;
  status: string;
  input: unknown;
  projectId: string | null;
  retryCount: number;
  maxRetries: number;
}

/** 单次扫描统计 */
export interface TaskHealResult {
  scanned: number;
  redispatched: number; // 本 tick 重新派发
  failed: number; // 本 tick 标 FAILED（重试耗尽）
  errored: number; // 单笔异常
}

/** 依赖注入（测试用；默认接真实 query + dispatchAiTask） */
export interface TaskHealDeps {
  findStuck?: (now: Date) => Promise<StuckTask[]>;
  bumpRetryCount?: (taskId: string) => Promise<void>;
  redispatch?: (t: StuckTask) => Promise<void>;
  failTask?: (t: StuckTask, reason: string) => Promise<void>;
  log?: (msg: string, meta?: unknown) => void;
}

function defaultLog(msg: string, meta?: unknown): void {
  console.log(msg, meta ?? '');
}

/** 任务类型 → 队列名映射（复用 ai-worker/types 常量） */
function queueForType(type: string): QueueName | null {
  if ((IMAGE_TASK_TYPES as readonly string[]).includes(type)) return 'image';
  if ((TEXT_TASK_TYPES as readonly string[]).includes(type)) return 'text';
  if ((VIDEO_TASK_TYPES as readonly string[]).includes(type)) return 'video';
  if ((VOICE_TASK_TYPES as readonly string[]).includes(type)) return 'voice';
  return null;
}

/** 默认 findStuck：查 QUEUED/PENDING 超时 + RUNNING 孤儿，按 updatedAt 升序取批次 */
async function defaultFindStuck(_now: Date): Promise<StuckTask[]> {
  const { rows } = await query(
    `SELECT id, "userId", type, status, input, "projectId", "retryCount", "maxRetries"
       FROM tasks
      WHERE (
            (status IN ('PENDING','QUEUED')
             AND "updatedAt" < NOW() - make_interval(secs => $1::double precision / 1000.0))
         OR (status = 'RUNNING'
             AND "startedAt" < NOW() - make_interval(secs =>
                   CASE
                     WHEN type = 'VIDEO_GENERATE' THEN ${STALE_RUNNING_SECONDS_BY_TYPE.VIDEO_GENERATE}::double precision
                     WHEN type = 'EPISODE_SPLIT' THEN ${STALE_RUNNING_SECONDS_BY_TYPE.EPISODE_SPLIT}::double precision
                     ELSE ${STALE_RUNNING_DEFAULT_SECONDS}::double precision
                   END
                 ))
      )
      -- 排除 inline-task（startInlineAiTask 打的 __inline 标记）：它们在 web 进程
      -- fire-and-forget 跑、无 BullMQ job，重派发到 ai-worker 会因 input 缺 model
      -- 等字段误失败（"文本任务缺少 model"）+ 与 web runner 竞态。inline 自带
      -- callAIWithTimeout + complete/fail 终态化，不需 heal-sweep 介入。
      AND (input->>'__inline') IS DISTINCT FROM 'true'
      ORDER BY "updatedAt" ASC
      LIMIT $2`,
    [STALE_QUEUED_MS, HEAL_BATCH_LIMIT],
  );
  return rows as StuckTask[];
}

/** 默认 bumpRetryCount：递增重试计数（让多次重派后能收敛到 FAILED） */
async function defaultBumpRetryCount(taskId: string): Promise<void> {
  await query(
    `UPDATE tasks SET "retryCount" = "retryCount" + 1, "updatedAt" = NOW() WHERE id = $1`,
    [taskId],
  );
}

/** 默认 redispatch：复用 taskId 重新入队（新 BullMQ job，type→queue 映射） */
async function defaultRedispatch(t: StuckTask): Promise<void> {
  const queue = queueForType(t.type);
  if (!queue) throw new Error(`未知任务类型，无法重派: ${t.type}`);
  const input = (t.input ?? {}) as Record<string, unknown>;
  await dispatchAiTask(t.id, t.userId, queue, t.type, {
    input,
    projectId: t.projectId ?? undefined,
  });
}

/** 默认 failTask：CAS 标 FAILED（仅非终态任务） */
async function defaultFailTask(t: StuckTask, reason: string): Promise<void> {
  await query(
    `UPDATE tasks
        SET status='FAILED', error=$1, "completedAt"=NOW(), "updatedAt"=NOW()
      WHERE id=$2 AND status IN ('PENDING','QUEUED','RUNNING')`,
    [reason, t.id],
  );
}

/**
 * 单次扫描：找卡死的非终态任务，逐个重派发或标 FAILED。永不抛。
 *
 * - retryCount >= maxRetries → 标 FAILED（CAS，防覆盖已恢复的任务）
 * - 否则 → 递增 retryCount + 重新派发（给一次重试机会）
 * 单笔出错计 errored 并继续——sweep 绝不能因一笔坏任务停摆。
 */
export async function sweepStuckTasks(deps: TaskHealDeps = {}): Promise<TaskHealResult> {
  const findStuck = deps.findStuck ?? defaultFindStuck;
  const bump = deps.bumpRetryCount ?? defaultBumpRetryCount;
  const redispatch = deps.redispatch ?? defaultRedispatch;
  const failTask = deps.failTask ?? defaultFailTask;
  const log = deps.log ?? defaultLog;

  const result: TaskHealResult = { scanned: 0, redispatched: 0, failed: 0, errored: 0 };

  let tasks: StuckTask[];
  try {
    tasks = await findStuck(new Date());
  } catch (err) {
    log('[task-heal] findStuck 失败，本 tick 跳过', { err: String(err) });
    return result;
  }

  result.scanned = tasks.length;
  if (tasks.length === 0) return result;

  for (const t of tasks) {
    try {
      // retryCount 只对 RUNNING 孤儿递增（真跑过卡死 = 真失败重试，耗尽才标 FAILED）。
      // QUEUED/PENDING 卡死多半是被 slot-gate 挡住没跑成（并发满 moveToDelayed 反复延迟）
      // 或 dispatch 入队失败——这些不是任务本身失败，重派幂等无副作用，不该消耗重试额度。
      // 旧实现无脑 bump，把被 slot-gate 反复延迟的健康任务推向 retryCount 耗尽误判 FAILED
      // （生产 28 张资产图被误杀根因：计数僵尸占位→QUEUED 反复延迟→heal 每 tick bump→3 次标 FAILED）。
      const isOrphanRunning = t.status === 'RUNNING';
      if (isOrphanRunning && t.retryCount >= t.maxRetries) {
        await failTask(
          t,
          `任务多次重试仍卡死（retryCount=${t.retryCount}/${t.maxRetries}），自愈 sweep 标记失败`,
        );
        result.failed++;
        continue;
      }
      if (isOrphanRunning) {
        await bump(t.id);
      }
      await redispatch(t);
      result.redispatched++;
    } catch (err) {
      result.errored++;
      log('[task-heal] 单笔处理失败，跳过', { id: t.id, err: String(err) });
    }
  }

  log('[task-heal] tick 完成', result);
  return result;
}

/** sweep 定时器句柄 */
export interface TaskHealHandle {
  stop: () => void;
}

/** 终态任务（FAILED/CANCELLED/TIMEOUT）保留此时长后清理（默认 7 天）。COMPLETED 保留（成功记录 + 审计）。 */
export const TERMINAL_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * E6：清理过期的终态任务（FAILED/CANCELLED/TIMEOUT），防失败任务无限堆积。
 * COMPLETED 不清（成功记录可能有审计价值）。永不抛。
 */
export async function cleanupOldTerminalTasks(
  ageMs: number = TERMINAL_CLEANUP_AGE_MS,
  log: (msg: string, meta?: unknown) => void = defaultLog,
): Promise<number> {
  try {
    const result = await query(
      `DELETE FROM tasks
        WHERE status IN ('FAILED','CANCELLED','TIMEOUT')
          AND "completedAt" < NOW() - make_interval(secs => $1::double precision / 1000.0)`,
      [ageMs],
    );
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) log('[task-heal] 清理过期终态任务', { deleted });
    return deleted;
  } catch (err) {
    log('[task-heal] cleanupOldTerminalTasks 失败，本 tick 跳过', { err: String(err) });
    return 0;
  }
}

/**
 * 2026-08-02 流量事件补丁：终态 VIDEO_GENERATE 任务的 input 含 3-6MB base64 参考图
 * （referenceImageBase64 / referenceImageUrls / characterReferenceImageUrls），
 * ai-worker 消费后不再需要；COMPLETED 永不清理 + 接口曾原样返回 = 磁盘与流量双爆。
 * 本函数每个 tick 摘掉 3 个大字段，保留 prompt/model/__dedupeKey/chainMode 等业务字段
 * （enqueueAiTask 的 dedupe/chainMode 复用仍按 input->>'__dedupeKey' / 'chainMode' 匹配）。
 */
export async function stripTerminalVideoGenerateInput(
  log: (msg: string, meta?: unknown) => void = defaultLog,
): Promise<number> {
  try {
    const result = await query(
      `UPDATE tasks
         SET input = input - 'referenceImageBase64' - 'referenceImageUrls' - 'characterReferenceImageUrls'
       WHERE type = 'VIDEO_GENERATE'
         AND status IN ('COMPLETED','FAILED','CANCELLED','TIMEOUT')
         AND (input ? 'referenceImageBase64' OR input ? 'referenceImageUrls' OR input ? 'characterReferenceImageUrls')`,
    );
    const updated = result.rowCount ?? 0;
    if (updated > 0) log('[task-heal] VIDEO_GENERATE input 大字段瘦身', { updated });
    return updated;
  } catch (err) {
    log('[task-heal] stripTerminalVideoGenerateInput 失败，本 tick 跳过', { err: String(err) });
    return 0;
  }
}

/**
 * 启动卡死任务自愈 sweep（常驻 ai-worker 调一次）。返回 stop 句柄。
 *
 * overlap guard：上一 tick 没跑完不起新 tick。tick 内部已 try/catch，
 * 定时器层再兜底 catch，永不让定时器死。
 */
export function startTaskHealSweep(
  opts: { intervalMs?: number; deps?: TaskHealDeps } = {},
): TaskHealHandle {
  const intervalMs = opts.intervalMs ?? HEAL_INTERVAL_MS;
  const deps: TaskHealDeps = { log: defaultLog, ...opts.deps };
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await sweepStuckTasks(deps);
      await cleanupOldTerminalTasks(TERMINAL_CLEANUP_AGE_MS, deps.log ?? defaultLog);
      await stripTerminalVideoGenerateInput(deps.log ?? defaultLog);
    } catch (err) {
      console.error('[task-heal] tick 未捕获异常', err);
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
