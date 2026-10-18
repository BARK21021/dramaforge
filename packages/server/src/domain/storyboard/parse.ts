// ============================================================
// ③ server/domain/storyboard/parse — 分镜结果解析
// ============================================================
//
// 解析 LLM 返回的分镜 JSON（{ shots: [...] }）→ 结构化 ParsedStoryboardShot[]。
// 用 safeParseJsonObject（jsonrepair 兜底）容错 LLM 常见的 JSON 损坏（多余逗号/
// 尾逗号/字段缺引号）。过滤掉无 visualPrompt 的无效条目。
//
// 本文件只负责供应商 JSON 容错与字段归一；时间码拆分、对白覆盖、资产模糊
// 匹配和自动编组集中在 postprocess.ts，避免多个路由各自实现不同处理顺序。
//
// 纯函数，零 ffmpeg。
// ============================================================

import { safeParseJsonObject } from '../prompt/json-repair';

export interface ParsedStoryboardShot {
  sceneId: string;
  shotIndex: number;
  visualPrompt: string;
  durationSeconds: number;
  purposeTag?: string;
  dialogue?: string;
  characters: string[];
  speakingCharacters: string[];
  environments: string[];
  items: string[];
  shotSize?: string;
  cameraAngle?: string;
  cameraMovement?: string;
  action?: string;
  soundCue?: string;
  emotionPurpose?: string;
  audioType?: string;
  emotionArcPosition?: string;
  groupIndex?: number;
  groupLabel?: string;
  // 结构化提示词（2026-07-28 对齐参考产品分镜制作）。存 shot.metadata.structuredPrompt。
  // 片段数/片段说明不在 AI 产出——由 UI 按 group 镜头派生（spec D4）。
  /** 场景：内/外景 @场景资产名 + 氛围基调 */
  sceneContext?: string;
  /** 场景设计：色调/光影/空间质感的视觉设计 */
  sceneDesign?: string;
  /** 画面信息：本镜画面规则与约束 */
  visualInfo?: string;
  /**
   * 本镜道具变体指定（对齐 referencedAssets.characterCostumes 的 {name,costumeKey}）。
   * 分镜 AI 按镜头剧情为每个多变体道具指定状态 key；postprocess 归一 name 到展示名。
   */
  itemCostumes?: AssetCostumeRef[];
  /** 本镜环境变体指定（时段/状态变体）。 */
  environmentCostumes?: AssetCostumeRef[];
  /** 本镜角色变体指定（成年/幼年等时期或状态变体，对齐 characterCostumes）。 */
  characterCostumes?: AssetCostumeRef[];
}

/** 资产→变体引用条目（道具/环境共用，对齐 referencedAssets.characterCostumes）。 */
export interface AssetCostumeRef {
  name: string;
  costumeKey: string;
}

/** 把数值夹在 [min, max] 之间。 */
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * 解析 {name, costumeKey} 变体引用数组（道具/环境共用）。容错 LLM 常见偏差：
 * 非数组/空、缺字段、字段非字符串。返回 [] 表示本镜无变体指定（回退默认图）。
 */
function parseAssetCostumeRefs(raw: unknown): AssetCostumeRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: AssetCostumeRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = (entry as { name?: unknown }).name;
    const costumeKey = (entry as { costumeKey?: unknown }).costumeKey;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (typeof costumeKey !== 'string' || !costumeKey.trim()) continue;
    refs.push({ name: name.trim(), costumeKey: costumeKey.trim() });
  }
  return refs;
}

/**
 * 解析分镜 JSON 文本为镜头数组。
 *
 * @param raw - LLM 返回的文本（应为 { shots: [...] } JSON）
 * @returns 解析出的镜头（过滤无效条目）；解析失败返回空数组
 */
export function parseStoryboardShots(raw: string): ParsedStoryboardShot[] {
  const data = safeParseJsonObject(raw) as { shots?: unknown };
  const arr = Array.isArray(data?.shots) ? (data.shots as unknown[]) : [];

  const shots: ParsedStoryboardShot[] = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const visualPrompt = [o.visualPrompt, o.videoPrompt, o.visualContent, o.action]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim())
      .join('\n');
    if (!visualPrompt) continue;

    const characters = Array.isArray(o.characters)
      ? (o.characters as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
      : [];

    const stringList = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
      : [];
    const duration = typeof o.durationSeconds === 'number'
      ? o.durationSeconds
      : typeof o.duration === 'number'
        ? o.duration
        : 5;

    shots.push({
      sceneId: typeof o.sceneId === 'string' ? o.sceneId.trim() : '',
      shotIndex: typeof o.shotIndex === 'number' && o.shotIndex > 0 ? Math.floor(o.shotIndex) : shots.length + 1,
      visualPrompt,
      durationSeconds: clamp(duration, 2, 15),
      purposeTag: typeof o.purposeTag === 'string' && o.purposeTag.trim() ? o.purposeTag.trim() : undefined,
      dialogue: typeof o.dialogue === 'string' && o.dialogue.trim() ? o.dialogue.trim() : undefined,
      characters,
      speakingCharacters: stringList(o.speakingCharacters),
      environments: stringList(o.environments),
      items: stringList(o.items),
      shotSize: typeof o.shotSize === 'string' ? o.shotSize.trim() : undefined,
      cameraAngle: typeof o.cameraAngle === 'string' ? o.cameraAngle.trim() : undefined,
      cameraMovement: typeof o.cameraMovement === 'string' ? o.cameraMovement.trim() : undefined,
      action: typeof o.action === 'string' ? o.action.trim() : undefined,
      soundCue: typeof o.soundCue === 'string' ? o.soundCue.trim() : undefined,
      emotionPurpose: typeof o.emotionPurpose === 'string' ? o.emotionPurpose.trim() : undefined,
      audioType: typeof o.audioType === 'string' ? o.audioType.trim() : undefined,
      // 结构化提示词（兼容 scene / sceneContext 两种 key）
      sceneContext: typeof o.sceneContext === 'string' && o.sceneContext.trim()
        ? o.sceneContext.trim()
        : typeof o.scene === 'string' && o.scene.trim() ? o.scene.trim() : undefined,
      sceneDesign: typeof o.sceneDesign === 'string' && o.sceneDesign.trim() ? o.sceneDesign.trim() : undefined,
      visualInfo: typeof o.visualInfo === 'string' && o.visualInfo.trim() ? o.visualInfo.trim() : undefined,
      itemCostumes: parseAssetCostumeRefs(o.itemCostumes),
      environmentCostumes: parseAssetCostumeRefs(o.environmentCostumes),
      characterCostumes: parseAssetCostumeRefs(o.characterCostumes),
    });
  }
  return shots;
}
