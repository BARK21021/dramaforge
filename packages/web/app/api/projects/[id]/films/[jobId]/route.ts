// ============================================================
// DELETE /api/projects/[id]/films/[jobId] — 删成片（批8 Step 6）
// ============================================================
//
// 删 render_jobs 行（DB 元数据）。客户端本地文件由前端 FilmLibraryPanel
// 调 IPC sfShell.removeFilm(localKey) 删（best-effort，GC-7 / dramaforge-assets-client-local
// 双面清理）。本 route 只清 DB，不碰服务器存储（服务器零媒体字节）。
//
// 鉴权：session REQUIRED + project ownership + render_job 属当前用户。
// 响应：
//   200 { success:true, data: { deleted: true, localKey: string|null } }
//   401 / 404
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { projectRepo, query } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

interface DeleteRow {
  id: string;
  user_id: string;
  type: string;
  result: unknown;
}

function readLocalKey(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { meta?: { localKey?: unknown } | null };
  if (r.meta && typeof r.meta.localKey === 'string') return r.meta.localKey;
  return null;
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, jobId } = await params;

    // 项目不存在和项目不属于当前用户使用同一个 404，避免泄露项目是否真实存在。
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 查 render_job 校验归属 + 类型（不校验 input.filmMeta.projectId === projectId，
    // 因为前端可能从全局入口删成片；只校验 userId 是当前登录用户即可——DB 行只能
    // 由该用户派发，type 限定 CONCAT/CHAIN_COMPILE 即可）
    const selectRes = await query(
      `SELECT id, user_id, type, result
         FROM render_jobs
        WHERE id = $1
          AND user_id = $2
          AND type IN ('CONCAT', 'CHAIN_COMPILE')`,
      [jobId, auth.userId],
    );
    const row = selectRes.rows[0] as DeleteRow | undefined;
    if (!row) {
      return apiFail({ error: '成片记录不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 删 DB 行
    await query(`DELETE FROM render_jobs WHERE id = $1 AND user_id = $2`, [
      jobId,
      auth.userId,
    ]);

    // 返 localKey 供前端删本地文件（best-effort，IPC 失败不阻断 DB 删除）
    const localKey = readLocalKey(row.result);

    return apiSuccess({ deleted: true, localKey });
  } catch (err) {
    return handleApiError(err, 'DELETE /api/projects/[id]/films/[jobId]');
  }
}
