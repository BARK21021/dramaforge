// ============================================================
// AI Task Repository — PG 任务记录与 BullMQ 派发的一致性接缝
// ============================================================
//
// 过去部分 route 只创建 BullMQ job，没有先创建 tasks 行，worker 的状态 UPDATE
// 会静默命中 0 行，刷新后也无法恢复。本模块把“查重复任务→落 PG→派队列”收敛
// 成一个 Interface，供原创拆集及后续长 AI 任务复用；一次性媒体流则用 inline
// 生命周期写同一张 tasks 表，避免把大文件塞入队列或服务端落盘。
// ============================================================

import { query } from '@server/infra';
import { genId } from '@shared/utils';
import { dispatchAiTask } from './dispatch';
import { publishTaskEvent } from './event-publisher';
import type { QueueName } from './queues';

export interface AiTaskView {
  id: string;
  userId: string;
  projectId: string | null;
  type: string;
  status: string;
  progress: number;
  stage: string | null;
  stageProgress: number;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function mapTask(row: Record<string, unknown>): AiTaskView {
  return {
    id: String(row.id),
    userId: String(row.userId),
    projectId: row.projectId == null ? null : String(row.projectId),
    type: String(row.type),
    status: String(row.status),
    progress: Number(row.progress ?? 0),
    stage: row.stage == null ? null : String(row.stage),
    stageProgress: Number(row.stageProgress ?? 0),
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error == null ? null : String(row.error),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** 仅返回调用用户自己的任务，避免 taskId 枚举泄露。 */
export async function getAiTask(taskId: string, userId: string): Promise<AiTaskView | null> {
  const { rows } = await query(
    'SELECT * FROM tasks WHERE id = $1 AND "userId" = $2',
    [taskId, userId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? mapTask(row) : null;
}

/** 当前用户的 AI 任务列表，用于页面刷新后恢复生成进度。 */
export async function listAiTasks(
  userId: string,
  filters: {
    status?: string;
    type?: string;
    projectId?: string;
    limit?: number;
  } = {},
): Promise<AiTaskView[]> {
  const clauses = ['"userId" = $1'];
  const params: unknown[] = [userId];
  const addFilter = (column: string, value: string | undefined): void => {
    if (!value) return;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };
  if (filters.status === 'ACTIVE') {
    clauses.push("status IN ('PENDING', 'QUEUED', 'RUNNING', 'PROCESSING')");
  } else {
    addFilter('status', filters.status);
  }
  addFilter('type', filters.type);
  addFilter('"projectId"', filters.projectId);

  const limit = Math.min(200, Math.max(1, filters.limit ?? 100));
  params.push(limit);
  const { rows } = await query(
    `SELECT * FROM tasks
      WHERE ${clauses.join(' AND ')}
      ORDER BY "createdAt" DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => mapTask(row as Record<string, unknown>));
}

/**
 * 创建并派发 AI 任务。同项目同类型已有活跃任务时复用，阻止刷新/双击制造并发
 * 重建；入队失败会把 PG 行标 FAILED，避免永久卡在 PENDING。
 */
export async function enqueueAiTask(input: {
  userId: string;
  projectId?: string | null;
  type: string;
  queueName: QueueName;
  payload: Record<string, unknown>;
  /** 可选的脱敏持久化输入；BullMQ 仍收到完整 payload，PG 只保存此对象。 */
  storedPayload?: Record<string, unknown>;
  /** 同项目同任务类型下的幂等作用域；例如 shotId，避免不同镜头互相误复用。 */
  dedupeKey?: string;
  /**
   * BullMQ job 不带 input（精简载荷，避免 base64 撑爆 Redis）；processor 按 taskId 从
   * PG tasks.input 取完整输入。仅 base64 胖 payload 的 VIDEO_GENERATE(chain) 开启；
   * IMAGE/TEXT/VOICE 不开（generate-image 靠 storedPayload 让 PG 脱敏、完整 input 走 BullMQ）。
   * 开启时不得传 storedPayload（PG 必须存完整 input 供 processor 读）。
   */
  leanBullMQ?: boolean;
  timeoutMs?: number;
}): Promise<{ task: AiTaskView; reused: boolean }> {
  if (input.projectId) {
    // chain resume：dedupeKey 分支额外匹配同 dedupeKey 的 COMPLETED chainMode 任务
    // （input.chainMode=true），让 chainCompile 被重调时复用上一轮已完成的组视频
    // （返回其 videoUrl，客户端轮询秒回 COMPLETED），而非重新生成——根治"已完成的组
    // 被反复重派"（4945 案 22 task/10 组）。COMPLETED 复用仅限 chainMode：图片(revision.id)
    // 等无 chainMode 的 dedupe 仍只匹配活跃，保持"重新生成要新结果"语义。ORDER BY 优先
    // COMPLETED：同组既有 COMPLETED 又有活跃时复用已完成（不重生成、不重复扣费）。
    const active = input.dedupeKey
      ? await query(
          `SELECT * FROM tasks
            WHERE "userId" = $1 AND "projectId" = $2 AND type = $3
              AND input->>'__dedupeKey' = $4
              AND (
                status IN ('PENDING', 'QUEUED', 'RUNNING')
                OR (status = 'COMPLETED' AND input->>'chainMode' = 'true' AND "completedAt" > NOW() - INTERVAL '20 hours')
              )
            ORDER BY (status = 'COMPLETED') DESC, "createdAt" DESC LIMIT 1`,
          [input.userId, input.projectId, input.type, input.dedupeKey],
        )
      : await query(
          `SELECT * FROM tasks
            WHERE "userId" = $1 AND "projectId" = $2 AND type = $3
              AND status IN ('PENDING', 'QUEUED', 'RUNNING')
            ORDER BY "createdAt" DESC LIMIT 1`,
          [input.userId, input.projectId, input.type],
        );
    const row = active.rows[0] as Record<string, unknown> | undefined;
    if (row) return { task: mapTask(row), reused: true };
  }

  const taskId = genId();
  const timeoutMs = Math.max(60_000, input.timeoutMs ?? 60 * 60 * 1000);
  const { rows } = await query(
    `INSERT INTO tasks
      (id, "userId", "projectId", type, status, progress, input, "timeoutAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'PENDING', 0, $5::jsonb, NOW() + ($6 * INTERVAL '1 millisecond'), NOW(), NOW())
     RETURNING *`,
    [
      taskId,
      input.userId,
      input.projectId ?? null,
      input.type,
      JSON.stringify(input.dedupeKey
        ? { ...(input.storedPayload ?? input.payload), __dedupeKey: input.dedupeKey }
        : (input.storedPayload ?? input.payload)),
      timeoutMs,
    ],
  );

  try {
    // leanBullMQ=true 时 BullMQ job 不带 input（精简，避免 base64 撑爆 Redis），processor 按
    // taskId 从 PG tasks.input 取；否则照旧把完整 payload 放 BullMQ（generate-image 等靠此）。
    await dispatchAiTask(taskId, input.userId, input.queueName, input.type, {
      ...(input.leanBullMQ ? {} : { input: input.payload }),
      projectId: input.projectId ?? undefined,
    });
    // CAS 守卫：仅当任务仍处 PENDING 才标 QUEUED。dispatchAiTask 已把 BullMQ job 暴露给
    // worker，worker 可能在本 UPDATE 之前就拾取并 markRunning（PENDING→RUNNING）。无 CAS 的
    // UPDATE 会把 RUNNING 砸回 QUEUED，造成「实际在跑、DB 却是 QUEUED」——task-heal-sweep
    // 5min 后按「卡死 QUEUED」每 60s 重派（每次发伪 QUEUED 事件），客户端进度流被污染、UI
    // 假死卡在最后看到的 progress（生产 19d0ca7c 等 25 任务/3 天的假死根因）。
    const queued = await query(
      `UPDATE tasks SET status = 'QUEUED', "updatedAt" = NOW() WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [taskId],
    );
    if (queued.rows.length > 0) {
      return { task: mapTask(queued.rows[0] as Record<string, unknown>), reused: false };
    }
    // 竞态：worker 已抢先 markRunning（PENDING→RUNNING），CAS 匹配 0 行。回读真实状态返回，
    // 不覆盖 worker 写入的 RUNNING（及其 progress）。
    const current = await query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    return { task: mapTask(current.rows[0] as Record<string, unknown>), reused: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 任务入队失败';
    await query(
      `UPDATE tasks SET status = 'FAILED', error = $1, "completedAt" = NOW(), "updatedAt" = NOW() WHERE id = $2`,
      [message, taskId],
    );
    throw error;
  }
}

/**
 * 取消 AI 任务（PENDING/QUEUED/RUNNING → CANCELLED 终态）。
 *
 * CAS 守卫：仅非终态可取消；已 COMPLETED/FAILED/CANCELLED 返回 null（调用方据此返 409）。
 * userId 进 WHERE 防越权取消他人任务（与 getAiTask 一致）。BullMQ job 的清理由调用方
 * （cancel route）经 removeQueuedAiJob best-effort 处理；processor 终态早退兜底已取消的
 * stall 重投。返回最新视图供 route 发 CANCELLED SSE 事件。
 */
export async function cancelAiTask(
  taskId: string,
  userId: string,
): Promise<AiTaskView | null> {
  const { rows } = await query(
    `UPDATE tasks
       SET status='CANCELLED', error='用户已取消',
           "completedAt"=NOW(), "updatedAt"=NOW()
     WHERE id=$1 AND "userId"=$2
       AND status IN ('PENDING','QUEUED','RUNNING')
     RETURNING *`,
    [taskId, userId],
  );
  return rows[0] ? mapTask(rows[0] as Record<string, unknown>) : null;
}

/**
 * 为必须在当前 HTTP 请求中消费一次性媒体流的工作创建任务记录。
 *
 * 这类工作不能先把视频塞进 BullMQ（会复制大文件或要求服务端落盘），因此由浏览器
 * 预生成 taskId，route 保持流式处理，同时复用 tasks + SSE 提供可恢复的真实进度。
 * storedInput 只能放脱敏元数据，禁止传视频字节、ReadableStream 或 API Key。
 * timeoutAt 留 30 分钟，覆盖大文件上传 + 两次最长 600s Kimi chat 的尾部余量。
 */
export async function startInlineAiTask(input: {
  id: string;
  userId: string;
  projectId: string;
  type: string;
  progress: number;
  stage: string;
  storedInput: Record<string, unknown>;
}): Promise<AiTaskView> {
  const progress = Math.max(0, Math.min(100, input.progress));
  const { rows } = await query(
    `INSERT INTO tasks
      (id, "userId", "projectId", type, status, progress, stage, "stageProgress",
       input, "startedAt", "timeoutAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6, 0, $7::jsonb,
             NOW(), NOW() + INTERVAL '30 minutes', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      input.id,
      input.userId,
      input.projectId,
      input.type,
      progress,
      input.stage,
      JSON.stringify({ ...input.storedInput, __inline: true }),
    ],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('任务 ID 已存在，请重新发起');

  await publishTaskEvent({
    taskId: input.id,
    userId: input.userId,
    status: 'RUNNING',
    type: 'status_change',
    progress,
    stage: input.stage,
    stageProgress: 0,
  });
  return mapTask(row);
}

/** 持久化 inline 任务的真实阶段，并通过现有 task:events SSE 通知浏览器。 */
export async function reportInlineAiTaskProgress(
  taskId: string,
  userId: string,
  progressValue: number,
  stage: string,
  stageProgressValue: number,
): Promise<void> {
  const progress = Math.max(0, Math.min(100, progressValue));
  const stageProgress = Math.max(0, Math.min(100, stageProgressValue));
  const { rows } = await query(
    `UPDATE tasks
        SET progress=$1, stage=$2, "stageProgress"=$3, "updatedAt"=NOW()
      WHERE id=$4 AND "userId"=$5 AND status='RUNNING'
      RETURNING id`,
    [progress, stage, stageProgress, taskId, userId],
  );
  if (!rows[0]) return;
  await publishTaskEvent({
    taskId,
    userId,
    status: 'RUNNING',
    type: 'progress',
    progress,
    stage,
    stageProgress,
  });
}

/** 在业务落库成功后把 inline 任务置为完成；output 只存摘要，不复制完整剧本。 */
export async function completeInlineAiTask(
  taskId: string,
  userId: string,
  output: Record<string, unknown>,
): Promise<void> {
  const { rows } = await query(
    `UPDATE tasks
        SET status='COMPLETED', progress=100, stage='已完成', "stageProgress"=100,
            output=$1::jsonb, "completedAt"=NOW(), "updatedAt"=NOW()
      WHERE id=$2 AND "userId"=$3 AND status='RUNNING'
      RETURNING id`,
    [JSON.stringify(output), taskId, userId],
  );
  if (!rows[0]) return;
  await publishTaskEvent({
    taskId,
    userId,
    status: 'COMPLETED',
    type: 'status_change',
    progress: 100,
    stage: '已完成',
    stageProgress: 100,
    result: output,
  });
}

/** 失败时只记录可展示的安全文案，避免把上游响应或凭证带入 SSE。 */
export async function failInlineAiTask(
  taskId: string,
  userId: string,
  safeError: string,
): Promise<void> {
  const { rows } = await query(
    `UPDATE tasks
        SET status='FAILED', error=$1, "completedAt"=NOW(), "updatedAt"=NOW()
      WHERE id=$2 AND "userId"=$3 AND status='RUNNING'
      RETURNING id`,
    [safeError, taskId, userId],
  );
  if (!rows[0]) return;
  await publishTaskEvent({
    taskId,
    userId,
    status: 'FAILED',
    type: 'status_change',
    error: safeError,
  });
}

/** 列出该用户+项目下某 type 的活跃(RUNNING)inline task，供路由去重(防双击双扣)。
 *  返回 input 字段供路由按 episodeId 精确匹配。 */
export async function listActiveInlineTasks(
  userId: string,
  projectId: string,
  type: string,
): Promise<AiTaskView[]> {
  const { rows } = await query(
    `SELECT * FROM tasks
      WHERE "userId"=$1 AND "projectId"=$2 AND type=$3 AND status='RUNNING'
      ORDER BY "createdAt" DESC`,
    [userId, projectId, type],
  );
  return rows.map((r) => mapTask(r as Record<string, unknown>));
}
