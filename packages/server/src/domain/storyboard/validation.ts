// ============================================================
// ③ server/domain/storyboard — 分镜字段校验（纯函数）
// ============================================================
//
// 文件职责：
//   校验分镜（shots 表）的输入字段，CRUD 前置校验。
//   全部为纯函数，无 I/O，可直接单测。
//
// 校验规则对齐 0001-init.sql 的 shots 表约束：
//   - projectId: 非空字符串
//   - shotIndex: 非负整数
//   - durationSeconds（可选）: 正数
//   - aspectRatio（可选）: 白名单内
//   - status（可选）: PENDING | CONFIRMED
//   - videoStatus（可选）: PENDING | GENERATING | COMPLETED | FAILED
// ============================================================

import { SHOT_ASPECT_RATIOS, SHOT_RESOLUTIONS } from './seedance-params';

/** 分镜状态白名单 */
export const SHOT_STATUSES = ['PENDING', 'CONFIRMED'] as const;

/** 视频生成状态白名单 */
export const SHOT_VIDEO_STATUSES = ['PENDING', 'GENERATING', 'COMPLETED', 'FAILED'] as const;

/** 校验结果 */
export interface ShotValidationResult {
  valid: boolean;
  errors: string[];
}

/** 创建分镜的输入 */
export interface ShotCreateInput {
  projectId: string;
  episodeId?: string | null;
  shotIndex: number;
  shotSeq?: string | null;
  durationSeconds?: number | null;
  visualPrompt?: string | null;
  stylePrompt?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  purposeTag?: string | null;
  emotionArcPosition?: string | null;
  audioType?: string | null;
  referencedAssets?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  sortOrder?: number;
}

/** 更新分镜的补丁（所有字段可选） */
export interface ShotUpdatePatch {
  shotIndex?: number;
  shotSeq?: string | null;
  durationSeconds?: number | null;
  visualPrompt?: string | null;
  stylePrompt?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  purposeTag?: string | null;
  emotionArcPosition?: string | null;
  audioType?: string | null;
  referencedAssets?: Record<string, unknown> | null;
  /** 当前选中素材；传 null 用于重制前解除旧素材绑定。 */
  currentMaterialId?: string | null;
  /** 当前素材地址；传 null 用于把镜头恢复到待生成状态。 */
  currentMaterialUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: string;
  videoStatus?: string;
  sortOrder?: number;
}

/**
 * 校验创建分镜的输入。
 *
 * @returns { valid, errors }
 */
export function validateShotCreate(input: ShotCreateInput): ShotValidationResult {
  const errors: string[] = [];

  if (!input.projectId || !input.projectId.trim()) {
    errors.push('projectId 不能为空');
  }

  if (!Number.isInteger(input.shotIndex) || input.shotIndex < 0) {
    errors.push('shotIndex 必须为非负整数');
  }

  if (input.durationSeconds != null && (typeof input.durationSeconds !== 'number' || input.durationSeconds <= 0 || !Number.isFinite(input.durationSeconds))) {
    errors.push('durationSeconds 必须为正数');
  }

  if (input.aspectRatio != null && !SHOT_ASPECT_RATIOS.includes(input.aspectRatio)) {
    errors.push(`aspectRatio 必须为白名单值: ${SHOT_ASPECT_RATIOS.join('/')}`);
  }

  if (input.resolution != null && !SHOT_RESOLUTIONS.includes(input.resolution)) {
    errors.push(`resolution 必须为白名单值: ${SHOT_RESOLUTIONS.join('/')}`);
  }

  if (input.sortOrder != null && (!Number.isInteger(input.sortOrder) || input.sortOrder < 0)) {
    errors.push('sortOrder 必须为非负整数');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 校验更新分镜的补丁。
 *
 * 仅校验补丁中出现的字段（部分更新语义）。
 *
 * @returns { valid, errors }
 */
export function validateShotUpdate(patch: ShotUpdatePatch): ShotValidationResult {
  const errors: string[] = [];

  if (patch.shotIndex !== undefined && (!Number.isInteger(patch.shotIndex) || patch.shotIndex < 0)) {
    errors.push('shotIndex 必须为非负整数');
  }

  if (
    patch.durationSeconds !== undefined &&
    patch.durationSeconds !== null &&
    (typeof patch.durationSeconds !== 'number' || patch.durationSeconds <= 0 || !Number.isFinite(patch.durationSeconds))
  ) {
    errors.push('durationSeconds 必须为正数或 null');
  }

  if (patch.aspectRatio !== undefined && patch.aspectRatio !== null && !SHOT_ASPECT_RATIOS.includes(patch.aspectRatio)) {
    errors.push(`aspectRatio 必须为白名单值或 null: ${SHOT_ASPECT_RATIOS.join('/')}`);
  }

  if (patch.resolution !== undefined && patch.resolution !== null && !SHOT_RESOLUTIONS.includes(patch.resolution)) {
    errors.push(`resolution 必须为白名单值或 null: ${SHOT_RESOLUTIONS.join('/')}`);
  }

  if (patch.status !== undefined && !SHOT_STATUSES.includes(patch.status as (typeof SHOT_STATUSES)[number])) {
    errors.push(`status 必须为白名单值: ${SHOT_STATUSES.join('/')}`);
  }

  if (patch.videoStatus !== undefined && !SHOT_VIDEO_STATUSES.includes(patch.videoStatus as (typeof SHOT_VIDEO_STATUSES)[number])) {
    errors.push(`videoStatus 必须为白名单值: ${SHOT_VIDEO_STATUSES.join('/')}`);
  }

  if (patch.sortOrder !== undefined && (!Number.isInteger(patch.sortOrder) || patch.sortOrder < 0)) {
    errors.push('sortOrder 必须为非负整数');
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================
// referencedAssets 结构校验（单镜头资产重绑用）
// ============================================================
//
// 仅做形状 / 子集 / 上限校验（纯函数，无 I/O）。名字是否解析到真实资产需读 assets
// 表，由路由层（PATCH shots/[shotId]）用 normalizeAssetName 建 kind:normalized 索引
// 后单独校验。归一化口径必须与分镜绑定 resolver（shot-asset-reference.ts 的
// normalizeName）和 asset-reuse.normalizeAssetName 完全一致，否则会出现"校验通过但
// resolver 解析不到"的空洞。

/** referencedAssets 各数组长度上限（characters 对齐 chain-generate 角色图槽位上限）。 */
export const REFERENCED_ASSETS_LIMITS = {
  characters: 4,
  speakingCharacters: 4,
  environments: 8,
  items: 8,
} as const;

/**
 * 角色→造型手动覆盖条目（批7）。
 *
 * 口径对齐 shot-asset-reference.ts 的 CharacterCostumeRef 与 route.ts 的同名类型，
 * 按「不跨域导入」约定就地同构（修改时三处同步）。
 */
export interface CharacterCostumeRef {
  name: string;
  costumeKey: string;
}

/**
 * 归一化资产名用于比较（对齐 asset-reuse.normalizeAssetName 与 resolver.normalizeName：
 * 转小写 + 去空格/连字符/标点/中英括号）。就地定义避免 storyboard→asset 跨域依赖。
 */
function normalizeForCompare(name: string): string {
  return name.toLowerCase().replace(/[\s\-_·.,'"()（）]/g, '');
}

/**
 * 校验 referencedAssets 的结构。
 *
 * @returns { valid, errors }；refs 为 null/undefined 时视为合法（不更新该字段）。
 */
export function validateReferencedAssetsShape(
  refs: Record<string, unknown> | null | undefined,
): ShotValidationResult {
  const errors: string[] = [];
  if (refs == null || typeof refs !== 'object' || Array.isArray(refs)) {
    return { valid: refs == null, errors: refs == null ? [] : ['referencedAssets 必须是对象'] };
  }

  const FIELD_DEFS = [
    { key: 'characters', limit: REFERENCED_ASSETS_LIMITS.characters },
    { key: 'speakingCharacters', limit: REFERENCED_ASSETS_LIMITS.speakingCharacters },
    { key: 'environments', limit: REFERENCED_ASSETS_LIMITS.environments },
    { key: 'items', limit: REFERENCED_ASSETS_LIMITS.items },
  ] as const;

  const cleaned: Partial<Record<(typeof FIELD_DEFS)[number]['key'], string[]>> & {
    characterCostumes?: CharacterCostumeRef[];
  } = {};
  for (const { key, limit } of FIELD_DEFS) {
    const raw = refs[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      errors.push(`referencedAssets.${key} 必须是字符串数组`);
      continue;
    }
    const names: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string' || !item.trim()) {
        errors.push(`referencedAssets.${key} 内含非字符串或空值`);
        break;
      }
      names.push(item.trim());
    }
    if (names.length > limit) {
      errors.push(`referencedAssets.${key} 数量超限（最多 ${limit} 个）`);
    }
    cleaned[key] = names;
  }

  // characterCostumes（批7）：形状 + name 唯一 + name⊆characters。
  // default costumeKey 在此视为合法形状（route 层做 sanitize 剔除）；存在性（costumeKey
  // 真实属于该资产 costumes[]）需读 assets 表，由 route 层校验。
  if (refs.characterCostumes !== undefined) {
    const rawCc = refs.characterCostumes;
    if (!Array.isArray(rawCc)) {
      errors.push('referencedAssets.characterCostumes 必须是数组');
    } else {
      const refsCc: CharacterCostumeRef[] = [];
      const seenNames = new Set<string>();
      for (const item of rawCc) {
        if (
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          typeof (item as { name?: unknown }).name !== 'string' ||
          !(item as { name: string }).name.trim() ||
          typeof (item as { costumeKey?: unknown }).costumeKey !== 'string' ||
          !(item as { costumeKey: string }).costumeKey.trim()
        ) {
          errors.push('referencedAssets.characterCostumes 内含非法条目（需 { name, costumeKey } 非空字符串）');
          break;
        }
        const cc: CharacterCostumeRef = {
          name: (item as { name: string }).name.trim(),
          costumeKey: (item as { costumeKey: string }).costumeKey.trim(),
        };
        const norm = normalizeForCompare(cc.name);
        if (seenNames.has(norm)) {
          errors.push(`referencedAssets.characterCostumes name 重复：${cc.name}`);
          break;
        }
        seenNames.add(norm);
        refsCc.push(cc);
      }
      cleaned.characterCostumes = refsCc;
    }
  }

  // speakingCharacters 必须 ⊆ characters（按归一化名比较，与 resolver 去重口径一致）。
  if (cleaned.speakingCharacters) {
    if (!cleaned.characters) {
      errors.push('referencedAssets.speakingCharacters 要求同时提供 characters');
    } else {
      const charSet = new Set(cleaned.characters.map(normalizeForCompare));
      for (const sp of cleaned.speakingCharacters) {
        if (!charSet.has(normalizeForCompare(sp))) {
          errors.push(`referencedAssets.speakingCharacters 引用了未在 characters 中的角色：${sp}`);
          break;
        }
      }
    }
  }

  // characterCostumes.name 必须 ⊆ characters（与 speakingCharacters 同款：要求同补丁内
  // 提供 characters，否则无法校验子集关系）。
  if (cleaned.characterCostumes) {
    if (!cleaned.characters) {
      errors.push('referencedAssets.characterCostumes 要求同时提供 characters');
    } else {
      const charSet = new Set(cleaned.characters.map(normalizeForCompare));
      for (const cc of cleaned.characterCostumes) {
        if (!charSet.has(normalizeForCompare(cc.name))) {
          errors.push(`referencedAssets.characterCostumes 引用了未在 characters 中的角色：${cc.name}`);
          break;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
