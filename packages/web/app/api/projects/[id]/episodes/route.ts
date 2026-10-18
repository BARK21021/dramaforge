// ============================================================
// GET/POST /api/projects/[id]/episodes — 分集列表 + 创建/重排（P7.1 T3）
// ============================================================
//
//   - GET            列出项目的所有分集（sortOrder 升序）
//   - POST           新建分集（自动 episodeNumber）
//   - POST ?reorder=1 批量重排（body: { episodeIds: string[] }）
//
// 鉴权 + ownership：requireUser → projectRepo.getById → userId 归属校验
//   （统一 404，不泄露存在性）。对齐 app1 episodes/route.ts。
//
// 响应：
//   GET  200 { success:true, data: { episodes: EpisodeRecord[] } }
//   POST 201 { success:true, data: EpisodeRecord }            新建
//   POST 200 { success:true, data: { episodes: EpisodeRecord[] } }  重排
//   404 / 400 / 401 同 [id] 路由
// ============================================================

import type { NextRequest } from 'next/server';
import { episodeRepo, projectRepo } from '@dramaforge/server';
import {
  createEpisodeSchema,
  reorderEpisodesSchema,
} from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { z } from 'zod';

/** 加载并校验项目归属；失败返 null（route 层 404）。 */
async function loadOwnedProject(projectId: string, userId: string) {
  const project = await projectRepo.getById(projectId);
  if (!project || project.userId !== userId) return null;
  return project;
}

/**
 * GET /api/projects/[id]/episodes — 列出项目的所有分集。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;
    if (!(await loadOwnedProject(projectId, auth.userId))) {
      return apiFail({ error: '项目不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    const episodes = await episodeRepo.listByProject(projectId);
    return apiSuccess({ episodes });
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/episodes');
  }
}

/**
 * POST /api/projects/[id]/episodes — 新建分集，或 ?reorder=1 批量重排。
 *
 * 重排模式校验 reorderEpisodesSchema（episodeIds 非空数组）。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;
    if (!(await loadOwnedProject(projectId, auth.userId))) {
      return apiFail({ error: '项目不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const url = new URL(req.url);
    const isReorder = url.searchParams.get('reorder') === '1';

    if (isReorder) {
      let parsed: z.infer<typeof reorderEpisodesSchema>;
      try {
        parsed = reorderEpisodesSchema.parse(raw);
      } catch (err) {
        if (err instanceof z.ZodError) return handleApiError(err);
        return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
      }
      const episodes = await episodeRepo.reorder(projectId, parsed);
      return apiSuccess({ episodes });
    }

    let parsed: z.infer<typeof createEpisodeSchema>;
    try {
      parsed = createEpisodeSchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const episode = await episodeRepo.create(projectId, parsed);
    return apiSuccess(episode, 201);
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/episodes');
  }
}
