// ============================================================
// GET  /api/storage/presign — 把稳定对象 key 换成短寿命 presigned GET URL
// POST /api/storage/presign — 为参考视频切片签发 presigned PUT URL
// ============================================================
//
// GET 作用：UI 在 CONCAT 等作业完成后拿到 meta.outputKey（稳定 key，例如
// `renders/<userId>/<jobId>.mp4`），但 key 不是浏览器可 fetch 的 URL。
// 本路由由 web 服务端用存储后端私钥签发一条短寿命 presigned GET URL，
// 供 UI 直接 <video src> / fetch 下载。
//
// POST 作用（国外转绘 REFERENCE_VIDEO）：客户端把本地切割好的参考视频切片
// 直传 MinIO。web 只签发 presigned PUT URL，**字节客户端直传、ARK 直拉
// presignDownload URL，服务器零字节落地**（H1 有界瞬态例外注记见
// docs/known-issues/architecture-and-migration.md）。key 完全由服务端生成
// （`uploads/<userId>/reference-video/<projectId>/clip-<i>.mp4`），客户端不可
// 指定 key —— 杜绝任意路径 PUT。切片用完即删（客户端 chain 完成后 DELETE
// + POST 时 lazy sweep 超 24h 旧 key）。
//
// GET 鉴权（load-bearing —— 越权下载他人对象是 P0 安全问题）：
//   1. requireUser() → 401 if 未登录。
//   2. key 非空校验 → 400 VALIDATION_ERROR。
//   3. **路径规范化**：先按 `/` 切段，剔除 `.` 与空段，应用 `..` 回退，
//      得到 normalized key。原 key 中的 `..`（含 URL-encoded `%2E%2E`，
//      searchParams 已自动解码）必须在授权前被解析掉，否则
//      `renders/userA/../userB/x` 会绕过朴素的 startsWith 检查。
//   4. 授权：normalized 必须以 `renders/${userId}/` 或 `uploads/${userId}/`
//      开头，否则 403 FORBIDDEN，且 presignDownload 一律不调用。
//   5. 用 normalized key 调 getStorage().presignDownload →
//      { success:true, data:{ url } }。
//
// 响应（UI-facing envelope，GC-4）：
//   200 { success:true, data: { url } }（GET）/
//       { success:true, data: { keys, urls } }（POST）
//   400 { success:false, error, code:'VALIDATION_ERROR' } — key 缺失/空 / count 越界
//   401 { success:false, error, code:'UNAUTHORIZED' }
//   403 { success:false, error, code:'FORBIDDEN' } — 跨用户前缀 / 裸 key / 穿越
//   404 { success:false, error, code:'NOT_FOUND' } — 项目不存在或非本人
//   500 { success:false, error, code:'INTERNAL_ERROR' } — presign 抛错等
//
// web 禁止 import 任何 ffmpeg 模块；本路由只读取 session 与调用存储后端。
// ============================================================

import type { NextRequest } from 'next/server';
import { getStorage, projectRepo } from '@dramaforge/server';
import {
  REFERENCE_VIDEO_MAX_CLIPS,
  REFERENCE_VIDEO_PRESIGN_TTL_SEC,
} from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/**
 * 把对象 key 规范化：按 `/` 切段，丢弃空段与 `.`，应用 `..` 回退。
 *
 * 这是 S3-style key 的纯字符串规范化（不依赖 node:path —— 因为 node:path
 * 在 Windows 上会把 `/` 转成 `\`，破坏 key 语义）。规范化后 `..` 已被吸收，
 * 授权 startsWith 检查再不会被 `renders/A/../B/x` 这种伪前缀骗过。
 *
 * 输入空字符串或纯 `..`/`.` 段时返回空串，调用方应据空串判定 403。
 *
 * 仅在本文件内部使用，不导出。
 */
function normalizeObjectKey(key: string): string {
  const segments: string[] = [];
  for (const seg of key.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join('/');
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    // 1) 鉴权
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    // 2) 取 key（searchParams 自动 URL-decode，%2E%2E → ..）
    const rawKey = new URL(req.url).searchParams.get('key') ?? '';
    const key = rawKey.trim();
    if (!key) {
      return apiFail(
        { error: '缺少 key 参数', code: 'VALIDATION_ERROR', category: 'validation' },
        400,
      );
    }

    // 3) 规范化 —— 在授权前把 `..` 解析掉
    const normalized = normalizeObjectKey(key);

    // 4) 授权：normalized key 必须落在当前用户的 renders/ 或 uploads/ 命名空间下
    const allowed =
      normalized.startsWith(`renders/${auth.userId}/`) ||
      normalized.startsWith(`uploads/${auth.userId}/`);
    if (!allowed) {
      return apiFail(
        { error: '无权访问该对象', code: 'FORBIDDEN', category: 'auth' },
        403,
      );
    }

    // 5) 签发 presigned GET URL —— 用规范化后的 key，杜绝任何残留歧义
    const url = await getStorage().presignDownload(normalized);
    return apiSuccess({ url });
  } catch (err) {
    return handleApiError(err, 'GET /api/storage/presign');
  }
}

/**
 * POST /api/storage/presign — 参考视频切片 presigned PUT。
 *
 * body: { projectId: string, count: number }（1..REFERENCE_VIDEO_MAX_CLIPS）
 * 服务端生成全部 key（`uploads/<userId>/reference-video/<projectId>/clip-<i>.mp4`），
 * 返回 { keys, urls } 一一对应。TTL 7 天（MinIO presign 上限），切片是
 * 有界瞬态对象：客户端 chain 完成后 DELETE，过期 key 由 POST 时 lazy sweep。
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    // 1) body 解析 + 校验
    const raw = (await req.json().catch(() => null)) as {
      projectId?: unknown;
      count?: unknown;
    } | null;
    const projectId = raw?.projectId;
    const count = raw?.count;
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return apiFail({ error: '缺少 projectId', code: 'VALIDATION_ERROR', category: 'validation' }, 400);
    }
    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > REFERENCE_VIDEO_MAX_CLIPS
    ) {
      return apiFail(
        { error: `count 必须在 1..${REFERENCE_VIDEO_MAX_CLIPS} 之间`, code: 'VALIDATION_ERROR', category: 'validation' },
        400,
      );
    }

    // 2) 项目归属校验（load-bearing：越权给他人项目签 PUT URL 是 P0）
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 3) 服务端生成 key + 签发 PUT URL（客户端不可指定 key → 杜绝任意路径 PUT）
    const keys = Array.from(
      { length: count },
      (_, i) => `uploads/${auth.userId}/reference-video/${projectId}/clip-${i}.mp4`,
    );
    const urls = await Promise.all(
      keys.map((key) => getStorage().presignUpload(key, REFERENCE_VIDEO_PRESIGN_TTL_SEC)),
    );
    return apiSuccess({ keys, urls });
  } catch (err) {
    return handleApiError(err, 'POST /api/storage/presign');
  }
}
