// ============================================================
// GET /api/projects/[id]/films — 项目成片列表（批8 Step 2）
// ============================================================
//
// 查询指定项目下 COMPLETED 的 CONCAT/CHAIN_COMPILE 候选，再按 app1 口径只保留
// 「分集全部镜头已生成、且任务覆盖镜头数等于分集总镜头数」的每集最终成片。
//
// Q1 选 A：直接查 render_jobs JSONB（零 schema 变更）。render_jobs 表无
// project_id/episode_id 列 → Step 1 chain-generate route + export-film route
// 已在 input.filmMeta 透传这些字段，本 route 提取即可。
//
// 媒体字节在客户端本地（批7 executor.ts CONCAT 写 filmsDir + sf-asset:// URL），
// 服务器只返元数据 + outputUrl（sf-asset://）。GC-7 / dramaforge-assets-client-local。
//
// 鉴权：session REQUIRED + project ownership。响应：
//   200 { success:true, data: FilmRecord[] }
//   401 / 404
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { getEpisodesCompletionMap, projectRepo, query } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/**
 * 成片记录（films route 返前端字段）。
 * - id: render_jobs.id（前端删成片 DELETE /films/[jobId] 用）
 * - type: 'CONCAT' | 'CHAIN_COMPILE'
 * - outputUrl: sf-asset:// URL（result.outputUrl，客户端本地）
 * - localKey: 客户端本地 clips/<localKey>.mp4（result.meta.localKey）
 *   —— 前端下载/删除 IPC 用（saveFilm/removeFilm）
 * - filmMeta.*: 卡片展示字段（episodeNumber/episodeTitle/shotCount/totalDuration）
 * - createdAt: ISO 字符串
 */
export interface FilmRecord {
  id: string;
  type: 'CONCAT' | 'CHAIN_COMPILE';
  outputUrl: string | null;
  localKey: string | null;
  episodeId: string | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  projectTitle: string | null;
  shotCount: number | null;
  totalDuration: number | null;
  createdAt: string;
}

interface FilmMetaRow {
  projectId?: string;
  episodeId?: string;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
  projectTitle?: string | null;
  shotIds?: unknown;
  shotCount?: number;
  totalDuration?: number;
}

interface RenderJobRow {
  id: string;
  type: 'CONCAT' | 'CHAIN_COMPILE';
  input: unknown;
  result: unknown;
  created_at: unknown;
}

function readMeta(input: unknown): FilmMetaRow | null {
  if (!input || typeof input !== 'object') return null;
  const meta = (input as { filmMeta?: unknown }).filmMeta;
  if (!meta || typeof meta !== 'object') return null;
  return meta as FilmMetaRow;
}

function readResult(result: unknown): {
  outputUrl?: string | null;
  localKey?: string | null;
} {
  if (!result || typeof result !== 'object') return {};
  const r = result as {
    outputUrl?: string | null;
    meta?: { localKey?: string | null } | null;
  };
  return {
    outputUrl: typeof r.outputUrl === 'string' ? r.outputUrl : null,
    localKey:
      r.meta && typeof r.meta.localKey === 'string' ? r.meta.localKey : null,
  };
}

function toIso(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;

    // ownership
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 先查用户的 COMPLETED CONCAT/CHAIN_COMPILE 候选；完成度门禁在下方统一执行。
    const result = await query(
      `SELECT id, type, input, result, created_at
         FROM render_jobs
        WHERE user_id = $1
          AND type IN ('CONCAT', 'CHAIN_COMPILE')
          AND status = 'COMPLETED'
        ORDER BY created_at DESC`,
      [auth.userId],
    );

    const rows = result.rows as RenderJobRow[];

    // app1 在返回成片前批量核验整集完成度；先收集可能进入当前项目成片库的分集，
    // 一次查询避免逐条 render_job 触发 N+1。
    const episodeIds = Array.from(new Set(rows.flatMap((row) => {
      const meta = readMeta(row.input);
      if (
        !meta
        || meta.projectId !== projectId
        || typeof meta.episodeId !== 'string'
      ) {
        return [];
      }
      return [meta.episodeId];
    })));
    const completionMap = await getEpisodesCompletionMap(episodeIds);

    // 从 input.filmMeta 提取 projectId 过滤 + 组装卡片字段
    const films: FilmRecord[] = [];
    for (const row of rows) {
      const meta = readMeta(row.input);
      // 成片库只接收有明确“项目 + 分集”归属的最终成片；无分集的历史/手工合片
      // 仍可留在镜头组或任务记录中，但不能伪装成“每集成片”。
      if (
        !meta
        || meta.projectId !== projectId
        || typeof meta.episodeId !== 'string'
        || meta.episodeId.length === 0
      ) continue;
      // C/S 的镜头组与整集曾共用 CHAIN_COMPILE：显式非空 shotIds 是“组任务”的稳定标记。
      // 即使该组刚好覆盖全剧集，也必须留在镜头组，不能与随后生成的整集 CONCAT 重复入库。
      if (Array.isArray(meta.shotIds) && meta.shotIds.length > 0) continue;
      // 已产出的最终成片（COMPLETED render_job + outputUrl）必须保留展示，不因当前
      // 镜头状态变化（重跑 reset / 重新生成使 shot 退回 PENDING）而隐藏——这正是
      // 「重跑后成片库全没了」的根因：原 complete 门禁按"当前所有 shot 是否 COMPLETED"
      // 过滤，shots 一旦被重跑 reset，已产出的成片就从成片库消失（4928 连续丢失）。
      // 仅保留计数门禁：任务当时覆盖的镜头数须等于该集当前总数，防止加镜头后旧成片
      // 冒充最终成片；分集已删除（completion 缺失）则不再展示。
      const completion = completionMap.get(meta.episodeId);
      if (
        !completion
        || (typeof meta.shotCount === 'number' && meta.shotCount !== completion.total)
      ) {
        continue;
      }

      const r = readResult(row.result);
      // outputUrl 缺失视为未完成（best-effort，不入列表）
      if (!r.outputUrl) continue;

      films.push({
        id: row.id,
        type: row.type,
        outputUrl: r.outputUrl,
        localKey: r.localKey ?? null,
        episodeId: typeof meta.episodeId === 'string' ? meta.episodeId : null,
        episodeNumber:
          typeof meta.episodeNumber === 'number' ? meta.episodeNumber : null,
        episodeTitle:
          typeof meta.episodeTitle === 'string' ? meta.episodeTitle : null,
        projectTitle:
          typeof meta.projectTitle === 'string' ? meta.projectTitle : null,
        shotCount:
          typeof meta.shotCount === 'number' ? meta.shotCount : null,
        totalDuration:
          typeof meta.totalDuration === 'number' ? meta.totalDuration : null,
        createdAt: toIso(row.created_at),
      });
    }

    return apiSuccess(films);
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/films');
  }
}
