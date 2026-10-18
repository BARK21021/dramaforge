// ============================================================
// shot-asset-reference.ts — 镜头引用资产解析（批6 简化版，Step 2）
// ============================================================
//
// 镜像 app1 `D:\app1\src\core\shot\asset-reference.ts` 的核心 resolve 函数。
// 批7 已补：造型（costume）三级优先解析链
//   manual override（referencedAssets.characterCostumes）
//   > scene 自动匹配（selectCharacterCostume × coverageScenes）
//   > default（asset.imageUrl）
//   对齐 app1 asset-reference.ts:97-119（含 coverage_scenes snake_case 兼容）。
//
// 仍未移植（出图/视频链路相关，本轮硬边界外，留下一步）：
//   - getBilingualNameAliases 双语别名匹配
//   - buildAssetImageProxyUrl server 代理 URL（OP3：dramaforge 直接用 asset.imageUrl
//     sf-asset://，server 全程不碰媒体字节，dramaforge-assets-client-local 满足）
//   - findMissingVariantImages 缺图检测
//   - buildVolcengineAssetReferencePrompt 火山引擎参考图提示词
//   - Levenshtein 模糊匹配
//
// 核心纯函数：按 name 精确匹配（lowercase + 去标点归一化）+ 造型三级优先链 → 返回 binding 数组。
//
// 媒体策略（dramaforge-assets-client-local 铁律）：
//   thumbnailUrl = asset.imageUrl（sf-asset:// 在 Electron protocol.handle 显示）
//   server 全程不碰媒体字节，无 landAssetImage，无 proxy route。
// ============================================================

import type { AssetRecord } from '@dramaforge/server';

// ============================================================
// 类型（与 app1 @core/types/entities 对齐，简化版）
// ============================================================

export type ShotAssetReferenceKind = 'CHARACTER' | 'LOCATION' | 'PROP';

/**
 * 镜头对角色的造型（costume）引用。
 *
 * 数据模型决策：`characters` 保持纯 `string[]` 不动（生成链路按纯字符串消费），
 * 造型归属独立字段 `referencedAssets.characterCostumes`。
 * - `name` 必须出现在 `characters` 中（PATCH 路由校验子集关系）。
 * - `costumeKey === 'default'`（或 '默认'/空）时**不入库**：选默认 = 删条目，让该角色
 *   走自动匹配/默认图。resolver 视 default 为「未手动覆盖」。
 * - 单角色单选互斥：同一 `name` 在数组中唯一（PATCH 路由校验）。
 */
export interface CharacterCostumeRef {
  name: string;
  costumeKey: string;
}

/** 镜头对资产的引用绑定（用于显示徽标 + hover 缩略图） */
export interface ShotAssetReferenceBinding {
  assetId?: string;
  kind: ShotAssetReferenceKind;
  /** 引用来源字段（referencedAssets.characters/environments/items） */
  sourceField?: 'characters' | 'environments' | 'items';
  name: string;
  /** 在镜头中的图片序号（"图片1"/"图片2"…） */
  promptRef: string;
  index: number;
  /** 资产图 URL（sf-asset:// 直接，非 proxy URL） */
  imageUrl: string | null;
  /** 缩略图 URL（dramaforge 简化：= imageUrl） */
  thumbnailUrl: string | null;
  description: string | null;
  assetType: string | null;
  /** 命中的造型 key（仅 CHARACTER 且非 default 时填充；对齐 app1 entities.ts:265-267） */
  costumeKey?: string;
  /** 命中的造型展示名（label 缺失时回退 costumeKey） */
  costumeLabel?: string;
}

/** 镜头.referencedAssets JSONB 形状（声明本组件使用的字段） */
export interface ShotReferencedAssets {
  characters?: string[];
  environments?: string[];
  items?: string[];
  /** 角色→造型手动覆盖（批7；name∈characters、单选互斥；default 不入库） */
  characterCostumes?: CharacterCostumeRef[];
  /** 道具→造型手动覆盖（对齐 characterCostumes；name∈items、default 不入库） */
  itemCostumes?: CharacterCostumeRef[];
  /** 环境→造型手动覆盖（对齐 characterCostumes；name∈environments、default 不入库） */
  environmentCostumes?: CharacterCostumeRef[];
  [key: string]: unknown;
}

type ShotLike = {
  referencedAssets?: ShotReferencedAssets | null;
  metadata?: Record<string, unknown> | null;
  /** 镜头所属场景 id（"S1" 或分段 "S1-1"）；缺失时回退 metadata.sceneId */
  sceneId?: string;
};

// ============================================================
// 工具函数
// ============================================================

/** 把名字归一化：lowercase + 去掉空格/连字符/下划线/中英标点 */
function normalizeName(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[\s\-_·.,'"()（）]/g, '')
    : '';
}

const GROUP_FIELDS = [
  { kind: 'CHARACTER' as const, field: 'characters' as const },
  { kind: 'LOCATION' as const, field: 'environments' as const },
  { kind: 'PROP' as const, field: 'items' as const },
];

// ============================================================
// 造型（costume）匹配 helper（批7，移植 app1 asset-reference.ts:78-119）
// ============================================================
//
// 对齐 app1 的三个 helper。dramaforge 与 app1 的差异：
//   - dramaforge AssetRecord.costumes 是 `Record<string, unknown>[] | null`（松类型），
//     app1 是强类型 CostumeVariant[]。这里用一个本地收窄的 CostumeLike 做安全读取，
//     不依赖 server 是否导出 CostumeVariant。
//   - 保留 coverage_scenes snake_case 兼容（app1 同款，DB 历史 JSONB）。

/** costume JSONB 行的收窄视图（读时安全访问，不强制结构） */
type CostumeLike = {
  key?: string;
  label?: string;
  imageUrl?: string | null;
  coverageScenes?: string[];
  coverage_scenes?: string[];
};

/**
 * 是否为 default 造型 key（空 / 'default' / '默认'）。
 *
 * 共用口径：resolver / validation / route 三处按「不跨域导入」约定各自复制本正则，
 * 注释标口径。修改这里时同步改 validation.ts 的 isDefaultCostumeKey 与 route.ts 的
 * inline 检测。
 */
export function isDefaultCostumeKey(key: string | undefined | null): boolean {
  return !key || /^(default|默认)$/i.test(key);
}

/**
 * 提取场景 id 的基础编号（"S1-1" → "S1"；"S1" → "S1"；非 S 前缀 → trim 原值）。
 *
 * 分镜后处理会把场景 id 改写为 `${scene.id}-${i+1}`（如 "S1-1"），而变体
 * coverageScenes 存的是基础 id。归一化后才能比对。
 */
function extractBaseSceneId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const m = value.trim().match(/^(S\d+)/i);
  return m ? m[1].toUpperCase() : value.trim();
}

/**
 * 为角色资产选择命中当前镜头场景的造型变体（app1 asset-reference.ts:97-119）。
 *
 * 匹配策略：按基础场景 id（"S1-1"→"S1"）比对 costume.coverageScenes；命中则返回
 * 该变体（含其 imageUrl）；未命中或无变体回退 default / 顶层 imageUrl。
 * 兼容历史 snake_case（coverage_scenes）。
 */
function selectCharacterCostume(
  asset: AssetRecord,
  sceneId: string | undefined,
): { variant?: CostumeLike; imageUrl: string | null } {
  const costumes = Array.isArray(asset.costumes)
    ? (asset.costumes as CostumeLike[])
    : [];
  if (costumes.length === 0) {
    return { imageUrl: asset.imageUrl };
  }
  const defaultVariant = costumes.find((c) => isDefaultCostumeKey(c.key));
  const fallback: { variant?: CostumeLike; imageUrl: string | null } = {
    variant: defaultVariant,
    imageUrl: defaultVariant?.imageUrl || asset.imageUrl,
  };
  if (!sceneId) return fallback;
  const baseSceneId = extractBaseSceneId(sceneId);
  if (!baseSceneId) return fallback;
  const matched = costumes.find((c) => {
    const scenes = (c.coverageScenes ?? c.coverage_scenes) as unknown[] | undefined;
    if (!Array.isArray(scenes)) return false;
    return scenes.some((s) => extractBaseSceneId(s) === baseSceneId);
  });
  if (matched) {
    return { variant: matched, imageUrl: matched.imageUrl || asset.imageUrl };
  }
  return fallback;
}

// ============================================================
// 核心解析
// ============================================================

/**
 * 解析镜头引用的标准资产。
 *
 * 策略（对齐 app1 + 批7 造型三级优先链）：
 *   1. 按 kind+normalizedName 构建资产索引（首次命中保留优先级，避免别名碰撞覆盖）
 *   2. 遍历 referencedAssets.{characters,environments,items}
 *      - environments 缺失时回退 metadata.sceneLocation（app1 同款兜底）
 *   3. 按 name 精确匹配（normalize 后）→ 生成 binding
 *   4. CHARACTER 命中时，造型图按三级优先链解析：
 *      a. manual override（refs.characterCostumes 命中 + 非 default + key 真实存在）
 *         → 用该变体 imageUrl/label
 *      b. scene 自动匹配（selectCharacterCostume × coverageScenes × 镜头 sceneId）
 *      c. default（asset.imageUrl）
 *      环境/道具跳过本步骤。
 *   5. 排序：保持 characters → environments → items 顺序，promptRef 从 1 自增
 *
 * sceneId 读取顺序（与 StoryboardStage.getGroupKey 兜底一致）：
 *   shot.sceneId → metadata.sceneId → metadata.storyboardTable.sceneId
 *
 * @param shot 镜头（含 referencedAssets + metadata，可选顶层 sceneId）
 * @param allAssets 项目下全部资产（ShotAssetReferenceBadges 缩略图源）
 * @param _projectId 保留参数（兼容 app1 签名；dramaforge 不需要，URL 在 asset.imageUrl）
 */
export function resolveShotAssetReferenceBindings(
  shot: ShotLike,
  allAssets: AssetRecord[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _projectId?: string,
): ShotAssetReferenceBinding[] {
  const metadata =
    shot.metadata && typeof shot.metadata === 'object'
      ? shot.metadata
      : {};

  const refs = shot.referencedAssets || {};

  // 资产索引：kind:normalizedName → AssetRecord（首次命中保留）
  const assetIndex = new Map<string, AssetRecord>();
  for (const asset of allAssets) {
    const key = `${asset.kind}:${normalizeName(asset.name)}`;
    if (!assetIndex.has(key)) assetIndex.set(key, asset);
  }

  // 镜头 sceneId：shot.sceneId → metadata.sceneId → metadata.storyboardTable.sceneId
  const sbTable =
    metadata.storyboardTable && typeof metadata.storyboardTable === 'object'
      ? (metadata.storyboardTable as Record<string, unknown>)
      : {};
  const metaSceneId =
    (typeof metadata.sceneId === 'string' && metadata.sceneId.trim()) ||
    (typeof sbTable.sceneId === 'string' && sbTable.sceneId.trim()) ||
    '';
  const shotSceneId = shot.sceneId || metaSceneId || '';

  // manual override 索引：规范名 → CharacterCostumeRef（last-wins；唯一性由 PATCH 校验保证）。
  // key 不存在/为 default 时 resolver 静默回退下级。角色/道具/环境三种 kind 各一桶，分别
  // 读 referencedAssets.characterCostumes / itemCostumes / environmentCostumes（结构同为
  // {name, costumeKey}）——对齐 server group-preview 的 selectVariantForShot，让分镜里换的
  // 道具/环境变体也在预览徽标图上生效（此前 web resolver 只处理角色，与 server 分叉）。
  const costumeOverrideByKind: Record<ShotAssetReferenceKind, Map<string, CharacterCostumeRef>> = {
    CHARACTER: new Map(),
    LOCATION: new Map(),
    PROP: new Map(),
  };
  const collectOverride = (arr: unknown, map: Map<string, CharacterCostumeRef>): void => {
    if (!Array.isArray(arr)) return;
    for (const cc of arr) {
      if (
        cc &&
        typeof cc === 'object' &&
        typeof (cc as CharacterCostumeRef).name === 'string' &&
        typeof (cc as CharacterCostumeRef).costumeKey === 'string'
      ) {
        map.set((cc as CharacterCostumeRef).name, cc as CharacterCostumeRef);
      }
    }
  };
  collectOverride(refs.characterCostumes, costumeOverrideByKind.CHARACTER);
  collectOverride(refs.itemCostumes, costumeOverrideByKind.PROP);
  collectOverride(refs.environmentCostumes, costumeOverrideByKind.LOCATION);

  // 环境兜底：referencedAssets.environments 缺失时用 metadata.sceneLocation
  const environmentNames =
    Array.isArray(refs.environments) && refs.environments.length > 0
      ? refs.environments
      : typeof metadata.sceneLocation === 'string' && metadata.sceneLocation.trim()
        ? [metadata.sceneLocation.trim()]
        : [];

  const rawGroups: Array<{
    kind: ShotAssetReferenceKind;
    field: 'characters' | 'environments' | 'items';
    names: string[];
  }> = [
    { kind: 'CHARACTER', field: 'characters', names: Array.isArray(refs.characters) ? refs.characters : [] },
    { kind: 'LOCATION', field: 'environments', names: environmentNames },
    { kind: 'PROP', field: 'items', names: Array.isArray(refs.items) ? refs.items : [] },
  ];

  const result: ShotAssetReferenceBinding[] = [];
  const seen = new Set<string>();

  for (const group of rawGroups) {
    for (const rawName of group.names) {
      if (!rawName || typeof rawName !== 'string') continue;
      const key = `${group.kind}:${normalizeName(rawName)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const asset = assetIndex.get(key);

      // 造型三级优先链（角色/道具/环境三种 kind 共用，对齐 server group-preview
      //   selectVariantForShot）：manual override > scene 自动匹配 > default（asset.imageUrl）
      //   非 default 命中：切换 imageUrl 到变体图，并记录 costumeKey/label。
      //   default（含未命中 + 自动匹配回退到 default 变体）：不填 costumeKey/label，
      //   与 app1 行为一致（默认造型不显式标注）。
      let bindingImageUrl = asset?.imageUrl || null;
      let bindingCostumeKey: string | undefined;
      let bindingCostumeLabel: string | undefined;
      if (asset) {
        const refName = asset.name || rawName;
        const overrideMap = costumeOverrideByKind[group.kind];
        const manual = overrideMap.get(refName) || overrideMap.get(rawName);
        let resolved: { variant?: CostumeLike; imageUrl: string | null } | undefined;
        if (manual && !isDefaultCostumeKey(manual.costumeKey)) {
          // Tier 1：manual override。key 真实存在 → 取该变体；悬空（变体已删）→ 静默
          // 回退下级（接受惰性报错；下次保存该镜头时 PATCH 400 拦截）。
          const costumes = Array.isArray(asset.costumes)
            ? (asset.costumes as CostumeLike[])
            : [];
          const variant = costumes.find((c) => c.key === manual.costumeKey);
          if (variant) {
            resolved = { variant, imageUrl: variant.imageUrl || asset.imageUrl };
          }
        }
        if (!resolved) {
          // Tier 2：scene 自动匹配（未命中或无 manual 时）。
          resolved = selectCharacterCostume(asset, shotSceneId || undefined);
        }
        if (resolved.imageUrl) bindingImageUrl = resolved.imageUrl;
        if (resolved.variant && !isDefaultCostumeKey(resolved.variant.key)) {
          bindingCostumeKey = resolved.variant.key;
          bindingCostumeLabel = resolved.variant.label || resolved.variant.key;
        }
      }

      result.push({
        assetId: asset?.id,
        kind: group.kind,
        sourceField: group.field,
        name: asset?.name || rawName,
        promptRef: '',
        index: 0,
        // dramaforge 媒体策略：直接用 asset.imageUrl（sf-asset://，server 不碰字节）
        imageUrl: bindingImageUrl,
        thumbnailUrl: bindingImageUrl,
        description: asset?.description || null,
        assetType: asset?.assetType || null,
        costumeKey: bindingCostumeKey,
        costumeLabel: bindingCostumeLabel,
      });
    }
  }

  // 自增 promptRef（"图片1"/"图片2"…，对齐 app1）
  return result.map((binding, idx) => ({
    ...binding,
    index: idx + 1,
    promptRef: `图片${idx + 1}`,
  }));
}
