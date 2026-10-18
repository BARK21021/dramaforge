// ============================================================
// GET/PATCH/DELETE /api/projects/[id] — 项目详情与删除（P7.1 T3）
// ============================================================
//
// 供 workspace/[projectId] 工作台外壳加载项目 + 重命名标题。
//   - GET   取项目详情（带 ownership 校验）
//   - PATCH 改 title/description/status/category（白名单，JSONB/脚本字段不在本 slice）
//   - DELETE 删除项目；项目内数据由数据库外键级联清理
//
// 鉴权 + ownership：requireUser → projectRepo.getById → 校验 userId 归属。
//   不区分 403/404（统一 404），避免泄露其他用户项目存在性——对齐 app1
//   ensureProjectOwnership 的安全策略。
//
// 响应：
//   GET   200 { success:true, data: ProjectRecord }
//   PATCH 200 { success:true, data: ProjectRecord }
//   404 { success:false, code:'NOT_FOUND' }   项目不存在 / 无权
//   400 { success:false, code:'VALIDATION_ERROR' }  PATCH body 校验失败
//   401 { success:false, code:'UNAUTHORIZED' }
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** PATCH 项目白名单 schema（P7.1：仅用户可见核心字段） */
const updateProjectSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z
    .enum(['DRAFT', 'SCREENWRITING', 'ASSET_DESIGN', 'STORYBOARD', 'PRODUCTION', 'COMPLETE'])
    .optional(),
  category: z.enum(['ORIGINAL', 'DOMESTIC', 'OVERSEAS']).optional(),
  // 转绘 X3.6：OriginalRewriteStage LOCAL_SCRIPT 分支 PATCH novelText 保存完整剧本
  // （对齐 app1 prisma.project.update({ novelText })）。service 层 update 已支持，
  // 此处补 route 白名单，否则 zod 默默 strip 导致保存静默失败。
  novelText: z.string().optional(),
  videoScriptDraft: z.string().optional(),
});

/**
 * GET /api/projects/[id] — 项目详情。
 *
 * ownership 校验失败统一返 404（不泄露存在性）。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id } = await params;
    const project = await projectRepo.getById(id);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '项目不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    return apiSuccess(project);
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]');
  }
}

/**
 * PATCH /api/projects/[id] — 更新项目（title/description/status/category）。
 *
 * ownership 校验同 GET。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id } = await params;
    const project = await projectRepo.getById(id);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '项目不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    let parsed: z.infer<typeof updateProjectSchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = updateProjectSchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const updated = await projectRepo.update(id, parsed);
    return apiSuccess(updated);
  } catch (err) {
    return handleApiError(err, 'PATCH /api/projects/[id]');
  }
}

/**
 * DELETE /api/projects/[id] — 删除当前用户拥有的项目。
 *
 * 不存在与越权统一返回 404；ownership 校验成功后才调用 remove，避免仅凭
 * 客户端传入 id 删除其他用户数据。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id } = await params;
    const project = await projectRepo.getById(id);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '项目不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    await projectRepo.remove(id);
    return apiSuccess({ id });
  } catch (err) {
    return handleApiError(err, 'DELETE /api/projects/[id]');
  }
}
