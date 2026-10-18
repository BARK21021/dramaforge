// ============================================================
// GET /api/render/jobs — 当前用户客户端作业列表
// ============================================================
// 供全局任务条和分集任务条恢复状态。服务器只返回展示所需字段，不暴露
// input、claimToken、claimedBy 等客户端执行细节。

import { renderJobRepo } from '@dramaforge/server';
import type { RenderJobStatus, RenderJobType } from '@dramaforge/shared';
import { requireUser } from '@web/lib/auth';
import { apiError, apiOk, unauthorized } from '@web/lib/response';

const VALID_STATUSES = new Set<RenderJobStatus>([
  'PENDING',
  'CLAIMED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
const VALID_TYPES = new Set<RenderJobType>([
  'CONCAT',
  'EXTRACT_FRAME',
  'SPLIT_BY_DURATION',
  'SPLIT_EVENLY',
  'CHAIN_COMPILE',
  'LONG_VIDEO_REWRITE',
]);

/** 从两种历史 input 形状提取项目 ID，仅用于列表展示。 */
function readProjectId(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (typeof record.projectId === 'string') return record.projectId;
  const filmMeta = record.filmMeta;
  if (filmMeta && typeof filmMeta === 'object') {
    const projectId = (filmMeta as Record<string, unknown>).projectId;
    if (typeof projectId === 'string') return projectId;
  }
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireUser();
  if (!auth) return unauthorized();

  const search = new URL(req.url).searchParams;
  const statusRaw = search.get('status');
  const typeRaw = search.get('type');
  const projectId = search.get('projectId')?.trim() || undefined;

  if (statusRaw && !VALID_STATUSES.has(statusRaw as RenderJobStatus)) {
    return apiError('非法作业状态', 400);
  }
  if (typeRaw && !VALID_TYPES.has(typeRaw as RenderJobType)) {
    return apiError('非法作业类型', 400);
  }

  const jobs = await renderJobRepo.listByUser(auth.userId, {
    status: statusRaw as RenderJobStatus | undefined,
    type: typeRaw as RenderJobType | undefined,
    projectId,
    limit: 100,
  });

  return apiOk({
    jobs: jobs.map((job) => ({
      // UI 与 SSE 始终以 taskId 关联；renderJobId 单独返回供诊断或精确操作。
      id: job.taskId,
      taskId: job.taskId,
      renderJobId: job.id,
      status: job.status,
      type: job.type,
      projectId: readProjectId(job.input),
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.completedAt ?? job.heartbeatAt ?? job.createdAt,
    })),
    total: jobs.length,
  });
}
