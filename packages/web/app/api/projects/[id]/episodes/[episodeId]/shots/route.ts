// ============================================================
// GET /api/projects/[id]/episodes/[episodeId]/shots — 分集分镜列表（P7.4）
// ============================================================
//
// 列出某分集下所有分镜（按 sortOrder 升序）。供 episode 详情页分镜区初始加载 +
// generate-storyboard 后刷新。
//
// 鉴权：session REQUIRED。ownership 校验（project + episode 属于 project）。
// 响应：200 { success:true, data: { shots } } / 401 / 404
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { episodeRepo, projectRepo, listShots, type ShotRecord } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, episodeId } = await params;

    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    const shots: ShotRecord[] = await listShots(projectId, episodeId);
    return apiSuccess({ shots });
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/episodes/[episodeId]/shots');
  }
}
