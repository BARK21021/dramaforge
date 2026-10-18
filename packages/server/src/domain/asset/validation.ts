// ============================================================
// ③ server/domain/asset — 资产字段校验（纯函数）
// ============================================================
//
// 文件职责：
//   校验资产（assets 表）的输入字段，CRUD 前置校验。
//   全部为纯函数，无 I/O，可直接单测。
//
// 校验规则对齐 0001-init.sql 的 assets 表约束：
//   - projectId: 非空字符串
//   - kind: CHARACTER | PROP | LOCATION
//   - name: 非空字符串
//   - assetType（可选，CHARACTER 专用）: 主角 | 核心配角 | 配角 | 群演
//   - voiceSource（可选）: library | upload
//   - auditionStatus（可选）: idle | pending | completed | failed
// ============================================================

/** 资产类型白名单 */
export const ASSET_KINDS = ['CHARACTER', 'PROP', 'LOCATION', 'ENTITY'] as const;

/** 角色细分类型白名单（CHARACTER 专用） */
export const CHARACTER_TYPES = ['主角', '核心配角', '配角', '群演'] as const;

/** 音色来源白名单 */
export const VOICE_SOURCES = ['library', 'upload'] as const;

/** 试音状态白名单 */
export const AUDITION_STATUSES = ['idle', 'pending', 'completed', 'failed'] as const;

/** 校验结果 */
export interface AssetValidationResult {
  valid: boolean;
  errors: string[];
}

/** 创建资产的输入 */
export interface AssetCreateInput {
  projectId: string;
  kind: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[] | null;
  assetType?: string | null;
  basePrompt?: string | null;
  isConfirmed?: boolean;
}

/** 更新资产的补丁（所有字段可选） */
export interface AssetUpdatePatch {
  name?: string;
  description?: string | null;
  imageUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[] | null;
  assetType?: string | null;
  basePrompt?: string | null;
  isConfirmed?: boolean;
  regenLocked?: boolean;
  voiceId?: string | null;
  voiceSource?: string | null;
  auditionStatus?: string;
  // 批5 MUST 字段（CHARACTER 富字段 A11c 核心）
  background?: string | null;
  voiceTrait?: string | null;
  identityLock?: string[] | null;
  significance?: string | null;
  intExt?: string | null;
  mood?: string | null;
  // 可选富字段（DB 已存在列，下游 P7.3/P7.4 消费）
  baseAmbience?: string | null;
  coverageScenes?: string[] | null;
  // 批4/批5/批6 字段（DB 列已存在 0001-init.sql：costumes JSONB / gridOverlayEnabled / pencilPaintEnabled）
  costumes?: unknown[] | null;
  gridOverlayEnabled?: boolean | null;
  pencilPaintEnabled?: boolean | null;
  // 彩铅/网格派生图（DB 列已存在；季继承等场景需可写，故纳入白名单）
  pencilImageUrl?: string | null;
  gridImageUrl?: string | null;
}

/**
 * 校验创建资产的输入。
 *
 * @returns { valid, errors }
 */
export function validateAssetCreate(input: AssetCreateInput): AssetValidationResult {
  const errors: string[] = [];

  if (!input.projectId || !input.projectId.trim()) {
    errors.push('projectId 不能为空');
  }

  if (!ASSET_KINDS.includes(input.kind as (typeof ASSET_KINDS)[number])) {
    errors.push(`kind 必须为白名单值: ${ASSET_KINDS.join('/')}`);
  }

  if (!input.name || !input.name.trim()) {
    errors.push('name 不能为空');
  }

  if (input.assetType != null && !CHARACTER_TYPES.includes(input.assetType as (typeof CHARACTER_TYPES)[number])) {
    errors.push(`assetType 必须为白名单值: ${CHARACTER_TYPES.join('/')}`);
  }

  if (input.tags != null && !Array.isArray(input.tags)) {
    errors.push('tags 必须为字符串数组');
  } else if (Array.isArray(input.tags) && !input.tags.every((t) => typeof t === 'string')) {
    errors.push('tags 元素必须全部为字符串');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 校验更新资产的补丁。
 *
 * 仅校验补丁中出现的字段（部分更新语义）。
 *
 * @returns { valid, errors }
 */
export function validateAssetUpdate(patch: AssetUpdatePatch): AssetValidationResult {
  const errors: string[] = [];

  if (patch.name !== undefined && (!patch.name || !patch.name.trim())) {
    errors.push('name 不能为空');
  }

  if (patch.assetType !== undefined && patch.assetType !== null && !CHARACTER_TYPES.includes(patch.assetType as (typeof CHARACTER_TYPES)[number])) {
    errors.push(`assetType 必须为白名单值或 null: ${CHARACTER_TYPES.join('/')}`);
  }

  if (patch.voiceSource !== undefined && patch.voiceSource !== null && !VOICE_SOURCES.includes(patch.voiceSource as (typeof VOICE_SOURCES)[number])) {
    errors.push(`voiceSource 必须为白名单值或 null: ${VOICE_SOURCES.join('/')}`);
  }

  if (patch.auditionStatus !== undefined && !AUDITION_STATUSES.includes(patch.auditionStatus as (typeof AUDITION_STATUSES)[number])) {
    errors.push(`auditionStatus 必须为白名单值: ${AUDITION_STATUSES.join('/')}`);
  }

  if (patch.tags !== undefined && patch.tags !== null) {
    if (!Array.isArray(patch.tags)) {
      errors.push('tags 必须为字符串数组或 null');
    } else if (!patch.tags.every((t) => typeof t === 'string')) {
      // I5 — 元素守卫:纵深防御,非字符串元素一律拒(防 [{}, [], 1, null]
      // 之类的脏 patch 在 service/DB 层炸成不友好错误)。
      errors.push('tags 元素必须全部为字符串');
    }
  }

  // I8 — metadata 序列化体积守卫:32KB 上限。防 client 把整个 JSON 文档当
  // metadata 塞进来撑爆 row + 让 PATCH 路由变成长请求 DoS 面。null 透传。
  if (patch.metadata !== undefined && patch.metadata !== null) {
    const serialized = JSON.stringify(patch.metadata);
    if (serialized.length >= 32 * 1024) {
      errors.push('metadata 序列化后超过 32KB 限制');
    }
  }

  // 批5 MUST 字段类型守卫（纵深防御：非 string/null 一律拒，防脏 patch 在
  // service/DB 层炸成不友好错误）。background/voiceTrait/significance/intExt/
  // mood/baseAmbience 是可空字符串；identityLock/coverageScenes 是可空字符串数组。
  const nullableStringFields: Array<[keyof AssetUpdatePatch, string]> = [
    ['background', 'background'],
    ['voiceTrait', 'voiceTrait'],
    ['significance', 'significance'],
    ['intExt', 'intExt'],
    ['mood', 'mood'],
    ['baseAmbience', 'baseAmbience'],
    ['pencilImageUrl', 'pencilImageUrl'],
    ['gridImageUrl', 'gridImageUrl'],
  ];
  for (const [field, label] of nullableStringFields) {
    const v = patch[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      errors.push(`${label} 必须为字符串或 null`);
    }
  }
  const nullableStringArrayFields: Array<[keyof AssetUpdatePatch, string]> = [
    ['identityLock', 'identityLock'],
    ['coverageScenes', 'coverageScenes'],
  ];
  for (const [field, label] of nullableStringArrayFields) {
    const v = patch[field];
    if (v !== undefined && v !== null) {
      if (!Array.isArray(v)) {
        errors.push(`${label} 必须为字符串数组或 null`);
      } else if (!v.every((x) => typeof x === 'string')) {
        errors.push(`${label} 元素必须全部为字符串`);
      }
    }
  }

  // 批4 costumes（JSONB 数组，元素结构前端构造，仅校验是数组）+ 批5/批6 bool 开关
  if (patch.costumes !== undefined && patch.costumes !== null && !Array.isArray(patch.costumes)) {
    errors.push('costumes 必须为数组或 null');
  }
  const nullableBoolFields: Array<[keyof AssetUpdatePatch, string]> = [
    ['gridOverlayEnabled', 'gridOverlayEnabled'],
    ['pencilPaintEnabled', 'pencilPaintEnabled'],
  ];
  for (const [field, label] of nullableBoolFields) {
    const v = patch[field];
    if (v !== undefined && v !== null && typeof v !== 'boolean') {
      errors.push(`${label} 必须为 boolean 或 null`);
    }
  }

  return { valid: errors.length === 0, errors };
}
