// ============================================================
// ③ server/domain/storyboard — 分镜 CRUD（shots 表）
// ============================================================
//
// 文件职责：
//   分镜（shots 表）的 CRUD 操作，DB 访问通过 @server/infra 的 query。
//   分镜是 app1 中"分镜/镜头"的实际数据载体（旧 storyboards 表已废弃）。
//
// 表结构（见 0001-init.sql）：
//   shots(id, "projectId", "episodeId", "sceneId", "shotSeq", "shotIndex",
//         "durationSeconds", "visualPrompt", "stylePrompt", "aspectRatio",
//         "resolution", "purposeTag", "emotionArcPosition", "montageType",
//         "audioType", "referencedAssets", "currentMaterialId", "currentMaterialUrl",
//         "videoStatus", status, "sortOrder", metadata, "createdAt", "updatedAt")
//
// 移植自 app1 generate-storyboard/route.ts 的 DB 写入逻辑，
// 改造为通用 CRUD 服务（app1 仅在路由内内联写 DB）。
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import { genId } from '@shared/utils';
import { query, tx } from '@server/infra';
import { validateShotCreate, validateShotUpdate, type ShotCreateInput, type ShotUpdatePatch } from './validation';
import { archiveCurrentShotsIfAny } from './storyboard-versions';

/** 分镜记录（与 shots 表行对齐，camelCase） */
export interface ShotRecord {
  id: string;
  projectId: string;
  episodeId: string | null;
  sceneId: string | null;
  shotSeq: string | null;
  shotIndex: number;
  durationSeconds: number | null;
  visualPrompt: string | null;
  stylePrompt: string | null;
  aspectRatio: string | null;
  resolution: string | null;
  purposeTag: string | null;
  emotionArcPosition: string | null;
  montageType: string | null;
  audioType: string | null;
  referencedAssets: Record<string, unknown> | null;
  currentMaterialId: string | null;
  currentMaterialUrl: string | null;
  videoStatus: string;
  status: string;
  sortOrder: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** 一集的镜头视频完成度；成片库用它区分整集成片与中间片段。 */
export interface EpisodeCompletion {
  total: number;
  completed: number;
  complete: boolean;
}

/** 把 DB 行映射为 ShotRecord */
export function toShotRecord(row: Record<string, unknown>): ShotRecord {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    episodeId: (row.episodeId as string | null) ?? null,
    sceneId: (row.sceneId as string | null) ?? null,
    shotSeq: (row.shotSeq as string | null) ?? null,
    shotIndex: row.shotIndex as number,
    durationSeconds: (row.durationSeconds as number | null) ?? null,
    visualPrompt: (row.visualPrompt as string | null) ?? null,
    stylePrompt: (row.stylePrompt as string | null) ?? null,
    aspectRatio: (row.aspectRatio as string | null) ?? null,
    resolution: (row.resolution as string | null) ?? null,
    purposeTag: (row.purposeTag as string | null) ?? null,
    emotionArcPosition: (row.emotionArcPosition as string | null) ?? null,
    montageType: (row.montageType as string | null) ?? null,
    audioType: (row.audioType as string | null) ?? null,
    referencedAssets: (row.referencedAssets as Record<string, unknown> | null) ?? null,
    currentMaterialId: (row.currentMaterialId as string | null) ?? null,
    currentMaterialUrl: (row.currentMaterialUrl as string | null) ?? null,
    videoStatus: (row.videoStatus as string) ?? 'PENDING',
    status: (row.status as string) ?? 'PENDING',
    sortOrder: (row.sortOrder as number) ?? 0,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: (row.createdAt as Date).toISOString(),
    updatedAt: (row.updatedAt as Date).toISOString(),
  };
}

/**
 * 列出项目下的分镜。
 *
 * @param projectId - 项目 ID
 * @param episodeId - 可选：按分集过滤
 * @returns 分镜列表（按 sortOrder 升序）
 */
export async function listShots(
  projectId: string,
  episodeId?: string,
): Promise<ShotRecord[]> {
  const sql = episodeId
    ? 'SELECT * FROM shots WHERE "projectId" = $1 AND "episodeId" = $2 ORDER BY "sortOrder" ASC, "shotIndex" ASC'
    : 'SELECT * FROM shots WHERE "projectId" = $1 ORDER BY "sortOrder" ASC, "shotIndex" ASC';
  const params = episodeId ? [projectId, episodeId] : [projectId];
  const result = await query(sql, params);
  return result.rows.map((r) => toShotRecord(r as Record<string, unknown>));
}

/**
 * 批量计算分集是否已完整生成视频。
 *
 * app1 的成片库只接收「该集每个镜头都 COMPLETED 且有素材 URL」的合集；
 * 本查询一次聚合所有目标分集，避免列表层逐集查询造成 N+1。没有镜头的分集不写入
 * Map，调用方因此会按未完成处理。
 */
export async function getEpisodesCompletionMap(
  episodeIds: readonly string[],
): Promise<Map<string, EpisodeCompletion>> {
  const uniqueIds = Array.from(new Set(episodeIds.filter((id) => id.length > 0)));
  if (uniqueIds.length === 0) return new Map();

  const result = await query(
    `SELECT "episodeId" AS "episodeId",
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE "videoStatus" = 'COMPLETED'
                AND COALESCE("currentMaterialUrl", '') <> ''
            )::int AS completed
       FROM shots
      WHERE "episodeId" = ANY($1::text[])
      GROUP BY "episodeId"`,
    [uniqueIds],
  );

  const completion = new Map<string, EpisodeCompletion>();
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const episodeId = typeof raw.episodeId === 'string' ? raw.episodeId : '';
    if (!episodeId) continue;
    const total = Number(raw.total ?? 0);
    const completed = Number(raw.completed ?? 0);
    completion.set(episodeId, {
      total,
      completed,
      complete: total > 0 && completed >= total,
    });
  }
  return completion;
}

/**
 * 查询单个分镜。
 *
 * @returns 分镜记录；不存在返回 null
 */
export async function getShot(shotId: string): Promise<ShotRecord | null> {
  const result = await query('SELECT * FROM shots WHERE id = $1', [shotId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? toShotRecord(row) : null;
}

/**
 * 创建分镜。
 *
 * @throws Error 当输入校验失败
 */
export async function createShot(input: ShotCreateInput): Promise<ShotRecord> {
  const validation = validateShotCreate(input);
  if (!validation.valid) {
    throw new Error(`分镜校验失败: ${validation.errors.join('; ')}`);
  }

  const id = genId();
  const sortOrder = input.sortOrder ?? 0;
  await query(
    `INSERT INTO shots
      (id, "projectId", "episodeId", "shotSeq", "shotIndex", "durationSeconds",
       "visualPrompt", "stylePrompt", "aspectRatio", "resolution", "purposeTag",
       "emotionArcPosition", "audioType", "referencedAssets", metadata, "sortOrder", status, "videoStatus", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'PENDING', 'PENDING', NOW(), NOW())`,
    [
      id,
      input.projectId,
      input.episodeId ?? null,
      input.shotSeq ?? null,
      input.shotIndex,
      input.durationSeconds ?? null,
      input.visualPrompt ?? null,
      input.stylePrompt ?? null,
      input.aspectRatio ?? '9:16',
      input.resolution ?? null,
      input.purposeTag ?? null,
      input.emotionArcPosition ?? null,
      input.audioType ?? null,
      input.referencedAssets ? JSON.stringify(input.referencedAssets) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      sortOrder,
    ],
  );

  const created = await getShot(id);
  if (!created) {
    throw new Error('分镜创建后查询失败');
  }
  return created;
}

/**
 * 更新分镜（部分更新）。
 *
 * 仅更新 patch 中出现的字段。
 *
 * @throws Error 当补丁校验失败或分镜不存在
 */
export async function updateShot(shotId: string, patch: ShotUpdatePatch): Promise<ShotRecord> {
  const validation = validateShotUpdate(patch);
  if (!validation.valid) {
    throw new Error(`分镜更新校验失败: ${validation.errors.join('; ')}`);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const addField = (column: string, value: unknown): void => {
    setClauses.push(`${column} = $${idx}`);
    params.push(value);
    idx++;
  };

  if (patch.shotIndex !== undefined) addField('"shotIndex"', patch.shotIndex);
  if (patch.shotSeq !== undefined) addField('"shotSeq"', patch.shotSeq);
  if (patch.durationSeconds !== undefined) addField('"durationSeconds"', patch.durationSeconds);
  if (patch.visualPrompt !== undefined) addField('"visualPrompt"', patch.visualPrompt);
  if (patch.stylePrompt !== undefined) addField('"stylePrompt"', patch.stylePrompt);
  if (patch.aspectRatio !== undefined) addField('"aspectRatio"', patch.aspectRatio);
  if (patch.resolution !== undefined) addField('"resolution"', patch.resolution);
  if (patch.purposeTag !== undefined) addField('"purposeTag"', patch.purposeTag);
  if (patch.emotionArcPosition !== undefined) addField('"emotionArcPosition"', patch.emotionArcPosition);
  if (patch.audioType !== undefined) addField('"audioType"', patch.audioType);
  if (patch.referencedAssets !== undefined) {
    addField('"referencedAssets"', patch.referencedAssets ? JSON.stringify(patch.referencedAssets) : null);
  }
  if (patch.currentMaterialId !== undefined) {
    addField('"currentMaterialId"', patch.currentMaterialId);
  }
  if (patch.currentMaterialUrl !== undefined) {
    addField('"currentMaterialUrl"', patch.currentMaterialUrl);
  }
  if (patch.metadata !== undefined) {
    addField('metadata', patch.metadata ? JSON.stringify(patch.metadata) : null);
  }
  if (patch.status !== undefined) addField('status', patch.status);
  if (patch.videoStatus !== undefined) addField('"videoStatus"', patch.videoStatus);
  if (patch.sortOrder !== undefined) addField('"sortOrder"', patch.sortOrder);

  if (setClauses.length === 0) {
    // 无字段更新，直接返回当前记录
    const current = await getShot(shotId);
    if (!current) throw new Error('分镜不存在');
    return current;
  }

  setClauses.push('"updatedAt" = NOW()');
  params.push(shotId);
  await query(
    `UPDATE shots SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    params,
  );

  const updated = await getShot(shotId);
  if (!updated) throw new Error('分镜不存在');
  return updated;
}

/**
 * 删除分镜（幂等：不存在不抛错）。
 */
export async function deleteShot(shotId: string): Promise<void> {
  await query('DELETE FROM shots WHERE id = $1', [shotId]);
}

/**
 * 删除项目下所有分镜（项目级清理）。
 */
export async function deleteShotsByProject(projectId: string): Promise<void> {
  await query('DELETE FROM shots WHERE "projectId" = $1', [projectId]);
}

/**
 * 删除某分集下所有分镜（P7.4 generate-storyboard rewrite 用）。
 */
export async function deleteShotsByEpisode(episodeId: string): Promise<void> {
  await query('DELETE FROM shots WHERE "episodeId" = $1', [episodeId]);
}

/**
 * 原子替换某集全部镜头。先在事务外完成输入校验，再在同一事务里删旧建新；
 * AI 返回或任一 INSERT 失败时旧分镜完整保留，避免“重新生成失败后整集变空”。
 */
export async function replaceEpisodeShots(
  episodeId: string,
  inputs: ShotCreateInput[],
): Promise<void> {
  for (const input of inputs) {
    if (input.episodeId !== episodeId) throw new Error('分镜 episodeId 与替换目标不一致');
    const validation = validateShotCreate(input);
    if (!validation.valid) {
      throw new Error(`分镜校验失败: ${validation.errors.join('; ')}`);
    }
  }
  await tx(async (q) => {
    // 串行锁：同集并发重生排队，保证归档 ordinal 串行分配（episode 行必然存在，
    // 路由层已校验归属；首生时 shots 为空锁不到行，故锁 episode 而非 shots）。
    await q.query('SELECT 1 FROM episodes WHERE id = $1 FOR UPDATE', [episodeId]);
    // 重生先把当前整集快照归档为历史版本（首生空集 no-op），旧镜头不再物理丢失。
    // 与下面的 DELETE/INSERT 同事务，任一 INSERT 失败则归档一并回滚。
    await archiveCurrentShotsIfAny(q, episodeId);
    await q.query('DELETE FROM shots WHERE "episodeId" = $1', [episodeId]);
    for (const input of inputs) {
      await q.query(
        `INSERT INTO shots
          (id, "projectId", "episodeId", "shotSeq", "shotIndex", "durationSeconds",
           "visualPrompt", "stylePrompt", "aspectRatio", "resolution", "purposeTag",
           "emotionArcPosition", "audioType", "referencedAssets", metadata, "sortOrder", status, "videoStatus", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 'PENDING', 'PENDING', NOW(), NOW())`,
        [
          genId(), input.projectId, input.episodeId ?? null, input.shotSeq ?? null,
          input.shotIndex, input.durationSeconds ?? null, input.visualPrompt ?? null,
          input.stylePrompt ?? null, input.aspectRatio ?? '9:16', input.resolution ?? null,
          input.purposeTag ?? null,
          input.emotionArcPosition ?? null,
          input.audioType ?? null,
          input.referencedAssets ? JSON.stringify(input.referencedAssets) : null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          input.sortOrder ?? 0,
        ],
      );
    }
  });
}
