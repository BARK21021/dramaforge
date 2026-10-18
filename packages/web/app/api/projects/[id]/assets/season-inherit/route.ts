// ============================================================
// POST /api/projects/[id]/assets/season-inherit — 季继承（资产外观对比继承计划）
// ============================================================
//
// 第二季（[id]）选第一季（body.sourceProjectId）为源，算出资产外观继承计划。
// 纯只读，0 写入、0 媒体字节（H1：服务器零媒体）：实际图片物理复制 + PATCH 目标
// 资产由客户端两步完成（sf.copyLocalAsset → PATCH /assets/[assetId]）。
//
//   Body: { sourceProjectId }
//   鉴权 + ownership：requireUser → 两项目均须属该 user。
//   响应：200 { sourceProjectId, targetProjectId, items, skipped } / 400 / 404。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo, planSeasonInheritance, isWholeScriptProject } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

const bodySchema = z.object({
  sourceProjectId: z.string().min(1),
});

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: targetProjectId } = await params;

    let parsed: z.infer<typeof bodySchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = bodySchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const { sourceProjectId } = parsed;
    if (sourceProjectId === targetProjectId) {
      return apiFail({ error: '源季项目不能与当前项目相同', code: 'SAME_PROJECT' }, 400);
    }

    // ownership：两项目都必须属于当前 user
    const [target, source] = await Promise.all([
      projectRepo.getById(targetProjectId),
      projectRepo.getById(sourceProjectId),
    ]);
    if (!target || target.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    if (!source || source.userId !== auth.userId) {
      return apiFail({ error: '源季项目不存在或无权访问', code: 'SOURCE_NOT_FOUND' }, 404);
    }
    // 季继承仅限整剧项目之间（sourceMode 须为 VIDEO_REWRITE/LOCAL_SCRIPT/ORIGINAL_PROJECT）。
    if (!isWholeScriptProject(target) || !isWholeScriptProject(source)) {
      return apiFail(
        { error: '季继承仅在整剧项目之间可用（整剧视频/剧本/原创衍生）', code: 'NOT_WHOLE_SCRIPT' },
        400,
      );
    }

    const plan = await planSeasonInheritance(targetProjectId, sourceProjectId);
    return apiSuccess(plan);
  } catch (err) {
    return handleApiError(err);
  }
}
