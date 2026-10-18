// ============================================================
// POST/DELETE /api/projects/[id]/reference-video/clips — 参考视频切片元数据
// ============================================================
//
// 国外转绘 REFERENCE_VIDEO：客户端在本地把原视频切成切片（ffmpeg，≤15s、
// 720p 封顶），经 POST /api/storage/presign 拿 presigned PUT URL 直传 MinIO。
// 本路由只收**零字节元数据**（H1：服务器零媒体字节），写进
// project.scriptData.referenceVideo；chain-generate 时据此按场景对齐签发
// presignDownload URL 给 ARK 拉取。
//
// 鉴权 + 归属：requireUser → projectRepo.getById → 校验 userId。
// fileKey 白名单：只接受 `uploads/<userId>/reference-video/<projectId>/clip-<i>.mp4`
// 严格格式（用户/项目都由服务端锁死，客户端无法注入任意 key）。
//
//   POST body: { clips: ReferenceVideoClipMeta[], sourceDurationSec: number }
//   POST 响应: 200 { success:true, data: { clips, sourceDurationSec } }
//   DELETE 响应: 200 { success:true }（幂等；同时 best-effort 删 MinIO 对象）
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo, getStorage } from '@dramaforge/server';
import {
  REFERENCE_VIDEO_CLIP_MAX_SEC,
  REFERENCE_VIDEO_MAX_CLIPS,
} from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** 24h：超过此年龄的切片对象视为孤儿（客户端 chain 失败/中断），POST 时 lazy sweep。 */
const CLIP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const clipSchema = z.object({
  index: z.number().int().min(0),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  durationSec: z.number().positive().max(REFERENCE_VIDEO_CLIP_MAX_SEC + 0.5),
  fileKey: z.string().min(1).optional(),
  height: z.number().int().positive().max(720),
});

const bodySchema = z.object({
  clips: z.array(clipSchema).min(1).max(REFERENCE_VIDEO_MAX_CLIPS),
  sourceDurationSec: z.number().positive(),
});

/** fileKey 严格白名单：`uploads/<userId>/reference-video/<projectId>/clip-<i>.mp4`。 */
function isAllowedClipKey(fileKey: string, userId: string, projectId: string): boolean {
  const prefix = `uploads/${userId}/reference-video/${projectId}/clip-`;
  if (!fileKey.startsWith(prefix)) return false;
  const idx = fileKey.slice(prefix.length);
  return /^\d+\.mp4$/.test(idx);
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

    let parsed: z.infer<typeof bodySchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = bodySchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    // fileKey 白名单：客户端若自带 fileKey，必须在 uploads/<userId>/reference-video/
    // <projectId>/clip-<i>.mp4 命名空间内，否则 403（防越权写到他人/他项目路径）。
    for (const clip of parsed.clips) {
      if (clip.fileKey && !isAllowedClipKey(clip.fileKey, auth.userId, projectId)) {
        return apiFail({ error: '非法 fileKey：不在本用户+项目的切片命名空间内', code: 'INVALID_FILE_KEY' }, 403);
      }
    }

    // 生成 fileKey + presigned PUT URL（客户端不知道 userId，服务端统一签发）。
    const CLIP_UPLOAD_TTL_SEC = 600;
    const clipsWithKeys = await Promise.all(
      parsed.clips.map(async (clip) => {
        const fileKey = clip.fileKey ?? `uploads/${auth.userId}/reference-video/${projectId}/clip-${clip.index}.mp4`;
        const uploadUrl = await getStorage().presignUpload(fileKey, CLIP_UPLOAD_TTL_SEC);
        return { ...clip, fileKey, uploadUrl };
      }),
    );

    // lazy sweep：清掉本项目下超 24h 的旧切片对象（有界瞬态闭环的一部分）。
    const prev = (project.scriptData as Record<string, unknown> | null)?.referenceVideo as
      | { clips?: Array<{ fileKey?: string; uploadedAt?: string }>; uploadedAt?: string }
      | undefined;
    if (prev?.clips?.length) {
      const now = Date.now();
      const stale = prev.clips.filter((c) => {
        const t = typeof prev.uploadedAt === 'string' ? Date.parse(prev.uploadedAt) : NaN;
        return Number.isFinite(t) && now - t > CLIP_MAX_AGE_MS;
      });
      await Promise.all(
        stale
          .map((c) => c.fileKey)
          .filter((k): k is string => typeof k === 'string')
          .map((key) => getStorage().delete(key).catch(() => undefined)),
      );
    }

    const referenceVideo = {
      clips: clipsWithKeys.map(({ uploadUrl: _u, ...rest }) => rest),
      sourceDurationSec: parsed.sourceDurationSec,
      uploadedAt: new Date().toISOString(),
    };
    const updated = await projectRepo.update(projectId, {
      scriptData: { referenceVideo },
    });
    const saved = (updated.scriptData as Record<string, unknown> | null)?.referenceVideo;
    return apiSuccess({
      clips: saved ?? referenceVideo,
      sourceDurationSec: parsed.sourceDurationSec,
      uploadUrls: Object.fromEntries(clipsWithKeys.map((c) => [c.index, c.uploadUrl])),
    });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/reference-video/clips');
  }
}

export async function DELETE(
  _req: NextRequest,
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

    const prev = (project.scriptData as Record<string, unknown> | null)?.referenceVideo as
      | { clips?: Array<{ fileKey?: string }> }
      | undefined;
    // best-effort 删 MinIO 对象（幂等；对象不存在视为已删）。
    if (prev?.clips?.length) {
      await Promise.all(
        prev.clips
          .map((c) => c.fileKey)
          .filter((k): k is string => typeof k === 'string' && isAllowedClipKey(k, auth.userId, projectId))
          .map((key) => getStorage().delete(key).catch(() => undefined)),
      );
    }

    // 清掉 scriptData.referenceVideo（JSONB 浅合并：null 会被浅合并覆盖掉顶层键）。
    await projectRepo.update(projectId, { scriptData: { referenceVideo: null } });
    return apiSuccess({ deleted: true });
  } catch (err) {
    return handleApiError(err, 'DELETE /api/projects/[id]/reference-video/clips');
  }
}

// ============================================================
// PATCH — persist ReferenceVideoStage phase to scriptData
// ============================================================
// Body: { phase: string }
// Updates project.scriptData.referenceVideo.phase (shallow merge with existing referenceVideo).
// Called by the frontend on each phase transition so progress survives refresh/restart.
const phaseSchema = z.object({ phase: z.string().min(1).max(50) });

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;
    const project = await projectRepo.getById(projectId);
    if (!project) return apiFail({ error: '项目不存在', code: 'NOT_FOUND' }, 404);
    if (project.userId !== auth.userId) {
      return apiFail({ error: '无权访问此项目', code: 'FORBIDDEN' }, 403);
    }

    const body = await req.json();
    const parsed = phaseSchema.safeParse(body);
    if (!parsed.success) {
      return apiFail({ error: '无效的 phase', code: 'VALIDATION_ERROR' }, 400);
    }

    // Shallow merge: preserve existing referenceVideo fields, add/update phase
    const prev = (project.scriptData as Record<string, unknown> | null)?.referenceVideo as
      | Record<string, unknown>
      | null;
    const referenceVideo = { ...(prev ?? {}), phase: parsed.data.phase, phaseUpdatedAt: new Date().toISOString() };
    await projectRepo.update(projectId, { scriptData: { referenceVideo } });
    return apiSuccess({ phase: parsed.data.phase });
  } catch (err) {
    return handleApiError(err, 'PATCH /api/projects/[id]/reference-video/clips');
  }
}
