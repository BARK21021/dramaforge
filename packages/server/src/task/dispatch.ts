// ============================================================
// ④ server/task/dispatch — 任务派发（render_jobs vs BullMQ 队列）
// ============================================================
//
// 文件职责：
//   根据任务类型决定派发通道：
//     A. 客户端 ffmpeg 任务 → 写 render_jobs 表（客户端 render-worker HTTP 拉取）
//        - FILM_EXPORT        → CONCAT
//        - video-split        → SPLIT_BY_DURATION / SPLIT_EVENLY
//        - CHAIN_GENERATE     → CHAIN_COMPILE
//        - LONG_VIDEO_REWRITE → LONG_VIDEO_REWRITE
//     B. 服务器端 AI 任务 → BullMQ 入队（ai-worker 消费）
//        - VIDEO_GENERATE 单镜 / IMAGE_* / VOICE_* / TEXT_* → 对应队列
//
// 设计要点：
//   - 通道 A 走 renderJobRepo.create（PG 持久化，客户端原子认领）
//   - 通道 B 走 addJob（BullMQ，Redis 内存队列，ai-worker 消费）
//   - dispatchAiTask 把 taskId/userId 合入 data 载荷，ai-worker 据此回写结果/扣费
//   - 服务器禁跑 ffmpeg：所有 ffmpeg 类任务一律走通道 A 由客户端执行
//
// 服务器禁止 import 任何 ffmpeg 模块。
// ============================================================

import { renderJobRepo } from './render-job-repo';
import { addJob, queues, type QueueName } from './queues';
import { genId } from '@shared/utils';
// 相对路径直引 event-publisher，绕过 ai-worker/index.ts:51 的 worker-bootstrap
// 副作用（recon 批2 §5 风险5）。本模块被 web bundle 拖入时不应创建 BullMQ Worker。
import { publishTaskEvent } from '../ai-worker/event-publisher';
import {
  TEXT_TASK_TYPES,
  IMAGE_TASK_TYPES,
  VIDEO_TASK_TYPES,
  VOICE_TASK_TYPES,
} from '../ai-worker/types';
import type {
  ChainGenerateDispatchResult,
} from './render-job-repo';
import type {
  ChainCompileInput,
  ConcatInput,
  LongVideoRewriteInput,
  RenderJob,
  SplitByDurationInput,
  SplitEvenlyInput,
} from '@shared/render-job';

/**
 * 派发成片导出（客户端 ffmpeg concat）— 成品落客户端本地
 * FILM_EXPORT → 写 CONCAT render_job
 *
 * 约束 `dramaforge-assets-client-local`：服务器**不存任何媒体字节**，不签 MinIO
 * presigned PUT URL，不生成 MinIO outputKey。客户端 render-worker 把 concat
 * 成品写到 `userData/clips/<jobId>.mp4`，通过 result.outputUrl(sf-asset://)
 * + result.meta.localKey 上报。服务器只持久化 job 状态 + 本地 key 元数据。
 *
 * ConcatInput.outputUploadUrl/outputKey 为遗留字段（向后兼容测试直传场景），
 * film 派发不设。
 *
 * jobId 由 genId() 预生成，作为 render_jobs.id + 客户端成品文件名(`<jobId>.mp4`)。
 */
export async function dispatchFilmExport(
  taskId: string,
  userId: string,
  input: ConcatInput,
): Promise<RenderJob> {
  const jobId = genId();
  const job = await renderJobRepo.create(taskId, userId, 'CONCAT', input, jobId);
  // 发 QUEUED 让前端 SSE 立即感知任务已入队（render_worker 尚未认领，job=PENDING）
  await publishTaskEvent({ taskId, userId, status: 'QUEUED', type: 'status_change' });
  return job;
}

/**
 * 派发视频拆分（客户端 ffmpeg split）
 * - input 含 durationSec → SPLIT_BY_DURATION
 * - input 含 segments    → SPLIT_EVENLY
 */
export async function dispatchVideoSplit(
  taskId: string,
  userId: string,
  input: SplitByDurationInput | SplitEvenlyInput,
): Promise<RenderJob> {
  const type = 'durationSec' in input
    ? 'SPLIT_BY_DURATION'
    : 'SPLIT_EVENLY';
  const job = await renderJobRepo.create(taskId, userId, type, input);
  await publishTaskEvent({ taskId, userId, status: 'QUEUED', type: 'status_change' });
  return job;
}

/**
 * 派发串联一键生成合片（客户端 ffmpeg concat 编排结果）
 * CHAIN_GENERATE → 写 CHAIN_COMPILE render_job
 */
export async function dispatchChainGenerate(
  taskId: string,
  userId: string,
  input: ChainCompileInput,
): Promise<RenderJob> {
  const job = await renderJobRepo.create(taskId, userId, 'CHAIN_COMPILE', input);
  await publishTaskEvent({ taskId, userId, status: 'QUEUED', type: 'status_change' });
  return job;
}

/**
 * 分集生产入口专用的幂等串生成派发。
 *
 * 仓储在 PostgreSQL 事务锁内完成 create-or-reuse；这里只在真正新建时发布 QUEUED，
 * 避免并发重试让同一个 taskId 出现重复的入队生命周期事件。
 */
export async function dispatchChainGenerateOnce(
  taskId: string,
  userId: string,
  input: ChainCompileInput,
): Promise<ChainGenerateDispatchResult> {
  const dispatched = await renderJobRepo.createOrReuseChainGenerate(taskId, userId, input);
  if (!dispatched.reused) {
    await publishTaskEvent({ taskId, userId, status: 'QUEUED', type: 'status_change' });
  }
  return dispatched;
}

/**
 * 派发长视频剧本重写（客户端 ffmpeg split + 云端 LLM + concat）
 * LONG_VIDEO_REWRITE → 写 LONG_VIDEO_REWRITE render_job
 */
export async function dispatchLongVideoRewrite(
  taskId: string,
  userId: string,
  input: LongVideoRewriteInput,
): Promise<RenderJob> {
  const job = await renderJobRepo.create(taskId, userId, 'LONG_VIDEO_REWRITE', input);
  await publishTaskEvent({ taskId, userId, status: 'QUEUED', type: 'status_change' });
  return job;
}

/**
 * 派发服务器端 AI 任务（ai-worker 消费）
 *
 * 把 taskId/userId 合入 data 载荷，ai-worker 据此回写任务结果、扣费。
 *
 * @param queueName - 目标队列（text/image/video/voice）
 * @param jobName   - Job 名称（如 'VIDEO_GENERATE'），ai-worker 据此分派 handler
 * @param data      - 任务输入载荷
 * @returns BullMQ Job ID
 */
export async function dispatchAiTask(
  taskId: string,
  userId: string,
  queueName: QueueName,
  jobName: string,
  data: Record<string, unknown>,
): Promise<string> {
  // P0-1：用 taskId 作 BullMQ jobId → task-heal redispatch 同 taskId 复用原 job 不新建，
  // 杜绝"卡死任务每 60s 新建一个 job，slot 释放后 N 个 job 全冲 handleTask 烧 key 烧钱"。
  const bullJobId = await addJob(queueName, jobName, { ...data, taskId, userId }, taskId);
  // taskId 用入参（recon 批2 §5.7），不是 BullMQ jobId — 前端 trackTaskId 跟踪
  // 的是 dispatch 入参 taskId，用 bullJobId 会让前端 SSE 匹配失败。
  await publishTaskEvent({ taskId, userId, status: 'QUEUED', type: 'status_change' });
  return bullJobId;
}

/**
 * 把 AiTaskType 映射到 BullMQ 队列（与 enqueueAiTask 的 queueName 一致）。
 * inline 同步任务（VIDEO_TO_SCRIPT 等，无 BullMQ job）返回 null。
 */
function queueForType(taskType: string): QueueName | null {
  if ((TEXT_TASK_TYPES as readonly string[]).includes(taskType)) return 'text';
  if ((IMAGE_TASK_TYPES as readonly string[]).includes(taskType)) return 'image';
  if ((VIDEO_TASK_TYPES as readonly string[]).includes(taskType)) return 'video';
  if ((VOICE_TASK_TYPES as readonly string[]).includes(taskType)) return 'voice';
  return null;
}

/**
 * 取消排队中的 BullMQ AI job（best-effort）。
 *
 * cancel route 翻 CANCELLED 后调用：对 QUEUED/PENDING 的 job 从队列移除，防 worker 拾取。
 * active/locked job 删不掉（catch 吞）——交由 processor 终态早退（CANCELLED 直接 return 不跑
 * handler）+ markCompleted/markFailed CAS 兜底。inline 同步任务 queueForType 返回 null 跳过。
 */
export async function removeQueuedAiJob(taskId: string, taskType: string): Promise<void> {
  const queueName = queueForType(taskType);
  if (!queueName) return;
  const job = await queues[queueName].getJob(taskId);
  if (!job) return;
  try {
    await job.remove();
  } catch {
    // active/locked job 无法删除：交 CAS + processor 早退兜底。
  }
}
