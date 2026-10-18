// ============================================================
// GET/DELETE /api/render/jobs/[id] — 查询或取消当前用户 render_job
// ============================================================
//
// 前端把本接口作为 SSE 的可靠性兜底：Redis pub/sub 事件丢失时，仍可从
// render_jobs 的持久状态得知作业已完成或失败。
//
// 安全边界：必须登录且只能读取自己的作业。不存在和非所有者统一返回 404，
// 避免泄漏作业是否存在。响应刻意不包含 input、claimToken、claimedBy 等执行信息。
// ============================================================

import { renderJobRepo } from '@dramaforge/server';
import { requireUser } from '@web/lib/auth';
import { apiError, apiOk, unauthorized } from '@web/lib/response';
import { publishTaskEvent } from '@web/lib/publish';

/**
 * 路径参数兼容 renderJobId 与 taskId。前者供编译/生产轮询，后者供 SSE 和
 * GenerationProgress；两种标识最终都解析成当前用户自己的作业。
 */
async function resolveOwnedJob(identifier: string, userId: string) {
  const byId = await renderJobRepo.getById(identifier);
  if (byId?.userId === userId) return byId;
  return renderJobRepo.getByTaskId(identifier, userId);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const job = await resolveOwnedJob(id, auth.userId);
  if (!job) {
    return apiError('作业不存在', 404);
  }

  const response = apiOk({
    job: {
      id: job.id,
      taskId: job.taskId,
      status: job.status,
      type: job.type,
      createdAt: job.createdAt,
      result: job.result,
      error: job.error,
    },
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

/**
 * DELETE /api/render/jobs/[id] — 取消 PENDING/CLAIMED/RUNNING 作业。
 * CAS 未命中说明作业已并发进入终态，返回 409 而不是伪装取消成功。
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const existing = await resolveOwnedJob(id, auth.userId);
  if (!existing) return apiError('作业不存在', 404);

  const cancelled = await renderJobRepo.cancel(existing.id, auth.userId);
  if (!cancelled) return apiError('作业已进入终态，无法取消', 409);

  await publishTaskEvent({
    taskId: cancelled.taskId,
    userId: cancelled.userId,
    status: 'CANCELLED',
    type: 'status_change',
  });
  return apiOk({ ok: true, job: { id: cancelled.id, status: cancelled.status } });
}
