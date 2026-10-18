// ============================================================
// POST /api/projects/[id]/video-to-script-full — 视频转剧本完整版（转绘 X4.1）
// ============================================================
//
// 对齐 app1 api/projects/[projectId]/video-to-script-full/route.ts。在 X2 单集基础上
// 增加 3 步（app1 同款）：
//   1. 未指定 episodeId → 自动创建新分集（episodeRepo.create，集号 service 自增）
//   2. 把剧本写进 episode.scriptData（merge：novelText/characters/locations/timePeriod
//      /videoFilename/processedAt）+ videoScriptDraft
//   3. 推进 episode.stageStatus input→analyzing + project.status DRAFT→SCREENWRITING
//
// app1 processVideoToScriptCore（含 Whisper/OCR/声纹）→ dramaforge callAI('kimi',
// video_to_script)（Kimi-only，砍 Whisper/OCR，与 X2 一致）。复用 web/lib/video-to-script
// 的 runVideoToScript（X2/X4.1/X4.2 共用）。
//
// C/S 铁律：GC-1 key 只在 server；dramaforge-assets-client-local 视频字节 server RAM 透传 Kimi
// 不落盘（与 X2 同，≤100MB 单集）。
//
// Body（multipart）：video(必) / model? / episodeId? / episodeTitle?
// 鉴权 + ownership：requireUser → project 归属 →（若带 episodeId）episode 属 project。
// 响应：200 { success:true, data:{ script, characters, locations, timePeriod, episodeId, persistedTo } }
//       400 NO_FILE/INVALID_FILE_TYPE/FILE_TOO_LARGE / 404 / 502 EMPTY_SCRIPT/PROVIDER_ERROR
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { episodeRepo, projectRepo, GatewayError } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { runVideoToScript, EmptyScriptError } from '@web/lib/video-to-script';

export const runtime = 'nodejs';
export const maxDuration = 600;
export const dynamic = 'force-dynamic';

// 与 Next body 上限（proxyClientMaxBodySize 110mb）对齐：留 10mb 余量，超过即
// 显式 400 FILE_TOO_LARGE（否则会被 Next 层直接拒，错误不友好）。1GB 旧值是死代码。
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED_VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv'];

function asString(v: FormDataEntryValue | null): string | null {
  return typeof v === 'string' ? v : null;
}

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
    // Kimi 视频转剧本调用之前；非精确预检，真实扣费在成功后。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    const formData = await req.formData();
    const file = formData.get('video') as File | null;
    if (!file) {
      return apiFail({ error: '未提供视频文件', code: 'NO_FILE' }, 400);
    }

    // 类型校验（扩展名优先，mkv MIME 常缺失）
    const lowerName = file.name.toLowerCase();
    const okExt = ALLOWED_VIDEO_EXT.some((ext) => lowerName.endsWith(ext));
    const okMime = typeof file.type === 'string' && file.type.startsWith('video/');
    if (!okExt && !okMime) {
      return apiFail(
        { error: '仅支持 MP4 / WebM / MOV / MKV 视频', code: 'INVALID_FILE_TYPE' },
        400,
      );
    }
    if (file.size > MAX_VIDEO_SIZE) {
      return apiFail(
        {
          error: `视频过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大支持 1GB`,
          code: 'FILE_TOO_LARGE',
        },
        400,
      );
    }
    if (file.size === 0) {
      return apiFail({ error: '视频文件为空', code: 'INVALID_FILE_TYPE' }, 400);
    }

    // UI 下拉传带前缀的 "kimi/kimi-k2.6"，callAI('kimi', ...) 不剥前缀，
    // 手动剥掉，否则 Kimi 收到 "kimi/kimi-k2.6" 报 404 Not found the model。
    const rawModel = (asString(formData.get('model'))?.trim()) || 'kimi-k2.6';
    const model = rawModel.startsWith('kimi/') ? rawModel.slice(5) : rawModel;
    const episodeIdParam = asString(formData.get('episodeId'));
    const episodeTitle = asString(formData.get('episodeTitle'));

    // 1. 确定目标分集：带 episodeId 则校验归属；否则自动创建
    let episodeId: string;
    let existingScriptData: Record<string, unknown>;
    if (episodeIdParam) {
      const episode = await episodeRepo.getById(episodeIdParam);
      if (!episode || episode.projectId !== projectId) {
        return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
      }
      episodeId = episodeIdParam;
      existingScriptData =
        episode.scriptData &&
        typeof episode.scriptData === 'object' &&
        !Array.isArray(episode.scriptData)
          ? (episode.scriptData as Record<string, unknown>)
          : {};
    } else {
      const created = await episodeRepo.create(
        projectId,
        episodeTitle ? { title: episodeTitle } : {},
      );
      episodeId = created.id;
      existingScriptData = {};
    }

    // 2. 视频转剧本（复用 X2 helper：callAI Kimi，Kimi-only 砍 Whisper/OCR）
    const videoBytes = Buffer.from(await file.arrayBuffer());
    const outcome = await runVideoToScript({
      userId: auth.userId,
      videoBytes,
      filename: file.name || 'video.mp4',
      mimeType: file.type || 'video/mp4',
      model,
    });

    // 成功后扣费（对齐 generate-image / long-video-text）：按 token 成本归因，余额不足
    // 重抛 402 → 不交付、不落库（"不够扣就不让用"）。
    await billDirectGeneration({
      userId: auth.userId,
      result: { url: '', meta: {}, cost: outcome.cost ?? undefined },
      description: '完整版视频转剧本',
      taskType: 'VIDEO_TO_SCRIPT_FULL',
    });

    // 3. 写 episode.scriptData（merge，对齐 app1）+ videoScriptDraft + stage 推进
    const scriptData: Record<string, unknown> = {
      ...existingScriptData,
      novelText: outcome.script,
      characters: outcome.characters,
      locations: outcome.locations,
      timePeriod: outcome.timePeriod,
      videoFilename: file.name,
      processedAt: new Date().toISOString(),
      // 转剧本模型 = 资产提取模型（REFERENCE_VIDEO 用户共用一个下拉）：
      // EPISODE_SPLIT/手动重提取据此用同一模型继续提资产。
      videoToScriptModel: model,
    };
    await episodeRepo.update(episodeId, {
      videoScriptDraft: outcome.script,
      scriptData,
      stageStatus: 'analyzing',
    });

    // 4. 项目 DRAFT → SCREENWRITING（对齐 app1）
    if (project.status === 'DRAFT') {
      await projectRepo.update(projectId, {
        status: 'SCREENWRITING',
        // 同步写 project.novelText，让 whole-script-asset-extraction 能直接读到
        // 剧本（否则它只读 project.novelText，读不到 episode 里的，报 400）。
        novelText: outcome.script,
      });
    } else {
      await projectRepo.update(projectId, { novelText: outcome.script });
    }

    return apiSuccess({
      script: outcome.script,
      characters: outcome.characters,
      locations: outcome.locations,
      timePeriod: outcome.timePeriod,
      fileId: outcome.fileId,
      episodeId,
      persistedTo: 'episode',
    });
  } catch (err) {
    if (err instanceof EmptyScriptError) {
      return apiFail({ error: err.message, code: 'EMPTY_SCRIPT' }, 502);
    }
    if (err instanceof GatewayError) {
      const status = err.status ?? 502;
      const retryable = err.retryAfter !== null || status === 429 || status >= 500;
      return apiFail(
        { error: err.message, code: 'PROVIDER_ERROR', category: 'provider', retryable },
        status,
      );
    }
    return handleApiError(err, 'POST /api/projects/[id]/video-to-script-full');
  }
}
