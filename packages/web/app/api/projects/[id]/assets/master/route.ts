// ============================================================
// GET /api/projects/[id]/assets/master — 资产总表聚合（资产×集出场矩阵）
// ============================================================
//
// 一次性返回项目级资产总表数据：资产列表 + 集列表 + 出场矩阵（assetId→变体→集）
// + 状态计数。前端据此渲染"资产总表"（资产×集矩阵）与"按集查看"双视图，
// 类型/状态/集/未分配筛选在前端做（单次拉取 + 客户端过滤，避免服务端双扫）。
//
// 出场集从 shots 派生（coverageScenes 集内本地歧义不可用，见 appearance.ts）。
//
// 鉴权：session REQUIRED。ownership 校验项目归属。
// 响应：200 { success:true, data: AssetMasterResult } / 401 / 404
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { projectRepo, computeAssetMaster } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;

    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    const master = await computeAssetMaster(projectId);
    return apiSuccess(master);
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/assets/master');
  }
}
