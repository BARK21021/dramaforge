// ============================================================
// POST /api/projects/[id]/whole-script-asset-extraction — 整剧资产提取（转绘 X4.4）
// ============================================================
//
// 对齐 app1：整剧 novelText 一次性喂 DeepSeek，提取项目级共享资产（角色/场景/道具）。
// EPISODE_SPLIT BullMQ 任务内部会自动调用；此 route 供已有项目手动重新提取共享资产。
//
//   Body: { model? }（默认 deepseek/deepseek-v4-flash，由 domain 层定）
//   - novelText 从 project.novelText 读（X3 整剧重写 result route 已写入；或 LOCAL_SCRIPT
//     分支 PATCH 写入）。
//   - OVERSEAS 项目：domain 层 defer，不调 AI，返回 {deferred:true, reason}。
//
// 鉴权 + ownership：requireUser → projectRepo.getById → 校验 userId。
// 响应：200 { success:true, data:{ created, totalDetected, deferred?, reason? } }
//       400 EMPTY_SCRIPT / 404 / 502 AI_GATEWAY_ERROR
// 纯文本 AI 调用，零媒体字节。web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo, episodeRepo, extractWholeScriptAssets, readLocalizationProfile, GatewayError } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** novelText 最小长度（过短无提取价值；app1 无此校验，dramaforge 加护栏）。 */
const MIN_NOVEL_TEXT_CHARS = 50;

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

    // 整剧文本带 === EP{n} === 集标记：优先从分集重建（让已有项目无需重拆即可按集标注变体
    // 出场 coverage_episodes），分集为空时回退 project.novelText。标记格式与单集聚合
    // route（asset-extraction）一致，整剧 prompt 据此要求 AI 输出每个变体的出场集号。
    const episodes = (await episodeRepo.listByProject(projectId)) ?? [];
    const fromEpisodes = episodes.length > 0
      ? episodes
          .map((ep) => {
            const titleSuffix = ep.title ? ` ${ep.title}` : '';
            // video-to-script-full 把剧本写进 videoScriptDraft 和 scriptData.novelText，
            // 这里都要兜底读，否则 REFERENCE_VIDEO 流程资产提取拿不到剧本报 400。
            const sd = (ep.scriptData ?? {}) as Record<string, unknown>;
            const body = (
              ep.novelText
              ?? ep.content
              ?? ep.videoScriptDraft
              ?? (typeof sd.novelText === 'string' ? sd.novelText : '')
              ?? ''
            ).toString();
            return `=== EP${ep.episodeNumber}${titleSuffix} ===\n${body}`;
          })
          .join('\n\n')
          .trim()
      : '';
    // project.novelText 兜底（video-to-script-full 已同步写入）；最后再兜 episode.scriptData.novelText。
    const fromProject = typeof project.novelText === 'string' ? project.novelText.trim() : '';
    const novelText = fromEpisodes || fromProject;
    if (novelText.length < MIN_NOVEL_TEXT_CHARS) {
      return apiFail(
        { error: '整剧剧本内容过短，无法提取资产', code: 'EMPTY_SCRIPT' },
        400,
      );
    }

    // 模型跟随：body.model 未传时用视频转剧本时的模型（REFERENCE_VIDEO 用户
    // 转剧本与资产提取共用一个 kimi 下拉；EPISODE_INPUT 无记录时 domain 默认
    // deepseek）。补传 localizationProfile（第 6 参，此前漏档）：OVERSEAS
    // 海外人种/服饰改编依赖它；EPISODE_SPLIT handler 内已传，手动重提取这里对齐。
    const scriptData = (project.scriptData as Record<string, unknown> | null) ?? {};
    const model =
      parsed.model ??
      (typeof scriptData.videoToScriptModel === 'string' ? scriptData.videoToScriptModel : undefined);
    const outcome = await extractWholeScriptAssets(
      projectId,
      novelText,
      auth.userId,
      project.category,
      model,
      readLocalizationProfile(project.scriptData),
    );

    return apiSuccess(outcome);
  } catch (err) {
    if (err instanceof GatewayError) {
      const status = err.status ?? 502;
      return apiFail(
        { error: err.message || '整剧资产提取 AI 调用失败', code: 'AI_GATEWAY_ERROR' },
        status >= 400 && status < 500 ? status : 502,
      );
    }
    // domain 层 "整剧资产提取返回格式无效" 等业务错 → 502
    if (err instanceof Error && err.message.includes('整剧资产提取')) {
      return apiFail({ error: err.message, code: 'EXTRACTION_FAILED' }, 502);
    }
    return handleApiError(err, 'POST /api/projects/[id]/whole-script-asset-extraction');
  }
}
