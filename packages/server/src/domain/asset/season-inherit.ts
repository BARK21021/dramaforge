// ============================================================
// ③ server/domain/asset/season-inherit — 季继承（资产外观对比继承）
// ============================================================
//
// 文件职责：
//   纯只读地为「目标季项目」算出一份资产外观继承计划。对比目标季与源季的资产，
//   对重复的角色/物体/环境/实体，给出从源季继承「完整外观」（参考图 + identityLock
//   + 服装变体图 + 派生图）的计划。绝不 INSERT/UPDATE —— 只返回计划，写入与图片
//   物理复制由调用方（route + 客户端 IPC）分两步完成（H1：服务器零媒体）。
//
// 设计要点（对齐 plan moonlit-hatching-wreath.md 功能1）：
//   1. 跨项目匹配必须跳过 characterId（它 project-scoped），只走姓名别名 / 归一名。
//      复用 replaceExtractedAssets(service.ts:386) 的 putPreferred / alias 索引模式。
//   2. 只继承「源季已落地本地图」(sf-asset://)，排除 http/ark 临时 URL。
//   3. 变体(costume)按 key 匹配，且只对目标季已有变体继承图 —— 不把源季独有变体
//      新增到目标季（"只继承不新增"，含变体）。
//   4. identityLock 并集（源季特征并入目标季）。
//
// ownership 校验在 route 层（两项目须属同一 user），本 service 单一职责只做匹配。
// ============================================================

import { listAssets, type AssetRecord } from './service';
import { getAssetLookupKey, getAssetNameAliases, mergeStringArray } from './asset-reuse';

const SF_ASSET_RE = /^sf-asset:\/\//;
function isLocalAssetUrl(v: unknown): v is string {
  return typeof v === 'string' && SF_ASSET_RE.test(v);
}

/**
 * 整剧项目的 sourceMode（一次性整剧输入/衍生）。季继承仅限整剧项目之间。
 * 排除逐集输入 EPISODE_INPUT 与参考视频转绘 REFERENCE_VIDEO（非季继承场景）。
 */
const WHOLE_SCRIPT_SOURCE_MODES = new Set<string>(['VIDEO_REWRITE', 'LOCAL_SCRIPT', 'ORIGINAL_PROJECT']);

/** 从 project.scriptData（unknown）安全读出 sourceMode。 */
function readSourceMode(scriptData: unknown): string | undefined {
  if (scriptData && typeof scriptData === 'object' && !Array.isArray(scriptData)) {
    const m = (scriptData as Record<string, unknown>).sourceMode;
    return typeof m === 'string' ? m : undefined;
  }
  return undefined;
}

/**
 * 是否整剧项目（季继承前置校验）。sourceMode 须为 VIDEO_REWRITE/LOCAL_SCRIPT/
 * ORIGINAL_PROJECT 之一。sourceMode 持久化在 project.scriptData.sourceMode
 * （见 domain/project/service.ts:203）。
 */
export function isWholeScriptProject(project: { scriptData: unknown }): boolean {
  const mode = readSourceMode(project.scriptData);
  return !!mode && WHOLE_SCRIPT_SOURCE_MODES.has(mode);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export interface InheritItem {
  targetAssetId: string;
  targetKind: string;
  targetName: string;
  sourceName: string;
  /** 源季 sf-asset:// key（未落地为 null）；客户端复制后重写为新 key 再 PATCH。 */
  imageUrl: string | null;
  pencilImageUrl: string | null;
  gridImageUrl: string | null;
  identityLock: string[];
  /** 变体外观：仅对目标季已有变体（同 key）继承源季图，源季独有变体不新增。 */
  costumes: Record<string, unknown>[];
}

export interface InheritSkipped {
  targetName: string;
  targetKind: string;
  reason: 'no-match' | 'source-no-image';
}

export interface InheritPlan {
  sourceProjectId: string;
  targetProjectId: string;
  items: InheritItem[];
  skipped: InheritSkipped[];
}

/** 源季"有任意可继承本地图"才值得继承该资产。 */
function sourceHasAnyImage(a: AssetRecord): boolean {
  return (
    isLocalAssetUrl(a.imageUrl) ||
    isLocalAssetUrl(a.pencilImageUrl) ||
    isLocalAssetUrl(a.gridImageUrl) ||
    (Array.isArray(a.costumes) && a.costumes.some((c) => isLocalAssetUrl((c as Record<string, unknown>).imageUrl)))
  );
}

/** 读 metadata.sourceNames（PROP/LOCATION 别名来源）。 */
function readSourceNames(asset: AssetRecord): string[] {
  const v = asset.metadata?.sourceNames;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

/**
 * 收集一个资产的跨项目匹配键（全部跳过 characterId）。
 * - CHARACTER：姓名别名（getAssetNameAliases）
 * - PROP/LOCATION：name + metadata.sourceNames
 * - ENTITY：name
 */
function collectAliasKeys(asset: AssetRecord): string[] {
  const keys = new Set<string>();
  if (asset.kind === 'CHARACTER') {
    for (const alias of getAssetNameAliases(asset.name)) {
      keys.add(getAssetLookupKey('CHARACTER', alias));
    }
  } else if (asset.kind === 'PROP' || asset.kind === 'LOCATION') {
    for (const n of [asset.name, ...readSourceNames(asset)]) {
      keys.add(getAssetLookupKey(asset.kind, n));
    }
  } else if (asset.kind === 'ENTITY') {
    keys.add(getAssetLookupKey('ENTITY', asset.name));
  }
  return [...keys];
}

/** protectionScore：有图/确认/锁定的资产优先作为源（对齐 service.ts:402）。 */
function protectionScore(a: AssetRecord): number {
  return (a.isConfirmed ? 4 : 0) + (a.regenLocked ? 2 : 0) + (a.imageUrl ? 1 : 0);
}

/** 以源季资产建 key→asset 索引，同 key 取 protectionScore 高者。 */
function buildSourceIndex(sourceAssets: AssetRecord[]): Map<string, AssetRecord> {
  const idx = new Map<string, AssetRecord>();
  for (const a of sourceAssets) {
    for (const key of collectAliasKeys(a)) {
      const cur = idx.get(key);
      if (!cur || protectionScore(a) > protectionScore(cur)) idx.set(key, a);
    }
  }
  return idx;
}

/**
 * 变体外观继承：以目标季 costumes 为骨架，对与源季同 key 的变体继承源季图 + identityLock；
 * 源季独有的变体不新增到目标季。目标季独有变体原样保留。
 */
function inheritCostumes(
  targetCostumes: Record<string, unknown>[] | null,
  sourceCostumes: Record<string, unknown>[] | null,
): Record<string, unknown>[] {
  const sourceByKey = new Map<string, Record<string, unknown>>();
  for (const sc of sourceCostumes ?? []) {
    if (!sc || typeof sc !== 'object') continue;
    const k = typeof sc.key === 'string' ? sc.key.trim() : '';
    if (k && !sourceByKey.has(k)) sourceByKey.set(k, sc);
  }
  return (targetCostumes ?? []).map((tc) => {
    if (!tc || typeof tc !== 'object') return tc;
    const k = typeof tc.key === 'string' ? tc.key.trim() : '';
    const sc = k ? sourceByKey.get(k) : undefined;
    if (!sc) return tc; // 目标季独有变体：保留不动
    const scImg = sc.imageUrl;
    return {
      ...tc,
      // 源季有本地图则继承；否则保留目标季原值
      imageUrl: isLocalAssetUrl(scImg) ? scImg : ((tc.imageUrl as string | null) ?? null),
      identityLock: mergeStringArray(asStringArray(tc.identityLock), asStringArray(sc.identityLock)),
    };
  });
}

/**
 * 计算季继承计划（纯只读，绝不写库）。
 *
 * @param targetProjectId 第二季（继承接收方，须已自行提取完资产）
 * @param sourceProjectId 第一季（外观来源）
 * @returns 继承计划；调用方据此在客户端复制图后 PATCH 目标资产。
 */
export async function planSeasonInheritance(
  targetProjectId: string,
  sourceProjectId: string,
): Promise<InheritPlan> {
  const [targetAssets, sourceAssets] = await Promise.all([
    listAssets(targetProjectId),
    listAssets(sourceProjectId),
  ]);

  const sourceIndex = buildSourceIndex(sourceAssets);
  const items: InheritItem[] = [];
  const skipped: InheritSkipped[] = [];

  for (const target of targetAssets) {
    let source: AssetRecord | undefined;
    for (const key of collectAliasKeys(target)) {
      const hit = sourceIndex.get(key);
      if (hit) {
        source = hit;
        break;
      }
    }
    if (!source) {
      skipped.push({ targetName: target.name, targetKind: target.kind, reason: 'no-match' });
      continue;
    }
    if (!sourceHasAnyImage(source)) {
      skipped.push({ targetName: target.name, targetKind: target.kind, reason: 'source-no-image' });
      continue;
    }
    items.push({
      targetAssetId: target.id,
      targetKind: target.kind,
      targetName: target.name,
      sourceName: source.name,
      imageUrl: isLocalAssetUrl(source.imageUrl) ? source.imageUrl : null,
      pencilImageUrl: isLocalAssetUrl(source.pencilImageUrl) ? source.pencilImageUrl : null,
      gridImageUrl: isLocalAssetUrl(source.gridImageUrl) ? source.gridImageUrl : null,
      identityLock: mergeStringArray(asStringArray(target.identityLock), asStringArray(source.identityLock)),
      costumes: inheritCostumes(target.costumes, source.costumes),
    });
  }

  return { sourceProjectId, targetProjectId, items, skipped };
}
