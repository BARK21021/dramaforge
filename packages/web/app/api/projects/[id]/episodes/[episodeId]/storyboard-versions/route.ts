// ============================================================
// GET /api/projects/[id]/episodes/[episodeId]/storyboard-versions
//   — 列出该集分镜历史版本（重生/恢复时自动归档的整集快照）
// ============================================================
// 鉴权：session REQUIRED。ownership 校验（project 属于用户 + episode 属于 project）。
// 响应：200 { success:true, data: { versions } }（summary，不含 shots_snapshot）/ 401 / 404
// web 禁止 import ffmpeg。

import type { NextRequest } from 'next/server';
import { episodeRepo, projectRepo, listStoryboardVersions } from '@dramaforge/server';
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

    const versions = await listStoryboardVersions(projectId, episodeId);
    return apiSuccess({ versions });
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/episodes/[episodeId]/storyboard-versions');
  }
}
