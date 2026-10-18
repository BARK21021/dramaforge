// ============================================================
// POST /api/projects/[id]/episodes/[episodeId]/video-to-script — 单集视频转剧本（转绘 X2）
// ============================================================
//
// 上传单集视频（≤100MB，mp4/webm/mov/mkv）→ 云端 Kimi 视频理解（extractVideoContext
// + generateScriptFromVideo，Kimi-only 砍 Whisper/OCR）→ 拿到结构化剧本 → 落
// episode.videoScriptDraft → 返回前端切文本 Tab 展示/编辑。对齐 app1
// api/projects/[projectId]/video-to-script/route.ts（app1 是项目级 + episodeId 可选，
// dramaforge 永远 episode 上下文故改 episode 级）。
//
// C/S 铁律：
//   - GC-1：Kimi key 只在 server（callAI cred 直传），绝不下发 client
//   - dramaforge-assets-client-local：新客户端正文以流直接接力 Kimi Files API，不落盘、
//     不转 base64、不整段驻留 RAM；旧 multipart 客户端保留受限 Buffer 回退。
//
// 鉴权 + ownership：requireUser → project 归属 → episode 属于 project，任一失败统一 404。
// 响应（UI-facing envelope）：
//   200 { success:true, data:{ script, characters, locations, timePeriod?, persistedTo:'episode' } }
//   400 INVALID_FILE_TYPE / FILE_TOO_LARGE / NO_FILE
//   401 / 404 / 429|5xx Kimi 暂时失败(retryable) / 500
// 新 raw 页面会在 X-SF-Task-Id 传浏览器 UUID；route 同步处理媒体流的同时把真实
// 阶段写入 tasks 并发布 SSE。未带该头的旧 multipart/raw 调用仍只使用同步响应。
//
// body size：Next.js app router 默认对 route segment 不硬限（自托管 docker），route 内
// 显式 runtime=nodejs/maxDuration=600（2 次 Kimi chat，自托管无 Vercel 300s 限制）。
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  GatewayError,
  episodeRepo,
  projectRepo,
  startInlineAiTask,
  reportInlineAiTaskProgress,
  completeInlineAiTask,
  failInlineAiTask,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import {
  runVideoToScript,
  EmptyScriptError,
  type VideoToScriptProgressEvent,
} from '@web/lib/video-to-script';

export const runtime = 'nodejs';
export const maxDuration = 600;
export const dynamic = 'force-dynamic';

/** 最大 100MB（与 app1 route.ts:39 一致；Kimi Files API 单文件 100MiB 上限）。 */
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const ALLOWED_VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv'];
/** 浏览器生成的 UUID 只用于关联 tasks/SSE；拒绝任意长文本污染任务主键。 */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Kimi 的真实边界事件映射为稳定的 UI 进度节点，不使用时间推算。 */
const VIDEO_PROGRESS_STAGES: Record<
  VideoToScriptProgressEvent['stage'],
  { progress: number; label: string; stageProgress: number }
> = {
  file_received: { progress: 25, label: '文件已接收', stageProgress: 100 },
  extracting_context: { progress: 35, label: '正在提取角色和场景', stageProgress: 0 },
  context_extracted: { progress: 55, label: '角色和场景提取完成', stageProgress: 100 },
  generating_script: { progress: 65, label: '正在生成剧本', stageProgress: 0 },
  script_generated: { progress: 88, label: '剧本生成完成', stageProgress: 100 },
};

/** 大正文绕过 Proxy 后在路由内执行同等 Origin / Fetch Metadata 防护。 */
function rejectCrossSiteMutation(req: NextRequest): Response | null {
  const allowed = new Set(['https://your-domain.example.com', 'http://localhost:3000']);
  for (const raw of [process.env.SF_DEV_URL, process.env.NEXTAUTH_URL]) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      allowed.add(`${url.protocol}//${url.host}`);
    } catch {
      // 配置无效时不扩大允许范围，保持 fail-closed。
    }
  }
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if ((origin !== null && !allowed.has(origin))
    || (site !== null && !['same-origin', 'same-site', 'none'].includes(site))) {
    return apiFail({ error: 'Forbidden: cross-site mutation blocked', code: 'CSRF_FORBIDDEN' }, 403);
  }
  return null;
}

/** 解码只允许出现在 ASCII header 中的 UTF-8 文件名，非法编码回退安全文件名。 */
function decodeStreamFilename(raw: string | null): string {
  try {
    const decoded = decodeURIComponent(raw || 'video.mp4');
    return decoded.replace(/[\r\n]/g, '').trim() || 'video.mp4';
  } catch {
    return 'video.mp4';
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
): Promise<Response> {
  // 只有新 raw 流链路会携带 taskId；旧 multipart 调用保持原同步契约。
  let inlineTask: { id: string; userId: string } | null = null;
  try {
    const csrfFailure = rejectCrossSiteMutation(req);
    if (csrfFailure) return csrfFailure;
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, episodeId } = await params;

    // ownership 双层校验，统一 404
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 余额前置预检（对齐 app1 precheckBalance / generate-image / long-video-text）：
    // 0 积分挡在昂贵 Kimi 视频转剧本调用之前；非精确预检，真实扣费在成功后。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    const isVideoStream = req.headers.get('x-sf-video-stream') === '1';
    const requestedTaskId = req.headers.get('x-sf-task-id')?.trim() || null;
    if (requestedTaskId && (!isVideoStream || !TASK_ID_PATTERN.test(requestedTaskId))) {
      return apiFail({ error: '无效的视频任务 ID', code: 'INVALID_TASK_ID' }, 400);
    }
    let filename: string;
    let mimeType: string;
    let fileSize: number;
    let videoStream: ReadableStream<Uint8Array> | undefined;
    let videoBytes: Buffer | undefined;
    // 带前缀 model id：callKimi 的 extractModelId 去前缀给 Moonshot API；
    // 计费表 pricing.ts 的 key 也带前缀 → 命中计费（裸 kimi-k2.6 会查不到 → 0 扣，白烧 key）。
    let model = 'kimi/kimi-k2.6';
    let sourceDurationSeconds: number | undefined;

    if (isVideoStream) {
      // 新链路只读取元数据 header/query；正文保持 ReadableStream，绝不调用 arrayBuffer/formData。
      filename = decodeStreamFilename(req.headers.get('x-sf-video-name'));
      mimeType = req.headers.get('content-type')?.split(';', 1)[0].trim() || 'video/mp4';
      fileSize = Number(req.headers.get('x-sf-video-size'));
      videoStream = req.body ?? undefined;
      model = req.nextUrl.searchParams.get('model')?.trim() || model;
      const duration = Number(req.nextUrl.searchParams.get('sourceDurationSeconds'));
      sourceDurationSeconds = Number.isFinite(duration) && duration > 0 ? duration : undefined;
      if (!videoStream || !Number.isFinite(fileSize) || fileSize <= 0) {
        return apiFail({ error: '未提供有效的视频流', code: 'NO_FILE' }, 400);
      }
    } else {
      // 旧 1.1.6 页面/外部调用兼容：multipart 最多 100MiB，解析后立即交给网关。
      const formData = await req.formData();
      const file = formData.get('video') as File | null;
      if (!file) return apiFail({ error: '未提供视频文件', code: 'NO_FILE' }, 400);
      filename = file.name || 'video.mp4';
      mimeType = file.type || 'video/mp4';
      fileSize = file.size;
      const modelField = formData.get('model');
      model = typeof modelField === 'string' && modelField.trim() ? modelField.trim() : model;
      const duration = Number(formData.get('sourceDurationSeconds'));
      sourceDurationSeconds = Number.isFinite(duration) && duration > 0 ? duration : undefined;
      videoBytes = Buffer.from(await file.arrayBuffer());
    }

    // 类型校验（扩展名优先，mkv 的 MIME 常缺失）
    const lowerName = filename.toLowerCase();
    const okExt = ALLOWED_VIDEO_EXT.some((ext) => lowerName.endsWith(ext));
    const okMime = mimeType.startsWith('video/');
    if (!okExt && !okMime) {
      return apiFail(
        { error: '仅支持 MP4 / WebM / MOV / MKV 视频', code: 'INVALID_FILE_TYPE' },
        400,
      );
    }
    // 大小校验
    if (fileSize > MAX_VIDEO_SIZE) {
      return apiFail(
        {
          error: `视频过大（${(fileSize / 1024 / 1024).toFixed(1)}MB），最大支持 100MB`,
          code: 'FILE_TOO_LARGE',
        },
        400,
      );
    }
    if (fileSize === 0) {
      return apiFail({ error: '视频文件为空', code: 'INVALID_FILE_TYPE' }, 400);
    }

    if (requestedTaskId) {
      // tasks.input 只保存可检索元数据；视频正文仍由当前请求直接流向 Kimi。
      await startInlineAiTask({
        id: requestedTaskId,
        userId: auth.userId,
        projectId,
        type: 'VIDEO_TO_SCRIPT',
        progress: 8,
        stage: '正在上传视频',
        storedInput: {
          episodeId,
          filename,
          mimeType,
          videoSize: fileSize,
        },
      });
      inlineTask = { id: requestedTaskId, userId: auth.userId };
    }

    const onProgress = inlineTask
      ? async (event: VideoToScriptProgressEvent): Promise<void> => {
          const node = VIDEO_PROGRESS_STAGES[event.stage];
          await reportInlineAiTaskProgress(
            inlineTask!.id,
            inlineTask!.userId,
            node.progress,
            node.label,
            node.stageProgress,
          );
        }
      : undefined;

    const outcome = await runVideoToScript({
      userId: auth.userId,
      videoBytes,
      videoStream,
      videoSize: fileSize,
      filename,
      mimeType,
      model,
      onProgress,
    });

    // 成功后扣费（对齐 generate-image / long-video-text）：按 token 成本归因，余额不足
    // 重抛 402 → 落到外层 catch → 不交付、不落库（"不够扣就不让用"）。
    await billDirectGeneration({
      userId: auth.userId,
      result: { url: '', meta: {}, cost: outcome.cost ?? undefined },
      description: '单集视频转剧本',
      taskType: 'VIDEO_TO_SCRIPT',
    });

    // 落库 episode.videoScriptDraft（updateEpisodeSchema 白名单已含，service 已实现）
    if (inlineTask) {
      await reportInlineAiTaskProgress(inlineTask.id, inlineTask.userId, 95, '正在保存剧本', 0);
    }
    const previousScriptData = episode.scriptData && typeof episode.scriptData === 'object'
      ? episode.scriptData as Record<string, unknown>
      : {};
    await episodeRepo.update(episodeId, {
      videoScriptDraft: outcome.script,
      ...(sourceDurationSeconds !== undefined
        ? {
            scriptData: {
              ...previousScriptData,
              sourceVideoDurationSeconds: sourceDurationSeconds,
            },
          }
        : {}),
    });

    if (inlineTask) {
      // output 仅保存结果摘要；完整剧本以 episode.videoScriptDraft 为唯一持久化正文。
      await completeInlineAiTask(inlineTask.id, inlineTask.userId, {
        episodeId,
        persistedTo: 'episode',
        scriptLength: outcome.script.length,
        fileId: outcome.fileId,
      });
    }

    return apiSuccess({
      script: outcome.script,
      characters: outcome.characters,
      locations: outcome.locations,
      timePeriod: outcome.timePeriod,
      fileId: outcome.fileId,
      persistedTo: 'episode',
      sourceDurationSeconds: sourceDurationSeconds ?? null,
    });
  } catch (err) {
    if (inlineTask) {
      // SSE 只暴露稳定用户文案；原始 provider 错误仍由下方 HTTP 映射和服务端日志处理。
      const safeError = err instanceof EmptyScriptError
        ? err.message
        : '视频转剧本失败，请重试';
      try {
        await failInlineAiTask(inlineTask.id, inlineTask.userId, safeError);
      } catch (taskError) {
        console.error('[video-to-script] failed to persist inline task failure', {
          message: taskError instanceof Error ? taskError.message : String(taskError),
        });
      }
    }
    if (err instanceof EmptyScriptError) {
      // 观测性：Kimi 上传/chat 成功但返空剧本，落日志便于定位（前端只看到笼统 502）。
      console.error('[video-to-script] EMPTY_SCRIPT: Kimi 未返回有效剧本', {
        message: err.message,
      });
      return apiFail({ error: err.message, code: 'EMPTY_SCRIPT' }, 502);
    }
    if (err instanceof GatewayError) {
      const status = err.status ?? 502;
      const retryable = err.retryAfter !== null || status === 429 || status >= 500;
      // 观测性：provider 上游错误（含 Kimi 文件上传 400「no such file」等）必须落
      // docker logs，否则 web 容器对所有 502 静默，只能靠 api_configs.lastErrorMessage
      // 反查（见 dramaforge-kimi-chinese-filename-bug 排查经历）。
      console.error('[video-to-script] provider error', {
        status,
        message: err.message,
        retryAfter: err.retryAfter,
      });
      return apiFail(
        {
          error: err.message,
          code: 'PROVIDER_ERROR',
          category: 'provider',
          retryable,
        },
        status,
      );
    }
    return handleApiError(err, 'POST /api/projects/[id]/episodes/[episodeId]/video-to-script');
  }
}
