// ============================================================
// Asset Image Revision Module — 生图尝试、客户端落地与当前指针提交
// ============================================================
//
// C/S 两阶段提交：云端先记录 GENERATING/GENERATED，客户端下载到 sf-asset://
// 后再 COMMIT。下载或 PATCH 失败不会替换 assets.imageUrl；历史版本也不会丢失。
// ============================================================

import { query, tx } from '@server/infra';
import { genId } from '@shared/utils';

export interface AssetImageRevision {
  id: string;
  assetId: string;
  projectId: string;
  costumeKey: string;
  generationOrdinal: number;
  status: 'GENERATING' | 'GENERATED' | 'COMMITTED' | 'FAILED';
  source: 'AI' | 'UPLOAD';
  modelName: string | null;
  prompt: string | null;
  providerUrl: string | null;
  localUrl: string | null;
  error: string | null;
  createdAt: string;
  committedAt: string | null;
}

function mapRevision(row: Record<string, unknown>): AssetImageRevision {
  const toIso = (value: unknown): string | null => value == null
    ? null
    : value instanceof Date ? value.toISOString() : String(value);
  return {
    id: String(row.id),
    assetId: String(row.assetId),
    projectId: String(row.projectId),
    costumeKey: typeof row.costumeKey === 'string' && row.costumeKey.trim()
      ? row.costumeKey.trim()
      : 'default',
    generationOrdinal: Number(row.generationOrdinal),
    status: String(row.status) as AssetImageRevision['status'],
    source: String(row.source) as AssetImageRevision['source'],
    modelName: row.modelName == null ? null : String(row.modelName),
    prompt: row.prompt == null ? null : String(row.prompt),
    providerUrl: row.providerUrl == null ? null : String(row.providerUrl),
    localUrl: row.localUrl == null ? null : String(row.localUrl),
    error: row.error == null ? null : String(row.error),
    createdAt: toIso(row.createdAt) ?? '',
    committedAt: toIso(row.committedAt),
  };
}

/** Keep the JSON default row aligned with the backward-compatible top-level image pointer. */
function withDefaultCostumeImage(value: unknown, imageUrl: string): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  let changed = false;
  const costumes = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item as Record<string, unknown>;
    const costume = { ...(item as Record<string, unknown>) };
    if (costume.key === 'default') {
      costume.imageUrl = imageUrl;
      changed = true;
    }
    return costume;
  });
  return changed ? costumes : null;
}

/** 分配单调 generationOrdinal；FOR UPDATE 让多窗口并发请求仍按创建顺序编号。 */
export async function beginAssetImageRevision(input: {
  assetId: string;
  projectId: string;
  modelName: string;
  prompt: string;
  costumeKey?: string;
}): Promise<AssetImageRevision> {
  const costumeKey = input.costumeKey?.trim() || 'default';
  return tx(async (q) => {
    const asset = await q.query(
      'SELECT id FROM assets WHERE id = $1 AND "projectId" = $2 FOR UPDATE',
      [input.assetId, input.projectId],
    );
    if (asset.rows.length === 0) throw new Error('资产不存在');
    const ordinalResult = await q.query(
      `SELECT COALESCE(MAX("generationOrdinal"), 0) + 1 AS next
         FROM asset_image_revisions WHERE "assetId" = $1`,
      [input.assetId],
    );
    const ordinal = Number((ordinalResult.rows[0] as { next?: number | string } | undefined)?.next ?? 1);
    const { rows } = await q.query(
      `INSERT INTO asset_image_revisions
        (id, "assetId", "projectId", "generationOrdinal", "costumeKey", status, source, "modelName", prompt)
       VALUES ($1, $2, $3, $4, $5, 'GENERATING', 'AI', $6, $7) RETURNING *`,
      [genId(), input.assetId, input.projectId, ordinal, costumeKey, input.modelName, input.prompt],
    );
    return mapRevision(rows[0] as Record<string, unknown>);
  });
}

export async function markAssetImageRevisionGenerated(
  revisionId: string,
  providerUrl: string,
): Promise<boolean> {
  // CAS 守卫：只有仍处于 GENERATING 的 revision 才允许翻到 GENERATED。
  // ASSET_IMAGE_GENERATE 在 processor withTimeout（8min）超时后已被 markFailed 置为
  // FAILED；底层 callAI 不会被真正中断，迟到完成时 handler 会继续回写本函数。
  // 若此处不加状态守卫，迟到回写会把 FAILED revision 复活成 GENERATED（带 providerUrl），
  // 卡在 GENERATED 永不 COMMIT，与用户看到的“生图失败”不一致。COMMITTED 同理不应被覆盖。
  // 返回是否真正生效，让调用方据此决定是否继续后续步骤。
  const result = await query(
    `UPDATE asset_image_revisions
        SET status = 'GENERATED', "providerUrl" = $1
      WHERE id = $2 AND status = 'GENERATING'`,
    [providerUrl, revisionId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markAssetImageRevisionFailed(revisionId: string, error: string): Promise<void> {
  // 错误只保留用户可读摘要，避免供应商响应或请求体把凭证带进数据库。
  await query(
    `UPDATE asset_image_revisions SET status = 'FAILED', error = $1 WHERE id = $2`,
    [error.slice(0, 500), revisionId],
  );
}

/**
 * 提交本地图片。只有“序号不小于当前已提交版本”的 revision 才能切换当前指针，
 * 因而旧请求晚完成也不会把新版本回滚掉。
 */
export async function commitAssetImageRevision(input: {
  assetId: string;
  projectId: string;
  revisionId?: string;
  localUrl: string;
  source?: 'AI' | 'UPLOAD';
  activateCurrent?: boolean;
  costumeKey?: string;
}): Promise<{ revision: AssetImageRevision; becameCurrent: boolean }> {
  if (!/^sf-asset:\/\/[A-Za-z0-9._-]+$/.test(input.localUrl)) {
    throw new Error('只允许提交客户端本地 sf-asset:// 图片引用');
  }
  return tx(async (q) => {
    const asset = await q.query(
      'SELECT id, costumes FROM assets WHERE id = $1 AND "projectId" = $2 FOR UPDATE',
      [input.assetId, input.projectId],
    );
    if (asset.rows.length === 0) throw new Error('资产不存在');
    const requestedCostumeKey = input.costumeKey?.trim() || 'default';
    let revisionId = input.revisionId;
    if (!revisionId) {
      const ordinalResult = await q.query(
        `SELECT COALESCE(MAX("generationOrdinal"), 0) + 1 AS next
           FROM asset_image_revisions WHERE "assetId" = $1`,
        [input.assetId],
      );
      const ordinal = Number((ordinalResult.rows[0] as { next?: number | string } | undefined)?.next ?? 1);
      revisionId = genId();
      await q.query(
        `INSERT INTO asset_image_revisions
          (id, "assetId", "projectId", "generationOrdinal", "costumeKey", status, source)
         VALUES ($1, $2, $3, $4, $5, 'GENERATED', $6)`,
        [revisionId, input.assetId, input.projectId, ordinal, requestedCostumeKey, input.source ?? 'UPLOAD'],
      );
    }

    const { rows } = await q.query(
      `UPDATE asset_image_revisions
          SET status = 'COMMITTED', "localUrl" = $1, "committedAt" = NOW(),
              "costumeKey" = CASE
                WHEN "costumeKey" = 'default' AND $5 <> 'default' THEN $5
                ELSE "costumeKey"
              END
        WHERE id = $2 AND "assetId" = $3 AND "projectId" = $4
        RETURNING *`,
      [input.localUrl, revisionId, input.assetId, input.projectId, requestedCostumeKey],
    );
    if (rows.length === 0) throw new Error('图片版本不存在或不属于该资产');
    const revision = mapRevision(rows[0] as Record<string, unknown>);
    if (input.costumeKey?.trim() && revision.costumeKey !== input.costumeKey.trim()) {
      throw new Error(`图片版本造型不匹配: ${revision.costumeKey}`);
    }
    if (revision.costumeKey !== 'default') {
      const rawCostumes = (asset.rows[0] as { costumes?: unknown }).costumes;
      const costumes = Array.isArray(rawCostumes)
        ? rawCostumes.map((item) => ({ ...(item as Record<string, unknown>) }))
        : [];
      const index = costumes.findIndex((item) => item.key === revision.costumeKey);
      if (index < 0) {
        // 容错：revision 指向的造型不在当前 costumes（重提取覆盖 costumes / 旧 revision 延迟提交）。
        // 与其硬失败阻断用户出图，补建该造型项承接本次提交，保留图片成果。
        console.warn(
          `[image-revision] commit: 造型 ${revision.costumeKey} 不在 costumes，自动补建以承接提交 (assetId=${input.assetId})`,
        );
        costumes.push({ key: revision.costumeKey, label: revision.costumeKey, imageUrl: input.localUrl });
      } else {
        // 资产行仍持有 FOR UPDATE 锁；只改命中的造型，保留其他并发提交后的 JSON。
        costumes[index] = { ...costumes[index], imageUrl: input.localUrl };
      }
      await q.query(
        'UPDATE assets SET costumes = $1::jsonb, "updatedAt" = NOW() WHERE id = $2',
        [JSON.stringify(costumes), input.assetId],
      );
      return { revision, becameCurrent: false };
    }
    const newer = await q.query(
      `SELECT 1 FROM asset_image_revisions
        WHERE "assetId" = $1 AND "costumeKey" = 'default'
          AND status = 'COMMITTED' AND "generationOrdinal" > $2
        LIMIT 1`,
      [input.assetId, revision.generationOrdinal],
    );
    const becameCurrent = input.activateCurrent !== false && newer.rows.length === 0;
    if (becameCurrent) {
      const syncedCostumes = withDefaultCostumeImage(
        (asset.rows[0] as { costumes?: unknown }).costumes,
        input.localUrl,
      );
      if (syncedCostumes) {
        await q.query(
          `UPDATE assets SET "imageUrl" = $1, costumes = $2::jsonb, "updatedAt" = NOW() WHERE id = $3`,
          [input.localUrl, JSON.stringify(syncedCostumes), input.assetId],
        );
      } else {
        await q.query(
          `UPDATE assets SET "imageUrl" = $1, "updatedAt" = NOW() WHERE id = $2`,
          [input.localUrl, input.assetId],
        );
      }
    }
    return { revision, becameCurrent };
  });
}

export async function listAssetImageRevisions(
  projectId: string,
  assetId: string,
): Promise<AssetImageRevision[]> {
  const { rows } = await query(
    `SELECT * FROM asset_image_revisions
      WHERE "projectId" = $1 AND "assetId" = $2
      ORDER BY "generationOrdinal" DESC`,
    [projectId, assetId],
  );
  return (rows as Record<string, unknown>[]).map(mapRevision);
}

/**
 * 把一条已提交的历史版本重新设为其所属造型的当前图。
 *
 * 与 commit 的区别：commit 是“客户端下载完一张新图后提交”，activate 是“从已有历史里挑一张设回当前”，
 * 不需要新 localUrl——复用 revision.localUrl（已是 sf-asset://）。
 *
 * 主图写 assets.imageUrl；非默认造型写回 costumes[costumeKey].imageUrl。
 */
export async function activateAssetImageRevision(input: {
  projectId: string;
  assetId: string;
  revisionId: string;
}): Promise<{ revision: AssetImageRevision }> {
  return tx(async (q) => {
    const asset = await q.query(
      'SELECT id, costumes FROM assets WHERE id = $1 AND "projectId" = $2 FOR UPDATE',
      [input.assetId, input.projectId],
    );
    if (asset.rows.length === 0) throw new Error('资产不存在');
    const { rows } = await q.query(
      `SELECT * FROM asset_image_revisions
        WHERE id = $1 AND "assetId" = $2 AND "projectId" = $3
          AND status = 'COMMITTED' AND "localUrl" IS NOT NULL AND "localUrl" <> ''`,
      [input.revisionId, input.assetId, input.projectId],
    );
    if (rows.length === 0) {
      throw new Error('图片版本不存在、未提交完成或无可用的本地图');
    }
    const revision = mapRevision(rows[0] as Record<string, unknown>);
    if (revision.costumeKey !== 'default') {
      const rawCostumes = (asset.rows[0] as { costumes?: unknown }).costumes;
      const costumes = Array.isArray(rawCostumes)
        ? rawCostumes.map((item) => ({ ...(item as Record<string, unknown>) }))
        : [];
      const index = costumes.findIndex((item) => item.key === revision.costumeKey);
      if (index < 0) {
        console.warn(
          `[image-revision] activate: 造型 ${revision.costumeKey} 不在 costumes，自动补建 (assetId=${input.assetId})`,
        );
        costumes.push({ key: revision.costumeKey, label: revision.costumeKey, imageUrl: revision.localUrl });
      } else {
        costumes[index] = { ...costumes[index], imageUrl: revision.localUrl };
      }
      await q.query(
        'UPDATE assets SET costumes = $1::jsonb, "updatedAt" = NOW() WHERE id = $2',
        [JSON.stringify(costumes), input.assetId],
      );
      return { revision };
    }
    const syncedCostumes = withDefaultCostumeImage(
      (asset.rows[0] as { costumes?: unknown }).costumes,
      revision.localUrl!,
    );
    if (syncedCostumes) {
      await q.query(
        `UPDATE assets SET "imageUrl" = $1, costumes = $2::jsonb, "updatedAt" = NOW() WHERE id = $3`,
        [revision.localUrl, JSON.stringify(syncedCostumes), input.assetId],
      );
    } else {
      await q.query(
        `UPDATE assets SET "imageUrl" = $1, "updatedAt" = NOW() WHERE id = $2`,
        [revision.localUrl, input.assetId],
      );
    }
    return { revision };
  });
}
