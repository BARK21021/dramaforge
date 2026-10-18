// ============================================================
// POST /api/render/jobs/[id]/progress — 客户端上报作业进度
// ============================================================
//
// ⑨ client/render-worker 在执行 ffmpeg 过程中定期上报进度。web 校验
// claimed_by 后发布 RUNNING 事件到 Redis task:events，/api/sse 透传给前端。
//
// 鉴权：session、作业所有者与 machineId 必须全部匹配。
//
// 请求体：{ progress: number, stage: string }（RenderJobProgress 契约）
// 响应：200 { ok: true } / 400 / 403 / 404
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import type { RenderJobProgress } from '@dramaforge/shared';
import { renderJobRepo } from '@dramaforge/server';
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

  let body: RenderJobProgress;
  try {
    const parsed = (await req.json()) as Partial<RenderJobProgress>;
    if (
      typeof parsed.progress !== 'number' ||
      typeof parsed.stage !== 'string'
    ) {
      return apiError('body 需含 { progress: number, stage: string }', 400);
    }
    // 渐进回传(dramaforge 独建):可选 groupClip = 某镜头组视频已在客户端本地落盘。
    // 严格校验 shotIds/videoUrl 形状,防脏数据/伪造进 SSE;不合规一律丢弃(不影响进度上报本身)。
    const rawClip = parsed.groupClip as
      | { shotIds?: unknown; videoUrl?: unknown }
      | undefined;
    let groupClip: RenderJobProgress['groupClip'];
    if (rawClip && typeof rawClip === 'object') {
      if (
        Array.isArray(rawClip.shotIds) &&
        rawClip.shotIds.length > 0 &&
        rawClip.shotIds.every((id) => typeof id === 'string' && id.length > 0) &&
        typeof rawClip.videoUrl === 'string' &&
        rawClip.videoUrl.length > 0
      ) {
        groupClip = {
          shotIds: rawClip.shotIds as string[],
          videoUrl: rawClip.videoUrl,
        };
      }
    }
    body = {
      progress: parsed.progress,
      stage: parsed.stage,
      ...(groupClip ? { groupClip } : {}),
    };
  } catch {
    return apiError('无效 JSON', 400);
  }

  // 推进状态到 RUNNING（首次进度上报时 CLAIMED → RUNNING）
  const runningJob = await renderJobRepo.markRunning(
    id,
    auth.userId,
    machineId!,
    claimToken!,
    body.progress,
    body.stage,
  );
  if (!runningJob) return apiError('作业租约已失效或状态冲突', 409);

  // 渐进组片段落 render_jobs.progress_clips，供刷新 / 4s 轮询恢复端点读 progressClips
  // 把已完成组翻成视频——不依赖 task_events（其 taskId 外键到 tasks，render_job 不入
  // tasks，groupClip 永不落库正是刷新丢渐进片的根因）。best-effort：失败不阻断进度上报与 SSE。
  if (body.groupClip) {
    try {
      await renderJobRepo.appendGroupClip(id, auth.userId, body.groupClip);
    } catch (err) {
      console.warn(
        '[progress] appendGroupClip failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 发布 RUNNING 事件给前端 SSE（携带 progress/stage，兼容 ⑥ TaskEventPayload 形状）。
  // groupClip 随本次事件透传(persistEvent 存 JSONB,SSE 重连重放也带);服务端零字节,只过 URL 字符串。
  await publishTaskEvent({
    taskId: runningJob.taskId,
    userId: runningJob.userId,
    status: 'RUNNING',
    progress: body.progress,
    stage: body.stage,
    ...(body.groupClip ? { groupClip: body.groupClip } : {}),
  });

  return apiOk({ ok: true });
}
