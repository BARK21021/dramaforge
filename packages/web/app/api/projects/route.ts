// ============================================================
// GET/POST /api/projects — 项目列表 + 创建（P3 Task 2）
// ============================================================
//
// 新端点：项目列表页（P3 Task 3 workspace 页）调用的 web API。
//   - GET  列出当前用户的所有项目（按 updatedAt desc）
//   - POST 创建新项目，并持久化内容来源、源项目引用与海外转绘风格
//
// 鉴权：requireUser()（无参）→ { userId, role } | null；返 null 时抛
//   AuthError(401, 'UNAUTHORIZED')，交由外层 try/catch 的 handleApiError
//   转 401 envelope。
// 校验：createProjectSchema（@dramaforge/shared，前后端单一来源）。POST
//   handler 内 inner try/catch 同时覆盖 JSON 解析与 zod parse——ZodError
//   仍交由 handleApiError 转 VALIDATION_ERROR 400（不自构造 envelope），
//   其余（SyntaxError 等）落 apiFail 400 INVALID_JSON（详见 lib/response.ts）。
//
// 响应（UI-facing envelope，GC-4）：
//   GET  200 { success:true, data: ProjectRecord[] }
//   POST 201 { success:true, data: ProjectRecord }
//   400 { success:false, code:'VALIDATION_ERROR' }   POST body 校验失败
//   400 { success:false, code:'INVALID_JSON' }       请求体非合法 JSON
//   401 { success:false, code:'UNAUTHORIZED' }       未登录
//   500 { success:false, code:'INTERNAL_ERROR' }     DB 异常等
//
// 模式照搬 app/api/render/dispatch/route.ts:100-111：requireUser + AuthError
//   + inner try/catch（ZodError → handleApiError；SyntaxError 等 → apiFail
//   INVALID_JSON）+ apiSuccess + 整 handler try/catch 兜底。
//
// web 禁止 import 任何 ffmpeg 模块；本路由仅读写 projects 表。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo } from '@dramaforge/server';
import { createProjectSchema } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/**
 * GET /api/projects — 列出当前用户的所有项目。
 *
 * 不过滤 status（草稿/完成/生产中均返回，UI 自行展示状态徽章）。
 * 排序（updatedAt DESC）由 projectRepo.listByUser 决定。
 */
export async function GET(): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    const projects = await projectRepo.listByUser(auth.userId);
    return apiSuccess(projects);
  } catch (err) {
    return handleApiError(err, 'GET /api/projects');
  }
}

/**
 * POST /api/projects — 创建新项目。
 *
 * sourceMode/category/artStyle 的组合先由共享 schema 校验；引用原创整剧时，
 * projectRepo.create 再按数据库记录校验源项目所有权与完整剧本。
 *
 * 成功返回 201 + 新建 ProjectRecord（含 DB 回填的 id/status/version/...）。
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    let parsed: z.infer<typeof createProjectSchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = createProjectSchema.parse(raw);
    } catch (err) {
      // ZodError 交由 handleApiError 转 VALIDATION_ERROR envelope；
      // JSON 解析失败保持 400 INVALID_JSON（照搬 dispatch route:100-111）。
      if (err instanceof z.ZodError) {
        return handleApiError(err);
      }
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    let project;
    try {
      project = await projectRepo.create(auth.userId, parsed);
    } catch (err) {
      // 源项目所有权和剧本完整性依赖数据库查询，属于可纠正的请求错误，
      // 不能落入通用 500。用稳定 name 判断也兼容测试环境的 server mock。
      if (err instanceof Error && err.name === 'ProjectValidationError') {
        return apiFail(
          { error: err.message, code: 'PROJECT_VALIDATION_ERROR', category: 'validation' },
          400,
        );
      }
      throw err;
    }
    return apiSuccess(project, 201);
  } catch (err) {
    return handleApiError(err, 'POST /api/projects');
  }
}
