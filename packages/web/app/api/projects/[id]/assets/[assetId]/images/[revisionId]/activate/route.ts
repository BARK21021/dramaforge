// POST /assets/[assetId]/images/[revisionId]/activate — 把历史版本设回对应的主图或造型图。
// 复用 revision.localUrl（已是 sf-asset://），不需要客户端重新下载。

import type { NextRequest } from 'next/server';
import {
  activateAssetImageRevision,
  getAsset,
  projectRepo,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';

async function authorize(userId: string, projectId: string, assetId: string): Promise<boolean> {
  const [project, asset] = await Promise.all([projectRepo.getById(projectId), getAsset(assetId)]);
  return Boolean(project?.userId === userId && asset?.projectId === projectId);
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string; revisionId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { id, assetId, revisionId } = await params;
    if (!await authorize(auth.userId, id, assetId)) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const result = await activateAssetImageRevision({
      projectId: id,
      assetId,
      revisionId,
    });
    return apiSuccess(result);
  } catch (error) {
    return handleApiError(error, 'POST /api/projects/[id]/assets/[assetId]/images/[revisionId]/activate');
  }
}
