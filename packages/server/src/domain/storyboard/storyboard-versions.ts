// ============================================================
// 分镜整集历史版本（storyboard_versions 表）
// ============================================================
// 重生/恢复时把当前整集 shots 快照归档（不删）。当前镜头永远在 shots 表（删不到），
// 历史全在此表。单位 = 整集（重生是一次性替换整集，区别于 asset_image_revisions 的单行级）。
//
// 设计要点：
//   - archiveCurrentShotsIfAny 是共享 helper，被 replaceEpisodeShots 和 restore 复用，
//     避免双重归档逻辑。
//   - restore 写回时 videoStatus/currentMaterial* 一律重置——materials 表
//     ON DELETE CASCADE 已随上次重生的 DELETE FROM shots 被级联删，保留 COMPLETED
//     会变成无素材的"假完成"，误导 getEpisodesCompletionMap。但历史快照本身保留
//     currentMaterialUrl，所以"查看历史"时旧视频仍可见，数据不丢。
//   - 串行锁锁 episodes 行（首生时 shots 为空锁不到行；episode 必然存在），保证
//     ordinal 串行分配 + 同集重生/恢复排队。
// ============================================================

import { genId } from '@shared/utils';
import { query, tx, type QueryFn } from '@server/infra';
import { toShotRecord, type ShotRecord } from './service';

/** 历史版本摘要（列表用，不解包 shots_snapshot） */
export interface StoryboardVersionSummary {
  id: string;
  episodeId: string;
  projectId: string;
  ordinal: number;
  shotCount: number;
  createdAt: string;
}

/** 历史版本详情（含完整快照） */
export interface StoryboardVersion extends StoryboardVersionSummary {
  shotsSnapshot: ShotRecord[];
}

const toIso = (value: unknown): string =>
  value == null ? '' : value instanceof Date ? value.toISOString() : String(value);

function mapSummary(row: Record<string, unknown>): StoryboardVersionSummary {
  return {
    id: String(row.id),
    episodeId: String(row.episodeId),
    projectId: String(row.projectId),
    ordinal: Number(row.ordinal),
    shotCount: Number(row.shot_count),
    createdAt: toIso(row.createdAt),
  };
}

/**
 * 事务内：把当前 live shots 快照归档为一条历史版本。空集 → no-op（return null）。
 * 调用方须已在同一事务内持 episodes 行锁（FOR UPDATE），保证 ordinal 串行分配。
 */
export async function archiveCurrentShotsIfAny(
  q: QueryFn,
  episodeId: string,
): Promise<{ ordinal: number } | null> {
  const sel = await q.query(
    'SELECT * FROM shots WHERE "episodeId" = $1 ORDER BY "sortOrder" ASC, "shotIndex" ASC',
    [episodeId],
  );
  const rows = (sel.rows ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const projectId = String(rows[0].projectId);
  const snapshot = rows.map((r) => toShotRecord(r));
  const ord = await q.query(
    'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM storyboard_versions WHERE "episodeId" = $1',
    [episodeId],
  );
  const ordinal = Number((ord.rows[0] as { next?: number | string } | undefined)?.next ?? 1);
  await q.query(
    `INSERT INTO storyboard_versions
       (id, "episodeId", "projectId", ordinal, shots_snapshot, shot_count, "createdAt")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())`,
    [genId(), episodeId, projectId, ordinal, JSON.stringify(snapshot), snapshot.length],
  );
  return { ordinal };
}

/** 列出某集历史版本（最新在前，不含快照正文）。 */
export async function listStoryboardVersions(
  projectId: string,
  episodeId: string,
): Promise<StoryboardVersionSummary[]> {
  const { rows } = await query(
    `SELECT id, "episodeId", "projectId", ordinal, shot_count, "createdAt"
       FROM storyboard_versions
      WHERE "projectId" = $1 AND "episodeId" = $2
      ORDER BY ordinal DESC`,
    [projectId, episodeId],
  );
  return (rows as Record<string, unknown>[]).map(mapSummary);
}

/** 取某条历史版本（含完整快照）。不存在返回 null（路由层映射 404）。 */
export async function getStoryboardVersion(
  projectId: string,
  episodeId: string,
  versionId: string,
): Promise<StoryboardVersion | null> {
  const { rows } = await query(
    `SELECT * FROM storyboard_versions
      WHERE id = $1 AND "episodeId" = $2 AND "projectId" = $3`,
    [versionId, episodeId, projectId],
  );
  if (rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  const snapshot = Array.isArray(row.shots_snapshot)
    ? (row.shots_snapshot as ShotRecord[])
    : [];
  return { ...mapSummary(row), shotsSnapshot: snapshot };
}

/** 手动删除一条历史版本（三元组防越权）。 */
export async function deleteStoryboardVersion(
  projectId: string,
  episodeId: string,
  versionId: string,
): Promise<void> {
  await query(
    `DELETE FROM storyboard_versions
      WHERE id = $1 AND "episodeId" = $2 AND "projectId" = $3`,
    [versionId, episodeId, projectId],
  );
}

/**
 * 恢复旧版：持锁 → 取目标版本快照 → 归档当前 live 成新版本 → 删 live → 快照写回。
 * 写回策略：status/文本/metadata/referencedAssets/sceneId/序号 保留；
 *           videoStatus='PENDING'、currentMaterialId/Url=null（materials 已级联删）；
 *           id 重新生成（不复用快照原 id，避免与已删的 materials/旧 render 引用纠缠）。
 */
export async function restoreStoryboardVersion(input: {
  projectId: string;
  episodeId: string;
  versionId: string;
}): Promise<{ archivedOrdinal: number | null }> {
  return tx(async (q) => {
    // 1. 串行锁（同一集的 restore/重生 排队，防 ordinal 竞争）
    const lock = await q.query('SELECT 1 FROM episodes WHERE id = $1 FOR UPDATE', [input.episodeId]);
    if (lock.rows.length === 0) throw new Error('分集不存在');
    // 2. 取目标版本快照
    const vr = await q.query(
      `SELECT * FROM storyboard_versions
        WHERE id = $1 AND "episodeId" = $2 AND "projectId" = $3`,
      [input.versionId, input.episodeId, input.projectId],
    );
    if (vr.rows.length === 0) throw new Error('分镜版本不存在或无权访问');
    const snapshot = Array.isArray((vr.rows[0] as { shots_snapshot?: unknown }).shots_snapshot)
      ? ((vr.rows[0] as { shots_snapshot: ShotRecord[] }).shots_snapshot)
      : [];
    // 3. 归档当前 live（复用共享 helper，避免双重归档）
    const archived = await archiveCurrentShotsIfAny(q, input.episodeId);
    // 4. 删 live
    await q.query('DELETE FROM shots WHERE "episodeId" = $1', [input.episodeId]);
    // 5. 写回快照（文本保留、视频态重置、id 新生成）
    for (const s of snapshot) {
      await q.query(
        `INSERT INTO shots
           (id, "projectId", "episodeId", "sceneId", "shotSeq", "shotIndex", "durationSeconds",
            "visualPrompt", "stylePrompt", "aspectRatio", "resolution", "purposeTag",
            "emotionArcPosition", "montageType", "audioType", "referencedAssets", metadata,
            "sortOrder", status, "currentMaterialId", "currentMaterialUrl", "videoStatus",
            "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb,
                 $17::jsonb, $18, $19, NULL, NULL, 'PENDING', $20, NOW())`,
        [
          genId(),
          s.projectId,
          s.episodeId ?? null,
          s.sceneId ?? null,
          s.shotSeq ?? null,
          s.shotIndex,
          s.durationSeconds ?? null,
          s.visualPrompt ?? null,
          s.stylePrompt ?? null,
          s.aspectRatio ?? '9:16',
          s.resolution ?? null,
          s.purposeTag ?? null,
          s.emotionArcPosition ?? null,
          s.montageType ?? null,
          s.audioType ?? null,
          s.referencedAssets ? JSON.stringify(s.referencedAssets) : null,
          s.metadata ? JSON.stringify(s.metadata) : null,
          s.sortOrder ?? 0,
          s.status ?? 'PENDING',
          s.createdAt || new Date(0).toISOString(),
        ],
      );
    }
    return { archivedOrdinal: archived?.ordinal ?? null };
  });
}
