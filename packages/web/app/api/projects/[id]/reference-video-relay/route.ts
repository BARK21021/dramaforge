// ============================================================
// POST/GET/DELETE /api/projects/[id]/reference-video-relay
// ============================================================
//
// 临时中继：让客户端本地视频切片经 MinIO presigned URL 暴露为 HTTPS，
// 供火山引擎 Seedance API 拉取（reference_video 入参只认 HTTPS URL）。
//
// 背景（H1：服务器零媒体字节 + 有界瞬态）：
//   - 客户端视频字节只在本地（sf-asset://），Seedance 需 HTTPS 才能拉。
//   - MinIO/COS 后端的 presignDownload 返回真实 HTTPS URL；local 后端返
//     localhost（不能用）——云端与本地开发均用 MinIO。
//   - 流程：客户端 POST 拿 PUT URL 直传 → GET 拿 GET URL 喂给 Seedance
//     （ARK 20 分钟轮询，故下载 TTL 给 30 分钟）→ DELETE 清掉中继对象。
//
// 鉴权 + 归属 + gate：requireUser → projectRepo.getById → 校验 userId；
// 只允许 OVERSEAS + scriptData.sourceMode==='REFERENCE_VIDEO' 的项目。
// storageKey 严格白名单 `uploads/reference-video-relay/<projectId>/`（防穿越）。
//
//   POST   body { mime?: string }             -> { uploadUrl, storageKey }
//   GET    ?storageKey | body { storageKey }  -> { downloadUrl }
//   DELETE body { storageKey }                -> { ok: true }
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo, getStorage } from '@dramaforge/server';
import { genId } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** 中继命名空间前缀（防路径穿越的 load-bearing 锚点）。 */
const RELAY_PREFIX = (projectId: string): string =>
  `uploads/reference-video-relay/${projectId}/`;

/** PUT URL 有效期：10 分钟，覆盖客户端单次直传。 */
const UPLOAD_TTL_SEC = 600;
/** GET URL 有效期：30 分钟，覆盖 ARK 20 分钟轮询。 */
const DOWNLOAD_TTL_SEC = 1800;

/**
 * storageKey 白名单：必须严格以本项目命名空间开头，且不含 `..` / 反斜杠 /
 * 绝对路径前缀（防穿越到任意对象 key）。
 */
function isAllowedRelayKey(storageKey: string, projectId: string): boolean {
  if (
    storageKey.includes('..') ||
    storageKey.includes('\\') ||
    storageKey.startsWith('/')
  ) {
    return false;
  }
  return storageKey.startsWith(RELAY_PREFIX(projectId));
}

/**
 * 三方法共享的鉴权 + 归属 + gate。
 * 成功返回 { auth, projectId }；失败返回可直接 return 的 Response。
 */
async function loadRelayProject(
  params: { id: string },
): Promise<
  | { ok: true; auth: NonNullable<Awaited<ReturnType<typeof requireUser>>>; projectId: string }
  | { ok: false; response: Response }
> {
  const auth = await requireUser();
  if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

  const { id: projectId } = params;
  const project = await projectRepo.getById(projectId);
  if (!project || project.userId !== auth.userId) {
    return {
      ok: false,
      response: apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404),
    };
  }

  // gate：仅海外参考视频转绘项目可用本中继。
  const scriptData = (project.scriptData as Record<string, unknown> | null) ?? {};
  const sourceMode =
    typeof scriptData.sourceMode === 'string' ? scriptData.sourceMode : '';
  if (project.category !== 'OVERSEAS' || sourceMode !== 'REFERENCE_VIDEO') {
    return {
      ok: false,
      response: apiFail(
        {
          error: '该中继仅支持海外参考视频转绘（OVERSEAS + REFERENCE_VIDEO）项目',
          code: 'UNSUPPORTED_SOURCE_MODE',
        },
        400,
      ),
    };
  }

  return { ok: true, auth, projectId };
}

const postBodySchema = z.object({
  mime: z.string().min(1).optional(),
});

// ============================================================
// POST — 签发 presigned PUT URL（客户端直传视频字节到 MinIO）
// ============================================================
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const loaded = await loadRelayProject(await params);
    if (!loaded.ok) return loaded.response;
    const { projectId } = loaded;

    let parsed: z.infer<typeof postBodySchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = postBodySchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    // 生成不可猜的对象 key（UUID v4）；扩展名固定 mp4（Seedance 参考视频格式）。
    const storageKey = `${RELAY_PREFIX(projectId)}${genId()}.mp4`;
    const uploadUrl = await getStorage().presignUpload(storageKey, UPLOAD_TTL_SEC);

    return apiSuccess({ uploadUrl, storageKey });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/reference-video-relay');
  }
}

// ============================================================
// GET — 签发 presigned download URL（喂给 Seedance / ARK 轮询拉取）
// ============================================================
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const loaded = await loadRelayProject(await params);
    if (!loaded.ok) return loaded.response;
    const { projectId } = loaded;

    // storageKey 来自 query 或 body（兼容两种调用方式；GET 通常用 query）。
    let storageKey: string | undefined =
      req.nextUrl.searchParams.get('storageKey') ?? undefined;
    if (!storageKey) {
      try {
        const body = (await req.json()) as { storageKey?: unknown };
        if (typeof body.storageKey === 'string') storageKey = body.storageKey;
      } catch {
        // 无 body / 非 JSON：落到下面的必填校验。
      }
    }
    if (!storageKey) {
      return apiFail({ error: '缺少 storageKey', code: 'MISSING_STORAGE_KEY' }, 400);
    }
    if (!isAllowedRelayKey(storageKey, projectId)) {
      return apiFail(
        { error: 'storageKey 不属于当前项目命名空间', code: 'FORBIDDEN' },
        403,
      );
    }

    const downloadUrl = await getStorage().presignDownload(
      storageKey,
      DOWNLOAD_TTL_SEC,
    );
    return apiSuccess({ downloadUrl });
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/reference-video-relay');
  }
}

const deleteBodySchema = z.object({
  storageKey: z.string().min(1),
});

// ============================================================
// DELETE — 清理中继文件（有界瞬态：生成完即删）
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const loaded = await loadRelayProject(await params);
    if (!loaded.ok) return loaded.response;
    const { projectId } = loaded;

    let parsed: z.infer<typeof deleteBodySchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = deleteBodySchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    if (!isAllowedRelayKey(parsed.storageKey, projectId)) {
      return apiFail(
        { error: 'storageKey 不属于当前项目命名空间', code: 'FORBIDDEN' },
        403,
      );
    }

    // 幂等：对象不存在视为已删（StorageBackend.delete 契约保证不抛错）。
    await getStorage().delete(parsed.storageKey);
    return apiSuccess({ ok: true });
  } catch (err) {
    return handleApiError(err, 'DELETE /api/projects/[id]/reference-video-relay');
  }
}