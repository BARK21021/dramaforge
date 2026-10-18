// ============================================================
// POST /api/admin/render-jobs/[id]/force-fail — 管理员强制失败一个 render_job
// ============================================================
//
// 运维止血用：CHAIN_COMPILE 假死（客户端心跳定时器仍续租但 executeJob 卡死，
// reapStale 的 2min 心跳条件永不触发、20min 硬 cap 还没到）时，admin 提前手动失败。
//
// 与客户端 POST /api/render/jobs/[id]/failed 的差异：
//   - 无需 lease token（运维没有客户端的 claim_token），从 PENDING/CLAIMED/RUNNING
//     任一非终态都可推进；
//   - 同样触发 G3-1 镜头级联（shots→FAILED）+ 退款 + SSE FAILED 事件，前端实时停转。
//
// 存在意义：替代裸 `UPDATE render_jobs SET status='FAILED'`（绕过级联 → 镜头永久卡
// GENERATING、前端转圈）。级联兜底 sweep 也会在 60s 内修正，但本路由立即生效 + 发 SSE。
//
// 鉴权：requireAdmin（ADMIN 角色 session）。
// 请求体：{ reason?: string }（可选，默认"管理员强制失败"）
// 响应：200 { success:true, data: { outcome, job, shotIds? } } / 401 / 403
// ============================================================

import type { NextRequest } from 'next/server';
import { refundTaskDebit, renderJobRepo } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';
import { publishTaskEvent } from '@web/lib/publish';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { id } = await ctx.params;

    let reason = '管理员强制失败（运维止血）';
    try {
      const body = (await req.json()) as { reason?: unknown };
      if (typeof body?.reason === 'string' && body.reason.trim()) {
        reason = body.reason.trim();
      }
    } catch {
      /* 无 body 或非 JSON，用默认 reason */
    }

    const r = await renderJobRepo.forceFail(id, reason);
    if (r.outcome === 'applied') {
      // 对齐 /failed 路由：退款（假死 job 未完成，不应扣费）+ 发 SSE FAILED 让前端实时停转。
      // 退款用 r.job.taskId（=chargeAggregatedTaskCost 的 billingTaskId = render_jobs.task_id），
      // 非主键 id（用主键查 billing_ledger 查不到 → 退款永不触发，资损）。
      await refundTaskDebit(r.job.userId, r.job.taskId);
      await publishTaskEvent({
        taskId: r.job.taskId,
        userId: r.job.userId,
        status: 'FAILED',
        error: reason,
      });
    }

    return apiSuccess(r);
  } catch (err) {
    return handleApiError(err, 'POST /api/admin/render-jobs/[id]/force-fail');
  }
}
