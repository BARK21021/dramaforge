// ============================================================
// GET  /api/projects/[id]/episodes/[episodeId]/storyboard-versions/[versionId]
//   — 查看某条历史版本的完整镜头快照（只读）
// DELETE /api/projects/[id]/episodes/[episodeId]/storyboard-versions/[versionId]
//   — 手动删除一条历史版本（当前镜头在 shots 表，删不到）
// ============================================================
// 鉴权：session REQUIRED。ownership 校验（project + episode + 版本三元组）。
// 响应：200 { success:true, data: { version } } / 401 / 404。web 禁止 import ffmpeg。

import type { NextRequest } from 'next/server';
import {
  episodeRepo,
  projectRepo,
  getStoryboardVersion,
  deleteStoryboardVersion,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string; versionId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, episodeId, versionId } = await params;

    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 版本级三元组校验在域函数 WHERE 完成：不属于该集的 versionId 命中 0 行 → 404。
    const version = await getStoryboardVersion(projectId, episodeId, versionId);
    if (!version) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    return apiSuccess({ version });
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/episodes/[episodeId]/storyboard-versions/[versionId]');
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string; versionId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, episodeId, versionId } = await params;

    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    await deleteStoryboardVersion(projectId, episodeId, versionId);
    return apiSuccess({});
  } catch (err) {
    return handleApiError(err, 'DELETE /api/projects/[id]/episodes/[episodeId]/storyboard-versions/[versionId]');
  }
}
