// ============================================================
// POST /api/projects/[id]/video-batch-process — 多集视频连续转剧本（转绘 X4.2）
// ============================================================
//
// 对齐 app1 api/projects/[projectId]/video-batch-process/route.ts。video-split 拆出的
// 多集片段批量转剧本：multipart segments(JSON) + 每集视频文件（key=episodeId），逐集
// runVideoToScript + 写 episode.videoScriptDraft，单集失败不阻断其他集。
//
// **C/S RAM 适配（与 app1 关键差异）**：app1 MAX_BATCH_EPISODES=50，单请求收 50 个
// 100MB multipart 文件 = 5GB 峰值 RAM，dramaforge server 1.8GB 必爆。dramaforge 砍到 **≤5 集/批**
// （500MB 瞬时峰值，自托管 docker 可承受），大批量由 UI 分批调或逐集调 X2/X4.1。
// （app1 UI 实测不直连本 route——grep 仅 backend 引用；dramaforge 亦以逐集 loop 为主路径，
// 本 route 保留 app1 契约 + ≤5 护栏。）
//
// **dramaforge 安全加严**：app1 不校验 episodeId 是否属本项目（recon 风险④）；dramaforge 先拉项目
// 全部分集建白名单，非本项目 episodeId 直接 fail，防跨项目写。
//
// 复用 web/lib/video-to-script runVideoToScript（X2/X4.1 共用）。Kimi-only 砍 Whisper/OCR。
// GC-1 key 只在 server；dramaforge-assets-client-local 字节 server RAM 透传不落盘。
//
// Body（multipart）：segments(JSON string:[{episodeId,filename?,mimeType?}]) / model? /
//   <episodeId>=视频文件（每集一个，key 是 episodeId）
// 响应：200 { success:true, data:{ results:[{episodeId, success, script?, error?}] } }
//       400 NO_SEGMENTS / SEGMENTS_OVER_LIMIT / 404
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { episodeRepo, projectRepo } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { runVideoToScript, EmptyScriptError } from '@web/lib/video-to-script';

export const runtime = 'nodejs';
export const maxDuration = 600;
export const dynamic = 'force-dynamic';

const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const ALLOWED_VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv'];
/** 单批上限（app1=50；dramaforge server 1.8GB RAM 砍到 5，防 multipart 解析峰值爆 RAM）。 */
const MAX_BATCH_EPISODES = 5;

const segmentSchema = z.object({
  episodeId: z.string().min(1),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
});

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

    // 余额前置预检（对齐 app1 precheckBalance / generate-image）：0 积分挡在昂贵
    // Kimi 批量视频转剧本之前；非精确预检，真实扣费在每集成功后。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    const formData = await req.formData();
    const segmentsJson = formData.get('segments');
    if (typeof segmentsJson !== 'string' || !segmentsJson.trim()) {
      return apiFail({ error: '缺少 segments 参数', code: 'NO_SEGMENTS' }, 400);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(segmentsJson);
    } catch {
      return apiFail({ error: 'segments 不是有效的 JSON', code: 'INVALID_SEGMENTS' }, 400);
    }
    const segmentsArrResult = z.array(segmentSchema).min(1).max(MAX_BATCH_EPISODES).safeParse(parsed);
    if (!segmentsArrResult.success) {
      const tooMany = segmentsArrResult.error.issues.some((i) => i.code === 'too_big');
      return apiFail(
        {
          error: tooMany
            ? `单次批处理不能超过 ${MAX_BATCH_EPISODES} 集`
            : 'segments 不能为空或格式无效',
          code: tooMany ? 'SEGMENTS_OVER_LIMIT' : 'INVALID_SEGMENTS',
        },
        400,
      );
    }
    const segments = segmentsArrResult.data;

    const modelField = formData.get('model');
    const model =
      typeof modelField === 'string' && modelField.trim().length > 0 ? modelField.trim() : 'kimi-k2.6';

    // 项目分集白名单（dramaforge 安全加严：防跨项目 episodeId 写入）
    const episodes = await episodeRepo.listByProject(projectId);
    const validEpisodeIds = new Set(episodes.map((e) => e.id));

    const results: Array<{ episodeId: string; success: boolean; script?: string; error?: string }> =
      [];

    for (const seg of segments) {
      try {
        if (!validEpisodeIds.has(seg.episodeId)) {
          results.push({
            episodeId: seg.episodeId,
            success: false,
            error: '分集不属于当前项目',
          });
          continue;
        }

        const file = formData.get(seg.episodeId) as File | null;
        if (!file) {
          results.push({
            episodeId: seg.episodeId,
            success: false,
            error: `未找到分集 ${seg.episodeId} 对应的视频文件`,
          });
          continue;
        }

        // 类型 + 大小校验（扩展名优先；mkv MIME 常缺失）
        const lowerName = (seg.filename ?? file.name).toLowerCase();
        const okExt = ALLOWED_VIDEO_EXT.some((ext) => lowerName.endsWith(ext));
        const okMime = typeof file.type === 'string' && file.type.startsWith('video/');
        if (!okExt && !okMime) {
          results.push({ episodeId: seg.episodeId, success: false, error: '不支持的视频格式' });
          continue;
        }
        if (file.size > MAX_VIDEO_SIZE) {
          results.push({
            episodeId: seg.episodeId,
            success: false,
            error: `视频过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大 100MB`,
          });
          continue;
        }

        const videoBytes = Buffer.from(await file.arrayBuffer());
        const outcome = await runVideoToScript({
          userId: auth.userId,
          videoBytes,
          filename: seg.filename ?? file.name ?? 'video.mp4',
          mimeType: file.type || seg.mimeType || 'video/mp4',
          model,
        });
        // 每集成功后扣费（对齐 generate-image / long-video-text）：余额不足重抛 402，
        // 被本集 catch 记为失败、不落库；其余集继续（与单集失败不阻断的隔离设计一致）。
        await billDirectGeneration({
          userId: auth.userId,
          result: { url: '', meta: {}, cost: outcome.cost ?? undefined },
          description: '批量视频转剧本',
          taskType: 'VIDEO_TO_SCRIPT_BATCH',
        });
        await episodeRepo.update(seg.episodeId, { videoScriptDraft: outcome.script });
        results.push({ episodeId: seg.episodeId, success: true, script: outcome.script });
      } catch (err) {
        const msg =
          err instanceof EmptyScriptError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        results.push({ episodeId: seg.episodeId, success: false, error: msg });
      }
    }

    return apiSuccess({ results });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/video-batch-process');
  }
}
