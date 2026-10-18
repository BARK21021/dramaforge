// ============================================================
// ⑥ server/ai-worker/processor — 任务处理生命周期编排
// ============================================================
//
// 文件职责：
//   processJob(job) — 单个 BullMQ Job 的完整处理流程，串联：
//     1. 解析 payload（taskId/userId/input + job.name 即 taskType）
//     2. 获取并发槽位（③ acquireSlot；超限抛错让 BullMQ backoff 重试）
//     3. 标记 RUNNING（task-repo.markRunning + 发布 RUNNING 事件）
//     4. 调用 handler（handleTask → ② callAI）
//     5. 成功：写 COMPLETED + 扣费 ③ + 发布 COMPLETED 事件
//     6. 失败：写 FAILED + 发布 FAILED 事件（不重抛，避免 BullMQ 重复扣费）
//     7. finally：释放并发槽位（③ releaseSlot）
//
// 设计要点（对齐 app1 BaseWorker.handleJob 语义）：
//   - 并发门控：acquireSlot 在前，releaseSlot 在 finally（成功/失败均释放）
//   - 错误不重抛：业务失败已写 FAILED + 发布事件，BullMQ 视为完成不重试
//     （仅基础设施错误经 BullMQ stall 路径重试，幂等由 tasks.status 终态保证）
//   - 扣费：② callAI 不返回 cost，当前恒为 0（no-op 账本）；待定价模型补入
//   - 事件发布：失败不阻断（任务状态已写 PG，前端可轮询兜底）
//
// 服务器禁止 import ffmpeg；本模块编排 ②③④⑦ 模块，零 ffmpeg 依赖。
// ============================================================

import { acquireSlot, releaseSlot, chargeCredits, yuanToCredits } from '@server/domain';
import { handleTask } from './handlers';
import {
  markRunning,
  markCompleted,
  markFailed,
  getConcurrencyLimit,
  getTaskStatus,
  getTaskInput,
  updateTaskProgress,
  setPendingCharge,
} from './task-repo';
import { publishTaskEvent } from './event-publisher';
import { getCachedProcessResult, markProcessCompleted } from './processed-cache';
import type { AiTaskType, HandlerResult, WorkerJobData } from './types';
import {
  IMAGE_TASK_TYPES,
  TEXT_TASK_TYPES,
  VIDEO_TASK_TYPES,
  VOICE_TASK_TYPES,
} from './types';
import { DelayedError } from 'bullmq';

/** Worker 实例标识（用于 tasks."workerId" 追踪） */
export const WORKER_ID = `ai-worker-${process.pid}`;

/**
 * handler 超时分档（ms）—— P0-A：handler hang（ARK 响应卡死 / 网络中断 / 死循环）时不能让
 * 任务永久 RUNNING 占着并发槽位（releaseSlot 在 finally 永远到不了 → Redis 计数僵尸 →
 * 排队死循环，今天 fe0ca0bb 卡 332s 就是征兆）。超时走 catch→markFailed→releaseSlot 释放槽位。
 * 底层 HTTP 可能仍在跑（浪费一次调用），但 markCompleted 的 CAS（status NOT IN COMPLETED,FAILED）
 * 挡住迟到的成功回写，不重复扣费。阈值照各 type 正常耗时 + 余量。
 */
const HANDLER_TIMEOUT_BY_CATEGORY: Record<string, number> = {
  image: 8 * 60 * 1000,   // 单图正常 <2min，8min 兜底（给 ARK 慢响应余量，防误杀能完成的慢任务）
  text: 3 * 60 * 1000,    // LLM 快
  video: 25 * 60 * 1000,  // Seedance pollAsync 内部已 20min 超时，25min 兜底防 pollAsync 机制失效
  voice: 5 * 60 * 1000,   // TTS 快
};
const HANDLER_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;

function timeoutForType(taskType: string): number {
  // EPISODE_SPLIT 特判（必须在分类判断之前）：虽归 TEXT_TASK_TYPES，但 handleEpisodeSplit
  // 实际做两次 DeepSeek 流式调用——splitScriptIntoEpisodes（最长 15min）+
  // extractWholeScriptAssets（最长 15min）。text 默认 3min 必杀每次 AI 分集：
  // 底层 DeepSeek 还在跑、事务已提交分集，任务却被 markFailed，用户看到失败且不扣费。
  if (taskType === 'EPISODE_SPLIT') return 30 * 60 * 1000; // 两次 DeepSeek 流式 split+extract 各最长 15min
  if ((IMAGE_TASK_TYPES as readonly string[]).includes(taskType)) return HANDLER_TIMEOUT_BY_CATEGORY.image;
  if ((TEXT_TASK_TYPES as readonly string[]).includes(taskType)) return HANDLER_TIMEOUT_BY_CATEGORY.text;
  if ((VIDEO_TASK_TYPES as readonly string[]).includes(taskType)) return HANDLER_TIMEOUT_BY_CATEGORY.video;
  if ((VOICE_TASK_TYPES as readonly string[]).includes(taskType)) return HANDLER_TIMEOUT_BY_CATEGORY.voice;
  return HANDLER_TIMEOUT_DEFAULT_MS;
}

/** Promise 超时包装：超时 reject Error，不取消底层（仅不等结果，底层 HTTP 自行超时）。 */
function withTimeout<T>(p: Promise<T>, ms: number, timeoutMsg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMsg)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 把 BullMQ job 移到 5s 后重投（不消耗重试次数）。并发满（E7）/ 基础设施抖动（Redis OOM、
 * 网络断、DB hiccup）共用同一条重试路径——这些都是瞬时状态，应当等资源恢复后重试，而非
 * 直接判 fatal FAILED。
 *
 * moveToDelayed 不可用（token 未透传）或其自身失败时，降级 throw 走 BullMQ 原生 backoff
 * （仍会重试，优于直接放弃）。throw DelayedError 是 BullMQ 信号：移入 delayed 集合、不消耗 attempt。
 */
async function delayForRetry(
  job: { moveToDelayed?(timestamp: number, token: string): Promise<unknown> },
  token: string | undefined,
  reason: string,
): Promise<never> {
  if (token && typeof job.moveToDelayed === 'function') {
    try {
      await job.moveToDelayed(Date.now() + 5000, token);
      throw new DelayedError(); // BullMQ 信号：移到 delayed 集合，不消耗 attempt
    } catch (delayErr) {
      if (delayErr instanceof DelayedError) throw delayErr;
      // moveToDelayed 本身失败：降级走 backoff（仍会重试，优于直接放弃）
    }
  }
  throw new Error(reason);
}

/**
 * 处理单个 BullMQ Job。
 *
 * @param job - BullMQ Job 对象（name=taskType, data=WorkerJobData）
 * @returns void（业务失败不重抛，BullMQ 视为完成）
 */
export async function processJob(
  job: {
    name: string;
    data: WorkerJobData;
    moveToDelayed?(timestamp: number, token: string): Promise<unknown>;
  },
  /**
   * BullMQ Worker processing token（moveToDelayed 必需）。
   * token 是 Worker processor 的第二参数，不是 Job 对象属性；必须由 worker-bootstrap
   * 的 `async (job, token) => processJob(job, token)` 透传。否则并发满时的
   * moveToDelayed 守卫恒 false → 降级 throw → 任务误判 FAILED（生产 #1 根因，83/105 失败）。
   */
  token?: string,
): Promise<void> {
  const taskType = job.name as AiTaskType;
  const data = job.data;
  const taskId = data.taskId;
  const userId = data.userId;

  // 0. 终态早退：stalled 重投 / 并发重投时若任务已 COMPLETED/FAILED，直接跳过，
  //    避免重复 handleTask + 重复扣费（与 task-repo 的 markXxx CAS 守卫配合）
  const existingStatus = await getTaskStatus(taskId);
  if (existingStatus === 'COMPLETED' || existingStatus === 'FAILED' || existingStatus === 'CANCELLED') {
    return;
  }

  // 0b. 幂等缓存早退（P0-3，对齐 app1 BaseWorker.handleJob 步骤0）：
  //     stalled 重投时任务仍处 RUNNING（markRunning 后、markCompleted 前），上面终态检查
  //     抓不住。若上次执行已在 handleTask 成功后写「已处理」标记、但 markCompleted/扣费崩溃，
  //     本次重投命中缓存 → 直接 return，不重跑 gateway、不重扣费。用户重生任务是新 taskId，不误命中。
  const cached = await getCachedProcessResult(taskId);
  if (cached) {
    console.info(
      `[ai-worker] 幂等命中：任务上次已执行完成，跳过重复执行（防 stall 重投重复扣费） (taskId=${taskId})`,
    );
    return;
  }

  // 1. 获取并发槽位
  //    并发满（slot.allowed=false）或基础设施抖动（Redis OOM/ECONNRESET、DB hiccup）一律走
  //    delayForRetry → moveToDelayed 5s 重投，不消耗重试次数，绝不直接 fatal FAILED。
  //
  //    生产 61 次 VIDEO_GENERATE 假死根因：Redis 256M 峰值打满（noeviction 策略）→ acquireSlot
  //    的 INCR 抛 OOM error（Redis 对写命令返 OOM）→ 旧实现此 try 外无 catch → 异常上抛 →
  //    worker.on('failed') → markFailed。瞬时 Redis 峰值本应重试即恢复，却判了死刑。现在把
  //    infra 异常也兜进同一条重试路径，Redis 腾空后任务自然成功（backoff 兜底防 Redis 长期满）。
  let slot!: Awaited<ReturnType<typeof acquireSlot>>;
  try {
    const limit = await getConcurrencyLimit(userId);
    slot = await acquireSlot(userId, limit);
  } catch (infraErr) {
    // 基础设施抖动（Redis/DB）：与「并发满」同款延迟重投，不当 fatal（61 次 OOM 假死根治）。
    const msg = infraErr instanceof Error ? infraErr.message : String(infraErr);
    console.warn(
      `[ai-worker] 并发槽位获取基础设施异常，延迟重投 (taskId=${taskId}, userId=${userId}): ${msg}`,
    );
    await delayForRetry(job, token, `并发槽位获取失败（基础设施抖动，将重试）：${msg}`);
  }
  if (!slot.allowed) {
    // E7 修复：并发已满 → moveToDelayed 5s 后重投，不消耗重试次数（对齐 app1 base.ts:237-267）。
    // 旧实现裸 throw 走 BullMQ backoff（attempts=3, 1s 指数），单图 10-30s 槽位不释放，
    // 7s 内重试用尽 → worker.on('failed') 误 markFailed，批量生图被毙（E7 元凶）。
    await delayForRetry(job, token, slot.reason ?? '用户并发任务数已达上限，稍后重试');
  }

  // Tier 2：用户取消（cancel route 翻 CANCELLED）后立即中断底层 AI 调用，而非等 handler
  // 自然返回/超时（video 最长 20min）。cancelController.signal 透传给 handleTask → callAI
  // → pollAsync，abort 其 fetch。5s 轮询 getTaskStatus 检测 CANCELLED 触发 abort。
  const cancelController = new AbortController();
  let cancelPollerStopped = false;
  void (async () => {
    while (!cancelPollerStopped) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      if (cancelPollerStopped) return;
      try {
        if ((await getTaskStatus(taskId)) === 'CANCELLED') {
          cancelController.abort();
          return;
        }
      } catch {
        // 查询失败不中断轮询（兜底由 handler 超时 / CAS 守卫覆盖）
      }
    }
  })().catch(() => undefined);

  try {
    // 2. 标记 RUNNING + 发布 RUNNING 事件（带 type:'status_change' 让 useSSE 归高优先级，
    //    与 dispatch.ts 的 QUEUED 事件保持一致；批2 §3.2.4 方案1）
    await markRunning(taskId, WORKER_ID);
    await publishTaskEvent({
      taskId,
      userId,
      status: 'RUNNING',
      type: 'status_change',
    });

    // 3. 调用 handler（→ ② callAI → ③ storage/asset）
    const reportProgress = async (progress: number, stage: string, stageProgress: number = 0) => {
      await updateTaskProgress(taskId, progress, stage, stageProgress);
      await publishTaskEvent({
        taskId,
        userId,
        status: 'RUNNING',
        type: 'progress',
        progress,
        stage,
        stageProgress,
      });
    };
    // input 从 PG tasks.input 按 taskId 取（BullMQ job 只带精简载荷，避免 base64 媒体
    // 撑爆 Redis）。旧客户端兜底：若 job.data 仍带 input（未升级客户端发的 fat job）则优先用之。
    let input = (data.input ?? null) as Record<string, unknown> | null;
    if (!input) {
      input = await getTaskInput(taskId, userId);
    }
    if (!input) {
      throw new Error(`任务 input 不存在或不属于该用户 (taskId=${taskId})`);
    }
    // P0-A：handler 超时保护——hang 时不能永久占槽位（计数僵尸 → 排队死循环）。
    const handlerTimeoutMs = timeoutForType(taskType);
    const result: HandlerResult = await withTimeout(
      handleTask(taskType, input, userId, taskId, reportProgress, cancelController.signal),
      handlerTimeoutMs,
      `${taskType} 处理超时（超过 ${Math.round(handlerTimeoutMs / 60000)}min），终止以防永久占用并发槽位`,
    );

    // 立即写「已处理」标记（在 markCompleted / 扣费之前，对齐 app1 BaseWorker.markProcessCompleted）：
    // 即便后续 markCompleted 或扣费崩溃触发 stall 重投，重投命中缓存 → 跳过 gateway 调用与扣费。
    // 极端情况（本行之后、扣费之前崩溃）用户可能少扣一次——可接受，远优于重复扣费。
    await markProcessCompleted(taskId, result);

    // 4. 成功：写 COMPLETED（CAS）+ 扣费 + 发布 COMPLETED 事件。
    //    completed=false 表示任务已处终态（stalled 重投/并发重复）——不扣费不发事件，直接返回。
    const completed = await markCompleted(taskId, result);
    if (!completed) return;
    // 扣费金额必须在 try 外计算：原实现把 billedCredits 声明在 try 块内，下方 catch
    // 引用 billedCredits 写 pendingCharge 时跨作用域 → tsc「Cannot find name」+ 运行时
    // ReferenceError 被内层 catch 吞掉，导致扣费失败时 pendingCharge 写不进去，P0-3
    // 补扣安全网失效。提到 try 外后 catch 可正常引用（纯计算，无副作用）。
    const platformCostYuan = result.cost ?? 0;
    const billedCredits = yuanToCredits(platformCostYuan);
    try {
      await chargeCredits(userId, billedCredits, {
        taskId,
        description: result.billingDescription ?? '任务扣费',
        metadata: { taskType, source: 'ai-worker', platformCostYuan },
      });
    } catch (billingErr) {
      // 扣费失败不阻断任务完成（任务已成功）。P0-B：写入 pendingCharge 待补扣，
      // 不再静默吞（旧实现只 console.warn，任务成功但没扣钱 = 漏收）。
      // markCompleted 下次完成扣费会清空 pendingCharge；补扣 sweep 据此重试。
      const msg = billingErr instanceof Error ? billingErr.message : String(billingErr);
      console.warn(`[ai-worker] 扣费失败 (taskId=${taskId}): ${msg}，写入 pendingCharge 待补扣`);
      try {
        await setPendingCharge(taskId, billedCredits, msg);
      } catch (pcErr) {
        console.error(`[ai-worker] 写 pendingCharge 也失败 (taskId=${taskId})`, pcErr);
      }
    }
    await publishTaskEvent({
      taskId,
      userId,
      status: 'COMPLETED',
      type: 'status_change',
      result: result.output,
      modelProvider: result.modelProvider,
      modelName: result.modelName,
    });
  } catch (err) {
    // 5. 失败：写 FAILED + 发布 FAILED 事件（不重抛）。
    // markFailed 返回 false 表示任务已 CANCELLED/COMPLETED（取消的终态事件已由 cancel route
    // 发出，或成功事件已发）——不重复发 FAILED，避免取消后弹假失败 toast。
    const errorMsg = err instanceof Error ? err.message : String(err);
    // failed: true=已标 FAILED；false=任务已 CANCELLED/COMPLETED（取消终态事件已由 cancel route
    // 发出，不重复发假 FAILED）；null=markFailed 自身异常（状态未知，仍发 FAILED 对齐旧行为，
    // 宁可多发不漏发）。
    let failed: boolean | null = null;
    try {
      failed = await markFailed(taskId, errorMsg);
    } catch (markErr) {
      const msg = markErr instanceof Error ? markErr.message : String(markErr);
      console.error(`[ai-worker] 标记 FAILED 失败 (taskId=${taskId}): ${msg}`);
    }
    if (failed !== false) {
      await publishTaskEvent({
        taskId,
        userId,
        status: 'FAILED',
        type: 'status_change',
        error: errorMsg,
      });
    }
  } finally {
    // 6. 停止取消轮询 + 释放并发槽位（成功/失败/取消均释放）
    cancelPollerStopped = true;
    cancelController.abort();
    try {
      await releaseSlot(userId);
    } catch (releaseErr) {
      const msg = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      console.warn(`[ai-worker] 释放并发槽位失败 (userId=${userId}): ${msg}`);
    }
  }
}
