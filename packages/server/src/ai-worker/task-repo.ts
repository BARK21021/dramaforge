// ============================================================
// ⑥ server/ai-worker/task-repo — PG tasks 表状态回写 + 用户并发上限查询
// ============================================================
//
// 文件职责：
//   1. markRunning(taskId, workerId)   — 状态 PENDING/QUEUED → RUNNING，记录 workerId/startedAt
//   2. markCompleted(taskId, result)   — 状态 → COMPLETED，写入 output/modelProvider/modelName/completedAt
//   3. markFailed(taskId, error)       — 状态 → FAILED，写入 error/completedAt
//   4. getConcurrencyLimit(userId)     — 查询 users."maxConcurrent"（默认 3）
//   5. updateShotMaterial(shotId, url, videoStatus) — 更新 shots."currentMaterialUrl"/"videoStatus"
//      （③ storyboard.updateShot 不支持 currentMaterialUrl 字段，故在此直接 SQL）
//
// 所有 SQL 走 @server/infra 的 query，无直接 pg import。
// 服务器禁止 import ffmpeg；本模块仅做 PG 读写，零 ffmpeg 依赖。
// ============================================================

import { query } from '@server/infra';
import type { HandlerResult } from './types';

/**
 * 标记任务为 RUNNING。
 *
 * 写入 workerId / startedAt / status='RUNNING'。
 * 幂等：多次调用只更新 startedAt（不重置状态机）。
 */
export async function markRunning(taskId: string, workerId: string): Promise<void> {
  // CAS 终态守卫：仅当任务尚处非终态时才置 RUNNING，防止 stalled 重投把
  // COMPLETED/FAILED 翻回 RUNNING（导致重复处理 + 重复扣费）。
  await query(
    `UPDATE tasks
       SET status='RUNNING', "workerId"=$1, "startedAt"=NOW(), "updatedAt"=NOW()
     WHERE id=$2 AND status IN ('PENDING','QUEUED','RUNNING')`,
    [workerId, taskId],
  );
}

/** 写入任务阶段进度，供前端 SSE 与 /api/tasks 轮询使用。 */
export async function updateTaskProgress(
  taskId: string,
  progress: number,
  stage: string,
  stageProgress: number = 0,
): Promise<void> {
  await query(
    `UPDATE tasks
       SET progress=$1, stage=$2, "stageProgress"=$3, "updatedAt"=NOW()
     WHERE id=$4`,
    [Math.max(0, Math.min(100, progress)), stage, Math.max(0, Math.min(100, stageProgress)), taskId],
  );
}

/**
 * 按 taskId + userId 取任务 input（BullMQ job 只带精简载荷后，processor 据此读完整 input）。
 * userId 过滤防越权读他人 task input。返回 null 表示任务不存在或不属于该用户。
 */
export async function getTaskInput(
  taskId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await query(
    'SELECT input FROM tasks WHERE id = $1 AND "userId" = $2',
    [taskId, userId],
  );
  const row = rows[0] as { input: unknown } | undefined;
  if (!row || row.input === null || typeof row.input !== 'object') return null;
  return row.input as Record<string, unknown>;
}

/**
 * 标记任务为 COMPLETED 并写入结果。
 *
 * 写入 output(JSONB) / modelProvider / modelName / completedAt / status='COMPLETED'。
 * 同时清空 pendingCharge（扣费已完成）。
 */
export async function markCompleted(
  taskId: string,
  result: HandlerResult,
): Promise<boolean> {
  // CAS 终态守卫 + RETURNING：仅当任务未到终态时才置 COMPLETED。
  // 返回是否真正更新——调用方（processor）据此决定是否扣费/发事件，
  // 杜绝 stalled 重投导致的重复完成 + 重复扣费。
  const { rows } = await query(
    `UPDATE tasks
       SET status='COMPLETED',
           progress=100,
           stage='已完成',
           "stageProgress"=100,
           output=$1::jsonb,
           "modelProvider"=$2,
           "modelName"=$3,
           "completedAt"=NOW(),
           "pendingCharge"=NULL,
           "updatedAt"=NOW()
     WHERE id=$4 AND status NOT IN ('COMPLETED','FAILED','CANCELLED')
     RETURNING id`,
    [
      JSON.stringify(result.output ?? null),
      result.modelProvider ?? null,
      result.modelName ?? null,
      taskId,
    ],
  );
  return rows.length > 0;
}

/**
 * 写入 pendingCharge（扣费失败时记录欠费，待补扣）。
 *
 * JSONB 结构：{ credits, reason, createdAt }。markCompleted 完成扣费时清空（=NULL）。
 * 补扣 sweep 查 `pendingCharge IS NOT NULL` 的任务重试扣费。
 *
 * P0-B：旧实现扣费失败只 console.warn，任务成功交付但没扣钱 = 漏收。现写入 pendingCharge 留痕待补。
 */
export async function setPendingCharge(
  taskId: string,
  credits: number,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE tasks
        SET "pendingCharge"=jsonb_build_object(
              'credits', $1::numeric,
              'reason', $2,
              'createdAt', NOW()
            ),
            "updatedAt"=NOW()
      WHERE id=$3`,
    [credits, reason, taskId],
  );
}

/**
 * 标记任务为 FAILED 并写入错误信息。
 *
 * 写入 error / completedAt / status='FAILED'。
 *
 * 返回是否真正更新——调用方（processor catch / worker-bootstrap handleJobFinallyFailed）
 * 据此决定是否发 FAILED 事件。CANCELLED 终态同样受保护：取消后迟到的 handler 错误不再
 * 覆盖 CANCELLED、也不误发假 FAILED 事件（取消的终态事件已由 cancel route 发出）。
 */
export async function markFailed(taskId: string, error: string): Promise<boolean> {
  // CAS 终态守卫：已 COMPLETED/CANCELLED 的任务不再覆盖为 FAILED（成功/取消优先）。
  const { rows } = await query(
    `UPDATE tasks
       SET status='FAILED', error=$1, "completedAt"=NOW(), "updatedAt"=NOW()
     WHERE id=$2 AND status NOT IN ('COMPLETED','CANCELLED')
     RETURNING id`,
    [error, taskId],
  );
  return rows.length > 0;
}

/**
 * 查询用户的并发任务上限。
 *
 * 读 users."maxConcurrent"（schema 默认 3）。
 * 用户不存在或查询异常时回退 3（不阻断任务执行）。
 */
export async function getConcurrencyLimit(userId: string): Promise<number> {
  try {
    const result = await query(
      'SELECT "maxConcurrent" FROM users WHERE id = $1',
      [userId],
    );
    const row = result.rows[0] as { maxConcurrent?: number } | undefined;
    const limit = row?.maxConcurrent;
    if (typeof limit === 'number' && limit > 0 && Number.isFinite(limit)) {
      return Math.floor(limit);
    }
    return 3;
  } catch {
    return 3;
  }
}

/**
 * 查询任务当前状态（只读）。
 *
 * processor 终态早退判断用——stalled 重投时若任务已 COMPLETED/FAILED 直接跳过，
 * 避免重复 handleTask + 重复扣费。
 */
export async function getTaskStatus(taskId: string): Promise<string | null> {
  const result = await query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  const row = result.rows[0] as { status?: string } | undefined;
  return row?.status ?? null;
}

/**
 * 更新分镜的当前素材 URL 和视频状态。
 *
 * 用于 VIDEO_GENERATE 任务完成后回写 shots."currentMaterialUrl" + "videoStatus"。
 * ③ storyboard.updateShot 的 ShotUpdatePatch 不含 currentMaterialUrl 字段，
 * 故在此直接 SQL（不改 ③ 文件）。
 *
 * @param shotId - 分镜 ID
 * @param materialUrl - 视频素材 URL（持久化后的 MinIO URL）
 * @param videoStatus - 视频状态（COMPLETED / FAILED）
 */
export async function updateShotMaterial(
  shotId: string,
  materialUrl: string,
  videoStatus: 'COMPLETED' | 'FAILED',
): Promise<void> {
  const now = new Date().toISOString();
  // 先读旧状态：把即将被覆盖的 currentMaterialUrl 记进 metadata.videoGenerations 历史，
  // 防覆盖丢失（生产痛点：单镜重生直接覆盖，老视频 URL 丢光、事后没法对比查问题）。
  const { rows } = await query(
    'SELECT "currentMaterialUrl", metadata FROM shots WHERE id = $1',
    [shotId],
  );
  const row = rows[0] as
    | { currentMaterialUrl?: string | null; metadata?: Record<string, unknown> | null }
    | undefined;
  const oldUrl = row?.currentMaterialUrl ?? null;
  const oldMeta = row?.metadata ?? {};
  const oldGenAt =
    typeof oldMeta.materialUpdatedAt === 'string' ? oldMeta.materialUpdatedAt : now;
  const prevGens = Array.isArray(oldMeta.videoGenerations) ? oldMeta.videoGenerations : [];
  // 构建代次列表：去重 by url，新的在最前（时间倒序），旧被覆盖的次之，再接历史。
  const seen = new Set<string>();
  const gens: Array<{ url: string; generatedAt: string }> = [];
  const addGen = (url: string | null | undefined, generatedAt: string): void => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    gens.push({ url, generatedAt });
  };
  if (videoStatus === 'COMPLETED') addGen(materialUrl, now); // 本次（最新）在最前
  addGen(oldUrl, oldGenAt); // 被覆盖的旧视频
  for (const g of prevGens) {
    if (g && typeof g === 'object' && typeof (g as { url?: unknown }).url === 'string') {
      const gv = g as { url: string; generatedAt?: string };
      addGen(gv.url, typeof gv.generatedAt === 'string' ? gv.generatedAt : oldGenAt);
    }
  }
  await query(
    `UPDATE shots
       SET "currentMaterialUrl"=$1, "videoStatus"=$2,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('materialUpdatedAt', $4::text, 'newSeenCount', 0,
                                   'videoGenerations', $5::jsonb),
           "updatedAt"=NOW()
     WHERE id=$3`,
    [materialUrl, videoStatus, shotId, now, JSON.stringify(gens)],
  );
}

/**
 * 标记一组分镜的视频状态（批量回滚用）。
 *
 * 用于 VIDEO_GENERATE 失败时把相关 shot 的 videoStatus 置 FAILED。
 */
export async function markShotsVideoStatus(
  shotIds: string[],
  videoStatus: 'COMPLETED' | 'FAILED' | 'GENERATING' | 'PENDING',
): Promise<void> {
  if (shotIds.length === 0) return;
  // 逐条更新（避免动态 IN 列表参数化复杂度；shotIds 通常 ≤ 10）
  for (const id of shotIds) {
    await query(
      `UPDATE shots SET "videoStatus"=$1, "updatedAt"=NOW() WHERE id=$2`,
      [videoStatus, id],
    );
  }
}
