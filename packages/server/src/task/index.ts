// ============================================================
// ④ server/task — barrel（BullMQ 队列 + render-job 仓储 + 派发 + 事件发布）
// ============================================================
// 调度层统一导出：
//   - queues: 4 个 BullMQ 队列（text/image/video/voice）+ addJob 入队助手
//   - renderJobRepo: render_jobs 表 CRUD + 原子认领（FOR UPDATE SKIP LOCKED）
//   - dispatch*: 任务→render_job / BullMQ 队列的派发函数
//   - event-publisher: task:events Redis Pub/Sub + task_events PG 持久化 +
//     SSE 重放（listEventsAfter）+ 活跃任务快照（listActiveTasksSnapshot）
//
// event-publisher 是 ④ task 子域的事件出口（被 dispatch/processor/render-jobs
// progress route 调用）；web 经 @dramaforge/server 根 barrel 取本 barrel 的
// listEventsAfter/listActiveTasksSnapshot 喂 /api/sse route。
//
// 服务器禁止 import 任何 ffmpeg 模块（本模块零 ffmpeg 依赖）。
// ============================================================

export {
  QUEUE_NAMES,
  queues,
  addJob,
  type QueueName,
  type QueueJobData,
} from './queues';

export {
  renderJobRepo,
  create,
  createOrReuseChainGenerate,
  claimNext,
  countActiveClaims,
  markRunning,
  markResult,
  markFailed,
  reapStale,
  getById,
  listByUser,
  getByTaskId,
  cancel,
  retry,
  createRetryCopy,
  forceFail,
  sweepStuckShots,
  mapRow,
  buildEpisodeConcatClips,
  DEFAULT_RENDER_JOB_LEASE_TIMEOUT_MS,
  type RenderJobRow,
  type RenderJobTransition,
  type ChainGenerateDispatchResult,
  type RenderJobListFilters,
} from './render-job-repo';

export {
  dispatchFilmExport,
  dispatchVideoSplit,
  dispatchChainGenerate,
  dispatchChainGenerateOnce,
  dispatchLongVideoRewrite,
  dispatchAiTask,
  removeQueuedAiJob,
} from './dispatch';

export {
  publishTaskEvent,
  listEventsAfter,
  listActiveTasksSnapshot,
  listTaskProgressClips,
  TASK_EVENTS_CHANNEL,
} from './event-publisher';

export {
  getAiTask,
  cancelAiTask,
  listAiTasks,
  enqueueAiTask,
  startInlineAiTask,
  reportInlineAiTaskProgress,
  completeInlineAiTask,
  failInlineAiTask,
  listActiveInlineTasks,
  type AiTaskView,
} from './ai-task-repo';

export {
  sweepStuckTasks,
  startTaskHealSweep,
  STALE_QUEUED_MS,
  STALE_RUNNING_SECONDS_BY_TYPE,
  STALE_RUNNING_DEFAULT_SECONDS,
  staleRunningSecondsForType,
  HEAL_INTERVAL_MS,
  HEAL_BATCH_LIMIT,
  type StuckTask,
  type TaskHealResult,
  type TaskHealDeps,
  type TaskHealHandle,
} from './task-heal-sweep';
