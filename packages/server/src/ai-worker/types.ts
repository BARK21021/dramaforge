// ============================================================
// ⑥ server/ai-worker/types — 纯 AI Worker 类型定义
// ============================================================
//
// 文件职责：
//   定义 ai-worker 模块的全部类型契约：
//   1. AiTaskType — ai-worker 处理的纯 AI 任务类型联合
//   2. WorkerJobData — BullMQ Job 数据载荷（④ dispatchAiTask 合入 taskId/userId）
//   3. HandlerResult — handler 返回值（output + 模型信息 + 计费描述）
//   4. TaskEventPayload — 发布到 Redis task:events 频道的事件载荷
//
// 任务类型映射（与 app1 对齐，剥离所有 ffmpeg 类任务）：
//   TEXT 队列（8 种）：STORY_ANALYZE / SCRIPT_CONVERT / EPISODE_SPLIT /
//     CHARACTER_PROFILE / SHOT_AI / STORY_EXPAND / LLM_CHAT / LLM_STREAM
//     —— 不含 LONG_VIDEO_REWRITE（客户端 ⑩）
//   IMAGE 队列（2 种）：IMAGE_GENERATE / ASSET_IMAGE_GENERATE
//   VIDEO 队列（1 种）：VIDEO_GENERATE（单镜；CHAIN_GENERATE/FILM_EXPORT/VIDEO_COMPOSITE 客户端 ⑨⑩）
//   VOICE 队列（1 种）：VOICE_GENERATE(TTS)
//
// 服务器禁止 import ffmpeg；ai-worker 仅消费 ④ 的 BullMQ 队列，调用 ② callAI，
// 回写 ⑦ PG tasks 表，扣费 ③ billing，释放 ③ concurrency，发布 Redis 事件给 ⑤ SSE。
// ============================================================

/**
 * ai-worker 处理的纯 AI 任务类型。
 *
 * 与 app1 18 种任务类型的差异：
 *   - 剥离 LONG_VIDEO_REWRITE（客户端 ⑩ 长 ffmpeg pipeline）
 *   - 剥离 FILM_EXPORT / CHAIN_GENERATE（客户端 ⑨ ffmpeg concat/编排）
 *   - 剥离 VIDEO_COMPOSITE（app1 占位实现，无实际逻辑）
 *   - 不提供 LIPSYNC：产品界面没有这项业务能力，也没有对应平台 Key
 *   - IMAGE_MODIFY / IMAGE_UNDO 在 app1 ImageWorker 未实现，不迁移
 */
export type AiTaskType =
  // TEXT 队列（8 种）
  | 'STORY_ANALYZE'
  | 'SCRIPT_CONVERT'
  | 'EPISODE_SPLIT'
  | 'CHARACTER_PROFILE'
  | 'SHOT_AI'
  | 'STORY_EXPAND'
  | 'LLM_CHAT'
  | 'LLM_STREAM'
  // IMAGE 队列（2 种）
  | 'IMAGE_GENERATE'
  | 'ASSET_IMAGE_GENERATE'
  // VIDEO 队列（1 种）
  | 'VIDEO_GENERATE'
  // VOICE 队列（1 种）
  | 'VOICE_GENERATE';

/** TEXT 队列的任务类型集合 */
export const TEXT_TASK_TYPES: readonly AiTaskType[] = [
  'STORY_ANALYZE',
  'SCRIPT_CONVERT',
  'EPISODE_SPLIT',
  'CHARACTER_PROFILE',
  'SHOT_AI',
  'STORY_EXPAND',
  'LLM_CHAT',
  'LLM_STREAM',
];

/** IMAGE 队列的任务类型集合 */
export const IMAGE_TASK_TYPES: readonly AiTaskType[] = [
  'IMAGE_GENERATE',
  'ASSET_IMAGE_GENERATE',
];

/** VIDEO 队列的任务类型集合 */
export const VIDEO_TASK_TYPES: readonly AiTaskType[] = ['VIDEO_GENERATE'];

/** VOICE 队列的任务类型集合 */
export const VOICE_TASK_TYPES: readonly AiTaskType[] = ['VOICE_GENERATE'];

/**
 * BullMQ Job 数据载荷。
 *
 * ④ dispatchAiTask 把 taskId/userId 合入 data：
 *   addJob(queueName, jobName, { ...data, taskId, userId })
 * jobName 即 AiTaskType（Worker 从 job.name 读取）。
 * 新派发 job 不再带 input（精简载荷避免 base64 媒体撑爆 Redis）；processor 按 taskId
 * 从 PG tasks.input 取完整输入。input 字段仅旧客户端 fat job 兜底用。
 */
export interface WorkerJobData {
  /** 任务 ID（PG tasks 表主键） */
  taskId: string;
  /** 用户 ID */
  userId: string;
  /**
   * 任务输入参数（类型特定）。新派发 job 不再携带（精简载荷避免 base64 媒体撑爆 Redis）；
   * processor 按 taskId 从 PG tasks.input 取。仅旧客户端发的 fat job 仍带此字段（兜底）。
   */
  input?: Record<string, unknown>;
  /** 关联项目 ID（可选，用于存储路径分段） */
  projectId?: string;
  /** 其他透传字段 */
  [key: string]: unknown;
}

/**
 * handler 返回值。
 *
 * - output：任务输出（写入 tasks.output JSONB）
 * - modelProvider/modelName：写入 tasks."modelProvider"/"modelName"
 * - cost：扣费金额（积分）；② callAI 不返回 cost，当前恒为 0（待定价模型补入）
 * - billingDescription：扣费描述（写入 billing_ledger.description）
 */
export interface HandlerResult {
  output: unknown;
  modelProvider?: string;
  modelName?: string;
  cost?: number;
  billingDescription?: string;
}

/**
 * 发布到 Redis task:events 频道的事件载荷（供 ⑤ SSE 消费）。
 *
 * - QUEUED：任务已派发（render_job 已写 / BullMQ 已入队），由 ④ dispatch 发布
 * - RUNNING：可选，标记任务开始执行（由 ⑥ processor / 客户端 progress route 发布）
 * - COMPLETED：携带 result（任务输出）
 * - FAILED：携带 error（错误信息）
 *
 * `type` 字段：事件语义分类（如 'status_change'）。dispatch 发 QUEUED 时带
 * `type: 'status_change'`，让前端 useSSE 将其归入高优先级（recon 批2 §3.2.4
 * 方案1），不被 progress 缓冲淘汰，确保 events[0].taskId 匹配触发 refetch。
 *
 * 持久化字段（照搬 app1 src/core/task/publisher.ts 的 TaskEvent 形状）：
 *   - id：事件 ID。④ task/event-publisher.publishTaskEvent 持久化时填入 task_events
 *     表自增 id（数字字符串），瞬时事件为 ephemeral:xxx / snapshot:xxx 前缀。
 *     纯数字 → SSE encodeSseEvent 发 `id:` 行让浏览器 Last-Event-ID 跟进。
 *   - progress / stage / stageProgress：进度信息。/api/render/jobs/[id]/progress
 *     route 上报时携带（render-worker 链路），未来内部 handler 批量循环也可上报。
 *   - snapshot：true 表示是 SSE 首连接时 ④ listActiveTasksSnapshot 合成的快照
 *     事件（非真实事件），让前端 useSSE 区分实时 vs 恢复。
 *   - timestamp：事件时间戳（毫秒）。publishTaskEvent 补默认 Date.now()。
 *
 * 这些字段全部可选以保持向后兼容；现有调用方不需修改即可继续工作。
 */
export interface TaskEventPayload {
  taskId: string;
  userId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  /** 事件语义分类（如 'status_change'）。可选以保持向后兼容 */
  type?: string;
  result?: unknown;
  error?: string;
  modelProvider?: string;
  modelName?: string;
  /** 事件 ID（持久化为数字字符串；瞬时事件为 ephemeral:/snapshot: 前缀）。publisher 填充 */
  id?: string;
  /** 进度百分比（0-100，支持小数）。render-worker 上报 + 内部进度估算 */
  progress?: number;
  /** 当前阶段名称（如「_concatenating」「生成中(第12/15镜头)」） */
  stage?: string;
  /** 当前阶段内子进度（0-100） */
  stageProgress?: number;
  /** SSE 首连接时合成的快照事件标记（listActiveTasksSnapshot 返回的事件） */
  snapshot?: boolean;
  /** 事件时间戳（毫秒）。publisher 补默认 Date.now()；app1 同字段 */
  timestamp?: number;
  /**
   * 渐进回传(dramaforge 独建):render-worker chain 编排器每组完成时,把已落客户端本地的组片
   * sf-asset:// URL 随 progress 事件下发,前端按 shotIds 乐观更新镜头卡片即时显示。
   * 服务端只透传这个 URL 字符串(不碰字节,符合 dramaforge-assets-client-local);persistEvent
   * 把整个 payload 存 JSONB,故 SSE 重连重放也带得上。
   */
  groupClip?: {
    shotIds: string[];
    videoUrl: string;
  };
}
