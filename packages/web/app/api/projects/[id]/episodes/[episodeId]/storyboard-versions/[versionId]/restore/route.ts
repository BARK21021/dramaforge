// ============================================================
// POST /api/projects/[id]/episodes/[episodeId]/storyboard-versions/[versionId]/restore
//   — 恢复一条历史版本：当前整集另存为新版本 → 旧版快照写回 shots 表（当前）。
// ============================================================
// 写回策略：分镜文本/metadata/资产引用保留；videoStatus/currentMaterial* 重置
// （materials 已随上次重生级联删）；id 重新生成。详见域函数注释。
// 鉴权：session REQUIRED。ownership 校验（project + episode + 版本三元组）。
// 响应：200 { success:true, data: { archivedOrdinal } } / 401 / 404。web 禁止 import ffmpeg。

import type { NextRequest } from 'next/server';
import { episodeRepo, projectRepo, restoreStoryboardVersion } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function POST(
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

    // 版本不存在/不属于该集 → 域函数 throw → handleApiError 映射。
    const { archivedOrdinal } = await restoreStoryboardVersion({ projectId, episodeId, versionId });
    return apiSuccess({ archivedOrdinal });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/episodes/[episodeId]/storyboard-versions/[versionId]/restore');
  }
}
