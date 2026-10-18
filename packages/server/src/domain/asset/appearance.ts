// ============================================================
// ③ server/domain/asset/appearance — 资产"出场集"聚合（资产总表用）
// ============================================================
//
// 文件职责：
//   计算项目级"资产 × 集"出场矩阵——每个资产（含变体）出现在哪些集。
//   供 web `GET /api/projects/[id]/assets/master` 一次性返回，前端渲染
//   资产总表（资产×集矩阵）/ 按集查看。
//
// 数据来源决策（见 spec 2026-07-28 §2 D2）：
//   assets.coverageScenes 存的是**集内本地场景号**（逐集分析产生，跨集合并后
//   歧义），不可用于跨集"出场集"聚合。改从 shots 派生——每个 shot 有确定
//   episodeId + referencedAssets（名称引用），按 name→资产解析得到出场集。
//   名称归一化复用 normalizeAssetName（与 web shot-asset-reference.ts 的
//   normalizeName 同正则，保证与分镜绑定展示一致）。
//
// 变体级出场（断剑态/修复态 / 道具状态 / 环境时段）：
//   两个可信来源——① 资产阶段：costumes[].coverage_episodes（AI 看 === EP{n} === 标记
//   输出的集号，跨集可靠）；② 分镜阶段：shot.referencedAssets.characterCostumes 的
//   显式 override（name→非 default costumeKey）。两者按集并集。coverageScenes 的
//   集内场景号跨集不可靠，不在此模块做。
//
// 安全约束：零 ffmpeg；纯读 + 内存聚合。
// ============================================================

import type { AssetRecord } from './service';
import { listAssets } from './service';
import { normalizeAssetName } from './asset-reuse';
import { listShots, type ShotRecord } from '../storyboard/service';
import { listByProject } from '../episode/service';

// ------------------------------------------------------------
// 对外契约
// ------------------------------------------------------------

/** 集摘要（资产总表列头） */
export interface EpisodeSummary {
  id: string;
  episodeNumber: number;
  title: string | null;
}

/** 单个变体（含主形象 default）在某资产的出场情况 */
export interface AssetVariantAppearance {
  /** 'default' = 主形象；其他 = 变体 key */
  key: string;
  /** 展示名（主形象='主形象'；变体=label 或 key） */
  label: string;
  /** 该变体出场的集号（升序去重） */
  episodes: number[];
  /** 该变体是否有图（主形象看 asset.imageUrl；变体看 costume.imageUrl） */
  hasImage: boolean;
  /** 该变体的图片 URL（sf-asset://；无图则 null）。供总表缩略展示 */
  imageUrl: string | null;
}

/** 单个资产的出场聚合 */
export interface AssetAppearance {
  /** 按变体拆分的出场（含 default 主形象） */
  byVariant: AssetVariantAppearance[];
  /** 该资产出场的全部集号（所有变体并集，升序去重） */
  allEpisodes: number[];
}

/** master 端点响应体 */
export interface AssetMasterResult {
  assets: AssetRecord[];
  episodes: EpisodeSummary[];
  /** assetId → 出场聚合 */
  appearance: Record<string, AssetAppearance>;
  statusCounts: {
    /** 资产总数 */
    total: number;
    /** 主形象 + 变体 槽位总数 */
    imageTotal: number;
    /** 其中有图的槽位数 */
    imagePresent: number;
    /** 无任何出场集的资产数 */
    unassigned: number;
  };
}

// ------------------------------------------------------------
// 内部工具
// ------------------------------------------------------------

/** referencedAssets JSONB 的读取形状 */
interface ReferencedAssetsLike {
  characters?: unknown;
  environments?: unknown;
  items?: unknown;
  characterCostumes?: unknown;
}

const GROUP_FIELDS = [
  { kind: 'CHARACTER' as const, field: 'characters' as const },
  { kind: 'LOCATION' as const, field: 'environments' as const },
  { kind: 'PROP' as const, field: 'items' as const },
] as const;

/** 是否为 default 造型 key（空 / 'default' / '默认'）。与 shot-asset-reference.ts 同口径。 */
function isDefaultCostumeKey(key: string | undefined | null): boolean {
  return !key || /^(default|默认)$/i.test(key);
}

/** 安全读 string[] */
function readStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 安全读 number[]（集号），仅保留有限数字 */
function readNumberArray(v: unknown): number[] {
  return Array.isArray(v)
    ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    : [];
}

/** costume JSONB 行的收窄视图 */
type CostumeLike = {
  key?: string;
  label?: string;
  imageUrl?: string | null;
};

/**
 * 计算项目级资产出场矩阵。
 *
 * 步骤：
 *   1. 拉 assets / shots(全量) / episodes
 *   2. 建 name 索引：`${kind}:${normalizeAssetName(name)}` → asset（首命中保留）
 *   3. 建 episodeId → episodeNumber 映射
 *   4. 遍历 shots：解析 referencedAssets 名称→asset，按集号记入对应变体
 *   5. 汇总 statusCounts
 */
export async function computeAssetMaster(projectId: string): Promise<AssetMasterResult> {
  const [assets, shots, episodes] = await Promise.all([
    listAssets(projectId),
    listShots(projectId),
    listByProject(projectId),
  ]);

  // —— name 索引（首命中保留，避免别名碰撞覆盖；对齐 web resolver）——
  const nameIndex = new Map<string, AssetRecord>();
  for (const a of assets) {
    const key = `${a.kind}:${normalizeAssetName(a.name)}`;
    if (key.endsWith(':') ) continue; // 空名跳过
    if (!nameIndex.has(key)) nameIndex.set(key, a);
  }

  // —— episodeId → episodeNumber ——
  const epNumById = new Map<string, number>();
  for (const e of episodes) {
    epNumById.set(e.id, e.episodeNumber);
  }

  // —— 初始化每个资产的变体出场桶 ——
  // appearance[assetId].byVariant: 主形象(default) + 各 costume 变体
  const appearance: Record<string, AssetAppearance> = {};
  const variantBucket = new Map<string, Set<number>>(); // `${assetId}:${variantKey}` → 集号集
  const assetVariants = new Map<string, CostumeLike[]>(); // assetId → costumes（含合成的 default）

  for (const a of assets) {
    const costumes: CostumeLike[] = Array.isArray(a.costumes)
      ? (a.costumes as CostumeLike[])
      : [];
    // 主形象桶（default）；若无 costumes，主形象 = 顶层 imageUrl
    const variants: CostumeLike[] = [{ key: 'default', label: '主形象', imageUrl: a.imageUrl }];
    for (const c of costumes) {
      if (isDefaultCostumeKey(c.key)) {
        // 覆盖合成 default 的 label/imageUrl
        variants[0] = { key: 'default', label: c.label || '主形象', imageUrl: c.imageUrl ?? a.imageUrl };
      } else {
        variants.push({ key: c.key || '', label: c.label || c.key || '', imageUrl: c.imageUrl ?? null });
      }
    }
    assetVariants.set(a.id, variants);
    for (const v of variants) {
      variantBucket.set(`${a.id}:${v.key || 'default'}`, new Set<number>());
    }
    // —— 播种：从 costumes[].coverage_episodes 种入集号 ——
    // 让按集查看在资产阶段（不等分镜）就有数据。coverage_episodes 是 AI 看 === EP{n} ===
    // 标记输出的集号，跨集可靠（与 coverageScenes 的集内场景号不同）。兼容 snake/camel 命名。
    // 后续 shots 派生的出场集会与这里并集（同 bucket.add）。
    for (const c of costumes) {
      const raw = c as Record<string, unknown>;
      const eps = readNumberArray(raw.coverageEpisodes).length > 0
        ? readNumberArray(raw.coverageEpisodes)
        : readNumberArray(raw.coverage_episodes);
      if (eps.length === 0) continue;
      const vKey = isDefaultCostumeKey(typeof c.key === 'string' ? c.key : '') ? 'default' : (c.key || 'default');
      const bucket = variantBucket.get(`${a.id}:${vKey}`);
      if (bucket) for (const e of eps) bucket.add(e);
    }
    appearance[a.id] = { byVariant: [], allEpisodes: [] };
  }

  // —— name → 变体 override 索引（每 shot 的 characterCostumes）+ 名称解析记入 ——
  for (const shot of shots) {
    if (!shot.episodeId) continue;
    const epNum = epNumById.get(shot.episodeId);
    if (epNum == null) continue;

    const refs = (shot.referencedAssets ?? {}) as ReferencedAssetsLike;
    // 该 shot 的角色名→变体 override
    const costumeOverride = new Map<string, string>();
    if (Array.isArray(refs.characterCostumes)) {
      for (const cc of refs.characterCostumes as Array<Record<string, unknown>>) {
        const n = typeof cc.name === 'string' ? cc.name : '';
        const k = typeof cc.costumeKey === 'string' ? cc.costumeKey : '';
        if (n && k && !isDefaultCostumeKey(k)) {
          costumeOverride.set(normalizeAssetName(n), k);
        }
      }
    }

    for (const g of GROUP_FIELDS) {
      const names = readStringArray(refs[g.field]);
      for (const rawName of names) {
        const asset = nameIndex.get(`${g.kind}:${normalizeAssetName(rawName)}`);
        if (!asset) continue;
        // 变体：CHARACTER 有 override 用 override，否则 default；PROP/LOCATION 恒 default
        const vKey =
          g.kind === 'CHARACTER'
            ? costumeOverride.get(normalizeAssetName(rawName)) ?? 'default'
            : 'default';
        variantBucket.get(`${asset.id}:${vKey}`)?.add(epNum);
      }
    }
  }

  // —— 组装 byVariant + allEpisodes + statusCounts ——
  let imageTotal = 0;
  let imagePresent = 0;
  let unassigned = 0;

  for (const a of assets) {
    const variants = assetVariants.get(a.id) ?? [{ key: 'default', label: '主形象', imageUrl: a.imageUrl }];
    const byVariant: AssetVariantAppearance[] = [];
    const allSet = new Set<number>();
    for (const v of variants) {
      const eps = variantBucket.get(`${a.id}:${v.key || 'default'}`);
      const episodes = eps ? Array.from(eps).sort((x, y) => x - y) : [];
      const hasImage = !!v.imageUrl;
      // 只列：有出场 OR 主形象（主形象始终展示，哪怕没出场）
      if (episodes.length > 0 || v.key === 'default') {
        byVariant.push({ key: v.key || 'default', label: v.label || '主形象', episodes, hasImage, imageUrl: v.imageUrl ?? null });
      }
      imageTotal += 1;
      if (hasImage) imagePresent += 1;
      for (const e of episodes) allSet.add(e);
    }
    const allEpisodes = Array.from(allSet).sort((x, y) => x - y);
    appearance[a.id] = { byVariant, allEpisodes };
    if (allEpisodes.length === 0) unassigned += 1;
  }

  return {
    assets,
    episodes: episodes
      .map((e) => ({ id: e.id, episodeNumber: e.episodeNumber, title: e.title }))
      .sort((a, b) => a.episodeNumber - b.episodeNumber),
    appearance,
    statusCounts: {
      total: assets.length,
      imageTotal,
      imagePresent,
      unassigned,
    },
  };
}

/** 导出 ShotRecord 透传（供 route 层类型复用，避免再跨域 import） */
export type { ShotRecord };
