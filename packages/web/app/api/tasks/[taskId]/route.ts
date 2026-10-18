// GET /api/tasks/[taskId] — AI 任务状态恢复端点（用户只可读自己的任务）

import type { NextRequest } from 'next/server';
import { getAiTask, cancelAiTask, removeQueuedAiJob, renderJobRepo } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';
import { publishTaskEvent } from '@web/lib/publish';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { taskId } = await params;
    const task = await getAiTask(taskId, auth.userId);
    if (task) {
      // 防流量爆炸（2026-08-02 某客户 案例）：VIDEO_GENERATE 的 input 内含
      // referenceImageBase64 / data:image base64 参考图（单任务 3-6MB），全量返回
      // 后客户端每 5s 轮询一次就拉走数 MB，单客户端两天烧掉 64GB 出站流量。
      // 前端 useTaskStatus 只消费 status/progress/stage/output/error 等字段；
      // input 仅 ai-worker 消费（processor 直接读 PG tasks.input，不走本接口），
      // 因此对外一律裁剪，避免轮询风暴放大成流量账单。
      const { input: _input, ...publicTask } = task;
      void _input;
      return apiSuccess(publicTask);
    }

    // C/S 的本地渲染任务以 render_jobs 为唯一状态源，不复制 tasks 行。
    // 全局任务跟踪仍按 taskId 请求本端点，因此 AI task 未命中时必须回退查询
    // render_jobs；否则真实生成仍在运行/已完成，界面却会收到 404 并显示假失败。
    const byTaskId = await renderJobRepo.getByTaskId(taskId, auth.userId);
    const byId = byTaskId ? null : await renderJobRepo.getById(taskId);
    const renderJob = byTaskId ?? (byId?.userId === auth.userId ? byId : null);
    if (!renderJob) return apiFail({ error: '任务不存在', code: 'NOT_FOUND' }, 404);

    const input = renderJob.input && typeof renderJob.input === 'object'
      ? renderJob.input as unknown as Record<string, unknown>
      : {};
    const filmMeta = input.filmMeta && typeof input.filmMeta === 'object'
      ? input.filmMeta as Record<string, unknown>
      : {};
    // 将数据库终态如实返回，避免失败任务长期伪装成“客户端处理中 0%”。
    const stageByStatus: Record<string, string> = {
      PENDING: '等待客户端',
      CLAIMED: '客户端已领取',
      RUNNING: '客户端处理中',
      COMPLETED: '已完成',
      FAILED: '生成失败',
      CANCELLED: '已取消',
    };
    // chain 作业：渐进回传组片段随 /progress 落 render_jobs.progress_clips（不再依赖
    // task_events——其 "taskId" 外键到 tasks，render_job 不入 tasks，groupClip 永不落库）。
    // 让前端在 SSE 断线 / 页面刷新时，仍能靠 4s 轮询把已完成组翻成视频（抗 SSE 断 + 抗刷新）。
    const progressClips =
      renderJob.type === 'CHAIN_COMPILE' && Array.isArray(renderJob.progressClips)
        ? renderJob.progressClips
        : undefined;
    return apiSuccess({
      id: renderJob.taskId,
      renderJobId: renderJob.id,
      backend: 'render',
      type: renderJob.type,
      status: renderJob.status,
      // chain 总组数（input.groupResults 即组计划，长度=总组数）；刷新恢复时显示"已完成 X/N 组"。
      groupCount:
        renderJob.type === 'CHAIN_COMPILE' && Array.isArray(input.groupResults)
          ? input.groupResults.length
          : undefined,
      // 读行内持久化的真值（/progress 路由每次上报落库），不再写死 0——根治刷新/轮询 0% 假死。
      progress: renderJob.status === 'COMPLETED' ? 100 : renderJob.progress,
      stage: renderJob.stage ?? stageByStatus[renderJob.status] ?? '处理中',
      projectId: typeof filmMeta.projectId === 'string' ? filmMeta.projectId : null,
      output: renderJob.result,
      result: renderJob.result,
      error: renderJob.error,
      ...(progressClips && progressClips.length > 0 ? { progressClips } : {}),
      createdAt: renderJob.createdAt,
      updatedAt: renderJob.completedAt ?? renderJob.heartbeatAt ?? renderJob.createdAt,
    });
  } catch (error) {
    return handleApiError(error, 'GET /api/tasks/[taskId]');
  }
}

/**
 * DELETE /api/tasks/[taskId] — 取消 AI 任务（PENDING/QUEUED/RUNNING → CANCELLED）。
 *
 * 归属校验经 getAiTask(userId 过滤)：不存在/非本人均 404 不泄漏存在性。
 * cancelAiTask CAS 未命中（已终态）→ 409。removeQueuedAiJob best-effort 删 BullMQ job
 * （失败不阻断，processor 终态早退兜底）。render_jobs 类取消走 DELETE /api/render/jobs/[id]。
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { taskId } = await params;

    const task = await getAiTask(taskId, auth.userId);
    if (!task) return apiFail({ error: '任务不存在', code: 'NOT_FOUND' }, 404);

    const cancelled = await cancelAiTask(taskId, auth.userId);
    if (!cancelled) return apiFail({ error: '任务已进入终态，无法取消', code: 'CONFLICT' }, 409);

    // QUEUED/PENDING：best-effort 删 BullMQ job 防 worker 拾取；RUNNING active job 删不掉
    // 由 processor 终态早退（CANCELLED 不跑 handler）+ CAS 兜底。
    await removeQueuedAiJob(taskId, task.type).catch(() => undefined);

    await publishTaskEvent({
      taskId,
      userId: auth.userId,
      status: 'CANCELLED',
      type: 'status_change',
    });
    return apiSuccess({ cancelled: true });
  } catch (error) {
    return handleApiError(error, 'DELETE /api/tasks/[taskId]');
  }
}
