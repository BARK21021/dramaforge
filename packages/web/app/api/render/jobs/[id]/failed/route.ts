// ============================================================
// POST /api/render/jobs/[id]/failed — 客户端上报作业失败
// ============================================================
//
// ⑨ client/render-worker ffmpeg 执行失败后上报。web 校验 claimed_by 后
// 调用 renderJobRepo.markFailed 写入 error + FAILED，并发布 FAILED 事件
// 到 Redis task:events 给前端 SSE。
//
// 鉴权：session、作业所有者与 machineId 必须全部匹配。
//
// 请求体：{ error: string }
// 响应：200 { ok: true } / 400 / 403 / 404
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import { refundTaskDebit, renderJobRepo } from '@dramaforge/server';
import { requireUser } from '@web/lib/auth';
import { apiError, apiOk, unauthorized } from '@web/lib/response';
import { verifyClaim } from '@web/lib/render-job-guard';
import { publishTaskEvent } from '@web/lib/publish';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth) return unauthorized();

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const machineId =
    req.headers.get('x-machine-id')?.trim() ||
    url.searchParams.get('machineId')?.trim() ||
    null;
  const claimToken = req.headers.get('x-claim-token')?.trim() || null;

  const guard = await verifyClaim(id, auth.userId, machineId, claimToken);
  if (!guard.ok) return guard.response;

  let errorMsg: string;
  try {
    const parsed = (await req.json()) as { error?: unknown };
    if (typeof parsed.error !== 'string' || parsed.error.length === 0) {
      return apiError('body 需含 { error: string }', 400);
    }
    errorMsg = parsed.error;
  } catch {
    return apiError('无效 JSON', 400);
  }

  const transition = await renderJobRepo.markFailed(
    id,
    auth.userId,
    machineId!,
    claimToken!,
    errorMsg,
  );
  if (transition.outcome === 'rejected') {
    return apiError('作业租约已失效或终态冲突', 409);
  }

  // applied 与幂等重试都执行补偿检查：若首次退款时数据库抖动，客户端重试仍可补回。
  // 退款用 job.taskId（对齐 chargeAggregatedTaskCost 的 billingTaskId = render_jobs.task_id），
  // 非 render_jobs 主键 id（用主键查 billing_ledger 查不到 → 退款永不触发，资损）。
  await refundTaskDebit(transition.job.userId, transition.job.taskId);

  if (transition.outcome === 'applied') {
    // 仅首次 CAS 成功发布；相同错误的客户端重试不会重复发 SSE。
    await publishTaskEvent({
      taskId: transition.job.taskId,
      userId: transition.job.userId,
      status: 'FAILED',
      error: errorMsg,
    });
  }

  return apiOk({ ok: true });
}
