// ============================================================
// POST /api/projects/[id]/assets/dedup-costumes — 造型变体 AI 去重（维护）
// ============================================================
//
// 修复"整剧提取中英文各跑一次 → 同一套服装存两份"的重复变体：逐资产调一次 AI，
// 合并跨语言等价变体，输出干净中文 label + 稳定英文 key，保留已生成图片。
//
//   Body: { model? }（默认 deepseek/deepseek-v4-flash）
//   鉴权 + ownership：requireUser → projectRepo.getById → 校验 userId。
//   响应：200 { success:true, data:{ processed, cleaned, details } } / 404 / 502
// 纯文本 AI 调用，零媒体字节。web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo, dedupProjectCostumes, GatewayError } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

const bodySchema = z.object({
  model: z.string().min(1).optional(),
});

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
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

    let parsed: z.infer<typeof bodySchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = bodySchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const outcome = await dedupProjectCostumes(projectId, auth.userId, parsed.model);
    return apiSuccess(outcome);
  } catch (err) {
    if (err instanceof GatewayError) {
      const status = err.status ?? 502;
      return apiFail(
        { error: err.message || '变体去重 AI 调用失败', code: 'AI_GATEWAY_ERROR' },
        status >= 400 && status < 500 ? status : 502,
      );
    }
    return handleApiError(err);
  }
}
