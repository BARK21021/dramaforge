// ============================================================
// GET/PATCH/DELETE /api/projects/[id]/episodes/[episodeId]（P7.1 T3）
// ============================================================
//
//   - GET    取单集详情（P7.1 不带 shots——shots 在 P7.4 分镜阶段加）
//   - PATCH  更新分集（白名单：title/novelText→contentKilo/content/
//            videoScriptDraft/stageStatus[单调]/status/scriptData/scenes/
//            defaultVisualStyle/emotionArc/sortOrder/episodeNumber）
//   - DELETE 删分集（shots 经 FK ON DELETE CASCADE 自动清）
//
// 鉴权 + ownership：requireUser → project 归属 → episode 属于该 project。
//   两层校验均统一 404（不泄露存在性）。对齐 app1 [episodeId]/route.ts。
//
// 响应：
//   GET   200 { success:true, data: EpisodeRecord }
//   PATCH 200 { success:true, data: EpisodeRecord }
//   DEL   200 { success:true, data: { deletedId } }
//   404 / 400 / 401
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { episodeRepo, projectRepo } from '@dramaforge/server';
import { updateEpisodeSchema } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/**
 * GET /api/projects/[id]/episodes/[episodeId] — 单集详情。
 *
 * 校验：项目归属当前用户 + 分集属于该项目。任一不满足返 404。
 */
export async function GET(
  req: NextRequest,
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
    return apiSuccess(episode);
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/episodes/[episodeId]');
  }
}

/**
 * PATCH /api/projects/[id]/episodes/[episodeId] — 更新分集。
 *
 * service 层对不存在 id 抛 Error（→ 500）；正常路径 zod 已校验枚举。
 */
export async function PATCH(
  req: NextRequest,
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
    const existing = await episodeRepo.getById(episodeId);
    if (!existing || existing.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    let parsed: z.infer<typeof updateEpisodeSchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = updateEpisodeSchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const updated = await episodeRepo.update(episodeId, parsed);
    return apiSuccess(updated);
  } catch (err) {
    return handleApiError(err, 'PATCH /api/projects/[id]/episodes/[episodeId]');
  }
}

/**
 * DELETE /api/projects/[id]/episodes/[episodeId] — 删除分集。
 *
 * shots 经 FK ON DELETE CASCADE 自动清除（无需手动级联，与 app1 Prisma
 * 兼容层不同——dramaforge 用原生 pg + 真实 FK）。
 */
export async function DELETE(
  req: NextRequest,
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
    const existing = await episodeRepo.getById(episodeId);
    if (!existing || existing.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    await episodeRepo.remove(episodeId);
    return apiSuccess({ deletedId: episodeId });
  } catch (err) {
    return handleApiError(err, 'DELETE /api/projects/[id]/episodes/[episodeId]');
  }
}
