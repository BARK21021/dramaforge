// ============================================================
// POST /api/projects/[id]/original-video-upload — 整剧重写任务派发（转绘 X3.6b）
// ============================================================
//
// ORIGINAL 项目的 3GB 长视频整剧重写入口。对齐 app1
// api/projects/[projectId]/original-video-upload/route.ts，但 **C/S 架构差异**：
//
//   app1：分片上传字节到服务器 tmpdir → 拼接 → createTask（服务器持视频字节）
//   dramaforge：视频字节 **从不离开客户端**（dramaforge-assets-client-local）。Electron 客户端
//         把 3GB 视频存到 userData/original-uploads/（X3.7 preload IPC），本地探
//         duration+size 后，调本端点（**纯元数据**）派发 LONG_VIDEO_REWRITE
//         render_job。server 只持 key + DB 元数据 + render_job 状态。
//
// 因此本端点是 **单次 POST 元数据**（无 app1 的 init/chunk/complete 三段式）：
//   Body: { videoUrl, filename, totalBytes, totalDurationSec, kimiModel?, outlineModel?, rewriteModel? }
//   - videoUrl：客户端本地视频路径（file:// 或绝对路径或 sf-asset:// key，client
//     render-worker 解析为本地文件）。**绝不上传字节**。
//   - totalDurationSec / totalBytes：客户端本地 probe（getVideoDuration + fs.stat）
//
// 鉴权 + ownership：requireUser → projectRepo.getById → 校验 userId + category==='ORIGINAL'。
// 响应：200 { success:true, data:{ taskId, renderJobId, segmentPlan, reused? } }
//       400 INVALID_FILE_TYPE / FILE_TOO_LARGE / 404 / 409 已有进行中任务（reused）
// web 禁止 import ffmpeg（duration/size 由客户端 probe 后传入）。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  projectRepo,
  dispatchLongVideoRewrite,
} from '@dramaforge/server';
import { genId, calculateKimiSegmentPlan } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** 与 app1 一致：3GB 上限。字节不落服务器，此上限仅防客户端传荒谬值。 */
const MAX_VIDEO_BYTES = 3 * 1024 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);

/** 进行中阶段（longVideoProgress.stage 命中这些则视为已有活动任务，复用）。 */
const IN_FLIGHT_STAGES = new Set(['splitting', 'transcribing', 'outlining', 'scripting']);

const uploadBodySchema = z.object({
  videoUrl: z.string().min(1),
  filename: z.string().min(1),
  totalBytes: z.number().int().positive().max(MAX_VIDEO_BYTES),
  totalDurationSec: z.number().positive(),
  kimiModel: z.string().optional(),
  outlineModel: z.string().optional(),
  rewriteModel: z.string().optional(),
  regenerateFromEpisode: z.number().int().min(2).optional(),
  reuseTargetStageDraft: z.boolean().optional(),
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
    if (project.category !== 'ORIGINAL') {
      return apiFail(
        { error: '仅剧本原创（ORIGINAL）项目支持整剧重写', code: 'NOT_ORIGINAL' },
        400,
      );
    }

    // 进行中任务复用（对齐 app1 recentTasks.activeTask 去重；dramaforge 用 progress 阶段
    // 廉价判定，免新增 render_jobs 按 project 查询方法）。
    const existing =
      project.longVideoProgress &&
      typeof project.longVideoProgress === 'object' &&
      !Array.isArray(project.longVideoProgress)
        ? (project.longVideoProgress as { stage?: string; taskId?: string })
        : null;
    if (existing && existing.taskId && IN_FLIGHT_STAGES.has(String(existing.stage))) {
      return apiSuccess({
        taskId: existing.taskId,
        renderJobId: null,
        segmentPlan: null,
        reused: true,
      });
    }

    let parsed: z.infer<typeof uploadBodySchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = uploadBodySchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const previousRewrite = project.scriptData
      && typeof project.scriptData === 'object'
      && !Array.isArray(project.scriptData)
      && (project.scriptData as Record<string, unknown>).longVideoRewrite
      && typeof (project.scriptData as Record<string, unknown>).longVideoRewrite === 'object'
      ? (project.scriptData as Record<string, unknown>).longVideoRewrite as Record<string, unknown>
      : null;
    if (parsed.regenerateFromEpisode) {
      const targetEpisodeCount = Number(previousRewrite?.targetEpisodeCount);
      if (
        !previousRewrite
        || typeof project.novelText !== 'string'
        || !project.novelText.trim()
        || !String(previousRewrite.analysisFingerprint ?? '')
        || !String(previousRewrite.sourceScript ?? '')
        || !String(previousRewrite.initialOutline ?? previousRewrite.outline ?? '')
        || !String(previousRewrite.directorBoard ?? '')
        || !Number.isInteger(targetEpisodeCount)
      ) {
        return apiFail({
          error: '该项目没有可验证的完整重写断点，请先执行一次完整重写',
          code: 'RECOVERY_NOT_AVAILABLE',
        }, 409);
      }
      if (parsed.regenerateFromEpisode > targetEpisodeCount) {
        return apiFail({
          error: `重生成起点不能超过第 ${targetEpisodeCount} 集`,
          code: 'RECOVERY_EPISODE_OUT_OF_RANGE',
        }, 400);
      }
    }

    // 扩展名校验（basename 防路径穿越；mkv 的 MIME 常缺失故只认扩展名）。
    const filename = parsed.filename.split(/[\\/]/).pop() ?? parsed.filename;
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      return apiFail(
        { error: '仅支持 MP4 / WebM / MOV / MKV 视频', code: 'INVALID_FILE_TYPE' },
        400,
      );
    }

    // 计算分段方案（按时长 + 字节双约束，单段 ≤48MiB / ≤600s）。
    const plan = calculateKimiSegmentPlan(parsed.totalDurationSec, parsed.totalBytes);

    const taskId = genId();
    const input = {
      videoUrl: parsed.videoUrl,
      sourceFilename: filename,
      segments: plan.segmentCount,
      projectId,
      userId: auth.userId,
      totalDurationSec: parsed.totalDurationSec,
      totalBytes: parsed.totalBytes,
      segmentSec: plan.segmentDurationSec,
      kimiModel: parsed.kimiModel ?? 'kimi-k2.6',
      outlineModel: parsed.outlineModel ?? 'deepseek/deepseek-v4-flash',
      rewriteModel: parsed.rewriteModel ?? 'deepseek/deepseek-v4-flash',
      ...(parsed.regenerateFromEpisode
        ? {
            regenerateFromEpisode: parsed.regenerateFromEpisode,
            reuseTargetStageDraft: parsed.reuseTargetStageDraft === true,
            previousNovelText: typeof project.novelText === 'string' ? project.novelText : '',
            previousLongVideoRewrite: previousRewrite ?? {},
            sourceScriptOverride: String(previousRewrite?.sourceScript ?? ''),
          }
        : {}),
    };

    const job = await dispatchLongVideoRewrite(taskId, auth.userId, input);

    // 初始化进度（splitting 0%，带 taskId 供 UI 恢复轮询）。
    await projectRepo.update(projectId, {
      longVideoProgress: {
        taskId,
        stage: 'splitting',
        progress: 0,
        currentStep: '任务已入队',
        updatedAt: new Date().toISOString(),
      },
    });

    return apiSuccess({
      taskId,
      renderJobId: job.id,
      segmentPlan: {
        segmentCount: plan.segmentCount,
        segmentDurationSec: plan.segmentDurationSec,
        totalDurationSec: plan.totalDurationSec,
        maxSegmentSec: plan.maxSegmentSec,
      },
    });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/original-video-upload');
  }
}
