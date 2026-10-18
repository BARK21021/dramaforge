// ============================================================
// POST /api/render/jobs/[id]/result — 客户端上报作业完成结果
// ============================================================
//
// ⑨ client/render-worker ffmpeg 执行成功后上报结果。web 校验 claimed_by
// 后调用 renderJobRepo.markResult 写入 result + COMPLETED，并发布 COMPLETED
// 事件到 Redis task:events 给前端 SSE。
//
// 鉴权：session、作业所有者与 machineId 必须全部匹配。
//
// 请求体：RenderJobResult { outputUrl?, outputs?, durationSec?, meta? }
// 响应：200 { ok: true } / 400 / 403 / 404
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import type { RenderJobResult } from '@dramaforge/shared';
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

  let body: RenderJobResult;
  try {
    const parsed = (await req.json()) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return apiError('result 必须是 JSON 对象', 400);
    }

    const candidate = parsed as Record<string, unknown>;
    if (
      (candidate.outputUrl !== undefined && typeof candidate.outputUrl !== 'string') ||
      (candidate.outputs !== undefined &&
        (!Array.isArray(candidate.outputs) ||
          !candidate.outputs.every((value) => typeof value === 'string'))) ||
      (candidate.durationSec !== undefined &&
        (typeof candidate.durationSec !== 'number' || !Number.isFinite(candidate.durationSec))) ||
      (candidate.meta !== undefined &&
        (candidate.meta === null ||
          typeof candidate.meta !== 'object' ||
          Array.isArray(candidate.meta)))
    ) {
      return apiError('result 字段类型不合法', 400);
    }

    // Persist only the public RenderJobResult contract; ignore unknown fields.
    body = {};
    if (candidate.outputUrl !== undefined) body.outputUrl = candidate.outputUrl as string;
    if (candidate.outputs !== undefined) body.outputs = candidate.outputs as string[];
    if (candidate.durationSec !== undefined) body.durationSec = candidate.durationSec as number;
    if (candidate.meta !== undefined) {
      body.meta = candidate.meta as Record<string, unknown>;
    }
  } catch {
    return apiError('无效 JSON', 400);
  }

  const transition = await renderJobRepo.markResult(
    id,
    auth.userId,
    machineId!,
    claimToken!,
    body,
  );
  if (transition.outcome === 'rejected') {
    return apiError('作业租约已失效或终态冲突', 409);
  }

  if (transition.outcome === 'failed_validation') {
    // 组片完整性校验失败已在仓储内把任务置 FAILED + G3-1 镜头级联（同事务）。
    // 这里补退款（用户未拿到成片，对齐 failed route 的 applied 分支）+ 发 FAILED
    // 事件让前端实时停转。返回 200 让客户端 render-worker 视为上报已受理，通过
    // 任务终态 FAILED 停止重试（不再 500 死循环）。
    // 退款用 job.taskId（=chargeAggregatedTaskCost 写入 billing_ledger.taskId 的
    // billingTaskId = render_jobs.task_id），非 render_jobs 主键 id。用主键 id 查
    // billing_ledger 永远查不到 TASK_DEBIT → 退款永不触发（资损，曾用错 transition.job.id）。
    await refundTaskDebit(transition.job.userId, transition.job.taskId);
    await publishTaskEvent({
      taskId: transition.job.taskId,
      userId: transition.job.userId,
      status: 'FAILED',
      error: transition.job.error ?? 'CHAIN_COMPILE 组片校验失败',
    });
    return apiOk({ ok: true, failed: true });
  }

  if (transition.outcome === 'partial_completed') {
    // 部分完成（≥1 组成功 + 其余失败）：仓储已把 job 判 COMPLETED，result.meta 带
    // partialCompleted=true + failedGroups，outputUrl 为空（部分片不算整集成片）。
    // 发 COMPLETED 事件（带 partial meta）让前端展示"部分完成 + 请重试失败组"；不退款
    // （计费按 ai-task：失败 task 未扣/已退，成功 task 已扣=合理）。无 followUpJob——
    // partial 路径未触发 maybeCreateEpisodeConcat（失败镜头存在不会 concat，待 retry 后再触发）。
    await publishTaskEvent({
      taskId: transition.job.taskId,
      userId: transition.job.userId,
      status: 'COMPLETED',
      result: transition.job.result ?? body,
    });
    return apiOk({ ok: true });
  }

  if (transition.outcome === 'applied') {
    // 仅首次 CAS 成功发布；相同结果的客户端重试不会重复发 SSE。
    await publishTaskEvent({
      taskId: transition.job.taskId,
      userId: transition.job.userId,
      status: 'COMPLETED',
      result: body,
    });
    if (transition.followUpJob) {
      // 最后一个镜头组完成时，仓储已在同一事务内创建整集 CONCAT；提交后再发
      // QUEUED，避免 SSE 先到而客户端尚且认领不到对应作业。
      await publishTaskEvent({
        taskId: transition.followUpJob.taskId,
        userId: transition.followUpJob.userId,
        status: 'QUEUED',
        type: 'status_change',
      });
    }
  }

  return apiOk({ ok: true });
}
