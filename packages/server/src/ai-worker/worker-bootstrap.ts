// ============================================================
// ⑥ server/ai-worker/worker-bootstrap — BullMQ Worker 实例创建
// ============================================================
//
// 文件职责：
//   为 4 个队列（text/image/video/voice）各创建一个 BullMQ Worker，
//   Worker 的 processor 调用 processJob（串联 handler → write-back → 扣费 → 发布）。
//
// 设计要点：
//   - 复用 @server/infra 的 getRedis() 单例（与 ④ Queue 同实例）
//   - 队列名从 ④ QUEUE_NAMES 取（不重命名，保证与 ④ dispatch 一致）
//   - 各队列独立配置并发：图片是远程 I/O，可安全提高；视频/文本仍保持保守值
//   - removeOnComplete/removeOnFail 保留与 ④ defaultJobOptions 一致的清理策略
//   - 业务失败不重试（processJob catch-all 不重抛），仅基础设施错误经 BullMQ
//     stall 路径重试（attempts=3 由 ④ defaultJobOptions 配置）
//
// 服务器禁止 import ffmpeg；本模块仅创建 BullMQ Worker，零 ffmpeg 依赖。
// ============================================================

import { Worker, type WorkerOptions, type Job } from 'bullmq';
import { getRedis } from '@server/infra';
import { QUEUE_NAMES } from '@server/task/queues';
import { processJob } from './processor';
import { markFailed } from './task-repo';
import { publishTaskEvent } from './event-publisher';
import type { WorkerJobData } from './types';
import {
  resolveWorkerConcurrency,
  type WorkerConcurrencyOptions,
} from './worker-concurrency';

/** 默认 Worker 选项；具体并发数由各队列创建函数覆盖。 */
const DEFAULT_WORKER_OPTIONS: Pick<
  WorkerOptions,
  'concurrency' | 'removeOnComplete' | 'removeOnFail' | 'stalledInterval' | 'maxStalledCount' | 'lockDuration'
> = {
  concurrency: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500, age: 86400 },
  // 显式 stalled 配置（替代 BullMQ 默认）：每 30s 跑 stalled-check，job 锁超过 lockDuration
  // 不续期判 stalled 触发 reprocess。lockDuration 对齐 app1 BaseWorker（base.ts:173）300s——
  // ai-worker 多为远程 LLM/视频生成调用，60s 太紧，GC/Redis 抖动/容器 CPU 节流即误判 stalled；
  // 配合 processor 幂等缓存（P0-3）即便真 stall 重投也不重复扣费。
  stalledInterval: 30_000,
  maxStalledCount: 1,
  lockDuration: 300_000,
};

/**
 * 创建一个 BullMQ Worker，消费指定队列。
 *
 * @param queueName - BullMQ 队列名（如 'tasks-text'）
 * @param concurrency - 并发处理数（默认 1）
 * @returns BullMQ Worker 实例
 */
/**
 * 处理 BullMQ job 彻底失败（attempts 用尽）：写 DB FAILED + 发事件。
 *
 * 仅当 attemptsMade >= opts.attempts 才写——单次 attempt 失败让 BullMQ 继续 backoff
 * 重试（保持原语义）。防"并发拒绝 throw 用尽重试后 DB 永远卡 QUEUED、前端无报错"。
 */
async function handleJobFinallyFailed(
  job: Job<WorkerJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;
  const taskId = job.data?.taskId;
  const userId = job.data?.userId;
  if (!taskId || !userId) return;
  const reason = err?.message ?? `任务重试 ${maxAttempts} 次后仍失败`;
  // markFailed 返回 false=任务已 CANCELLED/COMPLETED（取消终态事件已发，不重复发假 FAILED）；
  // true 或 throws 则继续发 FAILED（throws 由 worker.on('failed') .catch 兜底）。
  const failed = await markFailed(taskId, reason);
  if (failed === false) return;
  await publishTaskEvent({
    taskId,
    userId,
    status: 'FAILED',
    type: 'status_change',
    error: reason,
  });
}

function createWorkerForQueue(
  queueName: string,
  concurrency: number = 1,
): Worker<WorkerJobData> {
  const worker = new Worker<WorkerJobData>(
    queueName,
    // BullMQ Worker processor 的 token 是第二参数（不是 Job 对象属性），必须透传给
    // processJob，否则并发满时的 moveToDelayed 重投守卫恒 false → 降级 throw → 误判 FAILED。
    async (job, token) => {
      await processJob(job, token);
    },
    {
      connection: getRedis(),
      ...DEFAULT_WORKER_OPTIONS,
      concurrency,
    },
  );
  // 彻底失败（attempts 用尽）时补写 DB FAILED，防任务卡 QUEUED 无报错
  // 返回 promise（而非 void）以便单测可 await；BullMQ 忽略事件回调返回值，无副作用。
  worker.on('failed', (job, err) =>
    handleJobFinallyFailed(job ?? undefined, err as Error).catch((e) => {
      console.error('[ai-worker] failed 事件处理异常', e);
    }),
  );
  return worker;
}

/** 创建 TEXT 队列 Worker */
export function createTextWorker(concurrency: number = 1): Worker<WorkerJobData> {
  return createWorkerForQueue(QUEUE_NAMES.text, concurrency);
}

/** 创建 IMAGE 队列 Worker */
export function createImageWorker(concurrency: number = 1): Worker<WorkerJobData> {
  return createWorkerForQueue(QUEUE_NAMES.image, concurrency);
}

/** 创建 VIDEO 队列 Worker */
export function createVideoWorker(concurrency: number = 1): Worker<WorkerJobData> {
  return createWorkerForQueue(QUEUE_NAMES.video, concurrency);
}

/** 创建 VOICE 队列 Worker */
export function createVoiceWorker(concurrency: number = 1): Worker<WorkerJobData> {
  return createWorkerForQueue(QUEUE_NAMES.voice, concurrency);
}

/**
 * 创建全部 4 个队列的 BullMQ Worker。
 *
 * @param concurrency - 旧调用可传统一数字；生产建议传按队列拆分的配置
 * @returns 4 个 Worker 实例（text/image/video/voice 顺序）
 */
export function createAllWorkers(
  concurrency: number | WorkerConcurrencyOptions = resolveWorkerConcurrency(),
): Worker<WorkerJobData>[] {
  // 保留数字参数兼容现有调用和测试，同时让生产入口使用独立配置。
  const options = typeof concurrency === 'number'
    ? { text: concurrency, image: concurrency, video: concurrency, voice: concurrency }
    : concurrency;
  return [
    createTextWorker(options.text),
    createImageWorker(options.image),
    createVideoWorker(options.video),
    createVoiceWorker(options.voice),
  ];
}

/**
 * 优雅关闭一组 Worker。
 *
 * @param workers - Worker 实例数组
 */
export async function shutdownWorkers(
  workers: Worker<WorkerJobData>[],
): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
}
