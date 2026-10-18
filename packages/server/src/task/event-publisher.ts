// ============================================================
// ④ server/task/event-publisher — Redis task:events + PG task_events 持久化
// ============================================================
//
// 文件职责：
//   publishTaskEvent(payload) — 持久化事件到 task_events 表 → 发布到 Redis
//     `task:events` 频道；前端 SSE 通过 /api/sse 订阅。支持 Last-Event-ID 重连重放。
//   listEventsAfter(userId, afterId) — 查询用户在指定 id 之后的事件（SSE 重放）
//   listActiveTasksSnapshot(userId) — 查询用户活跃任务合成快照事件（SSE 首连接）
//
// 核心设计（照搬 app1 src/core/task/publisher.ts）：
//   - 持久化事件先 INSERT task_events 拿自增 id 再 redis.publish（事件附 id）
//   - 瞬时事件（无 type 或 type 未在 PERSISTABLE 中）用 ephemeral id，不持久化
//   - taskId→userId LRU（5000 上限）：progress/output/error 事件原本不带 userId
//     时查 tasks 表补全；任务生命周期内 status_change 先到，缓存几乎 100% 命中。
//   - 持久化失败降级为 ephemeral id，不抛异常（不能阻塞任务执行）
//   - 发布失败仅 console.warn（任务状态已写 PG，前端可轮询兜底）
//
// 与 app1 的差异：
//   - 单一 publishTaskEvent(payload) 函数（app1 有 publishProgress/publishStatusChange
//     等多方法）；dramaforge 调用方直接构造 payload。
//   - dramaforge 用 raw SQL via @server/infra 的 query（app1 用 prisma.$queryRaw）
//   - dramaforge tasks 表 active = status IN ('PENDING', 'RUNNING')（app1 还含 QUEUED；
//     dramaforge tasks 表无 QUEUED 状态，QUEUED 只在事件层）
//
// 此模块是 ④ task 子域的新成员；ai-worker/event-publisher.ts 已退化为 re-export
// shim，保留旧 import 路径（processor.ts / dispatch.ts / 测试 vi.mock 均仍指向
// ai-worker/event-publisher，shim 透传到本文件）。web 通过 @dramaforge/server
// 根 barrel 取 publishTaskEvent / listEventsAfter / listActiveTasksSnapshot。
//
// 服务器禁止 import ffmpeg；本模块仅做 PG 写 + Redis publish，零 ffmpeg 依赖。
// ============================================================

import { getRedis, query } from '@server/infra';
import type { TaskEventPayload } from '../ai-worker/types';
import type { RenderJobGroupClip } from '@dramaforge/shared';

/** Redis Pub/Sub 频道名（与 /api/sse 订阅端冻结一致；与原 ai-worker/event-publisher 同字符串） */
export const TASK_EVENTS_CHANNEL = 'task:events';

/** 需持久化到 task_events 表的事件 type（connected/system_alert 等瞬时事件不持久化） */
const PERSISTABLE_EVENT_TYPES = new Set(['status_change', 'progress', 'output', 'error']);

/** taskId → userId LRU 缓存上限（与 app1 _TASK_ID_CACHE_SIZE 一致） */
const TASK_ID_CACHE_SIZE = 5000;

/**
 * taskId → userId LRU 缓存（Map 维持插入序，超上限删最早 key 即 LRU 淘汰）。
 * progress/output/error 事件原本不带 userId 时查 tasks 表补全；任务生命周期内
 * status_change 先到（dispatch 发 QUEUED 时已带 userId），缓存几乎 100% 命中。
 */
const _taskIdToUserId = new Map<string, string>();

/**
 * 生成瞬时事件 ID（未持久化时使用）。
 * 格式：ephemeral:<时间戳36进制>:<随机串>。
 * 非纯数字 → SSE encodeSseEvent 不发 id: 行 → 浏览器 lastEventId 保持上次持久化 id。
 */
function createEphemeralId(): string {
  return `ephemeral:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 解析 taskId 对应的 userId（带 LRU 缓存）。
 * 缓存 miss 时查 tasks 表，并入缓存；查询失败返回 null（降级为 ephemeral id）。
 *
 * @param taskId - 任务 ID
 * @returns userId；task 不存在或查询失败时返回 null
 */
async function resolveUserId(taskId: string): Promise<string | null> {
  // 1. 缓存命中
  const cached = _taskIdToUserId.get(taskId);
  if (cached) return cached;

  // 2. 查 DB
  try {
    const result = await query(
      'SELECT "userId" FROM tasks WHERE id = $1',
      [taskId],
    );
    const row = result.rows[0] as { userId?: string } | undefined;
    const userId = row?.userId;
    if (typeof userId === 'string' && userId.length > 0) {
      // LRU 淘汰：超上限时删最早插入的 key
      if (_taskIdToUserId.size >= TASK_ID_CACHE_SIZE) {
        const firstKey = _taskIdToUserId.keys().next().value;
        if (firstKey) _taskIdToUserId.delete(firstKey);
      }
      _taskIdToUserId.set(taskId, userId);
      return userId;
    }
  } catch (e) {
    console.warn(
      `[event-publisher] resolveUserId failed taskId=${taskId}:`,
      e instanceof Error ? e.message : e,
    );
  }
  return null;
}

/**
 * 推断事件 eventType（用于持久化分类）。
 *
 * 优先级：显式 type > progress 字段 > status > error > result > undefined。
 * - 有 payload.type：直接用（dispatch.ts 显式带 'status_change'）
 * - 有 progress 字段：归 'progress'（即使 status=RUNNING，progress 上报本质是进度事件）
 * - 有 status：归 'status_change'（QUEUED/RUNNING/COMPLETED/FAILED 都是状态转换）
 * - 有 error：归 'error'
 * - 有 result：归 'output'
 *
 * @returns eventType 字符串；无法推断时返回 undefined（事件不持久化）
 */
function inferEventType(payload: TaskEventPayload): string | undefined {
  if (payload.type) return payload.type;
  if (typeof payload.progress === 'number') return 'progress';
  if (payload.status) return 'status_change';
  if (payload.error !== undefined) return 'error';
  if (payload.result !== undefined) return 'output';
  return undefined;
}

/**
 * 持久化事件到 task_events 表，返回自增 id（字符串）。
 * 持久化失败时降级为 ephemeral id，不抛异常（不能阻塞任务执行）。
 *
 * @param payload - 事件载荷（会被回填 userId，让 SSE filterEventForUser 走快速路径）
 * @param taskId - 任务 ID
 * @param eventType - 事件类型（status_change/progress/output/error）
 * @returns 事件 id（持久化为数字字符串，失败为 ephemeral:xxx）
 */
async function persistEvent(
  payload: TaskEventPayload,
  taskId: string,
  eventType: string,
): Promise<string> {
  // 1. 解析 userId（progress 等不带 userId 的事件查 tasks 表补全）
  const userId = payload.userId || (await resolveUserId(taskId));
  if (!userId) {
    // 极端情况：task 已被删除且无缓存，降级为 ephemeral
    return createEphemeralId();
  }

  try {
    // 2. 只有 AI tasks 才写带外键的历史表；render_jobs 共用实时 SSE，但不属于 tasks。
    // 用条件 INSERT 原子判断存在性，避免先查再写之间任务被删除的竞态。
    const result = await query(
      `INSERT INTO task_events ("taskId", "userId", "eventType", "payload", "createdAt")
       SELECT $1, $2, $3, $4::jsonb, NOW()
        WHERE EXISTS (SELECT 1 FROM tasks WHERE id = $1)
       RETURNING id`,
      [taskId, userId, eventType, JSON.stringify(payload)],
    );
    const row = result.rows[0] as { id?: string | bigint } | undefined;
    if (row?.id === undefined) return createEphemeralId();
    // 3. 回填 userId 到 payload，让 SSE filterEventForUser 走快速路径
    payload.userId = userId;
    // pg BIGSERIAL 返回字符串（避免 JS number 精度问题），保险做 String 转换
    return String(row.id);
  } catch (e) {
    console.warn(
      `[event-publisher] persistEvent failed taskId=${taskId}, fallback to ephemeral:`,
      e instanceof Error ? e.message : e,
    );
    return createEphemeralId();
  }
}

/**
 * 发布任务事件：持久化（符合条件的）→ Redis publish。
 *
 * 流程：
 *   1. 浅拷贝 payload（不污染调用方对象，避免 vitest toHaveBeenCalledWith 匹配失配）
 *   2. 推断 eventType；PERSISTABLE 类型先 INSERT task_events 拿自增 id
 *   3. 瞬时事件（无 type 或未在 PERSISTABLE 中）用 ephemeral id，不持久化
 *   4. 补默认 timestamp（毫秒）
 *   5. redis.publish(TASK_EVENTS_CHANNEL, JSON)
 *
 * 发布失败仅 console.warn（任务状态已写 PG / task_events 表，前端可轮询兜底）。
 *
 * @param payload - 任务事件载荷
 */
export async function publishTaskEvent(payload: TaskEventPayload): Promise<void> {
  // 浅拷贝避免污染调用方对象（dispatch.test.ts 用 toHaveBeenCalledWith 严格匹配）
  const enriched: TaskEventPayload = { ...payload };

  const taskId = enriched.taskId;
  const eventType = inferEventType(enriched);
  const shouldPersist =
    !!eventType &&
    PERSISTABLE_EVENT_TYPES.has(eventType) &&
    !!taskId &&
    taskId !== 'unknown';

  // 持久化事件先 INSERT 拿自增 id；瞬时事件用 ephemeral id
  enriched.id = shouldPersist
    ? await persistEvent(enriched, taskId, eventType!)
    : createEphemeralId();

  // 补默认 timestamp（毫秒）；调用方未传时填当前时间
  if (enriched.timestamp === undefined) {
    enriched.timestamp = Date.now();
  }

  try {
    const redis = getRedis();
    await redis.publish(TASK_EVENTS_CHANNEL, JSON.stringify(enriched));
  } catch (err) {
    // 发布失败不阻断主流程：任务状态已写 PG（或 task_events 表），前端可轮询兜底
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[event-publisher] 发布 task:events 失败 (taskId=${taskId}): ${msg}`,
    );
  }
}

/**
 * 查询某用户在指定事件 id 之后的所有事件（SSE 重放）。
 *
 * 浏览器携带 Last-Event-ID 重连时，SSE route 据此补发断线期间的持久化事件。
 *
 * @param userId - 用户 ID
 * @param afterId - 起始事件 id（不含），从 Last-Event-ID 请求头解析
 * @param limit - 返回上限，默认 500（硬上限 5000）
 * @returns 事件列表（按 id 升序，每条带 id 字段）；查询失败返回空数组
 */
export async function listEventsAfter(
  userId: string,
  afterId: number,
  limit = 500,
): Promise<TaskEventPayload[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 5000);
  try {
    const result = await query(
      `SELECT id, payload
         FROM task_events
        WHERE "userId" = $1 AND id > $2
        ORDER BY id ASC
        LIMIT $3`,
      [userId, afterId, safeLimit],
    );
    return (result.rows as Array<{
      id: string | bigint;
      payload: string | Record<string, unknown>;
    }>).map((row) => {
      const payload: TaskEventPayload =
        typeof row.payload === 'string'
          ? (JSON.parse(row.payload) as TaskEventPayload)
          : (row.payload as unknown as TaskEventPayload);
      payload.id = String(row.id);
      return payload;
    });
  } catch (e) {
    console.warn(
      `[event-publisher] listEventsAfter failed userId=${userId} afterId=${afterId}:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

/**
 * 查询用户当前活跃任务并合成快照事件（SSE 首连接）。
 * 活跃定义：status IN ('PENDING', 'QUEUED', 'RUNNING', 'PROCESSING')。
 *
 * @param userId - 用户 ID
 * @returns 快照事件列表（每条带 snapshot:true 标记；id 为 snapshot:xxx 非纯数字 →
 *          SSE encodeSseEvent 不发 id: 行，浏览器 lastEventId 保持上次持久化 id）
 */
export async function listActiveTasksSnapshot(
  userId: string,
): Promise<TaskEventPayload[]> {
  try {
    const result = await query(
      `SELECT id, type, status, progress, stage, "stageProgress", "updatedAt"
         FROM tasks
        WHERE "userId" = $1 AND status IN ('PENDING', 'QUEUED', 'RUNNING', 'PROCESSING')
        ORDER BY "createdAt" DESC
        LIMIT 200`,
      [userId],
    );
    return (result.rows as Array<{
      id: string;
      type: string;
      status: string;
      progress: number;
      stage: string | null;
      stageProgress: number;
      updatedAt: Date;
    }>).map((task) => {
      const updatedAtMs = new Date(task.updatedAt).getTime();
      return {
        taskId: task.id,
        userId,
        type: 'status_change',
        status: task.status as TaskEventPayload['status'],
        progress: task.progress,
        stage: task.stage ?? undefined,
        stageProgress: task.stageProgress,
        snapshot: true,
        timestamp: updatedAtMs,
        // 非纯数字 id → SSE encodeSseEvent 不发 id: 行
        id: `snapshot:${task.id}:${updatedAtMs}`,
      };
    });
  } catch (e) {
    console.warn(
      `[event-publisher] listActiveTasksSnapshot failed userId=${userId}:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

/**
 * 查询某 chain 任务已渐进回传的镜头组视频片段（抗 SSE 断 + 抗刷新）。
 *
 * chain 编排器每完成一组就经 progress 路由把 `{shotIds, videoUrl}` 写进一条 progress
 * 事件并持久化到 task_events（payload.groupClip）。SSE 断线或页面刷新时，前端 4s 轮询 /
 * 恢复 effect 无法靠 SSE 实时拿到这些片段——本函数从 task_events 把同一 taskId 的所有
 * groupClip 事件按时间序取出、按 shotId 去重（首到为准，跳过完全重复的回传），供状态
 * 端点挂到轮询快照里，让前端在 SSE 不可用时仍能把已完成组翻成视频。
 *
 * videoUrl 是 sf-asset://（客户端本地，服务端零字节）；查询失败返回空数组，不阻塞状态查询。
 *
 * @param taskId - 任务 ID
 * @param limit - 返回事件上限，默认 200（硬上限 2000）
 * @returns 去重后的组片段列表（按事件 id 升序）
 */
export async function listTaskProgressClips(
  taskId: string,
  limit = 200,
): Promise<RenderJobGroupClip[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 2000);
  try {
    const result = await query(
      `SELECT payload
         FROM task_events
        WHERE "taskId" = $1
          AND "eventType" = 'progress'
          AND payload ? 'groupClip'
        ORDER BY id ASC
        LIMIT $2`,
      [taskId, safeLimit],
    );
    const clips: RenderJobGroupClip[] = [];
    const seenShotIds = new Set<string>();
    for (const row of result.rows as Array<{
      payload: string | Record<string, unknown>;
    }>) {
      const payload: TaskEventPayload =
        typeof row.payload === 'string'
          ? (JSON.parse(row.payload) as TaskEventPayload)
          : (row.payload as unknown as TaskEventPayload);
      const clip = payload.groupClip;
      if (!clip || !Array.isArray(clip.shotIds) || clip.shotIds.length === 0) continue;
      if (typeof clip.videoUrl !== 'string' || clip.videoUrl.length === 0) continue;
      // 该组所有镜头均已由更早事件覆盖 → 跳过完全重复回传。
      if (clip.shotIds.every((id) => seenShotIds.has(id))) continue;
      for (const id of clip.shotIds) seenShotIds.add(id);
      clips.push({ shotIds: [...clip.shotIds], videoUrl: clip.videoUrl });
    }
    return clips;
  } catch (e) {
    console.warn(
      `[event-publisher] listTaskProgressClips failed taskId=${taskId}:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}
