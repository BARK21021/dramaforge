// ============================================================
// POST /api/projects/[id]/assets/[assetId]/rename — 角色改名 + 级联同步（批3）
// ============================================================
//
// @file projects/[id]/assets/[assetId]/rename/route.ts
// @description 角色改名端点。改 assets.name 的同时，把项目下所有出现该角色名
//              的位置（剧本 / 剧本分析 / 分镜设计 / 任务 prompt / 其余角色描述）
//              里的旧名在一个事务内同步替换为新名。详见 server/domain/asset/rename-service。
//
// 移植自 app1 src/app/api/projects/[projectId]/assets/[assetId]/rename/route.ts。
// 语义 1:1 对齐：POST 而非 PATCH（独立 endpoint，不走通用 PATCH 白名单），
// body { name }，鉴权 + ownership + 资产归属后调 renameAsset。
//
// @endpoints
//   POST /api/projects/[id]/assets/[assetId]/rename
//     请求体: { name: string }  —— 新名字
//     响应: 200 { success:true, data: { assetId, oldName, newName, counts } }
//
// 鉴权：session REQUIRED + 项目 ownership + 资产属于项目（统一 404 不泄露存在性）。
// web 禁止 import ffmpeg。零 ffmpeg 依赖。
// ============================================================

import type { NextRequest } from 'next/server';
import { getAsset, projectRepo, renameAsset, RenameValidationError } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/**
 * POST /api/projects/[id]/assets/[assetId]/rename — 角色改名 + 级联同步。
 *
 * @description 改一个角色的名字，并同步更新剧本/剧本分析/分镜设计/任务 prompt
 *              中所有出现处。仅支持 CHARACTER 类型资产。同名冲突 / 空名 / 非角色 → 400。
 *
 * @returns 200 - { success:true, data: { assetId, oldName, newName, counts } }
 * @returns 400 - VALIDATION_ERROR（空名 / 同名 / 非角色 / 与原名相同 / 超长）
 * @returns 404 - NOT_FOUND（项目或资产不存在 / 不属于当前用户，统一不泄露存在性）
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, assetId } = await params;

    // 1. ownership：项目归属（统一 404 不泄露存在性）
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 2. 资产归属（项目内的资产才允许改名）
    const asset = await getAsset(assetId);
    if (!asset || asset.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 3. 解 body（容错：非 JSON / 非对象 → 当空名处理走 400）
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    const name =
      raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).name === 'string'
        ? ((raw as Record<string, unknown>).name as string)
        : '';

    // 4. 调 server domain 改名（事务内级联同步；校验失败抛 RenameValidationError）
    try {
      const result = await renameAsset(projectId, assetId, name);
      return apiSuccess(result);
    } catch (err) {
      if (err instanceof RenameValidationError) {
        return apiFail(
          { error: err.message, code: 'VALIDATION_ERROR', category: 'validation' },
          400,
        );
      }
      throw err; // 未知错误交由 handleApiError 转 500
    }
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/assets/[assetId]/rename');
  }
}
