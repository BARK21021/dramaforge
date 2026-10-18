// ============================================================
// POST /api/render/jobs/[id]/retry — 重试失败或已取消的客户端作业
// ============================================================

import { renderJobRepo } from '@dramaforge/server';
import { requireUser } from '@web/lib/auth';
import { publishTaskEvent } from '@web/lib/publish';
import { apiError, apiOk, unauthorized } from '@web/lib/response';

/** 路径同时接受 renderJobId/taskId，且查询始终带当前 userId。 */
async function resolveOwnedJob(identifier: string, userId: string) {
  const byId = await renderJobRepo.getById(identifier);
  if (byId?.userId === userId) return byId;
  return renderJobRepo.getByTaskId(identifier, userId);
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const existing = await resolveOwnedJob(id, auth.userId);
  if (!existing) return apiError('作业不存在', 404);

  // 2026-08-03 历史版本修复：重试 = 复制新 job（新 jobId），旧记录与本地文件保留，
  // 不再原地重置覆盖（原地重置会让客户端用同 jobId 重跑，覆盖旧版本文件）。
  // 旧 job 保持 FAILED/CANCELLED 终态；新 job 入队由客户端认领。
  const retried = await renderJobRepo.createRetryCopy(existing.id, auth.userId);
  if (!retried) return apiError('仅失败或已取消的作业可以重试', 409);

  await publishTaskEvent({
    taskId: retried.taskId,
    userId: retried.userId,
    status: 'QUEUED',
    type: 'status_change',
  });
  return apiOk({ ok: true, job: { id: retried.id, status: retried.status } });
}
