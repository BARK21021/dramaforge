// ============================================================
// ⑥ server/ai-worker — 纯 AI 任务 Worker（barrel + 启动入口）
// ============================================================
//
// 文件职责：
//   1. 统一导出 ai-worker 模块的全部公共 API
//   2. startAllWorkers(concurrency) — 进程入口：创建 4 个 BullMQ Worker 并开始消费
//
// 架构定位（C/S 重构后）：
//   - ④ @server/task 生产 BullMQ 队列（dispatchAiTask 入队）
//   - ⑥ @server/ai-worker 消费队列（本模块）：纯 AI 任务（text/image/video/voice）
//   - ⑨⑩ @client/render-worker 消费 render_jobs 表：ffmpeg 类任务（concat/split/chain）
//   - ⑤ @server/gateway SSE 通道订阅本模块发布的 task:events 事件，推送给前端
//
// 服务器禁止 import ffmpeg；本模块仅消费 ④ 队列 + 调用 ② callAI +
// 回写 ⑦ PG + 扣费 ③ + 发布 Redis 事件，零 ffmpeg 依赖。
// ============================================================

export type {
  AiTaskType,
  WorkerJobData,
  HandlerResult,
  TaskEventPayload,
  TEXT_TASK_TYPES,
  IMAGE_TASK_TYPES,
  VIDEO_TASK_TYPES,
  VOICE_TASK_TYPES,
} from './types';

export { parseModel, tryExtractProvider, computeAspectRatio, DEFAULT_NEGATIVE_PROMPT } from './model-util';
export {
  markRunning,
  markCompleted,
  markFailed,
  updateTaskProgress,
  getConcurrencyLimit,
  updateShotMaterial,
  markShotsVideoStatus,
} from './task-repo';
export { publishTaskEvent, TASK_EVENTS_CHANNEL } from './event-publisher';
export { handleTask } from './handlers';
export { processJob, WORKER_ID } from './processor';
export {
  createTextWorker,
  createImageWorker,
  createVideoWorker,
  createVoiceWorker,
  createAllWorkers,
  shutdownWorkers,
} from './worker-bootstrap';
export { resolveWorkerConcurrency } from './worker-concurrency';
export type { WorkerConcurrencyOptions } from './worker-concurrency';

import {
  createAllWorkers,
  shutdownWorkers,
} from './worker-bootstrap';
import {
  resolveWorkerConcurrency,
  type WorkerConcurrencyOptions,
} from './worker-concurrency';
import {
  startPaymentSweep,
  SWEEP_INTERVAL_MS,
  type SweepHandle,
  startPendingChargeSweep,
  type PendingChargeSweepHandle,
} from '../domain/payment';
import { startKeyPoolReapSweep, type ReapSweepHandle } from '../gateway/api-key-pool';
import {
  startTaskHealSweep,
  sweepStuckTasks,
  sweepStuckShots,
  type TaskHealHandle,
  renderJobRepo,
  DEFAULT_RENDER_JOB_LEASE_TIMEOUT_MS,
} from '../task';
import { episodeRepo } from '../domain/episode';
import { recomputeAllFromDb } from '../domain/concurrency';
import type { Worker } from 'bullmq';
import type { WorkerJobData } from './types';

// payment 对账 sweep 句柄（进程级单例；startAllWorkers 启、stopAllWorkers 停）。
// sweep 非 AI 任务，但 worker 是常驻后台进程，借宿于此：零 ffmpeg 依赖，重启即续。
let _sweepHandle: SweepHandle | null = null;
// pendingCharge 补扣 sweep 句柄（同上借宿；扫扣费失败留痕的 COMPLETED 任务重试 chargeCredits 防漏收）。
let _pendingChargeSweepHandle: PendingChargeSweepHandle | null = null;
// key 池 cooldown reap sweep 句柄（同上借宿 ai-worker；恢复过期 cooldown key 为 active）。
let _keyPoolReapHandle: ReapSweepHandle | null = null;
// task-heal sweep 句柄（同上借宿；自愈卡死的 QUEUED/PENDING/RUNNING 任务防永久卡死）。
let _taskHealHandle: TaskHealHandle | null = null;
let _renderJobReapHandle: { stop: () => void } | null = null;
// render_jobs 终态级联兜底 sweep 句柄（同上借宿；补任何绕过 markFailed/cancel 级联的
// 裸 UPDATE / 崩溃残留，防镜头永久卡 GENERATING 前端转圈）。
let _renderJobCascadeHandle: { stop: () => void } | null = null;
// render_jobs zombie 回收 sweep 句柄（客户端 heartbeat 续租但 executeJob 卡死）。
let _renderJobZombieHandle: { stop: () => void } | null = null;
// episode stage 复位 sweep 句柄（inline-task fire-and-forget 被 web 重启杀时兜底）。
let _episodeStageSweepHandle: { stop: () => void } | null = null;

/**
 * 启动 render_jobs stale-lease reap 定时（常驻 ai-worker）。
 *
 * 客户端 Electron 崩溃/断网/合盖 >120s 会让 CLAIMED/RUNNING 行的 heartbeat 停更；
 * claimNext 只清"当前 poll 用户"的过期租约，用户不上线就永远卡死、前端转圈无报错。
 * 本 sweep 每 60s 把 heartbeat 过期行重置回 PENDING，自愈卡死（仿 task-heal / key-pool reap）。
 */
function startRenderJobReapSweep(): { stop: () => void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const n = await renderJobRepo.reapStale(DEFAULT_RENDER_JOB_LEASE_TIMEOUT_MS);
      if (n > 0) {
        console.log(`[render-jobs] reap 恢复 ${n} 个超时 CLAIMED/RUNNING 行为 PENDING`);
      }
    } catch (err) {
      console.error('[render-jobs] reap tick 未捕获异常', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 60_000);
  return { stop: () => clearInterval(timer) };
}

/**
 * 启动 render_jobs 终态级联兜底定时（常驻 ai-worker）。
 *
 * markFailed/cancel/retry/reapStale 都会级联处理 shots，但裸 SQL UPDATE（运维手动
 * 止血）或级联事务中途崩溃会绕过级联，留下 videoStatus='GENERATING' 的镜头永远转圈
 * （前端刷新也不停）。本 sweep 每 60s 扫近 24h 终态 CHAIN_COMPILE job，把仍卡
 * GENERATING 的镜头强制对齐（FAILED→FAILED / CANCELLED→PENDING），让症状不可能发生。
 */
function startRenderJobCascadeSweep(): { stop: () => void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const n = await sweepStuckShots();
      if (n > 0) {
        console.log(`[render-jobs] 级联兜底修正 ${n} 个卡 GENERATING 的镜头`);
      }
    } catch (err) {
      console.error('[render-jobs] cascade sweep tick 未捕获异常', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 60_000);
  return { stop: () => clearInterval(timer) };
}

/**
 * 启动 render_jobs zombie 回收定时（常驻 ai-worker）。
 *
 * 客户端 executeJob 卡死（死锁/ffmpeg hang/网络挂起）但 heartbeat 续租定时器仍跑时，
 * reapStale 的 heartbeat 超时条件永远不触发。本 sweep 每 60s 扫 RUNNING >15min 且
 * progress 未达 100 的 job，回收到 PENDING 重新排队，让镜头不再永久卡 GENERATING。
 */
function startRenderJobZombieSweep(): { stop: () => void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const n = await renderJobRepo.reapZombieJobs(15 * 60 * 1000);
      if (n > 0) {
        console.log(`[render-jobs] zombie 回收 ${n} 个心跳活着但进度卡死的 RUNNING job`);
      }
    } catch (err) {
      console.error('[render-jobs] zombie sweep tick 未捕获异常', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 60_000);
  return { stop: () => clearInterval(timer) };
}

/**
 * 启动 episode stageStatus='analyzing' 复位定时（常驻 ai-worker）。
 *
 * analyze 路由现在走 inline-task fire-and-forget（路由立即返 202，后台 runner 在 web
 * 进程内跑 callAI）。web 重启会杀掉后台 promise → 孤儿 task + episode 永久卡
 * stageStatus='analyzing'（split/route.ts:45 的 EPISODE_BUSY 409 会误拦后续操作）。
 * 本 sweep 每 60s 复位 updatedAt 超 35min（越过 task timeoutAt 30min + 余量）的
 * analyzing 集，让用户可重试。仿 startRenderJobCascadeSweep 范式，幂等（只动 analyzing）。
 */
function startEpisodeStageSweep(): { stop: () => void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const n = await episodeRepo.sweepStuckAnalyzing();
      if (n > 0) {
        console.log(`[episode-stage-sweep] 复位 ${n} 个卡死 analyzing 的集`);
      }
    } catch (err) {
      console.error('[episode-stage-sweep] tick 未捕获异常', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 60_000);
  return { stop: () => clearInterval(timer) };
}

/**
 * 启动 ai-worker 进程：创建 4 个 BullMQ Worker 并开始消费 + 启动 payment 对账 sweep。
 *
 * @param concurrency - 各队列独立并发；省略时从环境变量读取安全默认值
 * @returns Worker 实例数组（用于优雅关闭）
 */
export async function startAllWorkers(
  concurrency: number | WorkerConcurrencyOptions = resolveWorkerConcurrency(),
): Promise<Worker<WorkerJobData>[]> {
  // P0-2：消费前先把并发计数器重算到 DB 真值，清掉崩溃残留的虚高计数（防新 worker 读到泄漏计数）。
  // recompute 同时把上一进程遗留的孤儿 RUNNING 重置为 QUEUED；若回收了孤儿，立即跑一次
  // task-heal 把它们重新派发入队（启动即恢复，不等 60s 首个 tick，防 admin 批量任务重启后空窗）。
  try {
    const r = await recomputeAllFromDb();
    console.log(
      `[ai-worker] 并发计数器重算: checked=${r.checked} reset=${r.reset}(孤儿RUNNING→QUEUED) cleared=${r.cleared}`,
    );
    if (r.reset > 0) {
      try {
        const h = await sweepStuckTasks();
        console.log(
          `[ai-worker] 启动 heal: scanned=${h.scanned} redispatched=${h.redispatched} failed=${h.failed}`,
        );
      } catch (he) {
        console.error('[ai-worker] 启动 heal 失败（不阻塞，等 60s 定时 sweep 兜底）', he);
      }
    }
  } catch (e) {
    console.error('[ai-worker] 并发计数器重算失败（不阻塞启动）', e);
  }
  const workers = createAllWorkers(concurrency);
  _sweepHandle = startPaymentSweep();
  _pendingChargeSweepHandle = startPendingChargeSweep();
  _keyPoolReapHandle = startKeyPoolReapSweep();
  _taskHealHandle = startTaskHealSweep();
  _renderJobReapHandle = startRenderJobReapSweep();
  _renderJobCascadeHandle = startRenderJobCascadeSweep();
  _renderJobZombieHandle = startRenderJobZombieSweep();
  _episodeStageSweepHandle = startEpisodeStageSweep();
  console.log(
    `[ai-worker] 已启动 4 个 Worker (concurrency=${JSON.stringify(concurrency)}): ` +
      'text/image/video/voice',
  );
  console.log(
    `[ai-worker] 已启动 payment 对账 sweep (每 ${SWEEP_INTERVAL_MS / 1000}s，` +
      `兜底陈年 PENDING 单防漏单)`,
  );
  console.log(
    `[ai-worker] 已启动 pendingCharge 补扣 sweep (每 60s，重试扣费失败任务防漏收)`,
  );
  console.log(`[ai-worker] 已启动 key 池 cooldown reap sweep (每 60s，恢复过期 cooldown key)`);
  console.log(
    `[ai-worker] 已启动 task-heal sweep (每 60s，自愈卡死的 QUEUED/PENDING/RUNNING 任务)`,
  );
  console.log(
    `[ai-worker] 已启动 render_jobs reap sweep (每 60s，自愈客户端崩溃/断网的卡死租约)`,
  );
  console.log(
    '[ai-worker] 已启动 render_jobs 级联兜底 sweep (每 60s，修正绕过级联的卡 GENERATING 镜头)',
  );
  console.log(
    '[ai-worker] 已启动 render_jobs zombie 回收 sweep (每 60s，回收心跳活着但进度卡死的 job)',
  );
  console.log(
    '[ai-worker] 已启动 episode stage 复位 sweep (每 60s，复位 web 重启遗留的卡死 analyzing 集)',
  );
  return workers;
}

/**
 * 优雅关闭 ai-worker 进程。
 *
 * @param workers - startAllWorkers 返回的 Worker 实例数组
 */
export async function stopAllWorkers(
  workers: Worker<WorkerJobData>[],
): Promise<void> {
  _sweepHandle?.stop();
  _sweepHandle = null;
  _pendingChargeSweepHandle?.stop();
  _pendingChargeSweepHandle = null;
  _keyPoolReapHandle?.stop();
  _keyPoolReapHandle = null;
  _taskHealHandle?.stop();
  _taskHealHandle = null;
  _renderJobReapHandle?.stop();
  _renderJobReapHandle = null;
  _renderJobCascadeHandle?.stop();
  _renderJobCascadeHandle = null;
  _renderJobZombieHandle?.stop();
  _renderJobZombieHandle = null;
  _episodeStageSweepHandle?.stop();
  _episodeStageSweepHandle = null;
  await shutdownWorkers(workers);
  console.log(
    '[ai-worker] 已关闭全部 Worker + payment sweep + pendingCharge sweep + key 池 reap + task-heal sweep',
  );
}
