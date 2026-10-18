// ============================================================
// POST /api/projects/[id]/long-video-rewrite/result — 整剧重写产物落库（转绘 X3.6a）
// ============================================================
//
// 长视频整剧重写 orchestrator（client，X3.4）跑完 processLongVideo 全链后，把
// 最终产物一次性写回项目级。对齐 app1 processLongVideo 末尾的
// `prisma.project.update({ novelText, videoScriptDraft, status:'SCREENWRITING',
//   longVideoProgress:{stage:'completed',progress:100}, scriptData:{ longVideoRewrite } })`。
//
// C/S 铁律：
//   - dramaforge-assets-client-local：产物是文本（novelText/videoScriptDraft/大纲），
//     非媒体字节，落 DB 合规（媒体字节从未进过本链——视频只在 client 本地切片 +
//     透传 Kimi 即弃）
//   - GC-1：本端点不碰任何 AI key（生成已在 orchestrator 经 generate route 完成）
//
// 鉴权 + ownership：requireUser → projectRepo.getById → 校验 userId，统一 404。
// 响应：200 { success:true, data:{ projectId, status } }
//       400 VALIDATION_ERROR（body 无任何产物字段）/ 401 / 404
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/**
 * 整剧重写产物写入校验。三个产物字段至少给一个；longVideoRewrite 作为
 * scriptData.longVideoRewrite 浅合并写入（保留 scriptData 其他键）。
 */
const resultSchema = z
  .object({
    novelText: z.string().optional(),
    videoScriptDraft: z.string().optional(),
    /** LongVideoRewriteResult（shared 类型），透传进 scriptData.longVideoRewrite。 */
    longVideoRewrite: z.record(z.unknown()).optional(),
    /** 落库后项目状态，默认 SCREENWRITING（对齐 app1：重写完进剧本阶段）。 */
    targetStatus: z
      .enum(['DRAFT', 'SCREENWRITING', 'ASSET_DESIGN', 'STORYBOARD', 'PRODUCTION', 'COMPLETE'])
      .optional(),
    /** 完成时间戳（ISO），写进 longVideoProgress.updatedAt。 */
    completedAt: z.string().optional(),
  })
  .refine(
    (d) => d.novelText !== undefined || d.videoScriptDraft !== undefined || d.longVideoRewrite !== undefined,
    { message: '至少提供 novelText / videoScriptDraft / longVideoRewrite 之一' },
  );

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id } = await params;
    const project = await projectRepo.getById(id);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    let parsed: z.infer<typeof resultSchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = resultSchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    // 一次性写回：novelText/videoScriptDraft/进度完成/scriptData.longVideoRewrite/status。
    // scriptData 走 service 层浅合并（保留既有 localizationProfile 等键）。
    const targetStatus = parsed.targetStatus ?? 'SCREENWRITING';
    await projectRepo.update(id, {
      ...(parsed.novelText !== undefined ? { novelText: parsed.novelText } : {}),
      ...(parsed.videoScriptDraft !== undefined
        ? { videoScriptDraft: parsed.videoScriptDraft }
        : {}),
      ...(parsed.longVideoRewrite !== undefined
        ? { scriptData: { longVideoRewrite: parsed.longVideoRewrite } }
        : {}),
      status: targetStatus,
      longVideoProgress: {
        stage: 'completed',
        progress: 100,
        updatedAt: parsed.completedAt ?? new Date().toISOString(),
      },
    });

    return apiSuccess({ projectId: id, status: targetStatus });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/long-video-rewrite/result');
  }
}
