// ============================================================
// ④ server/task/queues — BullMQ 队列定义（4 队列：text/image/video/voice）
// ============================================================
//
// 文件职责：
//   1. 定义 4 类任务队列名称常量（text / image / video / voice）
//   2. 用 BullMQ Queue 实例化 4 个队列，复用 @server/infra 的 Redis 单例
//      （getRedis() 已配置 maxRetriesPerRequest:null，BullMQ v5 强制要求）
//   3. 提供 addJob(queueName, jobName, data) 入队助手
//
// 设计要点：
//   - 队列实例在模块加载时创建并缓存（懒连接：BullMQ Queue 构造不发 Redis 命令）
//   - 按 AI 任务类型分流：文本→text、图像→image、视频生成→video、语音→voice
//   - defaultJobOptions：完成/失败各保留 N 条；3 次指数退避重试
//   - 服务器端 ai-worker 消费这些队列；客户端 ffmpeg 任务不走 BullMQ，
//     而是写 render_jobs 表由客户端 render-worker HTTP 拉取（见 render-job-repo.ts）
//
// 移植自 app1 src/core/task/queue.ts，去掉 QueueManager 单例类与 Redis 健康预检
// （健康预检由 infra 层负责），仅保留队列定义 + 入队助手。
// 服务器禁止 import 任何 ffmpeg 模块。
// ============================================================

import { Queue, type JobsOptions } from 'bullmq';
import { getRedis } from '@server/infra';

/**
 * 4 类任务队列名称常量
 * 按任务类型分为文本、图像、视频、语音四个独立队列，实现资源隔离
 */
export const QUEUE_NAMES = {
  text: 'tasks-text',
  image: 'tasks-image',
  video: 'tasks-video',
  voice: 'tasks-voice',
} as const;

/** 队列名（逻辑键） */
export type QueueName = keyof typeof QUEUE_NAMES;

/** BullMQ Job 数据载荷类型（任意可序列化对象） */
export type QueueJobData = Record<string, unknown>;

/**
 * 默认 Job 选项
 * - removeOnComplete: 保留最近 200 条已完成（2026-07-25 由 1000 下调——1000 条
 *   completed job 把 256m redis 撑爆 OOM；200 足够诊断，内存占用降 5×）
 * - removeOnFail: 保留最近 500 条失败（由 5000 下调，同理）
 * - attempts: 3 次重试，指数退避（1s 起步）
 */
const defaultJobOptions: JobsOptions = {
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
};

/**
 * 创建一个 BullMQ Queue 实例
 *
 * 复用 @server/infra 的 Redis 单例（maxRetriesPerRequest:null 已配置）。
 * BullMQ Queue 构造时不发 Redis 命令（懒连接），故模块加载安全。
 */
function createQueue(name: string): Queue<QueueJobData> {
  return new Queue<QueueJobData>(name, {
    connection: getRedis(),
    defaultJobOptions,
  });
}

/**
 * 4 个队列实例（模块加载时创建）
 * 服务器 ai-worker 各起一个 Worker 消费对应队列
 */
export const queues: Record<QueueName, Queue<QueueJobData>> = {
  text: createQueue(QUEUE_NAMES.text),
  image: createQueue(QUEUE_NAMES.image),
  video: createQueue(QUEUE_NAMES.video),
  voice: createQueue(QUEUE_NAMES.voice),
};

/**
 * 入队助手：向指定队列添加一个 Job
 *
 * @param queueName - 逻辑队列名（text/image/video/voice）
 * @param jobName - Job 名称（如 'VIDEO_GENERATE'），消费者据此分派 handler
 * @param data - Job 数据载荷（须可 JSON 序列化）
 * @returns BullMQ Job ID（字符串）
 */
export async function addJob(
  queueName: QueueName,
  jobName: string,
  data: QueueJobData,
  /**
   * 幂等 jobId（可选）。传则用 BullMQ 同 jobId 复用语义：同 jobId 的 job 若仍存活
   * （active/waiting/delayed）则 add 返回现有 job 不新建，completed/failed/不存在则新建。
   * P0-1 修复：dispatchAiTask 传 taskId 作 jobId，task-heal redispatch 同 taskId 复用原 job，
   * 不再每 tick 新建重复 job → 杜绝"卡死任务每 60s +1 job，slot 释放后 N 个 job 全冲
   * handleTask → N 倍 provider 调用烧 key 烧钱"（复检1 发现，task-heal retryCount 修复的副作用）。
   */
  jobId?: string,
): Promise<string> {
  const queue = queues[queueName];
  const job = await queue.add(jobName, data, jobId ? { jobId } : undefined);
  return job.id ?? '';
}
