// GET/POST /assets/[assetId]/images — 图片版本历史与客户端两阶段提交。

import type { NextRequest } from 'next/server';
import {
  commitAssetImageRevision,
  getAsset,
  listAssetImageRevisions,
  projectRepo,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';

async function authorize(userId: string, projectId: string, assetId: string): Promise<boolean> {
  const [project, asset] = await Promise.all([projectRepo.getById(projectId), getAsset(assetId)]);
  return Boolean(project?.userId === userId && asset?.projectId === projectId);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { id, assetId } = await params;
    if (!await authorize(auth.userId, id, assetId)) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    return apiSuccess(await listAssetImageRevisions(id, assetId));
  } catch (error) {
    return handleApiError(error, 'GET /api/projects/[id]/assets/[assetId]/images');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { id, assetId } = await params;
    if (!await authorize(auth.userId, id, assetId)) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const body = await request.json().catch(() => null) as {
      revisionId?: unknown;
      localUrl?: unknown;
      source?: unknown;
      activateCurrent?: unknown;
      costumeKey?: unknown;
    } | null;
    if (!body || typeof body.localUrl !== 'string') {
      return apiFail({ error: 'localUrl 不能为空', code: 'BAD_LOCAL_URL' }, 400);
    }
    const result = await commitAssetImageRevision({
      projectId: id,
      assetId,
      localUrl: body.localUrl,
      ...(typeof body.revisionId === 'string' ? { revisionId: body.revisionId } : {}),
      source: body.source === 'AI' ? 'AI' : 'UPLOAD',
      activateCurrent: body.activateCurrent !== false,
      ...(typeof body.costumeKey === 'string' && body.costumeKey.trim()
        ? { costumeKey: body.costumeKey.trim() }
        : {}),
    });
    return apiSuccess(result);
  } catch (error) {
    return handleApiError(error, 'POST /api/projects/[id]/assets/[assetId]/images');
  }
}
