// ============================================================
// ③ server/domain/asset — 资产 CRUD（assets 表）
// ============================================================
//
// 文件职责：
//   资产（assets 表）的 CRUD 操作，DB 访问通过 @server/infra 的 query。
//   资产包含角色（CHARACTER）/道具（PROP）/环境（LOCATION）三类。
//
// 表结构（见 0001-init.sql，含大量 ALTER 扩展列）：
//   assets(id, "projectId", kind, name, description, "imageUrl", metadata, tags,
//          "folderId", version, "createdAt", "updatedAt",
//          "assetType", "background", "identityLock", "voiceTrait", "voiceId",
//          "voiceSource", "auditionStatus", "significance", "intExt", "mood",
//          "baseAmbience", "basePrompt", "isConfirmed", "coverageScenes",
//          "relationships", "designImage", "pencilPaintEnabled", "gridOverlayEnabled",
//          "pencilImageUrl", "gridImageUrl", "costumes", "voiceprintId", "characterId",
//          "regenLocked")
//
// 移植自 app1 generate-image/route.ts 与 asset-reuse-service.ts 的 DB 写入逻辑，
// 改造为通用 CRUD 服务。
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import { genId } from '@shared/utils';
import { query, tx } from '@server/infra';
import { validateAssetCreate, validateAssetUpdate, type AssetCreateInput, type AssetUpdatePatch } from './validation';
// 仅类型引入（编译期擦除，零运行时跨域耦合）：资产批量写入需要 ExtractedAssets 结构。
import type { ExtractedAssets } from '../prompt';
// 值引入：群演/路人名过滤（代码层兜底，对齐 app1 extraction/route.ts:269）。
import { isAnonymousCharacterName } from '../prompt';
import {
  getAssetLookupKey,
  getAssetNameAliases,
  mergeCostumes,
  mergeStringArray,
  shouldPreserveAssetTextFields,
  shouldProtectAssetFromDeletion,
} from './asset-reuse';

/** 资产记录（含 ALTER 扩展富列；P7.3 出图 / P7.4 分镜均消费） */
export interface AssetRecord {
  id: string;
  projectId: string;
  kind: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  folderId: string | null;
  version: number;
  assetType: string | null;
  basePrompt: string | null;
  isConfirmed: boolean;
  characterId: string | null;
  regenLocked: boolean;
  // ALTER 富列（0001-init.sql:178-263 已存在，P7.3/P7.4 消费）
  background: string | null;
  identityLock: string[] | null;
  significance: string | null;
  intExt: string | null;
  mood: string | null;
  baseAmbience: string | null;
  coverageScenes: string[] | null;
  costumes: Record<string, unknown>[] | null;
  relationships: Record<string, unknown>[] | null;
  // 批5 MUST 字段（CHARACTER 富字段 A11c 核心）：voiceTrait TEXT（0001-init.sql:189）
  voiceTrait: string | null;
  // 批6 音色库：voiceId（绑定的预设音色文件名，如 "female_001_xxx.wav"）+
  // voiceSource（'library' 用户从音色库选 / 'upload' 用户上传，默认 null 未绑）。
  // DB 列 0001-init.sql:193/196 已存在；PATCH 白名单批4阶段2已加，但读回此前漏映射。
  voiceId: string | null;
  voiceSource: string | null;
  // 批5/批6 读回字段（DB 列 0001-init.sql 已存在，PATCH 白名单批4阶段2已加）
  gridOverlayEnabled: boolean | null;
  pencilPaintEnabled: boolean | null;
  /** 彩铅/网格派生图不覆盖设计原图，生产台按开关选择。 */
  pencilImageUrl: string | null;
  gridImageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 把 DB 行映射为 AssetRecord */
function toAssetRecord(row: Record<string, unknown>): AssetRecord {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    kind: row.kind as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    imageUrl: (row.imageUrl as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    tags: (row.tags as string[] | null) ?? null,
    folderId: (row.folderId as string | null) ?? null,
    version: (row.version as number) ?? 1,
    assetType: (row.assetType as string | null) ?? null,
    basePrompt: (row.basePrompt as string | null) ?? null,
    isConfirmed: (row.isConfirmed as boolean) ?? false,
    characterId: (row.characterId as string | null) ?? null,
    regenLocked: (row.regenLocked as boolean) ?? false,
    background: (row.background as string | null) ?? null,
    identityLock: (row.identityLock as string[] | null) ?? null,
    significance: (row.significance as string | null) ?? null,
    intExt: (row.intExt as string | null) ?? null,
    mood: (row.mood as string | null) ?? null,
    baseAmbience: (row.baseAmbience as string | null) ?? null,
    coverageScenes: (row.coverageScenes as string[] | null) ?? null,
    costumes: (row.costumes as Record<string, unknown>[] | null) ?? null,
    relationships: (row.relationships as Record<string, unknown>[] | null) ?? null,
    // 批5 MUST 字段：voiceTrait TEXT
    voiceTrait: (row.voiceTrait as string | null) ?? null,
    // 批6 音色库读回（DB 列已存在 0001-init.sql:193/196，此前漏映射）
    voiceId: (row.voiceId as string | null) ?? null,
    voiceSource: (row.voiceSource as string | null) ?? null,
    // 批5/批6 读回字段（boolean，DB 列已存在）
    gridOverlayEnabled: (row.gridOverlayEnabled as boolean | null) ?? null,
    pencilPaintEnabled: (row.pencilPaintEnabled as boolean | null) ?? null,
    pencilImageUrl: (row.pencilImageUrl as string | null) ?? null,
    gridImageUrl: (row.gridImageUrl as string | null) ?? null,
    createdAt: (row.createdAt as Date).toISOString(),
    updatedAt: (row.updatedAt as Date).toISOString(),
  };
}

export function mergeCostumeMetadataPreservingImages(
  currentValue: unknown,
  requestedCostumes: readonly Record<string, unknown>[],
  defaultImageUrl: unknown,
): Record<string, unknown>[] {
  const currentByKey = new Map<string, Record<string, unknown>>();
  if (Array.isArray(currentValue)) {
    for (const item of currentValue) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const costume = item as Record<string, unknown>;
      const key = typeof costume.key === 'string' ? costume.key.trim() : '';
      if (key && !currentByKey.has(key)) currentByKey.set(key, costume);
    }
  }

  const readNumArray = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : [];

  return requestedCostumes.map((item) => {
    const next = { ...item };
    const key = typeof next.key === 'string' ? next.key.trim() : '';
    const current = key ? currentByKey.get(key) : undefined;
    const currentImageUrl = typeof current?.imageUrl === 'string' && current.imageUrl.trim()
      ? current.imageUrl
      : key === 'default' && typeof defaultImageUrl === 'string' && defaultImageUrl.trim()
        ? defaultImageUrl
        : null;
    // Costume metadata PATCHes never own image pointers. Existing pointers are
    // preserved from the locked DB row; newly added variants start without one.
    if (currentImageUrl) next.imageUrl = currentImageUrl;
    else delete next.imageUrl;
    // coverage_episodes（集号）：requested 非空时以其为准（AI/用户权威）；
    // requested 为空时回填 current（避免重跑提取把已有集号抹空）。兼容 snake/camel。
    const requestedEps = readNumArray(next.coverageEpisodes).length > 0
      ? readNumArray(next.coverageEpisodes)
      : readNumArray(next.coverage_episodes);
    if (requestedEps.length === 0) {
      const currentEps = readNumArray(current?.coverageEpisodes).length > 0
        ? readNumArray(current?.coverageEpisodes)
        : readNumArray(current?.coverage_episodes);
      if (currentEps.length > 0) next.coverage_episodes = currentEps;
    }
    return next;
  });
}

/**
 * 列出项目下的资产。
 *
 * @param projectId - 项目 ID
 * @param kind      - 可选：按类型过滤（CHARACTER/PROP/LOCATION）
 * @returns 资产列表（按 createdAt 升序）
 */
export async function listAssets(
  projectId: string,
  kind?: string,
): Promise<AssetRecord[]> {
  const sql = kind
    ? 'SELECT * FROM assets WHERE "projectId" = $1 AND kind = $2 ORDER BY "createdAt" ASC'
    : 'SELECT * FROM assets WHERE "projectId" = $1 ORDER BY "createdAt" ASC';
  const params = kind ? [projectId, kind] : [projectId];
  const result = await query(sql, params);
  return result.rows.map((r) => toAssetRecord(r as Record<string, unknown>));
}

/**
 * 查询单个资产。
 *
 * @returns 资产记录；不存在返回 null
 */
export async function getAsset(assetId: string): Promise<AssetRecord | null> {
  const result = await query('SELECT * FROM assets WHERE id = $1', [assetId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? toAssetRecord(row) : null;
}

/**
 * Replaces editable costume metadata without allowing a stale browser snapshot
 * to roll back images committed by the revision pipeline. Omitted costume keys
 * are still deleted intentionally; retained keys always keep the image pointer
 * from the latest row locked inside this transaction.
 */
export async function updateAssetCostumesPreservingImages(
  assetId: string,
  projectId: string,
  costumes: readonly Record<string, unknown>[] | null,
): Promise<AssetRecord> {
  return tx(async (q) => {
    const locked = await q.query(
      'SELECT * FROM assets WHERE id = $1 AND "projectId" = $2 FOR UPDATE',
      [assetId, projectId],
    );
    const current = locked.rows[0] as Record<string, unknown> | undefined;
    if (!current) throw new Error('资产不存在');
    const merged = costumes === null
      ? null
      : mergeCostumeMetadataPreservingImages(current.costumes, costumes, current.imageUrl);
    const updated = await q.query(
      'UPDATE assets SET costumes = $1::jsonb, "updatedAt" = NOW() WHERE id = $2 AND "projectId" = $3 RETURNING *',
      [merged === null ? null : JSON.stringify(merged), assetId, projectId],
    );
    const row = updated.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('资产不存在');
    return toAssetRecord(row);
  });
}

/**
 * 创建资产。
 *
 * @throws Error 当输入校验失败
 */
export async function createAsset(input: AssetCreateInput): Promise<AssetRecord> {
  const validation = validateAssetCreate(input);
  if (!validation.valid) {
    throw new Error(`资产校验失败: ${validation.errors.join('; ')}`);
  }

  const id = genId();
  await query(
    `INSERT INTO assets
      (id, "projectId", kind, name, description, "imageUrl", metadata, tags,
       version, "assetType", "basePrompt", "isConfirmed", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, NOW(), NOW())`,
    [
      id,
      input.projectId,
      input.kind,
      input.name,
      input.description ?? null,
      input.imageUrl ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.assetType ?? null,
      input.basePrompt ?? null,
      input.isConfirmed ?? false,
    ],
  );

  const created = await getAsset(id);
  if (!created) throw new Error('资产创建后查询失败');
  return created;
}

/**
 * 更新资产（部分更新）。
 *
 * @throws Error 当补丁校验失败或资产不存在
 */
export async function updateAsset(assetId: string, patch: AssetUpdatePatch): Promise<AssetRecord> {
  const validation = validateAssetUpdate(patch);
  if (!validation.valid) {
    throw new Error(`资产更新校验失败: ${validation.errors.join('; ')}`);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const addField = (column: string, value: unknown): void => {
    setClauses.push(`${column} = $${idx}`);
    params.push(value);
    idx++;
  };

  if (patch.name !== undefined) addField('name', patch.name);
  if (patch.description !== undefined) addField('description', patch.description);
  if (patch.imageUrl !== undefined) addField('"imageUrl"', patch.imageUrl);
  if (patch.metadata !== undefined) {
    if (patch.metadata) {
      // 合并而非替换：防止部分 metadata PATCH 擦掉已有键。生产事故：资产确认只传
      // {confirmed,confirmedAt} 走全量替换 → 把整剧提取写入的 confirmed_voice /
      // suggested_voices / source / wholeScript 全擦了（7 角色语音推荐丢失）。jsonb ||
      // 是浅层 upsert：新键覆盖同名旧键，旧键无同名时保留。
      setClauses.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${idx}::jsonb`);
      params.push(JSON.stringify(patch.metadata));
      idx++;
    } else {
      // 显式 null 仍可清空（极少用，保留能力）。
      addField('metadata', null);
    }
  }
  if (patch.tags !== undefined) {
    addField('tags', patch.tags ? JSON.stringify(patch.tags) : null);
  }
  if (patch.assetType !== undefined) addField('"assetType"', patch.assetType);
  if (patch.basePrompt !== undefined) addField('"basePrompt"', patch.basePrompt);
  if (patch.isConfirmed !== undefined) addField('"isConfirmed"', patch.isConfirmed);
  if (patch.regenLocked !== undefined) addField('"regenLocked"', patch.regenLocked);
  if (patch.voiceId !== undefined) addField('"voiceId"', patch.voiceId);
  if (patch.voiceSource !== undefined) addField('"voiceSource"', patch.voiceSource);
  if (patch.auditionStatus !== undefined) addField('"auditionStatus"', patch.auditionStatus);
  // 资产富字段集中在同一个 PATCH Interface：角色/实体身份与音色、道具意义、环境
  // 氛围、造型版本和视频参考图预处理开关均走白名单更新。
  if (patch.background !== undefined) addField('background', patch.background);
  if (patch.voiceTrait !== undefined) addField('"voiceTrait"', patch.voiceTrait);
  if (patch.significance !== undefined) addField('significance', patch.significance);
  if (patch.intExt !== undefined) addField('"intExt"', patch.intExt);
  if (patch.mood !== undefined) addField('mood', patch.mood);
  if (patch.baseAmbience !== undefined) addField('"baseAmbience"', patch.baseAmbience);
  if (patch.identityLock !== undefined) {
    addField('"identityLock"', patch.identityLock ? JSON.stringify(patch.identityLock) : null);
  }
  if (patch.coverageScenes !== undefined) {
    addField('"coverageScenes"', patch.coverageScenes ? JSON.stringify(patch.coverageScenes) : null);
  }
  // 批4 costumes（JSONB）+ 批5/批6 gridOverlayEnabled/pencilPaintEnabled（boolean）
  if (patch.costumes !== undefined) {
    addField('costumes', patch.costumes ? JSON.stringify(patch.costumes) : null);
  }
  if (patch.gridOverlayEnabled !== undefined) addField('"gridOverlayEnabled"', patch.gridOverlayEnabled);
  if (patch.pencilPaintEnabled !== undefined) addField('"pencilPaintEnabled"', patch.pencilPaintEnabled);
  if (patch.pencilImageUrl !== undefined) addField('"pencilImageUrl"', patch.pencilImageUrl);
  if (patch.gridImageUrl !== undefined) addField('"gridImageUrl"', patch.gridImageUrl);

  if (setClauses.length === 0) {
    const current = await getAsset(assetId);
    if (!current) throw new Error('资产不存在');
    return current;
  }

  setClauses.push('"updatedAt" = NOW()');
  params.push(assetId);
  await query(
    `UPDATE assets SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    params,
  );

  const updated = await getAsset(assetId);
  if (!updated) throw new Error('资产不存在');
  return updated;
}

/**
 * 删除资产（幂等：不存在不抛错）。
 */
export async function deleteAsset(assetId: string): Promise<void> {
  await query('DELETE FROM assets WHERE id = $1', [assetId]);
}

/**
 * 删除项目下所有资产（项目级清理）。
 */
export async function deleteAssetsByProject(projectId: string): Promise<void> {
  await query('DELETE FROM assets WHERE "projectId" = $1', [projectId]);
}

// ============================================================
// 资产提取批量写入（P7.2-T2b）
// ============================================================
//
// 把 AI 资产提取结果（parseAssetExtraction 产物）落到 assets 表。
// 移植自 app1 src/app/api/projects/[projectId]/asset/extraction/route.ts 的 DB 写入段，
// 改造为 asset domain 原生函数（route 层只调 AI + 解析，不再持裸 SQL）。
//
// 语义：对 CHARACTER/PROP/LOCATION 各自「清理旧的未确认资产 + 插入新提取资产」。
//   - 清理仅删 isConfirmed=false AND regenLocked=false AND imageUrl IS NULL 的资产，
//     保留用户已确认 / 已锁定 / 已生图的成果（重提不破坏用户工作）。
//   - 插入走富列（characterId / coverageScenes / assetType / intExt / mood /
//     significance / costumes 等），供 P7.3 生图 / 配音消费。
//
// 当前实现按 characterId/双语别名/类型化名称跨集复用，合并 coverage/costumes，
// 支持 ENTITY，并保留用户确认、锁定、已生图、音色和手工文本。
// ============================================================

/**
 * 把累计分集提取结果合并到项目级资产表。
 *
 * app1 对齐规则：角色优先按 characterId，其次按双语姓名别名匹配；其他资产按
 * 归一化名称匹配。命中时合并 coverage/costumes，保留图片、确认、锁定、音色和
 * 用户文本；未命中才创建。这样第 N 集只会给既有人物补充新场景/造型，不会重建。
 */
export async function replaceExtractedAssets(
  projectId: string,
  extracted: ExtractedAssets,
): Promise<{ characters: number; items: number; environments: number; entities: number }> {
  // 路人/群演角色全部保留（用户需求）：剧本里出现的所有背景角色、群演、路人都要提取并保留，
  // 无具体人名的按「身份+天干」编号命名。提示词层（asset-prompt.ts rule #10）已要求 LLM
  // 提取全部背景角色。此处仅统计泛指角色数量用于观测，不再过滤删除。
  // 注：与 app1 extraction/route.ts:269-281 相反——app1 会过滤路人，本项目按需求保留。
  const anonymousCount = extracted.characters.filter((c) => isAnonymousCharacterName(c.name)).length;
  if (anonymousCount > 0) {
    console.log(`[replaceExtractedAssets] 保留泛指路人/群演角色 ${anonymousCount} 个（按用户需求不过滤）`);
  }

  const existing = await listAssets(projectId);
  const usedIds = new Set<string>();

  const protectionScore = (asset: AssetRecord): number =>
    (asset.isConfirmed ? 4 : 0) + (asset.regenLocked ? 2 : 0) + (asset.imageUrl ? 1 : 0);
  const putPreferred = (map: Map<string, AssetRecord>, key: string, asset: AssetRecord) => {
    if (!key) return;
    const current = map.get(key);
    if (!current || protectionScore(asset) > protectionScore(current)) map.set(key, asset);
  };

  const readSourceNames = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      : [];
  const aliasesFromAsset = (asset: AssetRecord): string[] => {
    const stored = asset.metadata && typeof asset.metadata === 'object'
      ? readSourceNames(asset.metadata.sourceNames)
      : [];
    return mergeStringArray(stored, getAssetNameAliases(asset.name));
  };
  const aliasesFromExtraction = (name: string, sourceNames: unknown): string[] =>
    mergeStringArray(readSourceNames(sourceNames), getAssetNameAliases(name));
  const findByAliases = (
    map: Map<string, AssetRecord>,
    kind: 'PROP' | 'LOCATION',
    name: string,
    sourceNames: unknown,
  ): AssetRecord | undefined => {
    for (const alias of aliasesFromExtraction(name, sourceNames)) {
      const asset = map.get(getAssetLookupKey(kind, alias));
      if (asset) return asset;
    }
    return undefined;
  };
  const indexAliases = (
    map: Map<string, AssetRecord>,
    kind: 'PROP' | 'LOCATION',
    asset: AssetRecord,
  ) => {
    for (const alias of aliasesFromAsset(asset)) {
      putPreferred(map, getAssetLookupKey(kind, alias), asset);
    }
  };

  const characterById = new Map<string, AssetRecord>();
  const characterByName = new Map<string, AssetRecord>();
  const propByName = new Map<string, AssetRecord>();
  const locationByName = new Map<string, AssetRecord>();
  const entityByName = new Map<string, AssetRecord>();
  for (const asset of existing) {
    if (asset.kind === 'CHARACTER') {
      if (asset.characterId?.trim()) putPreferred(characterById, asset.characterId.trim(), asset);
      for (const alias of getAssetNameAliases(asset.name)) {
        putPreferred(characterByName, getAssetLookupKey('CHARACTER', alias), asset);
      }
    } else if (asset.kind === 'PROP') {
      indexAliases(propByName, 'PROP', asset);
    } else if (asset.kind === 'LOCATION') {
      indexAliases(locationByName, 'LOCATION', asset);
    } else if (asset.kind === 'ENTITY') {
      putPreferred(entityByName, getAssetLookupKey('ENTITY', asset.name), asset);
    }
  }

  // —— CHARACTER：characterId → 双语姓名别名，三级复用 ——
  for (const c of extracted.characters) {
    const nextCostumes = (c.costumes ?? []).map((cv) => ({
      key: cv.key,
      label: cv.label,
      description: cv.description,
      identityLock: cv.identity_lock ?? [],
      imageUrl: null,
      coverageScenes: cv.coverage_scenes ?? [],
      coverageEpisodes: cv.coverage_episodes ?? [],
      ...(cv.variant_type === 'period' ? { variantType: 'period' as const } : {}),
    }));
    // 批6 音色库：AI 资产提取返回的 suggested_voices 预填 voiceTrait（取首个 desc）；
    // voiceId 暂留空（用户在 AssetDesignStage VoiceBrowserModal 选定后才 PATCH 写入）。
    // 同时把 suggested_voices 写入 metadata，供 UI 在音色库 modal 高亮 AI 推荐项。
    const suggestedVoices = Array.isArray(c.suggested_voices) ? c.suggested_voices : [];
    const voiceTrait =
      suggestedVoices.length > 0 && suggestedVoices[0]?.desc
        ? suggestedVoices[0].desc
        : null;
    let reusable = c.characterId?.trim() ? characterById.get(c.characterId.trim()) : undefined;
    if (!reusable) {
      for (const alias of getAssetNameAliases(c.name)) {
        reusable = characterByName.get(getAssetLookupKey('CHARACTER', alias));
        if (reusable) break;
      }
    }

    const oldMeta = reusable?.metadata && typeof reusable.metadata === 'object'
      ? reusable.metadata
      : {};
    const charMeta: Record<string, unknown> = { ...oldMeta, source: 'ai', extracted: true };
    if (suggestedVoices.length > 0) {
      charMeta.suggested_voices = suggestedVoices.map((v) => ({
        file: v.file,
        desc: v.desc ?? '',
        gender: v.gender ?? '',
      }));
    }
    // 默认绑 AI 推荐首个音色（对齐 app1 extraction/route.ts:446-449 / start-workflow:278-280）：
    // 仅当用户尚未确认时取 suggested_voices[0]，永不覆盖。confirmed_voice 供生成时作
    // Seedance reference_audio 顶到该角色（chain-generate route.ts:104-124 读它）。
    if (!charMeta.confirmed_voice && suggestedVoices[0]) {
      const v = suggestedVoices[0];
      charMeta.confirmed_voice = { file: v.file, desc: v.desc ?? '', gender: v.gender ?? '' };
    }
    if (reusable) {
      usedIds.add(reusable.id);
      if (reusable.name !== c.name) charMeta.canonicalName = c.name;
      const preserveText = shouldPreserveAssetTextFields(reusable);
      const mergedCostumes = mergeCostumes(reusable.costumes, nextCostumes);
      await query(
        `UPDATE assets SET
          description = $1, "assetType" = $2, background = $3,
          "identityLock" = $4::jsonb, "coverageScenes" = $5::jsonb,
          costumes = $6::jsonb, "characterId" = $7, "voiceTrait" = $8,
          metadata = $9::jsonb, "updatedAt" = NOW()
         WHERE id = $10 AND "projectId" = $11`,
        [
          preserveText ? reusable.description : (c.description || reusable.description || null),
          preserveText ? reusable.assetType : (c.role_type ?? reusable.assetType),
          preserveText ? reusable.background : (c.background ?? reusable.background),
          JSON.stringify(preserveText
            ? (reusable.identityLock ?? [])
            : mergeStringArray(c.identity_lock, reusable.identityLock)),
          JSON.stringify(mergeStringArray(c.coverage_scenes, reusable.coverageScenes)),
          JSON.stringify(mergedCostumes),
          reusable.characterId ?? c.characterId ?? null,
          reusable.voiceTrait ?? voiceTrait,
          JSON.stringify(charMeta),
          reusable.id,
          projectId,
        ],
      );
      continue;
    }

    const id = genId();
    await query(
      `INSERT INTO assets
        (id, "projectId", kind, name, description, "assetType", background,
         "identityLock", relationships, "coverageScenes", costumes, "characterId",
         "voiceTrait", metadata, "isConfirmed", "createdAt", "updatedAt")
       VALUES ($1, $2, 'CHARACTER', $3, $4, $5, $6,
               $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11,
               $12, $13::jsonb, false, NOW(), NOW())`,
      [
        id,
        projectId,
        c.name,
        c.description ?? null,
        c.role_type ?? null,
        c.background ?? null,
        JSON.stringify(c.identity_lock ?? []),
        JSON.stringify(c.relationships ?? []),
        JSON.stringify(c.coverage_scenes ?? []),
        JSON.stringify(nextCostumes),
        c.characterId ?? null,
        voiceTrait,
        JSON.stringify(charMeta),
      ],
    );
    usedIds.add(id);
    const created = await getAsset(id);
    if (created) {
      if (created.characterId?.trim()) characterById.set(created.characterId.trim(), created);
      for (const alias of getAssetNameAliases(created.name)) {
        characterByName.set(getAssetLookupKey('CHARACTER', alias), created);
      }
    }
  }

  // —— PROP ——
  for (const it of extracted.items) {
    const reusable = findByAliases(propByName, 'PROP', it.name, it.source_names);
    const oldMeta = reusable?.metadata && typeof reusable.metadata === 'object'
      ? reusable.metadata
      : {};
    const meta: Record<string, unknown> = { ...oldMeta, source: 'ai', extracted: true };
    const sourceNames = mergeStringArray(
      it.source_names,
      readSourceNames(oldMeta.sourceNames),
    );
    if (reusable && reusable.name !== it.name) sourceNames.push(reusable.name);
    meta.sourceNames = Array.from(new Set(sourceNames));
    if (it.requiresCharacterRef) {
      meta.requiresCharacterRef = true;
      meta.involvedCharacters = it.involvedCharacters ?? [];
    }
    // 道具变体（对齐角色 costumes：基准 default + 状态变体），写库统一 camelCase。
    const itemCostumes = (it.costumes ?? []).map((cv) => ({
      key: cv.key,
      label: cv.label,
      description: cv.description,
      identityLock: cv.identity_lock ?? [],
      imageUrl: null,
      coverageScenes: cv.coverage_scenes ?? [],
      coverageEpisodes: cv.coverage_episodes ?? [],
      ...(cv.variant_type === 'period' ? { variantType: 'period' as const } : {}),
    }));
    if (reusable) {
      usedIds.add(reusable.id);
      const preserveText = shouldPreserveAssetTextFields(reusable);
      const preserveName = shouldProtectAssetFromDeletion(reusable);
      if (preserveName && reusable.name !== it.name) meta.canonicalDisplayName = it.name;
      await query(
        `UPDATE assets SET name = $1, description = $2, "assetType" = $3, significance = $4,
          "coverageScenes" = $5::jsonb, costumes = $6::jsonb, metadata = $7::jsonb, "updatedAt" = NOW()
         WHERE id = $8 AND "projectId" = $9`,
        [
          preserveName ? reusable.name : it.name,
          preserveText ? reusable.description : (it.description || reusable.description || null),
          preserveText ? reusable.assetType : (it.item_type ?? reusable.assetType),
          preserveText ? reusable.significance : (it.significance ?? reusable.significance),
          JSON.stringify(mergeStringArray(it.coverage_scenes, reusable.coverageScenes)),
          JSON.stringify(mergeCostumes(reusable.costumes, itemCostumes)),
          JSON.stringify(meta),
          reusable.id,
          projectId,
        ],
      );
      continue;
    }
    const id = genId();
    await query(
      `INSERT INTO assets
        (id, "projectId", kind, name, description, "assetType", significance,
         "coverageScenes", costumes, metadata, "isConfirmed", "createdAt", "updatedAt")
       VALUES ($1, $2, 'PROP', $3, $4, $5, $6,
               $7::jsonb, $8::jsonb, $9::jsonb, false, NOW(), NOW())`,
      [
        id,
        projectId,
        it.name,
        it.description ?? null,
        it.item_type ?? null,
        it.significance ?? null,
        JSON.stringify(it.coverage_scenes ?? []),
        JSON.stringify(itemCostumes),
        JSON.stringify(meta),
      ],
    );
    usedIds.add(id);
    const created = await getAsset(id);
    if (created) indexAliases(propByName, 'PROP', created);
  }

  // —— LOCATION ——
  for (const env of extracted.environments) {
    const reusable = findByAliases(locationByName, 'LOCATION', env.name, env.source_names);
    const oldMeta = reusable?.metadata && typeof reusable.metadata === 'object'
      ? reusable.metadata
      : {};
    const sourceNames = mergeStringArray(
      env.source_names,
      readSourceNames(oldMeta.sourceNames),
    );
    if (reusable && reusable.name !== env.name) sourceNames.push(reusable.name);
    const meta: Record<string, unknown> = {
      ...oldMeta,
      source: 'ai',
      extracted: true,
      sourceNames: Array.from(new Set(sourceNames)),
    };
    // 环境变体（对齐角色 costumes：基准 default + 时段/状态变体），写库统一 camelCase。
    const envCostumes = (env.costumes ?? []).map((cv) => ({
      key: cv.key,
      label: cv.label,
      description: cv.description,
      identityLock: cv.identity_lock ?? [],
      imageUrl: null,
      coverageScenes: cv.coverage_scenes ?? [],
      coverageEpisodes: cv.coverage_episodes ?? [],
      ...(cv.variant_type === 'period' ? { variantType: 'period' as const } : {}),
    }));
    if (reusable) {
      usedIds.add(reusable.id);
      const preserveText = shouldPreserveAssetTextFields(reusable);
      const preserveName = shouldProtectAssetFromDeletion(reusable);
      if (preserveName && reusable.name !== env.name) meta.canonicalDisplayName = env.name;
      await query(
        `UPDATE assets SET name = $1, description = $2, "intExt" = $3, mood = $4,
          "baseAmbience" = $5, "coverageScenes" = $6::jsonb, costumes = $7::jsonb, metadata = $8::jsonb,
          "updatedAt" = NOW()
         WHERE id = $9 AND "projectId" = $10`,
        [
          preserveName ? reusable.name : env.name,
          preserveText ? reusable.description : (env.description || reusable.description || null),
          preserveText ? reusable.intExt : (env.int_ext ?? reusable.intExt),
          preserveText ? reusable.mood : (env.mood ?? reusable.mood),
          preserveText ? reusable.baseAmbience : (env.base_ambience ?? reusable.baseAmbience),
          JSON.stringify(mergeStringArray(env.coverage_scenes, reusable.coverageScenes)),
          JSON.stringify(mergeCostumes(reusable.costumes, envCostumes)),
          JSON.stringify(meta),
          reusable.id,
          projectId,
        ],
      );
      continue;
    }
    const id = genId();
    await query(
      `INSERT INTO assets
        (id, "projectId", kind, name, description, "intExt", mood, "baseAmbience",
         "coverageScenes", costumes, metadata, "isConfirmed", "createdAt", "updatedAt")
       VALUES ($1, $2, 'LOCATION', $3, $4, $5, $6, $7,
               $8::jsonb, $9::jsonb, $10::jsonb, false, NOW(), NOW())`,
      [
        id,
        projectId,
        env.name,
        env.description ?? null,
        env.int_ext ?? null,
        env.mood ?? null,
        env.base_ambience ?? null,
        JSON.stringify(env.coverage_scenes ?? []),
        JSON.stringify(envCostumes),
        JSON.stringify(meta),
      ],
    );
    usedIds.add(id);
    const created = await getAsset(id);
    if (created) indexAliases(locationByName, 'LOCATION', created);
  }

  // —— ENTITY：非人发声体使用独立资产类型，但和角色共享音色建议/确认保护语义 ——
  for (const entity of extracted.entities ?? []) {
    const reusable = entityByName.get(getAssetLookupKey('ENTITY', entity.name));
    const oldMeta = reusable?.metadata && typeof reusable.metadata === 'object'
      ? reusable.metadata
      : {};
    const suggestedVoices = Array.isArray(entity.suggested_voices)
      ? entity.suggested_voices
      : [];
    const metadata: Record<string, unknown> = {
      ...oldMeta,
      source: 'ai',
      extracted: true,
      entityType: entity.entity_type || 'other',
      ...(suggestedVoices.length > 0
        ? {
            suggested_voices: suggestedVoices.map((voice) => ({
              file: voice.file,
              desc: voice.desc ?? '',
              gender: voice.gender ?? '',
            })),
          }
        : {}),
    };
    // 默认绑 AI 推荐首个音色（同 CHARACTER，对齐 app1 extraction:681 / start-workflow:319）。
    if (!metadata.confirmed_voice && suggestedVoices[0]) {
      const v = suggestedVoices[0];
      metadata.confirmed_voice = { file: v.file, desc: v.desc ?? '', gender: v.gender ?? '' };
    }
    const voiceTrait = suggestedVoices[0]?.desc || null;

    if (reusable) {
      usedIds.add(reusable.id);
      const preserveText = shouldPreserveAssetTextFields(reusable);
      await query(
        `UPDATE assets SET description = $1, "assetType" = $2,
          "identityLock" = $3::jsonb, "coverageScenes" = $4::jsonb,
          "voiceTrait" = $5, metadata = $6::jsonb, "updatedAt" = NOW()
         WHERE id = $7 AND "projectId" = $8`,
        [
          preserveText ? reusable.description : (entity.description || reusable.description || null),
          preserveText ? reusable.assetType : (entity.entity_type ?? reusable.assetType),
          JSON.stringify(preserveText
            ? (reusable.identityLock ?? [])
            : mergeStringArray(entity.identity_lock, reusable.identityLock)),
          JSON.stringify(mergeStringArray(entity.coverage_scenes, reusable.coverageScenes)),
          reusable.voiceTrait ?? voiceTrait,
          JSON.stringify(metadata),
          reusable.id,
          projectId,
        ],
      );
      continue;
    }

    const id = genId();
    await query(
      `INSERT INTO assets
        (id, "projectId", kind, name, description, "assetType", "identityLock",
         "coverageScenes", "voiceTrait", metadata, "isConfirmed", "createdAt", "updatedAt")
       VALUES ($1, $2, 'ENTITY', $3, $4, $5, $6::jsonb,
               $7::jsonb, $8, $9::jsonb, false, NOW(), NOW())`,
      [
        id,
        projectId,
        entity.name,
        entity.description ?? null,
        entity.entity_type ?? 'other',
        JSON.stringify(entity.identity_lock ?? []),
        JSON.stringify(entity.coverage_scenes ?? []),
        voiceTrait,
        JSON.stringify(metadata),
      ],
    );
    usedIds.add(id);
    const created = await getAsset(id);
    if (created) entityByName.set(getAssetLookupKey('ENTITY', created.name), created);
  }

  // 聚合脚本中已经不再出现的 AI 临时资产才清理；任何确认、锁定或已生图成果保留。
  for (const asset of existing) {
    if (!['CHARACTER', 'PROP', 'LOCATION', 'ENTITY'].includes(asset.kind)) continue;
    if (usedIds.has(asset.id) || shouldProtectAssetFromDeletion(asset)) continue;
    if (asset.metadata?.extracted !== true || asset.metadata?.source !== 'ai') continue;
    await query('DELETE FROM assets WHERE id = $1 AND "projectId" = $2', [asset.id, projectId]);
  }

  return {
    characters: extracted.characters.length,
    items: extracted.items.length,
    environments: extracted.environments.length,
    entities: extracted.entities?.length ?? 0,
  };
}
