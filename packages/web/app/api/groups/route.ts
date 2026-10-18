// ============================================================
// GET /api/groups — 当前用户的镜头组库
// ============================================================
//
// app1 的镜头组事实源是 shots.currentMaterialUrl：同一生成组内的镜头共享同一个
// 视频地址。C/S 也必须读取这个持久化事实，而不能把 CHAIN_COMPILE 的整集 outputUrl
// 误当成一个镜头组。服务器只返回 URL/元数据，媒体字节仍由客户端 sf-asset:// 直读。
// ============================================================

import type { NextRequest } from 'next/server';
import { query } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

/** 镜头组卡片契约；id 使用该组排序后的首镜头 ID，稳定且不会与其他组冲突。 */
export interface GroupItem {
  id: string;
  type: 'CHAIN_COMPILE';
  projectId: string;
  projectTitle: string;
  episodeId: string;
  episodeNumber: number | null;
  episodeTitle: string | null;
  groupIndex: number;
  groupLabel: string;
  videoUrl: string;
  localKey: string | null;
  shotCount: number;
  duration: number;
  updatedAt: string;
  /** 该组覆盖的全局镜头起止序号（episode 内）。 */
  shotStart: number;
  shotEnd: number;
  /** 语义组名（建场组/高潮组…），缺失为「组N」。 */
  groupName: string;
  /** 该组的全部生成历史（每次重生一代），按时间倒序；isCurrent=当前镜头引用的那代。 */
  generations?: Generation[];
}

/** 单次组生成的历史记录（一次 CHAIN_COMPILE 重生 = 一代）。 */
export interface Generation {
  /** sf-asset:// URL（桌面客户端 protocol handler 读本地）。 */
  videoUrl: string;
  /** 客户端本地 clips/<localKey>.mp4（saveFilm IPC 用）。 */
  localKey: string | null;
  /** 生成时间（ISO）。 */
  generatedAt: string;
  /** 是否当前镜头引用的那代（最新/在用）。 */
  isCurrent: boolean;
}

interface CompletedShotRow {
  shotId: string;
  projectId: string;
  projectTitle: string;
  episodeId: string;
  episodeNumber: number | null;
  episodeTitle: string | null;
  durationSeconds: number | null;
  videoUrl: string;
  updatedAt: unknown;
  shotIndex: number | null;
  metadata: unknown;
}

/** DB timestamp 统一成可序列化 ISO；异常历史值退化为空串。 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }
  return '';
}

/** 只有严格的客户端本地 mp4 URL 才能交给 saveFilm IPC。 */
function readLocalKey(videoUrl: string): string | null {
  if (!videoUrl.startsWith('sf-asset://')) return null;
  const key = videoUrl.slice('sf-asset://'.length);
  return /^[a-z0-9-]+\.mp4$/i.test(key) ? key : null;
}

/** 卡片标题只描述分集；组号由独立徽标展示，避免标题重复拼接。 */
function buildGroupLabel(episodeNumber: number | null, episodeTitle: string | null): string {
  if (episodeNumber !== null) {
    return `第 ${episodeNumber} 集${episodeTitle ? ` · ${episodeTitle}` : ''}`;
  }
  return episodeTitle || '未命名分集';
}

/** 从 shot.metadata 读取语义组名（建场组/高潮组…），缺失回退「组{groupIndex}」。 */
function readGroupName(metadata: unknown, groupIndex: number): string {
  if (!metadata || typeof metadata !== 'object') return `组${groupIndex}`;
  const meta = metadata as Record<string, unknown>;
  const sbTable = (meta.storyboardTable || {}) as Record<string, unknown>;
  const label =
    (typeof meta.groupLabel === 'string' && meta.groupLabel) ||
    (typeof sbTable.groupLabel === 'string' && sbTable.groupLabel) ||
    '';
  return label || `组${groupIndex}`;
}

export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    // 一次 JOIN 取得当前镜头状态及项目/分集标题，避免按项目或分集触发 N+1。
    // 只有 COMPLETED + 非空 URL 才是可展示镜头组；项目 userId 是首要隔离条件。
    const result = await query(
      `SELECT s.id AS "shotId",
              s."projectId" AS "projectId",
              p.title AS "projectTitle",
              s."episodeId" AS "episodeId",
              e."episodeNumber" AS "episodeNumber",
              e.title AS "episodeTitle",
              s."durationSeconds" AS "durationSeconds",
              s."currentMaterialUrl" AS "videoUrl",
              s."updatedAt" AS "updatedAt",
              s."shotIndex" AS "shotIndex",
              s.metadata AS "metadata"
         FROM shots s
         JOIN projects p
           ON p.id = s."projectId"
         JOIN episodes e
           ON e.id = s."episodeId" AND e."projectId" = s."projectId"
        WHERE p."userId" = $1
          AND s."videoStatus" = 'COMPLETED'
          AND COALESCE(s."currentMaterialUrl", '') <> ''
        ORDER BY p."updatedAt" DESC,
                 e."episodeNumber" ASC,
                 s."sortOrder" ASC,
                 s."shotIndex" ASC`,
      [auth.userId],
    );

    const groups: GroupItem[] = [];
    const byEpisodeAndUrl = new Map<string, GroupItem>();
    const nextIndexByEpisode = new Map<string, number>();
    // 每个 group.id → 该组覆盖的全部 shotId（用于把历史 render_job 匹配回组）。
    const groupShotIds = new Map<string, Set<string>>();

    for (const row of result.rows as CompletedShotRow[]) {
      const episodeKey = `${row.projectId}:${row.episodeId}`;
      const groupKey = `${episodeKey}:${row.videoUrl}`;
      const existing = byEpisodeAndUrl.get(groupKey);
      const updatedAt = toIso(row.updatedAt);
      const shotIdx = typeof row.shotIndex === 'number' ? row.shotIndex : 0;
      if (existing) {
        existing.shotCount += 1;
        existing.duration += Number(row.durationSeconds ?? 0);
        existing.shotStart = Math.min(existing.shotStart, shotIdx);
        existing.shotEnd = Math.max(existing.shotEnd, shotIdx);
        // 一组多镜写回在同一事务；仍取最大时间以兼容历史分批修复记录。
        if (updatedAt > existing.updatedAt) existing.updatedAt = updatedAt;
        groupShotIds.get(existing.id)?.add(row.shotId);
        continue;
      }

      const groupIndex = (nextIndexByEpisode.get(episodeKey) ?? 0) + 1;
      nextIndexByEpisode.set(episodeKey, groupIndex);
      const item: GroupItem = {
        id: row.shotId,
        type: 'CHAIN_COMPILE',
        projectId: row.projectId,
        projectTitle: row.projectTitle || '未知项目',
        episodeId: row.episodeId,
        episodeNumber: typeof row.episodeNumber === 'number' ? row.episodeNumber : null,
        episodeTitle: typeof row.episodeTitle === 'string' ? row.episodeTitle : null,
        groupIndex,
        groupLabel: buildGroupLabel(
          typeof row.episodeNumber === 'number' ? row.episodeNumber : null,
          typeof row.episodeTitle === 'string' ? row.episodeTitle : null,
        ),
        videoUrl: row.videoUrl,
        localKey: readLocalKey(row.videoUrl),
        shotCount: 1,
        duration: Number(row.durationSeconds ?? 0),
        updatedAt,
        shotStart: shotIdx,
        shotEnd: shotIdx,
        groupName: readGroupName(row.metadata, groupIndex),
      };
      byEpisodeAndUrl.set(groupKey, item);
      groups.push(item);
      groupShotIds.set(item.id, new Set([row.shotId]));
    }

    // 挂载每次重生的历史代次：render_jobs 里每次 CHAIN_COMPILE 完成都留有一代
    //（input.filmMeta.shotIds + result.meta.groupClips[].videoUrl + created_at）。
    // 现状只把最新视频写在镜头上、旧代次被覆盖；这里从 render_jobs 把全部历史捞回，
    // 让前端展示「每次生成的时间 + 哪代是当前在用」，用户能辨别生没生、是不是新的。
    // group.id → (videoUrl 去重 → Generation)，保留最新时间。两个来源合并：
    //   A. CHAIN_COMPILE render_jobs（组编译历史，整组重生的代次）
    //   B. shots.metadata.videoGenerations（单镜 VIDEO_GENERATE 重生历史，updateShotMaterial
    //      不再覆盖、把旧 URL 追加进此数组）。B 让左侧 tap 栏对单镜重生也能展示
    //      「新老都在、新的在前」，不再因覆盖而丢老代次。
    const gensByGroup = new Map<string, Map<string, Generation>>();
    const episodeIds = [...new Set(groups.map((g) => g.episodeId))];
    if (episodeIds.length > 0) {
      const jobResult = await query(
        `SELECT "input", "result", "created_at" AS "createdAt"
           FROM render_jobs
          WHERE type = 'CHAIN_COMPILE'
            AND status = 'COMPLETED'
            AND "input"->'filmMeta'->>'episodeId' = ANY($1::text[])
          ORDER BY "created_at" DESC`,
        [episodeIds],
      );
      for (const job of jobResult.rows as Array<{
        input?: { filmMeta?: { shotIds?: unknown[] } };
        result?: { meta?: { groupClips?: Array<{ videoUrl?: string; localKey?: string; shotIds?: unknown[] }> } };
        createdAt: unknown;
      }>) {
        const filmMeta = job.input?.filmMeta;
        const clips = job.result?.meta?.groupClips;
        if (!filmMeta || !Array.isArray(clips)) continue;
        const createdAt = toIso(job.createdAt);
        for (const clip of clips) {
          const clipUrl = typeof clip?.videoUrl === 'string' ? clip.videoUrl : '';
          if (!clipUrl) continue;
          const clipShotIds = Array.isArray(clip?.shotIds) ? clip.shotIds : [];
          const clipLocalKey = typeof clip?.localKey === 'string' ? clip.localKey : readLocalKey(clipUrl);
          // 该 clip 属于哪个当前组：clip.shotIds 与组镜头集合有交集。仅用 clip 级
          // shotIds（不用 job 级 filmMeta.shotIds——整集 job 的 shotIds 会误命中所有组）。
          for (const g of groups) {
            const gShots = groupShotIds.get(g.id);
            if (!gShots) continue;
            const overlap = clipShotIds.some((id) => gShots.has(String(id)));
            if (!overlap) continue;
            let map = gensByGroup.get(g.id);
            if (!map) { map = new Map(); gensByGroup.set(g.id, map); }
            const ex = map.get(clipUrl);
            if (!ex || createdAt > ex.generatedAt) {
              map.set(clipUrl, {
                videoUrl: clipUrl,
                localKey: clipLocalKey,
                generatedAt: createdAt,
                isCurrent: clipUrl === g.videoUrl,
              });
            }
            break; // 一个 clip 只归一个组
          }
        }
      }
    }

    // 来源 B：单镜重生历史（metadata.videoGenerations）。按 shotId→组 归并进 gensByGroup。
    const shotIdToGroup = new Map<string, GroupItem>();
    for (const g of groups) {
      const shots = groupShotIds.get(g.id);
      if (shots) for (const sid of shots) shotIdToGroup.set(sid, g);
    }
    for (const row of result.rows as CompletedShotRow[]) {
      const meta = row.metadata as Record<string, unknown> | null;
      const shotGens = meta && Array.isArray(meta.videoGenerations) ? meta.videoGenerations : [];
      if (shotGens.length === 0) continue;
      const g = shotIdToGroup.get(row.shotId);
      if (!g) continue;
      let map = gensByGroup.get(g.id);
      if (!map) { map = new Map(); gensByGroup.set(g.id, map); }
      for (const sg of shotGens) {
        if (!sg || typeof sg !== 'object') continue;
        const url = typeof (sg as { url?: unknown }).url === 'string' ? (sg as { url: string }).url : '';
        if (!url) continue;
        const generatedAt = toIso((sg as { generatedAt?: unknown }).generatedAt);
        const ex = map.get(url);
        if (!ex || generatedAt > ex.generatedAt) {
          map.set(url, {
            videoUrl: url,
            localKey: readLocalKey(url),
            generatedAt,
            isCurrent: url === g.videoUrl,
          });
        }
      }
    }

    for (const g of groups) {
      const map = gensByGroup.get(g.id);
      if (!map || map.size === 0) continue;
      const arr = [...map.values()].sort((a, b) => (a.generatedAt > b.generatedAt ? -1 : 1));
      for (const gen of arr) gen.isCurrent = gen.videoUrl === g.videoUrl;
      g.generations = arr;
    }

    return apiSuccess(groups);
  } catch (err) {
    return handleApiError(err, 'GET /api/groups');
  }
}
