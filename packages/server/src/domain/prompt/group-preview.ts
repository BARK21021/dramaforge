// ============================================================
// ③ server/domain/prompt — 成组镜头提示词预览纯函数
// ============================================================
//
// 文件职责：
//   把同一分集、同一生成组的镜头按时间顺序拼成可编辑的 Seedance 文本提示词。
//   本文件只处理内存中的结构化文本，不访问数据库、不调用 AI，也不接触媒体字节
//   或 ffmpeg；项目、分集和镜头的归属校验由 Web 路由完成。
//
// 迁移来源：F:\app1\src\core\ai\group-prompt.ts 的 combineGroupPrompts。
// C/S 版本保留预览所需的核心语义：有效时长档位、连续时间码、镜头画面/声音、
// 角色与道具引用，以及生成验收约束；媒体参考图编号留给实际生成链路处理。
// ============================================================

import {
  appendSeedanceMotionCalibration,
  externalizeEmotion,
  fmtTime,
  MAX_REFERENCE_AUDIOS,
  MAX_REFERENCE_CHARACTERS,
  MAX_REFERENCE_IMAGES,
  snapToValidDuration,
  durationLadderFor,
  VALID_DURATIONS,
} from './seedance-helpers';
import { sanitizePromptForModeration } from './asset-helpers';
import { buildVideoLanguageContract } from './video-language';
import type { LocalizationProfile } from './target-languages';
import { normalizeNameForPrompt } from './language';
import { resolveCostumeCode } from './asset-prompt';
import { getProjectArtStylePreset } from '@shared/project';
import type { CostumeVariant } from './types';

/** 纯函数需要的最小镜头结构；ShotRecord 可直接按结构类型传入。 */
export interface GroupPreviewShot {
  id: string;
  sortOrder: number;
  shotIndex: number;
  shotSeq?: string | null;
  durationSeconds?: number | null;
  visualPrompt?: string | null;
  purposeTag?: string | null;
  audioType?: string | null;
  sceneId?: string | null;
  aspectRatio?: string | null;
  referencedAssets?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/** 预览接口返回的稳定文本与时长字段。 */
export interface GroupPreviewPromptResult {
  combinedPrompt: string;
  /** 镜头原始时长之和，不包含模型档位补齐。 */
  totalDuration: number;
  /** 向上对齐后的 Seedance 有效生成时长。 */
  validDuration: number;
}

export interface GroupPromptReferenceBinding {
  name: string;
  kind: 'CHARACTER' | 'LOCATION' | 'PROP' | 'BLOCKING';
  /** 选中变体的可读名（如"破损"/"深夜"），用于资产图标注；基准/无变体时为空。 */
  variantLabel?: string | null;
  /**
   * 选中变体的全局稳定编号（如 "Leo-03"，见 CostumeVariant.code）。
   * 对齐/审计用 code 而非名称匹配；无变体时为空。
   */
  variantCode?: string | null;
}

export interface GroupPromptAudioBinding {
  name: string;
}

/** prompt 子域消费的最小资产结构；server AssetRecord 可直接按结构类型传入。 */
export interface GroupPromptAsset {
  id: string;
  kind: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  costumes?: ReadonlyArray<Partial<CostumeVariant> & Record<string, unknown>> | null;
  metadata?: Record<string, unknown> | null;
  assetType?: string | null;
  pencilImageUrl?: string | null;
  pencilPaintEnabled?: boolean | null;
  gridOverlayEnabled?: boolean | null;
  voiceId?: string | null;
  intExt?: string | null;
  mood?: string | null;
}

/** 剧本造型表条目；sceneId 使用基础场景号，分段镜头会自动归一化。 */
export interface GroupPromptCostumeMapEntry {
  sceneId?: string;
  character?: string;
  costumeLabel?: string;
  costumeDesc?: string;
  isNew?: boolean;
}

export interface CollectedReferenceAssets {
  characterImageUrls: string[];
  imageUrls: string[];
  /** Prompt/provider-facing resolved URLs, aligned with audioRefs. */
  audioUrls: string[];
  /**
   * Client-local preset filenames aligned with audioUrls/audioRefs. A null
   * entry means the prompt URL is not backed by the packaged voice manifest.
   */
  clientAudioFiles: Array<string | null>;
  /** 顺序严格等于 characterImageUrls + imageUrls。 */
  assetRefs: GroupPromptReferenceBinding[];
  /** 顺序严格等于 audioUrls。 */
  audioRefs: GroupPromptAudioBinding[];
  /**
   * Script-selected costume bindings that cannot be rendered safely yet.
   * Callers must not silently replace these with the character's default image.
   */
  unresolvedCostumes: GroupPromptUnresolvedCostumeBinding[];
  /** Only assets and costume choices that this group actually resolved. */
  context: GroupPromptReferenceContext;
}

export interface GroupPromptUnresolvedCostumeBinding {
  assetId: string;
  assetName: string;
  character: string;
  sceneId: string;
  costumeLabel: string;
  reason: 'COSTUME_NOT_FOUND' | 'IMAGE_MISSING';
}

export interface GroupPromptSelectedCostumeContext {
  assetId: string;
  sceneId: string;
  character: string;
  costume: Partial<CostumeVariant> & Record<string, unknown>;
}

export interface GroupPromptReferenceContext {
  assets: GroupPromptAsset[];
  costumeEntries: GroupPromptCostumeMapEntry[];
  selectedCostumes: GroupPromptSelectedCostumeContext[];
}

export interface CombineGroupPromptOptions {
  prevLastFrameHint?: boolean;
  allAssets?: readonly GroupPromptAsset[];
  assetRefs?: readonly GroupPromptReferenceBinding[];
  projectArtStyle?: string | null;
  language?: 'zh' | 'en';
  audioRefs?: readonly GroupPromptAudioBinding[];
  /** C/S 生产链显式画幅优先于历史 visualPrompt 内的旧值。 */
  aspectRatio?: string | null;
  /** C/S 海外转绘增强：在末尾追加唯一的视频语言硬约束。 */
  localizationProfile?: LocalizationProfile | null;
  /** 同场景的位置不变量映射（sceneId→"座位布局"），由 analyzing 提取、buildSceneSpatialLayoutMap 构建。 */
  sceneSpatialLayoutMap?: Readonly<Record<string, string>> | null;
  /** 同场景的时段映射（sceneId→"日/夜/黄昏"等 scene.time），由 buildSceneTimeOfDayMap 构建，注入"时段光照"锁定行。 */
  sceneTimeOfDayMap?: Readonly<Record<string, string>> | null;
  /** 单组最大时长（秒）。默认 15（Seedance 2.0）；30 走 Seedance 2.5 扩展档位。 */
  maxDuration?: number;
}

/** 缺失镜头时长时沿用 app1 分组逻辑的 2 秒兜底。 */
const DEFAULT_SHOT_DURATION_SECONDS = 2;

/** 把 unknown 安全收窄为普通对象，避免脏 metadata 破坏整个预览。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 读取去除首尾空白后的非空字符串。 */
function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** 读取字符串数组并去空、去重，保持用户原始顺序。 */
function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = readText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

/** 取得镜头有效时长；非法或非正值统一回退到 2 秒。 */
function getShotDuration(shot: GroupPreviewShot): number {
  const duration = shot.durationSeconds;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : DEFAULT_SHOT_DURATION_SECONDS;
}

/**
 * 将镜头总时长向上对齐到 Seedance 档位。
 *
 * 不能使用“最近档位”，否则 7 秒镜头组可能被压到 6 秒并截断末镜；超过 Mini 上限时
 * 直接抛出 RangeError，由路由转成 400，提示调用方先重新分组。
 */
function ceilToValidDuration(totalDuration: number): number {
  return snapToValidDuration(totalDuration);
}

/**
 * 去除旧提示词中的时间码和结构标题，防止新时间码外再嵌套一套时间线。
 * 只做文本清理，不改变用户的主体、动作、对白或风格描述。
 */
function cleanVisualPrompt(value: string): string {
  return value
    .replace(/\[\d{2}:\d{2}(?:\.\d+)?-\d{2}:\d{2}(?:\.\d+)?\]/g, '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/^【(?:全局基础设定|当前生成组分镜)】.*$/gm, '')
    .trim();
}

/** 向集合追加字符串列表，用于生成组级角色/道具摘要。 */
function addAll(target: Set<string>, values: string[]): void {
  for (const value of values) target.add(value);
}

function normalizeLookupValue(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\-_·.,'"“”()（）]/g, '');
}

function assetLookupNames(asset: GroupPromptAsset): string[] {
  return [asset.name, ...readTextList(asRecord(asset.metadata).sourceNames)];
}

export function extractBaseSceneId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/^(S\d+)/i);
  return match ? match[1].toUpperCase() : value.trim();
}

function buildAssetLookup(
  assets: readonly GroupPromptAsset[],
): (kind: string, name: string) => GroupPromptAsset | undefined {
  return (kind, name) => {
    const normalized = normalizeLookupValue(name);
    const exact = assets.find(
      (asset) => asset.kind === kind && assetLookupNames(asset)
        .some((candidate) => normalizeLookupValue(candidate) === normalized),
    );
    if (exact || !normalized) return exact;
    return assets.find((asset) => {
      if (asset.kind !== kind) return false;
      return assetLookupNames(asset).some((value) => {
        const candidate = normalizeLookupValue(value);
        return candidate.includes(normalized) || normalized.includes(candidate);
      });
    });
  };
}

export function readShotSceneId(shot: GroupPreviewShot): string {
  const metadata = asRecord(shot.metadata);
  const storyboard = asRecord(metadata.storyboardTable);
  return readText(metadata.sceneId)
    ?? readText((shot as GroupPreviewShot & { sceneId?: string | null }).sceneId)
    ?? readText(storyboard.sceneId)
    ?? '';
}

interface CostumeSelection {
  entry: GroupPromptCostumeMapEntry | null;
  costume: (Partial<CostumeVariant> & Record<string, unknown>) | null;
  imageUrl: string | null;
}

function findCostumeEntry(
  shotSceneId: string,
  characterName: string,
  costumeMap: readonly GroupPromptCostumeMapEntry[],
): GroupPromptCostumeMapEntry | null {
  if (!shotSceneId) return null;
  const baseSceneId = extractBaseSceneId(shotSceneId);
  const characterKey = normalizeLookupValue(characterName);
  return costumeMap.find(
    (item) => extractBaseSceneId(item.sceneId) === baseSceneId
      && normalizeLookupValue(item.character ?? '') === characterKey,
  ) ?? null;
}

function selectCostume(
  asset: GroupPromptAsset,
  shotSceneId: string,
  characterName: string,
  costumeMap: readonly GroupPromptCostumeMapEntry[],
): CostumeSelection {
  if (!shotSceneId) return { entry: null, costume: null, imageUrl: null };
  const entry = findCostumeEntry(shotSceneId, characterName, costumeMap);
  if (!entry || !Array.isArray(asset.costumes)) {
    return { entry, costume: null, imageUrl: null };
  }
  const target = normalizeLookupValue(entry?.costumeLabel ?? '');
  if (!target) return { entry, costume: null, imageUrl: null };

  // 对齐 app1 group-prompt.ts findCostumeImageUrl（if (!cv.imageUrl) continue）：
  // 无图的 costume 不参与匹配（default 变体回退顶层 imageUrl）。否则会精确命中某个
  // 无图变体后提前返回，错过后续有图的近似变体，导致镜头角色漂移到默认图。
  // The default costume's canonical image is also stored at the asset top
  // level for backward compatibility with pre-revision projects.
  const resolveCostumeUrl = (
    costume: Partial<CostumeVariant> & Record<string, unknown>,
  ): string | null => {
    const key = normalizeLookupValue(typeof costume.key === 'string' ? costume.key : '');
    return readText(costume.imageUrl) ?? (key === 'default' ? readText(asset.imageUrl) : null);
  };

  let exactWithoutImage: (Partial<CostumeVariant> & Record<string, unknown>) | null = null;
  let partialMatch: (Partial<CostumeVariant> & Record<string, unknown>) | null = null;
  let partialScore = -1;
  for (const costume of asset.costumes) {
    const label = normalizeLookupValue(
      typeof costume.label === 'string' ? costume.label : '',
    );
    const key = normalizeLookupValue(
      typeof costume.key === 'string' ? costume.key : '',
    );
    const imageUrl = resolveCostumeUrl(costume);
    const isExact = label === target || key === target;
    if (isExact && imageUrl) {
      return { entry, costume, imageUrl };
    }
    if (isExact && !exactWithoutImage) {
      exactWithoutImage = costume;
    }
    if (imageUrl) {
      const candidate = label || key;
      if (candidate && (candidate.includes(target) || target.includes(candidate))) {
        const score = Math.min(candidate.length, target.length);
        if (score > partialScore) {
          partialMatch = costume;
          partialScore = score;
        }
      }
    }
  }
  // 有图的包含匹配优先于无图的精确匹配：避免绑定一个无图变体却回退默认图（漂移）。
  if (partialMatch) {
    return { entry, costume: partialMatch, imageUrl: resolveCostumeUrl(partialMatch) };
  }
  if (exactWithoutImage) {
    return { entry, costume: exactWithoutImage, imageUrl: null };
  }
  return { entry, costume: null, imageUrl: null };
}

/** 资产开启彩铅且已有缓存时，缓存图拥有最高优先级。 */
function selectAssetImage(
  asset: GroupPromptAsset,
  alternateUrl: string | null = null,
): string | null {
  const cachedPencil = readText(asset.pencilImageUrl)
    ?? readText(asset.metadata?.pencilPaintingUrl);
  if (asset.pencilPaintEnabled === true && cachedPencil) return cachedPencil;
  return alternateUrl ?? readText(asset.imageUrl);
}

/**
 * 道具/环境变体按镜头选择。优先级：
 *   1) 镜头显式指定的 costumeKey（分镜 AI 据剧情在 itemCostumes/environmentCostumes
 *      给出，如"破损""深夜"）——命中且有图即用，这是整剧提取变体（只有 coverageEpisodes、
 *      无集内场景号）能被分镜正确引用的唯一可靠路径。
 *   2) coverageScenes 命中本镜场景的变体（手动 MVP / 单集提取路径，baseSceneId 归一）。
 *   3) 返回 null → 调用方回退默认图。
 *
 * 返回 { url, label } 让资产图标注能写出变体名（"道具参考 图片N 中的XX（破损变体）"）。
 */
function selectVariantForShot(
  asset: GroupPromptAsset,
  shotSceneId: string,
  shotCostumeKey: string | null,
): { url: string; label: string | null; code: string | null } | null {
  const costumes = Array.isArray(asset.costumes) ? asset.costumes : [];
  if (costumes.length === 0) return null;
  const labelOf = (costume: Partial<CostumeVariant> & Record<string, unknown>): string | null =>
    readText(costume.label) ?? (typeof costume.key === 'string' && costume.key ? costume.key : null);
  const codeOf = (costume: Partial<CostumeVariant> & Record<string, unknown>): string | null =>
    resolveCostumeCode(costume, asset.name, costumes.indexOf(costume) + 1);
  // 1) 镜头显式变体（非 default）。
  if (shotCostumeKey && shotCostumeKey !== 'default') {
    const target = shotCostumeKey.trim().toLocaleLowerCase();
    const match = costumes.find((c) => {
      const key = typeof c.key === 'string' ? c.key.trim().toLocaleLowerCase() : '';
      return key && key === target;
    });
    const url = match ? readText(match.imageUrl) : null;
    if (url) return { url, label: labelOf(match), code: codeOf(match) };
  }
  // 2) coverageScenes 兜底（手动 MVP / 单集提取）。
  const base = extractBaseSceneId(shotSceneId);
  if (base) {
    for (const costume of costumes) {
      const scenes = Array.isArray(costume.coverageScenes) ? costume.coverageScenes : [];
      const hit = scenes.some((scene: unknown) => extractBaseSceneId(String(scene)) === base);
      if (!hit) continue;
      const url = readText(costume.imageUrl);
      if (url) return { url, label: labelOf(costume), code: codeOf(costume) };
    }
  }
  return null;
}

/**
 * 解析角色音色引用。`confirmed_voice` 是用户最终确认值，优先于同名 VOICE
 * 资产和历史 `audioUrl`；C/S 顶层 `voiceId` 作为兼容兜底。
 */
function readClientVoiceFile(value: string | null): string | null {
  if (!value) return null;
  let candidate = value.trim();
  const apiMatch = candidate.match(/^\/api\/reference-audio\/([^/?#]+)$/i);
  if (apiMatch) {
    try {
      candidate = decodeURIComponent(apiMatch[1]);
    } catch {
      return null;
    }
  }
  return /^[^\\/]+\.wav$/i.test(candidate) && !candidate.includes('..')
    ? candidate
    : null;
}

interface ResolvedCharacterVoice {
  promptUrl: string;
  clientFile: string | null;
}

function resolveCharacterVoice(
  characterAsset: GroupPromptAsset | null | undefined,
  voiceAsset: GroupPromptAsset | null | undefined,
): ResolvedCharacterVoice | null {
  const confirmedVoice = asRecord(characterAsset?.metadata?.confirmed_voice);
  const confirmedFile = readText(confirmedVoice.file);
  if (confirmedFile) {
    const promptUrl = /^(?:https?:|data:|\/)/i.test(confirmedFile)
      ? confirmedFile
      : `/api/reference-audio/${encodeURIComponent(confirmedFile)}`;
    return { promptUrl, clientFile: readClientVoiceFile(confirmedFile) ?? readClientVoiceFile(promptUrl) };
  }

  const voiceAssetUrl = readText(voiceAsset?.imageUrl);
  if (voiceAssetUrl) {
    return { promptUrl: voiceAssetUrl, clientFile: readClientVoiceFile(voiceAssetUrl) };
  }

  const metadataAudioUrl = readText(characterAsset?.metadata?.audioUrl);
  if (metadataAudioUrl) {
    return { promptUrl: metadataAudioUrl, clientFile: readClientVoiceFile(metadataAudioUrl) };
  }

  const voiceId = readText(characterAsset?.voiceId);
  if (!voiceId) return null;
  const promptUrl = /^(?:https?:|data:|\/)/i.test(voiceId)
    ? voiceId
    : `/api/reference-audio/${encodeURIComponent(voiceId)}`;
  return { promptUrl, clientFile: readClientVoiceFile(voiceId) ?? readClientVoiceFile(promptUrl) };
}

export function resolveCharacterVoiceUrl(
  characterAsset: GroupPromptAsset | null | undefined,
  voiceAsset: GroupPromptAsset | null | undefined,
): string | null {
  return resolveCharacterVoice(characterAsset, voiceAsset)?.promptUrl ?? null;
}

/**
 * 收集一组镜头实际下发给视频模型的参考图，并生成与 URL 严格同序的 图片N 绑定。
 */
export function collectReferenceAssets(
  sortedShots: readonly GroupPreviewShot[],
  allAssets: readonly GroupPromptAsset[],
  costumeMap: readonly GroupPromptCostumeMapEntry[] = [],
): CollectedReferenceAssets {
  const characterImageUrls: string[] = [];
  const imageUrls: string[] = [];
  const characterRefs: GroupPromptReferenceBinding[] = [];
  const imageRefs: GroupPromptReferenceBinding[] = [];
  const seenCharacterUrls = new Set<string>();
  const seenImageUrls = new Set<string>();
  const speakingCharacters = new Set<string>();
  const findAsset = buildAssetLookup(allAssets);
  const contextAssets: GroupPromptAsset[] = [];
  const contextAssetIds = new Set<string>();
  const costumeEntries: GroupPromptCostumeMapEntry[] = [];
  const seenCostumeEntries = new Set<GroupPromptCostumeMapEntry>();
  const selectedCostumes: GroupPromptSelectedCostumeContext[] = [];
  const seenSelectedCostumes = new Set<string>();
  const unresolvedCostumes: GroupPromptUnresolvedCostumeBinding[] = [];
  const seenUnresolvedCostumes = new Set<string>();
  const registerAsset = (asset: GroupPromptAsset | undefined): void => {
    if (!asset || contextAssetIds.has(asset.id)) return;
    contextAssetIds.add(asset.id);
    contextAssets.push(asset);
  };
  const registerCostumeEntry = (entry: GroupPromptCostumeMapEntry | null): void => {
    if (!entry || seenCostumeEntries.has(entry)) return;
    seenCostumeEntries.add(entry);
    costumeEntries.push(entry);
  };

  // combineGroupPrompts reads the first shot's sceneLocation asset for mood and
  // interior/exterior atmosphere even when it is not an explicit image ref.
  const firstMetadata = asRecord(sortedShots[0]?.metadata);
  const firstStoryboard = asRecord(firstMetadata.storyboardTable);
  const firstSceneLocation = readText(firstMetadata.sceneLocation)
    ?? readText(firstStoryboard.sceneLocation);
  if (firstSceneLocation) registerAsset(findAsset('LOCATION', firstSceneLocation));

  for (const shot of sortedShots) {
    const references = asRecord(shot.referencedAssets);
    const storyboard = asRecord(asRecord(shot.metadata).storyboardTable);
    // 镜头显式指定的变体覆盖（分镜 AI / setCharacterCostume 输出 {name,costumeKey}）。
    // 角色/道具/环境共用：非默认 key 且该变体有图 → 赢过脚本 costumeMap / pencil 缓存 / 基准图。
    const buildCostumeKeyMap = (refs: unknown): Map<string, string> => {
      const map = new Map<string, string>();
      if (!Array.isArray(refs)) return map;
      for (const entry of refs) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const name = (entry as { name?: unknown }).name;
        const costumeKey = (entry as { costumeKey?: unknown }).costumeKey;
        if (typeof name !== 'string' || !name.trim()) continue;
        if (typeof costumeKey !== 'string' || !costumeKey.trim()) continue;
        map.set(normalizeLookupValue(name.trim()), costumeKey.trim());
      }
      return map;
    };
    const characterCostumeKeyMap = buildCostumeKeyMap(references.characterCostumes);
    const characters = readTextList(references.characters).concat(
      readTextList(storyboard.characters),
    );
    const declaredSpeakers = readTextList(references.speakingCharacters).concat(
      readTextList(storyboard.speakingCharacters),
    );
    for (const name of declaredSpeakers) {
      speakingCharacters.add(name);
    }
    const rawPrompt = readText(asRecord(shot.metadata).timecodePrompt)
      ?? readText(shot.visualPrompt)
      ?? '';
    const inferredSound = parseShotSoundDesign({
      soundCue: readText(storyboard.soundCue) ?? '',
      voiceContent: rawPrompt.match(/\[voice[:：]\s*([^\]]+)\]/i)?.[1]
        ?? readText(asRecord(shot.metadata).voiceContent)
        ?? '',
      visualText: `${readText(storyboard.visualContent) ?? ''}\n${readText(storyboard.action) ?? ''}\n${rawPrompt}`,
      audioType: shot.audioType,
      declaredSpeakers,
      characterNames: characters,
    });
    for (const name of inferredSound.speakingCharacters) speakingCharacters.add(name);
    let environments = readTextList(references.environments).concat(
      readTextList(storyboard.environments),
    );
    const items = readTextList(references.items).concat(readTextList(storyboard.items));
    if (environments.length === 0) {
      const sceneLocation = readText(asRecord(shot.metadata).sceneLocation)
        ?? readText(storyboard.sceneLocation);
      if (sceneLocation) environments = [sceneLocation];
    }

    for (const name of characters) {
      const shotSceneId = readShotSceneId(shot);
      const costumeEntry = findCostumeEntry(shotSceneId, name, costumeMap);
      registerCostumeEntry(costumeEntry);
      const asset = findAsset('CHARACTER', name);
      if (!asset) continue;
      registerAsset(asset);
      const costumeSelection = selectCostume(
        asset,
        shotSceneId,
        name,
        costumeMap,
      );
      registerCostumeEntry(costumeSelection.entry);
      const explicitCostumeLabel = readText(costumeSelection.entry?.costumeLabel);
      if (explicitCostumeLabel && (!costumeSelection.costume || !costumeSelection.imageUrl)) {
        const unresolvedKey = [
          asset.id,
          extractBaseSceneId(shotSceneId),
          normalizeLookupValue(name),
          normalizeLookupValue(explicitCostumeLabel),
        ].join(':');
        if (!seenUnresolvedCostumes.has(unresolvedKey)) {
          seenUnresolvedCostumes.add(unresolvedKey);
          unresolvedCostumes.push({
            assetId: asset.id,
            assetName: asset.name,
            character: name,
            sceneId: extractBaseSceneId(shotSceneId),
            costumeLabel: explicitCostumeLabel,
            reason: costumeSelection.costume ? 'IMAGE_MISSING' : 'COSTUME_NOT_FOUND',
          });
        }
      }
      if (costumeSelection.costume) {
        const selectionKey = [
          asset.id,
          extractBaseSceneId(shotSceneId),
          normalizeLookupValue(name),
          normalizeLookupValue(String(costumeSelection.costume.key ?? costumeSelection.costume.label ?? '')),
        ].join(':');
        if (!seenSelectedCostumes.has(selectionKey)) {
          seenSelectedCostumes.add(selectionKey);
          selectedCostumes.push({
            assetId: asset.id,
            sceneId: extractBaseSceneId(shotSceneId),
            character: name,
            costume: costumeSelection.costume,
          });
        }
      }
      // An explicit script costume is authoritative and wins over the default
      // pencil cache when its variant image exists. When the variant image is
      // missing, fall back to the asset's default image — aligned with app1
      // group-prompt.ts (`costumeImageUrl || asset.imageUrl`) so an ungenerated
      // costume variant never blocks generation.
      // 分镜显式角色变体覆盖（characterCostumes）优先于脚本 costumeMap：命中非默认 key
      // 且该变体有图 → 用变体图；否则回退 costumeMap / 基准图。对齐道具/环境的
      // selectVariantForShot，让分镜里换的角色变体真正进 Seedance 参考图（而非只改前端）。
      const shotCostumeKey = characterCostumeKeyMap.get(normalizeLookupValue(name)) ?? null;
      const overrideVariant = shotCostumeKey && shotCostumeKey !== 'default'
        ? selectVariantForShot(asset, shotSceneId, shotCostumeKey)
        : null;
      if (shotCostumeKey && shotCostumeKey !== 'default' && !overrideVariant) {
        const overrideCostume = Array.isArray(asset.costumes)
          ? asset.costumes.find((c) => {
            const k = typeof c.key === 'string' ? c.key.trim().toLocaleLowerCase() : '';
            return k && k === shotCostumeKey.trim().toLocaleLowerCase();
          })
          : undefined;
        const unresolvedKey = [
          asset.id,
          extractBaseSceneId(shotSceneId),
          normalizeLookupValue(name),
          normalizeLookupValue(shotCostumeKey),
        ].join(':');
        if (!seenUnresolvedCostumes.has(unresolvedKey)) {
          seenUnresolvedCostumes.add(unresolvedKey);
          unresolvedCostumes.push({
            assetId: asset.id,
            assetName: asset.name,
            character: name,
            sceneId: extractBaseSceneId(shotSceneId),
            costumeLabel: shotCostumeKey,
            reason: overrideCostume ? 'IMAGE_MISSING' : 'COSTUME_NOT_FOUND',
          });
        }
      }
      const url = overrideVariant?.url
        ?? (explicitCostumeLabel
          ? (costumeSelection.imageUrl ?? selectAssetImage(asset))
          : selectAssetImage(asset));
      if (!url || seenCharacterUrls.has(url)) continue;
      seenCharacterUrls.add(url);
      characterImageUrls.push(url);
      characterRefs.push({
        name: asset.name,
        kind: 'CHARACTER',
        ...(overrideVariant?.label ? { variantLabel: overrideVariant.label } : {}),
        ...(overrideVariant?.code ? { variantCode: overrideVariant.code } : {}),
      });
    }

    // 镜头显式指定的道具/环境变体（分镜 AI 据剧情输出 {name,costumeKey}）→ collectNonCharacter。
    const collectNonCharacter = (
      kind: 'LOCATION' | 'PROP',
      names: string[],
      costumeKeyMap: Map<string, string>,
    ) => {
      const shotSceneId = readShotSceneId(shot);
      for (const name of names) {
        const asset = findAsset(kind, name);
        if (!asset) continue;
        registerAsset(asset);
        const shotCostumeKey = costumeKeyMap.get(normalizeLookupValue(name)) ?? null;
        // 道具/环境变体：镜头显式指定的变体图（或 coverageScenes 命中）赢过 pencil 缓存/默认图
        // （对齐角色 costume 行为：显式变体胜过 pencil）。
        const variant = selectVariantForShot(asset, shotSceneId, shotCostumeKey);
        const url = variant?.url ?? selectAssetImage(asset);
        if (!url) continue;
        const refBinding: GroupPromptReferenceBinding = {
          name: asset.name,
          kind,
          ...(variant?.label ? { variantLabel: variant.label } : {}),
          ...(variant?.code ? { variantCode: variant.code } : {}),
        };
        if (asset.gridOverlayEnabled === true) {
          if (seenCharacterUrls.has(url)) continue;
          seenCharacterUrls.add(url);
          characterImageUrls.push(url);
          characterRefs.push(refBinding);
        } else {
          if (seenImageUrls.has(url)) continue;
          seenImageUrls.add(url);
          imageUrls.push(url);
          imageRefs.push(refBinding);
        }
      }
    };
    collectNonCharacter('LOCATION', environments, buildCostumeKeyMap(references.environmentCostumes));
    collectNonCharacter('PROP', items, buildCostumeKeyMap(references.itemCostumes));
  }

  // Seedance 最多接收 3 条参考音频。顺序固定为：正在说话的主角、其余已绑定
  // 人物（按参考图顺序）、最后是未带人物图但明确声明说话的 ENTITY/角色。
  const imageCharacterNames = characterRefs
    .filter((reference) => reference.kind === 'CHARACTER')
    .map((reference) => reference.name);
  const mainCharacter = imageCharacterNames.find(
    (name) => findAsset('CHARACTER', name)?.assetType === '主角',
  ) ?? imageCharacterNames[0] ?? null;
  const orderedSpeakingCharacters: string[] = [];
  if (mainCharacter && speakingCharacters.has(mainCharacter)) {
    orderedSpeakingCharacters.push(mainCharacter);
  }
  for (const name of imageCharacterNames) {
    if (speakingCharacters.has(name) && !orderedSpeakingCharacters.includes(name)) {
      orderedSpeakingCharacters.push(name);
    }
  }
  for (const name of speakingCharacters) {
    if (!orderedSpeakingCharacters.includes(name)) orderedSpeakingCharacters.push(name);
  }

  const audioUrls: string[] = [];
  const clientAudioFiles: Array<string | null> = [];
  const audioRefs: GroupPromptAudioBinding[] = [];
  const seenAudioUrls = new Set<string>();
  for (const name of orderedSpeakingCharacters) {
    if (audioUrls.length >= MAX_REFERENCE_AUDIOS) break;
    const characterAsset = findAsset('CHARACTER', name) ?? findAsset('ENTITY', name);
    const voiceAsset = findAsset('VOICE', name);
    registerAsset(characterAsset);
    registerAsset(voiceAsset);
    const voice = resolveCharacterVoice(characterAsset, voiceAsset);
    if (!voice || seenAudioUrls.has(voice.promptUrl)) continue;
    seenAudioUrls.add(voice.promptUrl);
    audioUrls.push(voice.promptUrl);
    clientAudioFiles.push(voice.clientFile);
    audioRefs.push({ name });
  }

  return {
    characterImageUrls,
    imageUrls,
    audioUrls,
    clientAudioFiles,
    assetRefs: [...characterRefs, ...imageRefs],
    audioRefs,
    unresolvedCostumes,
    context: {
      assets: contextAssets,
      costumeEntries,
      selectedCostumes,
    },
  };
}

/**
 * 按模型参考图上限贪心拆组。单镜本身超限时仍保留为一个子组，交给调用端
 * 做最终截断；跨镜拆分则严格使用 collectReferenceAssets 的实际选图结果，
 * 避免彩铅图、造型图或网格通道导致“计数图”和“提交图”不一致。
 */
export function splitShotsByAssetLimit(
  sortedShots: readonly GroupPreviewShot[],
  allAssets: readonly GroupPromptAsset[],
  maxAssets = MAX_REFERENCE_IMAGES,
  maxCharacters = MAX_REFERENCE_CHARACTERS,
  costumeMap: readonly GroupPromptCostumeMapEntry[] = [],
): GroupPreviewShot[][] {
  if (sortedShots.length === 0) return [];

  const groups: GroupPreviewShot[][] = [];
  let currentGroup: GroupPreviewShot[] = [];
  let currentUrls = new Set<string>();
  let currentCharacterUrls = new Set<string>();

  for (const shot of sortedShots) {
    const references = collectReferenceAssets([shot], allAssets, costumeMap);
    const shotUrls = [...references.characterImageUrls, ...references.imageUrls];
    const shotCharacterUrls = references.characterImageUrls.filter(
      (_url, index) => references.assetRefs[index]?.kind === 'CHARACTER',
    );
    const newUrls = shotUrls.filter((url) => !currentUrls.has(url));
    const newCharacterUrls = shotCharacterUrls.filter(
      (url) => !currentCharacterUrls.has(url),
    );
    const exceedsImageLimit = currentGroup.length > 0
      && currentUrls.size + newUrls.length > maxAssets;
    const exceedsCharacterLimit = currentGroup.length > 0
      && currentCharacterUrls.size + newCharacterUrls.length > maxCharacters;

    if (exceedsImageLimit || exceedsCharacterLimit) {
      groups.push(currentGroup);
      currentGroup = [];
      currentUrls = new Set<string>();
      currentCharacterUrls = new Set<string>();
    }

    currentGroup.push(shot);
    for (const url of shotUrls) currentUrls.add(url);
    for (const url of shotCharacterUrls) currentCharacterUrls.add(url);
  }

  if (currentGroup.length > 0) groups.push(currentGroup);
  return groups;
}

// ============================================================
// 镜头分组算法（串联一键生成 / 长集按 Seedance 时长档位分段）
// ============================================================
//
// 从 app1 src/core/ai/grouping.ts computeGroupsForChain 移植，适配 dramaforge
// GroupPreviewShot 结构。dramaforge server 域原先缺这套算法——只有 web/lib/
// group-prompt-snapshot.ts 的简化前置分组和前端 ProductionStage.tsx 的一
// 份 inline 副本；服务端生成链路（gateway）调用 combineGroupPrompts 前没有
// 可复用的分段原语，导致 >15s 的长镜头组直达 snapToValidDuration 抛
// RangeError → 任务 FAILED。本算法补齐这块，调用方必须在 combineGroupPrompts
// 前先经 computeGroupsForChain / splitShotsByDuration 切组。
//
// 算法概览（三阶段，对齐 app1 grouping.ts）：
//   1. 贪心填充：按 groupIndex 预分组 + 未分组镜头贪心装箱（15s 硬上限）
//   2. 超长拆分：时长超过 15s 的组按贪心拆为多个 ≤15s 子组
//   3. 合并：相邻组只要合计 ≤15s 即贪婪合并（无最低镜数门槛，压满 15s）
//
// 约束：单组 ≤ VALID_DURATIONS 末位（15s）；相邻组合计 ≤15s 即贪婪合并（压满
// 15s，无最低镜数门槛）；缺失时长默认 2 秒（与 getShotDuration 一致）。15s 边界统一
// 保留 0.05s 浮点容差（对齐 snapToValidDuration），保证分组器接受的组在生成
// 阶段不抛错。单镜本身 >15s 时无法再分，作为独立子组返回并由 suggestGroupSplit
// 提示调用方处理——对齐 app1（storyboard 应保证单镜 ≤15s）。
// ============================================================

/** Seedance 2.0 单组最大时长（秒）= VALID_DURATIONS 末位，绑定避免档位漂移。 */
const MAX_GROUP_DURATION_SECONDS = VALID_DURATIONS[VALID_DURATIONS.length - 1];

/** 分组标签池，按全局序号循环使用（对齐 app1 grouping.ts GROUP_LABELS）。 */
// 组标签：2026-08-12 实测 ARK 平台把「高潮组」判为涉黄敏感词组
// （InputTextSensitiveContentDetected，二分验证：'# 高潮组' + 皮肤主句 400，
// '# 剧情高潮段落'/'收束组' 200）——组标签改「高潮段落」保留剧情语义。
const GROUP_LABELS = ['建场组', '推进组', '高潮段落', '收束组', '过渡组', '尾声组'];

/** 分组结果（对齐 app1 GroupInfo）。 */
export interface ShotGroupInfo {
  /** 组内镜头 ID 列表（已去重，按 sortOrder 升序）。 */
  shotIds: string[];
  /** 组内镜头原始时长之和（秒，保留 1 位小数）。 */
  totalDuration: number;
  /** 对齐到 Seedance 有效档位的生成时长（秒）。 */
  validDuration: number;
  /** 分组标签（如「建场组-1 · 5镜」）。 */
  groupLabel: string;
}

/**
 * 把镜头时长对齐到 Seedance 有效档位；超过 15s 上限时取最大档（15）而非抛错。
 *
 * 分组算法本身必须永不崩溃（否则长集仍会 FAILED）。正常 ≤15.05s 输入与
 * snapToValidDuration 完全一致；单镜本身 >15s 的病态输入回退最大档，由调用方
 * 结合 suggestGroupSplit 决定拒绝或截断。对齐前端 ProductionStage.tsx
 * normalizeGroupDuration 的容错策略。
 */
function groupValidDuration(totalSeconds: number, maxDuration: number = MAX_GROUP_DURATION_SECONDS): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return VALID_DURATIONS[0];
  }
  if (totalSeconds <= maxDuration + 0.05 + 1e-9) {
    return snapToValidDuration(totalSeconds, durationLadderFor(maxDuration));
  }
  return maxDuration;
}

/** 读取镜头的 groupIndex（storyboardTable.groupIndex 优先），未分组返回 null。 */
function readGroupIndex(shot: GroupPreviewShot): number | null {
  const metadata = asRecord(shot.metadata);
  const storyboard = asRecord(metadata.storyboardTable);
  const value = storyboard.groupIndex ?? metadata.groupIndex;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 读取镜头所属场景 id（归一化基础场景号；缺失返回 'unknown'）。 */
function groupingSceneId(shot: GroupPreviewShot): string {
  return readShotSceneId(shot) || 'unknown';
}

/**
 * 计算一个候选组（若干镜头）的场景签名，供阶段 3 合并判据识别"跨场景"。
 *
 * - 组内所有镜头同属一个真实场景 → 返回该 sceneId；
 * - 组内镜头跨越多个场景（仅 auto 装箱可能出现）→ 返回 '__mixed__'；
 * - 组内镜头都无 sceneId → 返回 'unknown'。
 *
 * 合并守卫只阻断"两组都是真实场景且不同"的合并（杀跨场景穿帮）；unknown/mixed
 * 回退纯时长行为，避免对无 sceneId 的历史数据产生回归。
 */
function entrySceneKey(shots: readonly GroupPreviewShot[]): string {
  const scenes = new Set<string>();
  for (const s of shots) scenes.add(groupingSceneId(s));
  if (scenes.size === 1) return scenes.values().next().value ?? 'unknown';
  return '__mixed__';
}

/** 两组是否属于不同的真实场景（如是则禁止合并，避免把两个场景塞进同一 15s 组）。 */
function isCrossScene(a: string, b: string): boolean {
  return (
    a !== '__mixed__' &&
    b !== '__mixed__' &&
    a !== 'unknown' &&
    b !== 'unknown' &&
    a !== b
  );
}

/** 读取镜头持久化的组标签（storyboardTable.groupLabel 优先）。 */
function readGroupLabel(shot: GroupPreviewShot): string | null {
  const metadata = asRecord(shot.metadata);
  const storyboard = asRecord(metadata.storyboardTable);
  return readText(storyboard.groupLabel) ?? readText(metadata.groupLabel);
}

/**
 * 按时长把镜头序列贪心切分为 ≤ maxDuration 的子组，保持原镜头顺序。
 *
 * 15s 边界保留 0.05s 浮点容差（对齐 snapToValidDuration）。单个镜头本身超过
 * maxDuration 时作为独立子组返回（无法再分），交由调用方处理。
 *
 * @example splitShotsByDuration([4,4,4,4,4] 秒, 15) → [[s1,s2,s3](12s), [s4,s5](8s)]
 */
export function splitShotsByDuration<T extends GroupPreviewShot>(
  shots: readonly T[],
  maxDuration: number = MAX_GROUP_DURATION_SECONDS,
): T[][] {
  const sorted = [...shots].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.shotIndex - right.shotIndex,
  );
  const groups: T[][] = [];
  let current: T[] = [];
  let duration = 0;
  for (const shot of sorted) {
    const shotDuration = getShotDuration(shot);
    if (current.length > 0 && duration + shotDuration > maxDuration + 0.05) {
      groups.push(current);
      current = [];
      duration = 0;
    }
    current.push(shot);
    duration += shotDuration;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * 串联一键生成的镜头分组算法（三阶段：贪心填充 → 超长拆分 → 合并）。
 *
 * 从 app1 src/core/ai/grouping.ts computeGroupsForChain 移植。纯函数，保证每组
 * ≤ Seedance 15s 上限，可直接喂给 combineGroupPrompts。是 dramaforge server 域缺失的
 * 权威分组原语——调用方（gateway / chain 编排）必须在 combineGroupPrompts 前先
 * 经本函数切组，避免长集抛 RangeError。
 *
 * @param shotList 待分组的镜头列表（任意顺序）
 * @returns 分组结果（按 sortOrder 升序）
 */
export function computeGroupsForChain<T extends GroupPreviewShot>(
  shotList: readonly T[],
  maxDuration: number = MAX_GROUP_DURATION_SECONDS,
): ShotGroupInfo[] {
  // ============================================================
  // 阶段 1：贪心填充 - 按 groupIndex 预分组，未分组镜头贪心装箱
  // ============================================================
  const groupMap = new Map<string, T[]>();
  const ungrouped: T[] = [];

  for (const shot of shotList) {
    const key = readGroupIndex(shot);
    if (key !== null) {
      const groupKey = `${groupingSceneId(shot)}#${key}`;
      if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
      groupMap.get(groupKey)!.push(shot);
    } else {
      ungrouped.push(shot);
    }
  }

  if (ungrouped.length > 0) {
    ungrouped.sort((a, b) => a.sortOrder - b.sortOrder);
    let autoIdx = 0;
    let autoDur = 0;
    let autoShots = 0;
    let autoKey = `auto#${autoIdx}`;
    for (const shot of ungrouped) {
      const dur = getShotDuration(shot);
      // 15s 是硬上限；"每组至少 4 镜" 是次级目标，不能为凑镜数超时。
      if (autoShots > 0 && autoDur + dur > maxDuration + 0.05) {
        autoIdx += 1;
        autoKey = `auto#${autoIdx}`;
        autoDur = 0;
        autoShots = 0;
      }
      if (!groupMap.has(autoKey)) groupMap.set(autoKey, []);
      groupMap.get(autoKey)!.push(shot);
      autoDur += dur;
      autoShots += 1;
    }
  }

  // ============================================================
  // 阶段 2：超长拆分 - 时长超过 15s 的组按贪心拆为 ≤15s 子组
  // ============================================================
  const splitMap = new Map<string, T[]>();
  let splitIdx = 0;

  for (const [gKey, shots] of groupMap) {
    const sorted = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
    const totalDur = sorted.reduce((acc, s) => acc + getShotDuration(s), 0);

    if (totalDur <= maxDuration + 0.05) {
      splitMap.set(gKey, sorted);
    } else {
      let subDur = 0;
      let subCount = 0;
      let subGroup: T[] = [];
      for (const shot of sorted) {
        const dur = getShotDuration(shot);
        // 超时必须立即切组，即使子组尚未达 4 镜。
        if (subCount > 0 && subDur + dur > maxDuration + 0.05) {
          splitMap.set(`${gKey}-split${splitIdx++}`, subGroup);
          subGroup = [];
          subDur = 0;
          subCount = 0;
        }
        subGroup.push(shot);
        subDur += dur;
        subCount += 1;
      }
      if (subGroup.length > 0) {
        splitMap.set(`${gKey}-split${splitIdx++}`, subGroup);
      }
    }
  }

  // ============================================================
  // 阶段 3：合并 - 不足 4 镜的组向相邻组合并（严格 15s 上限）
  // ============================================================
  interface MergeEntry {
    key: string;
    shots: T[];
    duration: number;
    firstOrder: number;
    /** 该组的场景签名（entrySceneKey），用于阶段 3 跨场景合并守卫。 */
    sceneKey: string;
  }
  let mergeEntries: MergeEntry[] = [...splitMap.entries()]
    .map(([key, shots]) => {
      const sorted = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
      return {
        key,
        shots: sorted,
        duration: sorted.reduce((acc, s) => acc + getShotDuration(s), 0),
        firstOrder: sorted.length > 0 ? Math.min(...sorted.map((s) => s.sortOrder)) : 0,
        sceneKey: entrySceneKey(sorted),
      };
    })
    .sort((a, b) => a.firstOrder - b.firstOrder);

  let merged = true;
  let safety = 0;
  while (merged && mergeEntries.length > 1 && safety < 50) {
    merged = false;
    safety += 1;
    for (let i = 0; i < mergeEntries.length; i += 1) {
      const canMergeNext =
        i + 1 < mergeEntries.length &&
        mergeEntries[i].duration + mergeEntries[i + 1].duration <= maxDuration + 0.05 &&
        !isCrossScene(mergeEntries[i].sceneKey, mergeEntries[i + 1].sceneKey);
      const canMergePrev =
        i - 1 >= 0 &&
        mergeEntries[i - 1].duration + mergeEntries[i].duration <= maxDuration + 0.05 &&
        !isCrossScene(mergeEntries[i - 1].sceneKey, mergeEntries[i].sceneKey);
      if (canMergeNext) {
        mergeEntries[i + 1].shots = [...mergeEntries[i].shots, ...mergeEntries[i + 1].shots];
        mergeEntries[i + 1].duration += mergeEntries[i].duration;
        mergeEntries[i + 1].firstOrder = Math.min(mergeEntries[i].firstOrder, mergeEntries[i + 1].firstOrder);
        mergeEntries[i + 1].sceneKey = entrySceneKey(mergeEntries[i + 1].shots);
        mergeEntries.splice(i, 1);
        merged = true;
        break;
      }
      if (canMergePrev) {
        mergeEntries[i - 1].shots = [...mergeEntries[i - 1].shots, ...mergeEntries[i].shots];
        mergeEntries[i - 1].duration += mergeEntries[i].duration;
        mergeEntries[i - 1].sceneKey = entrySceneKey(mergeEntries[i - 1].shots);
        mergeEntries.splice(i, 1);
        merged = true;
        break;
      }
    }
    // 严格遵守 15s 上限：无法安全合并（合计 >15s）的相邻组保留，不再强制合并。
  }

  // ============================================================
  // 输出阶段：生成 ShotGroupInfo，去重镜头 ID，分配标签
  // ============================================================
  const groups: ShotGroupInfo[] = [];
  const seenShotIds = new Set<string>();

  mergeEntries.forEach((entry, globalIdx) => {
    const sorted = entry.shots;
    const sum = entry.duration;
    const valid = groupValidDuration(sum, maxDuration);
    const savedLabel = sorted.length > 0 ? readGroupLabel(sorted[0]) : null;
    const baseLabel = savedLabel ?? GROUP_LABELS[globalIdx % GROUP_LABELS.length];
    // 元数据标签描述真实剧情功能；统一附全局组号避免同集多场同名组无法区分。
    const label = savedLabel
      ? `${baseLabel}-${globalIdx + 1}`
      : globalIdx >= GROUP_LABELS.length
        ? `${baseLabel}-${globalIdx + 1}`
        : baseLabel;
    const dedupShotIds: string[] = [];
    for (const s of sorted) {
      if (seenShotIds.has(s.id)) continue;
      seenShotIds.add(s.id);
      dedupShotIds.push(s.id);
    }
    groups.push({
      shotIds: dedupShotIds,
      totalDuration: Math.round(sum * 10) / 10,
      validDuration: valid,
      groupLabel: `${label} · ${dedupShotIds.length}镜`,
    });
  });

  return groups;
}

/**
 * 给出镜头组拆分建议（贪心按累积时长切分为多个 ≤15s 子组）。
 *
 * 从 app1 src/core/shot/group-service.ts suggestGroupSplit 移植。供调用方在预检
 * 发现超时（例如单个镜头本身 >15s 无法再分）时拼装可读错误信息，而不是让
 * snapToValidDuration 抛裸 RangeError 导致任务 FAILED。
 */
export function suggestGroupSplit<T extends GroupPreviewShot>(
  sortedShots: readonly T[],
): string {
  const sorted = [...sortedShots].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.shotIndex - right.shotIndex,
  );
  const groups: { shots: T[]; duration: number }[] = [];
  let current: { shots: T[]; duration: number } = { shots: [], duration: 0 };
  for (const shot of sorted) {
    const dur = getShotDuration(shot);
    if (current.shots.length > 0 && current.duration + dur > MAX_GROUP_DURATION_SECONDS + 0.05) {
      groups.push(current);
      current = { shots: [], duration: 0 };
    }
    current.shots.push(shot);
    current.duration += dur;
  }
  if (current.shots.length > 0) groups.push(current);

  const lines = groups.map((g, i) => {
    const seqs = g.shots.map((s) => s.shotSeq ?? s.id.slice(0, 8)).join(', ');
    return `  第 ${i + 1} 组（${g.duration.toFixed(1)} 秒）: ${seqs}`;
  });
  return `建议拆分为 ${groups.length} 组：\n${lines.join('\n')}`;
}

const SOUND_EFFECT_KEYWORDS = [
  '声', '环境', '雨', '雷', '风', '脚步', '呼吸', '摩擦', '碰撞', '敲击',
  '轰鸣', '轰响', '门轴', '铃声', '震动', '鸟鸣', '翅膀', '回声', '底噪',
  '嗡声', '音乐', '声效', '音效',
];

export interface ParsedShotSoundDesign {
  dialogue: string;
  effects: string;
  speakingCharacters: string[];
  hasDialogue: boolean;
}

/** 按分号/加号拆声音层，同时保留引号内完整台词。 */
function splitSoundLayers(value: string): string[] {
  const layers: string[] = [];
  let current = '';
  let closingQuote = '';
  const quotePairs: Record<string, string> = {
    '“': '”', '「': '」', '『': '』', '‘': '’', '"': '"', "'": "'",
  };
  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    // 英文缩写撇号夹在字母之间：不当开闭引号，也不当分隔符，
    // 否则引号状态在第一个缩写处就错位，含 ;/+ 的台词会被误切。
    const isContractionApostrophe = character === "'"
      && /\w/.test(value[i - 1] ?? '')
      && /\w/.test(value[i + 1] ?? '');
    if (isContractionApostrophe) {
      current += character;
      continue;
    }
    if (!closingQuote && quotePairs[character]) {
      closingQuote = quotePairs[character];
      current += character;
    } else if (closingQuote && character === closingQuote) {
      closingQuote = '';
      current += character;
    } else if (!closingQuote && /[；;+]/.test(character)) {
      if (current.trim()) layers.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) layers.push(current.trim());
  return layers;
}

/**
 * 将分镜声音提示拆成对白与环境/动作音效。对白保留原句，不自行补写；老数据
 * 只在 visualPrompt 中留台词时，仅在明确的“说/台词/对白”语境下补回引号原文。
 */
export function parseShotSoundDesign(input: {
  soundCue?: string;
  voiceContent?: string;
  visualText?: string;
  audioType?: string | null;
  declaredSpeakers?: readonly string[];
  characterNames?: readonly string[];
}): ParsedShotSoundDesign {
  const primarySource = (input.soundCue || input.voiceContent || '').trim();
  if (!primarySource && !input.visualText) {
    return { dialogue: '', effects: '', speakingCharacters: [], hasDialogue: false };
  }

  const declaredSpeakers = [...(input.declaredSpeakers ?? [])].filter(Boolean);
  const characterNames = [...new Set([
    ...(input.characterNames ?? []),
    ...declaredSpeakers,
  ].filter(Boolean))];
  const dialogueLayers: string[] = [];
  const effectLayers: string[] = [];
  const inferredSpeakers = new Set<string>(declaredSpeakers);

  const quotedSpans = (value: string): Array<{
    start: number;
    end: number;
    text: string;
  }> => {
    const spans: Array<{ start: number; end: number; text: string }> = [];
    // 直引号必须容忍词中撇号（英文缩写 you will / I am / do not 的撇号夹在字母之间，
    // 不是开闭引号）。旧版正则在第一个缩写处就闭合，把台词截断、后半截漏进音效行。
    // 修复：开闭引号要求在词边界（前后非字母），词中撇号允许出现在引号内。
    const patterns = [
      /“([^”]+)”/g, /「([^」]+)」/g, /『([^』]+)』/g, /‘([^’]+)’/g,
      /(?<!\w)"((?:[^"\n]|"(?=\w))*)"(?!\w)/g,
      /(?<!\w)'((?:[^'\n]|'(?=\w))*)'(?!\w)/g,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(value)) !== null) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[1],
        });
      }
    }
    return spans.sort((left, right) => left.start - right.start);
  };
  const findNamedSpeaker = (value: string): string | undefined => {
    const normalized = value.toLocaleLowerCase();
    return characterNames.find((name) => normalized.includes(name.toLocaleLowerCase()));
  };
  // 精确匹配已知角色名（大小写无关）。用于识别新对白格式「角色名：台词」里的说话人——
  // 不能用 includes，否则「伊莱对白：…」会被「伊莱」误命中而走新路径，破坏老数据行为。
  const isKnownCharacter = (name: string): boolean => {
    const key = name.trim().toLocaleLowerCase();
    return key.length > 0 && characterNames.some((c) => c.trim().toLocaleLowerCase() === key);
  };
  // 新对白格式探测器：「角色名（通道）：台词」（通道=OS/VO/说/画外/旁白/内心/独白）
  // 或「角色名：台词」（角色名须精确命中已知角色）。命中即抽出纯台词 + 说话人，
  // 跳过下面的引号/标签旧逻辑——旧格式（「伊莱对白：…」「林晚低声说"…"」）完全不走此路径。
  const MODALITY_TAG = /^(OS|VO|画外|旁白|内心|独白|说|off[-\s]?screen|voice[-\s]?over)/i;
  const TAGGED_PAREN = /^([^\s：:（(]+?)[（(]([^）)]*)[）)]\s*[:：]\s*(.+)$/;
  const TAGGED_BARE = /^([^\s：:（(]{1,12})\s*[:：]\s*(.+)$/;
  const matchTaggedDialogue = (
    layer: string,
  ): { line: string; speaker?: string } | undefined => {
    const paren = TAGGED_PAREN.exec(layer);
    if (paren) {
      const speaker = paren[1].trim();
      const tag = paren[2].trim();
      const line = paren[3].trim();
      // 仅当括号是通道标签（OS/VO 等）时才认——避免误吞「角色（情绪）：」之类的旧括注。
      if (line && MODALITY_TAG.test(tag) && !SOUND_EFFECT_KEYWORDS.some((k) => speaker.includes(k))) {
        return { line, speaker: isKnownCharacter(speaker) ? speaker : findNamedSpeaker(layer) };
      }
      return undefined;
    }
    const bare = TAGGED_BARE.exec(layer);
    if (bare) {
      const speaker = bare[1].trim();
      const line = bare[2].trim();
      // 裸「角色：台词」要求角色名精确命中已知角色，防止把「环境：雨声」当对白。
      if (line && isKnownCharacter(speaker)) {
        return { line, speaker };
      }
    }
    return undefined;
  };
  const seenDialogueKeys = new Set<string>();
  const addDialogue = (value: string, namedSpeaker?: string) => {
    const normalized = value.trim();
    const explicitPayload = /(?:对白|旁白|OS|VO)[^：:\n]{0,80}[：:]\s*(.+)$/i
      .exec(normalized)?.[1]?.trim();
    const spokenText = quotedSpans(normalized)[0]?.text ?? explicitPayload ?? normalized;
    const key = spokenText.toLocaleLowerCase()
      .replace(/[\s，。！？、；：:,.!?"'“”‘’「」『』…—\-]/g, '');
    if (!normalized || !key || seenDialogueKeys.has(key)) return;
    seenDialogueKeys.add(key);
    dialogueLayers.push(normalized);
    if (namedSpeaker) inferredSpeakers.add(namedSpeaker);
  };
  const addEffect = (value: string) => {
    const normalized = value.trim().replace(/^[，,、]+|[，,、]+$/g, '');
    if (normalized && !effectLayers.includes(normalized)) effectLayers.push(normalized);
  };
  const consumeLayers = (
    source: string,
    options: { allowBareDialogue: boolean; acceptEffects: boolean },
  ) => {
    for (const layer of splitSoundLayers(source)) {
      // 新对白格式优先：命中即抽纯台词 + 说话人，跳过旧逻辑（旧格式不命中，行为不变）。
      const tagged = matchTaggedDialogue(layer);
      if (tagged) {
        addDialogue(tagged.line, tagged.speaker);
        continue;
      }
      const quote = quotedSpans(layer)[0] ?? null;
      const namedSpeaker = findNamedSpeaker(layer);
      const explicitPayload = /(?:对白|旁白|OS|VO)[^：:\n]{0,80}[：:]\s*(.+)$/i
        .exec(layer)?.[1]?.trim();
      const looksLikeEffect = SOUND_EFFECT_KEYWORDS.some((keyword) => layer.includes(keyword));
      const hasSpeechLabel = /(?:对白|旁白|OS|VO)/i.test(layer);
      const bareVoiceLooksLikeDialogue = options.allowBareDialogue
        && !looksLikeEffect
        && !hasSpeechLabel
        && layer.length <= 120;

      if (quote) {
        if (looksLikeEffect && !hasSpeechLabel && !namedSpeaker) {
          if (options.acceptEffects) addEffect(layer);
          continue;
        }
        addDialogue(layer.slice(0, quote.end).trim(), namedSpeaker);
        const trailingEffect = layer.slice(quote.end).trim();
        if (options.acceptEffects && trailingEffect) addEffect(trailingEffect);
        continue;
      }
      const explicitPayloadContainsWords = Boolean(explicitPayload)
        && !SOUND_EFFECT_KEYWORDS.some((keyword) => explicitPayload!.includes(keyword))
        && (!namedSpeaker
          || explicitPayload!.toLocaleLowerCase()
            .replace(namedSpeaker.toLocaleLowerCase(), '').trim().length > 12);
      if (explicitPayloadContainsWords || bareVoiceLooksLikeDialogue) {
        addDialogue(layer, namedSpeaker);
        continue;
      }
      // 只有“某人对白/某音色”而无正文时，不允许模型自行编造台词。
      if (hasSpeechLabel) continue;
      if (options.acceptEffects) addEffect(layer);
    }
  };

  consumeLayers(primarySource, {
    allowBareDialogue: !input.soundCue && Boolean(input.voiceContent),
    acceptEffects: true,
  });
  if (input.soundCue && input.voiceContent
    && input.voiceContent.trim() !== input.soundCue.trim()) {
    consumeLayers(input.voiceContent, {
      allowBareDialogue: false,
      acceptEffects: effectLayers.length === 0,
    });
  }
  if (dialogueLayers.length === 0 && input.visualText) {
    const quote = quotedSpans(input.visualText)
      .map((span) => {
        const context = input.visualText!.slice(Math.max(0, span.start - 100), span.start);
        const speechScore = /说出|说台词|台词|对白|开口|嘴唇|低语|喊|OS|VO/i
          .test(context) ? 1000 : 0;
        return { ...span, score: speechScore + span.text.length };
      })
      .filter((span) => span.score >= 1000)
      .sort((left, right) => right.score - left.score)[0];
    if (quote) {
      const prefix = input.visualText.slice(Math.max(0, quote.start - 80), quote.start);
      const speaker = findNamedSpeaker(prefix)
        ?? (characterNames.length === 1 ? characterNames[0] : undefined);
      addDialogue(`${speaker ? `${speaker}：` : ''}“${quote.text}”`, speaker);
    }
  }
  if (dialogueLayers.length > 0 && inferredSpeakers.size === 0
    && characterNames.length === 1) {
    inferredSpeakers.add(characterNames[0]);
  }
  return {
    dialogue: dialogueLayers.join('；'),
    effects: effectLayers.join('；'),
    speakingCharacters: [...inferredSpeakers],
    hasDialogue: dialogueLayers.length > 0,
  };
}

function firstFrameElement(value: string): string {
  return value.split(/[，。,.]/).map((part) => part.trim()).find(Boolean) ?? '场景';
}

function lastFrameElement(value: string): string {
  const parts = value.split(/[，。,.]/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? '情绪落点';
}

/**
 * 把镜头的视觉源（storyboard.visualContent ?? shot.visualPrompt）**解析一次**，拆成
 * 干净的「画面正文 / 首帧 / 末帧 / 声音标签」。
 *
 * 背景：dramaforge 落库时丢了 visualContent 等干净列（generate-storyboard 只存
 * shotSize/cameraAngle/cameraMovement/action/soundCue），于是 visualContent 回退到
 * 完整 visualPrompt 复合体 `【首帧】\n[MM:SS],景别,机位,运镜,[主体]+…,[voice:…]\n【落点】`。
 * 旧代码把这个复合体整个 dump 进「画面：」行，又在「当前动作/镜头/首末」里重复其片段，
 * 造成同一画面信息出现 4 次。这里只取时间码行正文作画面、行外 【…】 作首末、[voice:] 作声音，
 * 每个信息只产出一次，对齐 app1 干净分列。
 *
 * - 有 [MM:SS] 时间码行（复合体）→ renderBody = 时间码行去掉 [MM:SS] 与 [voice:…]；
 *   首末优先取行外 【…】 bracket（首帧/落点标签），缺则从 renderBody 推导。
 * - 无时间码行（干净 visualContent，如分镜 fixture）→ renderBody = cleanVisualPrompt(原文)，
 *   行为与旧实现一致，首末从 renderBody 推导。
 *
 * 运镜/景别/机位**不**从时间码行 split 解析——正文含逗号会让 fields[2] 错位串入正文，
 * 一律改用 storyboard 列（见 buildShotNarrative）。这里只负责画面正文与首末。
 */
function parseCompositeVisual(rawSource: string): {
  renderBody: string;
  firstFrame: string;
  lastFrame: string;
  voice: string;
} {
  const voice = rawSource.match(/\[voice[:：]\s*([^\]]+)\]/i)?.[1]?.trim() ?? '';
  const timecodeLine = rawSource.match(
    /\[\d{2}:\d{2}(?:\.\d+)?-\d{2}:\d{2}(?:\.\d+)?\][^\n\r]*/,
  )?.[0] ?? '';
  const brackets = rawSource.match(/【([^】]+)】/g)
    ?.map((bracket) => bracket.replace(/^【|】$/g, '').trim())
    .filter(Boolean) ?? [];
  if (!timecodeLine) {
    const body = cleanVisualPrompt(rawSource);
    return {
      renderBody: body,
      firstFrame: firstFrameElement(body),
      lastFrame: lastFrameElement(body),
      voice,
    };
  }
  const body = timecodeLine
    .replace(/\[\d{2}:\d{2}(?:\.\d+)?-\d{2}:\d{2}(?:\.\d+)?\][,，]?/, '')
    .replace(/\[voice[:：]\s*[^\]]*\]/i, '')
    .trim();
  return {
    renderBody: body,
    firstFrame: brackets[0] ?? firstFrameElement(body),
    lastFrame: brackets.at(-1) ?? lastFrameElement(body),
    voice,
  };
}

/** 单镜叙事块：动作、画面、运镜、对白/音效、情绪与下一镜落点。 */
export function buildShotNarrative(
  shot: GroupPreviewShot,
  shotIndex: number,
  totalShots: number,
  startTime: string,
  endTime: string,
  actualDuration: number,
  isLast: boolean,
  extended: boolean,
  nextFirstFrameElement?: string,
  dialogueOverride?: string,
  splitIndex = 0,
  splitTotal = 1,
): string {
  const metadata = asRecord(shot.metadata);
  const storyboard = asRecord(metadata.storyboardTable);
  const references = asRecord(shot.referencedAssets);
  const shotSize = readText(storyboard.shotSize) ?? '中景';
  const cameraAngle = readText(storyboard.cameraAngle) ?? '平视';
  const action = readText(storyboard.action) ?? '';
  // metadata.dialogue 是分镜落库的权威逐字台词（海外项目即目标语种原文，如
  // "Maya: My mom passed away..."）；storyboard.soundCue 只是声场描述（如"声音通过
  // 音响传出，带混响"）。二者绝不能用 ?? 串成一条——soundCue 非空时会遮蔽真实台词，
  // 导致 Seedance 拿不到要说的字、只能自行瞎编（成片台词完全对不上）。分开读取，
  // dialogue 在下方作为权威值优先注入。
  const metadataDialogue = readText(metadata.dialogue) ?? '';
  const soundCue = readText(storyboard.soundCue) ?? '';
  const globalPrompt = readText(storyboard.globalPrompt) ?? '';
  const detailEnhancement = readText(storyboard.detailEnhancement) ?? '';
  // 分镜结构化提示词（metadata.structuredPrompt，2026-07-28 对齐参考产品分镜制作）：
  // UI 在分镜设计阶段可编辑。此前只落库不消费 → 用户改完分镜，生成视频用的仍是旧
  // 提示词（"分镜和生产对应不上"的客观根因）。visualInfo 是镜头级画面规则，逐镜注入。
  const structuredPrompt = asRecord(metadata.structuredPrompt);
  const spVisualInfo = readText(structuredPrompt.visualInfo) ?? '';
  // 画面正文/首末/声音只解析一次：复合体（visualContent 列未落库→回退完整 visualPrompt）
  // 拆成干净 renderBody + 首末 bracket + voice，不再把整个复合体 dump 进「画面：」行。
  // 运镜/景别/机位一律用 storyboard 列（正文含逗号，时间码行 split 会错位串入）。
  const parsed = parseCompositeVisual(
    readText(storyboard.visualContent)
      ?? readText(shot.visualPrompt)
      ?? '当前场景',
  );
  const visualContent = parsed.renderBody;
  const voiceContent = parsed.voice;
  const cameraMovement = readText(storyboard.cameraMovement)
    ?? readText(metadata.cameraMovement)
    ?? '固定';
  const characterNames = readTextList(storyboard.characters)
    .concat(readTextList(references.characters));
  const declaredSpeakers = readTextList(references.speakingCharacters)
    .concat(readTextList(storyboard.speakingCharacters));
  const parsedSound = dialogueOverride === undefined
    ? parseShotSoundDesign({
        soundCue,
        voiceContent,
        visualText: `${visualContent}\n${action}`,
        audioType: shot.audioType,
        declaredSpeakers,
        characterNames,
      })
    : null;
  // 台词优先级：显式 override > 权威 metadata.dialogue > 从 soundCue/voice 解析。
  // effects 用解析结果（无解析时回退抽象 soundCue 作声场提示）；有权威台词时它一定进
  // {…} 块，Seedance 才有字可念。
  const dialogue = dialogueOverride || metadataDialogue || parsedSound?.dialogue || '';
  const sound = {
    dialogue,
    effects: parsedSound?.effects ?? soundCue,
    speakingCharacters: parsedSound?.speakingCharacters ?? declaredSpeakers,
    hasDialogue: Boolean(dialogue),
  };
  const firstElement = parsed.firstFrame;
  const lastElement = parsed.lastFrame;
  const nextStart = isLast
    ? '下一场景入口'
    : (nextFirstFrameElement ?? lastElement);
  const splitSuffix = splitTotal > 1 ? ` [续${splitIndex + 1}/${splitTotal}]` : '';
  const emotionCues = externalizeEmotion(`${action} ${visualContent} ${soundCue}`);

  const lines = [
    `Shot ${shotIndex + 1}${splitSuffix} [${startTime}-${endTime}]（${actualDuration.toFixed(1)}秒）`,
  ];
  if (action) lines.push(`当前动作：${action}。`);
  lines.push(`画面：${visualContent}。`);
  if (spVisualInfo) lines.push(`画面规则（分镜指定）：${spVisualInfo}。`);
  lines.push(
    `镜头：${shotSize}、${cameraAngle}，${extended ? '缓慢拉' : cameraMovement}；`
      + `从${firstElement}开始，结束在${lastElement}。`,
  );
  if (globalPrompt || detailEnhancement) {
    lines.push(`光线与细节：${[globalPrompt, detailEnhancement].filter(Boolean).join('；')}。`);
  }
  const soundParts = [
    sound.dialogue ? `{${sound.dialogue}}` : '',
    sound.effects ? `<${sound.effects}>` : '',
  ].filter(Boolean);
  if (soundParts.length > 0) lines.push(`声音：${soundParts.join('；')}。`);
  if (emotionCues) lines.push(`情绪外化：${emotionCues}。`);
  lines.push(
    isLast
      ? '落点：作为本组完成状态——末帧画面停稳、动作收束，避免尾随运动模糊或定格在不完整姿态。'
      : `落点：运动穿过末帧、画面不停死，下一镜从${nextStart}接起。`,
  );
  return lines.join('\n');
}

/** 从场景描述与 LOCATION 资产推导内外景、色调、光源和环境质感。 */
export function extractSceneAtmosphere(
  sceneDescription: string,
  sceneLocation: string,
  allAssets: readonly GroupPromptAsset[] = [],
): { intExt: string; mainColor: string; lightSource: string; envTexture: string } {
  const location = buildAssetLookup(allAssets)('LOCATION', sceneLocation);
  let intExt = readText(location?.intExt) ?? '';
  const mood = readText(location?.mood) ?? '';
  const locationAndDescription = `${sceneDescription} ${sceneLocation}`;
  if (!intExt) {
    intExt = /外|户外|室外|天空|街道|广场|空地|田野|森林|海边|山顶/
      .test(locationAndDescription) ? '外' : '内';
  }
  const text = `${sceneDescription} ${mood}`;
  let mainColor = '自然色调';
  if (/冷色|冷调|阴天|阴冷|蓝灰|惨白|冰冷|幽暗/.test(text)) mainColor = '冷调';
  else if (/暖色|暖调|夕阳|黄昏|温暖|琥珀|金色/.test(text)) mainColor = '暖调';
  else if (/高对比|强光|聚光|无影灯/.test(text)) mainColor = '高对比';

  let lightSource = '环境光';
  if (/无影灯|手术灯|顶灯|天花板灯/.test(text)) lightSource = '顶部无影灯';
  else if (/聚光|强光|直射/.test(text)) lightSource = '强聚光';
  else if (/阴天|漫射|散射|无直射/.test(text)) lightSource = '阴天漫射光';
  else if (/夕阳|黄昏|侧光|窗户光/.test(text)) lightSource = '侧向自然光';
  else if (/月光|夜|暗/.test(text)) lightSource = '微弱环境光';

  let envTexture = '空间层次分明';
  if (/石壁|峡谷|采石|岩石|山/.test(text)) envTexture = '粗粝岩壁环绕';
  else if (/走廊|医院|手术室|病房/.test(text)) envTexture = '冰冷医疗空间';
  else if (/森林|树木|草地/.test(text)) envTexture = '自然植被环绕';
  else if (/街道|建筑|城市/.test(text)) envTexture = '建筑街景纵深';
  return { intExt, mainColor, lightSource, envTexture };
}

export function extractCoreSceneUnit(sceneDescription: string): string {
  if (!sceneDescription) return '核心区域';
  const cleaned = sceneDescription.replace(/^【[^】]*】/, '').trim();
  for (const part of cleaned.split(/[，。,.]/).filter(Boolean)) {
    const value = part.replace(/^(阴天|晴天|雨天|雪天|夜|晨|午|晚)[，,]?\s*/, '').trim();
    if (value) return value;
  }
  return cleaned.split(/[，。,.]/)[0] || '核心区域';
}

/** 合并组内镜头为 Seedance 生产级结构化时间码提示词。 */
/**
 * 把座位布局里的角色名换成「图片N」引用。
 *
 * 火山 Seedance 2.0 官方提示词指南：参考图在提示词中以「图片1、图片2 …… 图片n」
 * 指代（无容器）。但座位布局是 analyzing 阶段写的，那时只知角色名（图片N 是分组
 * 后按组 assetRefs 顺序分配的，同场景不同组可能不同），所以注入组提示词时按本组
 * 的「角色名→图片N」映射转换。该组没有参考图的角色保留原名（降级，不破坏布局）。
 */
export function convertCharacterNamesToImageRefs(
  spatialLayout: string,
  characterImageNumber: ReadonlyMap<string, number>,
): string {
  if (!spatialLayout || characterImageNumber.size === 0) return spatialLayout;
  const normToImage = new Map<string, string>();
  for (const [name, n] of characterImageNumber) {
    normToImage.set(normalizeNameForPrompt(name), `图片${n}`);
  }
  // 匹配「名字(位置)」对：名字不含分隔符/括号/中点；位置在括号内。
  return spatialLayout.replace(
    /([^、,，\s()（）·；;]+)\s*[（(]([^)）]+)[)）]/g,
    (full, nameRaw: string, pos: string) => {
      const img = normToImage.get(normalizeNameForPrompt(String(nameRaw).trim()));
      return img ? `${img}(${pos})` : full;
    },
  );
}

export function combineGroupPrompts(
  sortedShots: readonly GroupPreviewShot[],
  options: CombineGroupPromptOptions = {},
): GroupPreviewPromptResult {
  if (sortedShots.length === 0) throw new RangeError('镜头组不能为空');
  const {
    allAssets = [],
    assetRefs = [],
    projectArtStyle,
    language = 'zh',
    audioRefs = [],
    aspectRatio,
    localizationProfile,
    sceneSpatialLayoutMap,
    sceneTimeOfDayMap,
    prevLastFrameHint = false,
    maxDuration = MAX_GROUP_DURATION_SECONDS,
  } = options;
  const rawTotalDuration = sortedShots.reduce(
    (sum, shot) => sum + getShotDuration(shot),
    0,
  );
  const durationLadder = durationLadderFor(maxDuration);
  const validDuration = snapToValidDuration(rawTotalDuration, durationLadder);
  const firstShot = sortedShots[0];
  const firstMetadata = asRecord(firstShot.metadata);
  const firstStoryboard = asRecord(firstMetadata.storyboardTable);
  const sceneLocation = readText(firstMetadata.sceneLocation)
    ?? readText(firstStoryboard.sceneLocation)
    ?? '沿用分镜设定';
  const sceneId = readText(firstMetadata.sceneId)
    ?? readText(firstShot.sceneId)
    ?? readText(firstStoryboard.sceneId)
    ?? '';
  const sceneSpatialLayout = sceneId && sceneSpatialLayoutMap
    ? (sceneSpatialLayoutMap[extractBaseSceneId(sceneId)] ?? null)
    : null;
  const sceneTimeOfDay = sceneId && sceneTimeOfDayMap
    ? (sceneTimeOfDayMap[extractBaseSceneId(sceneId)] ?? null)
    : null;
  const groupLabel = readText(firstStoryboard.groupLabel)
    ?? readText(firstMetadata.groupLabel);
  const allCharacters = new Set<string>();
  const allItems = new Set<string>();
  for (const shot of sortedShots) {
    const metadata = asRecord(shot.metadata);
    const storyboard = asRecord(metadata.storyboardTable);
    const references = asRecord(shot.referencedAssets);
    addAll(allCharacters, readTextList(storyboard.characters));
    addAll(allCharacters, readTextList(references.characters));
    addAll(allItems, readTextList(storyboard.items));
    addAll(allItems, readTextList(references.items));
  }

  let cursor = 0;
  const timecodeSegments: string[] = [];
  const shotNarratives: string[] = [];
  sortedShots.forEach((shot, index) => {
    const rawDuration = getShotDuration(shot);
    const isLast = index === sortedShots.length - 1;
    const duration = isLast
      ? rawDuration + Math.max(0, validDuration - cursor - rawDuration)
      : rawDuration;
    const extended = isLast && duration > rawDuration + 0.3;
    const start = fmtTime(cursor);
    const end = fmtTime(cursor + duration);
    const metadata = asRecord(shot.metadata);
    const storyboard = asRecord(metadata.storyboardTable);
    const shotSize = readText(storyboard.shotSize) ?? '中景';
    const cameraAngle = readText(storyboard.cameraAngle) ?? '平视';
    const visual = cleanVisualPrompt(
      readText(storyboard.visualContent)
        ?? readText(shot.visualPrompt)
        ?? `镜头${index + 1}`,
    );
    const prompt = readText(metadata.timecodePrompt)
      ?? readText(shot.visualPrompt)
      ?? '';
    const timecodeLine = prompt.match(
      /\[\d{2}:\d{2}(?:\.\d+)?-\d{2}:\d{2}(?:\.\d+)?\][^\n\r]*/,
    )?.[0];
    if (timecodeLine) {
      timecodeSegments.push(
        `[${start}-${end}]${timecodeLine.replace(/\[\d{2}:\d{2}(?:\.\d+)?-\d{2}:\d{2}(?:\.\d+)?\]/, '')}`,
      );
    } else {
      timecodeSegments.push(
        `[${start}-${end}],${shotSize},${cameraAngle},${extended ? '缓慢拉' : '固定'},${visual}`,
      );
    }
    const nextShot = sortedShots[index + 1];
    const nextStoryboard = asRecord(asRecord(nextShot?.metadata).storyboardTable);
    const nextVisual = readText(nextStoryboard.visualContent)
      ?? readText(nextShot?.visualPrompt);
    shotNarratives.push(buildShotNarrative(
      shot,
      index,
      sortedShots.length,
      start,
      end,
      duration,
      isLast,
      extended,
      nextVisual ? firstFrameElement(nextVisual) : undefined,
    ));
    cursor += duration;
  });

  const firstPrompt = readText(firstMetadata.timecodePrompt)
    ?? readText(firstShot.visualPrompt)
    ?? '';
  const stylePreset = getProjectArtStylePreset(projectArtStyle);
  const style = stylePreset?.label
    ?? firstPrompt.match(/画风[：:]\s*([^|\n]+)/)?.[1]?.trim()
    ?? '真人写实';
  const ratio = readText(aspectRatio)
    ?? readText(firstShot.aspectRatio)
    ?? firstPrompt.match(/画幅[：:]\s*([^|\n]+)/)?.[1]?.trim()
    ?? '9:16';
  const angle = firstPrompt.match(/视角[：:]\s*([^|\n]+)/)?.[1]?.trim()
    ?? '第三人称视角';
  // 分镜结构化提示词：scene（场景上下文，含内/外景 @资产 + 氛围基调）并入场景描述，
  // sceneDesign（色调/光影/空间质感）作为组级场景设计行注入——用户改分镜后生成必须生效。
  const firstStructuredPrompt = asRecord(firstMetadata.structuredPrompt);
  const spSceneContext = readText(firstStructuredPrompt.scene) ?? '';
  const spSceneDesign = readText(firstStructuredPrompt.sceneDesign) ?? '';
  const sceneDescription = [readText(firstStoryboard.visualContent), spSceneContext]
    .filter(Boolean)
    .join('；');
  const globalPrompt = readText(firstStoryboard.globalPrompt) ?? '';
  const detailEnhancement = readText(firstStoryboard.detailEnhancement) ?? '';
  const lockingParts = [...(timecodeSegments[0] ?? '').matchAll(/\[([^\]]+)\]/g)]
    .map((match) => match[1])
    .filter((part) => !/^\d{2}:\d{2}/.test(part))
    // 排除音频标签：[voice:…]/[audio:…]/[vo:…]/[os:…]/[音…] 是声音通道，不是主体锁定。
    // 旧版只滤时间码，LLM 主体标签稀疏(<4)时 [voice:…] 滑进前 4 被当主体 →
    // 「主体开场状态」出现 [voice: distant horns…] 之类。
    .filter((part) => !/^(voice|audio|vo|os|音)/i.test(part))
    .slice(0, 4)
    .map((part) => `[${part}]`)
    .join('+');
  const characterList = [...allCharacters];
  const itemList = [...allItems];
  const mainCharacter = characterList[0] ?? '主角';
  const { intExt, mainColor, lightSource, envTexture } = extractSceneAtmosphere(
    sceneDescription,
    sceneLocation,
    allAssets,
  );

  const lines: string[] = [
    `# ${groupLabel ?? (sceneId ? `场景${sceneId}` : '连续叙事段落')} | ${validDuration}秒`,
    // 画质防伪影条前置到正文第一行（2026-08-12 用户实测：放提示词末尾不生效，
    // 模型注意力被长提示词稀释——皮肤/面料连续性约束必须开头强调）。
    '人物保持完整平滑的皮肤与面料纹理，无覆盖性线条、描边或网格伪影（皮肤与衣物纹理连贯，不得被线条打断或覆盖）',
    '',
  ];
  if (stylePreset) {
    lines.push(language === 'en' ? stylePreset.lockContentEn : stylePreset.lockContentZh, '');
  }
  if (assetRefs.length > 0) {
    const characterGroups = new Map<string, number[]>();
    const characterOrder: string[] = [];
    const otherReferences: string[] = [];
    let blockingImageNumber: number | null = null;
    assetRefs.forEach((reference, index) => {
      const imageNumber = index + 1;
      if (reference.kind === 'CHARACTER') {
        if (!characterGroups.has(reference.name)) {
          characterGroups.set(reference.name, []);
          characterOrder.push(reference.name);
        }
        characterGroups.get(reference.name)!.push(imageNumber);
      } else if (reference.kind === 'BLOCKING') {
        // 场景站位图：写实定场图，无脸人形占位 + 烘焙道具，锁跨组空间地理。
        // 身份仍由角色参考图提供，这里只占用一个 图片N 槽位并声明其用途。
        blockingImageNumber = imageNumber;
      } else {
        const prefix = reference.kind === 'LOCATION' ? '场景设定参考' : '道具参考';
        const variantSuffix = reference.variantLabel
          ? reference.variantCode
            ? `（${reference.variantCode} ${normalizeNameForPrompt(reference.variantLabel)}）`
            : `（${normalizeNameForPrompt(reference.variantLabel)}变体）`
          : '';
        otherReferences.push(
          `${prefix} 图片${imageNumber} 中的${normalizeNameForPrompt(reference.name)}${variantSuffix}`,
        );
      }
    });
    const characterVariantLabels = new Map<string, { code: string | null; label: string }>();
    for (const ref of assetRefs) {
      if (ref.kind === 'CHARACTER' && ref.variantLabel) {
        characterVariantLabels.set(normalizeNameForPrompt(ref.name), {
          code: ref.variantCode ?? null,
          label: ref.variantLabel,
        });
      }
    }
    const characterReferences = characterOrder.map((name) => {
      const imageNames = characterGroups.get(name)!
        .map((imageNumber) => `图片${imageNumber}`)
        .join('、');
      // 角色变体（幼年形态等）写进文字：参考图是幼年版但角色名是成年资产名，模型可能
      // 按名字弱化参考图年龄（8/11 实测 22 集：参考图已换 child-artie 但成片仍成年）。
      // 文字点明变体编号+label 后模型明确"本组 Arthur=幼年形态"，与道具/环境变体标注对齐。
      const variant = characterVariantLabels.get(normalizeNameForPrompt(name));
      const variantSuffix = variant
        ? variant.code
          ? `（${variant.code} ${variant.label}）`
          : `（${variant.label}）`
        : '';
      return `参考 ${imageNames} 中的角色形象${variantSuffix}，保持${normalizeNameForPrompt(name)}特征一致`;
    });
    lines.push(
      '资产参考图引用（图片N 对应第 N 张参考图，主体定义后以名称指代）：',
      [...characterReferences, ...otherReferences].join('，'),
      '角色参考只取身份与服装；场景参考只取空间与光线；道具参考只取外观。每张图只读取自己的维度，勿互相叠加。',
    );
    if (characterOrder.length > 0) {
      // 反双胞胎：角色参考图是多角度设计稿（同一人的特写+正/侧/背），模型易把
      // 多视图读成多个人 → 画面冒重复角色。明确告知"图里是同一人，画面只出现一个"。
      lines.push(
        '角色参考图说明：每张角色参考图是同一角色一人的多角度设计稿——面部特写、正面、侧面、背面视图画的都是同一个人。生成时只取其中一个视角作为该角色在画面中的唯一外观，每个角色在画面里只出现一个真人；不要把同一张设计稿里的多个视角画成几个人，不要出现两个长相相同的人或双胞胎。',
      );
    }
    if (blockingImageNumber !== null) {
      lines.push(
        `场景空间布局参考 图片${blockingImageNumber}：这是一张写实定场图，图中人物为无脸占位人形（仅用于标定位置，身份以角色参考图为准）。据此图锁定本组画面空间：家具与门窗出入口的位置、角色站位与相对距离、前景后景的层次关系；生成时沿用此空间布局，不要新增或挪动图中的家具、门窗与站位。`,
      );
    }
  }
  if (audioRefs.length > 0) {
    lines.push(
      `音色参考（音频N 对应第 N 个参考音频，主角优先）：${audioRefs
        .map((reference, index) => `参考音频${index + 1}的${normalizeNameForPrompt(reference.name)}音色`)
        .join('、')}`,
    );
  }
  const coreScene = extractCoreSceneUnit(sceneDescription || sceneLocation);
  lines.push(
    `场景：${sceneLocation}；${intExt}景「${coreScene}」；${mainColor}，${lightSource}，${envTexture}。`,
  );
  if (spSceneDesign) lines.push(`场景设计（分镜指定）：${spSceneDesign}。`);
  if (globalPrompt || detailEnhancement) {
    lines.push(`本组可见风格锚点：${[globalPrompt, detailEnhancement].filter(Boolean).join('；')}。`);
  }
  if (characterList.length > 0) {
    lines.push(`角色：${characterList.map((name) => normalizeNameForPrompt(name)).join('、')}。每个角色的脸型、发色、瞳色、五官比例、服装款式与配饰在组内所有镜头保持一致，不要中途换人或改变外貌特征。`);
  }
  if (sceneSpatialLayout) {
    // 座位布局是 analyzing 用角色名写的；这里按本组「角色名→图片N」映射换成
    // 火山官方的图片N 引用（模型原生识别），该组没参考图的角色保留原名。
    const characterImageNumber = new Map<string, number>();
    assetRefs.forEach((reference, index) => {
      if (reference.kind === 'CHARACTER' && !characterImageNumber.has(reference.name)) {
        characterImageNumber.set(reference.name, index + 1);
      }
    });
    const layout = convertCharacterNamesToImageRefs(sceneSpatialLayout, characterImageNumber);
    lines.push(`站位布局：${layout}。组内镜头沿用此站位与坐/立姿态，勿换位换姿，可小幅动作。`);
  }
  if (sceneTimeOfDay) {
    // 时段光照锁：scene.time 是场景级不变量（日/夜/黄昏等），同场景所有镜头必须保持
    // 此时段与光照一致，不得跨镜乱切早/午/晚（除非剧本明确换场换时）。app1 无此锁，dramaforge 独建。
    lines.push(`时段光照：${sceneTimeOfDay}。组内统一此时段的光源方向、色温与明暗，勿跨镜切换，除非剧本写明转场。`);
  }
  if (assetRefs.length === 0 && itemList.length > 0) {
    lines.push(`道具：${itemList.map((name) => normalizeNameForPrompt(name)).join('、')}`);
  }
  lines.push(
    `画风：${style} | 画幅：${ratio} | 视角：${angle} | 时长：${validDuration}秒`,
    '',
    '## 开场连续性锁定',
    `主体开场状态：${lockingParts || `[${mainCharacter}]+[中心位置]+[正面朝向]+[站立姿态]`}`,
  );
  if (prevLastFrameHint) {
    // 首尾衔接：编排器 chain-generate.ts 把上一组视频末帧（extractLastFrame + gridOverlay）
    // 经 referenceImageBase64 送入本组请求，ark.ts 把它拼到参考图数组最后一张
    // （allReferenceImageUrls = [...charRefs, ...sceneRefs, ...imageUrls, ...lastFrameUrls,
    //   ...chainedFrameUrls]，见 gateway/providers/ark.ts）。assetRefs 与参考图数组严格同序
    // （character 通道在前、scene 通道在后，见 group-prompt-snapshot.ts），故末帧编号可精确
    // 计算 = assetRefs.length + 1，写死「图片N」让模型按官方编号引用（而非靠位置猜）。
    // 无末帧的降级场景（首组 / 上一组末帧提取失败或被跳过）由 chain-generate.ts 执行时
    // 删除整句衔接行，避免引用不存在的图片。
    const lastFrameImageNumber = assetRefs.length + 1;
    lines.push(
      `首尾衔接：本组首镜从上一组末帧（参考图最后一张，图片${lastFrameImageNumber}）的场景/站位/主光继续，两组无缝衔接；该帧仅作衔接参考，勿照搬画面、勿把其中角色当新人物复制。`,
    );
  }
  lines.push(
    '',
    '---',
    '',
    '### 当前生成组分镜',
    '',
  );
  shotNarratives.forEach((narrative, index) => {
    lines.push(narrative, '');
    if (index < shotNarratives.length - 1) lines.push('---', '');
  });
  // 语言硬约束仅「海外锁定目标语种」时追加（原设计即 group-preview.ts:149 "海外转绘增强"）。
  //   国内：提示词与输出同为中文，{} 标记已界定对白、下方「保持无字幕」行已覆盖画面文字，
  //         完整 4 条契约（含"对白只用目标语种/字幕只用目标语种"）对国内是纯开销。
  //   海外：输出语种 ≠ 提示词中文，必须约束以防中文制作指令被朗读成画外音、或字幕乱码混语种。
  const hasOverseasLanguage = Boolean(localizationProfile?.targetLanguage?.code);
  lines.push(
    '---',
    '',
    ...(hasOverseasLanguage ? [buildVideoLanguageContract(localizationProfile), ''] : []),
    // 保持无字幕：避免生成任何文字或字幕（防伪影条已前置到正文第一行，见 lines 构造）。
    '保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成Logo',
  );
  // 视频提示词送 Seedance 前三步处理（顺序不可换）：
  //   1. sanitizePromptForModeration：敏感词委婉化（血迹→污渍、尸体→倒地身躯…），
  //      规避 ARK InputTextSensitiveContentDetected 文本审核（原仅生图用、从未被调用=死函数，此处接视频链路）。
  //   2. appendSeedanceMotionCalibration：动作自然度校准（additive）。
  //   3. appendSeedanceCreationContext：虚构创作语境声明（提文本审核容错，无法救图片侧真人检测）。
  const sanitizedPrompt = sanitizePromptForModeration(lines.join('\n')).sanitized;
  return {
    combinedPrompt: appendSeedanceMotionCalibration(sanitizedPrompt),
    totalDuration: cursor,
    validDuration,
  };
}

/**
 * 把镜头组拼成可直接展示、编辑并保存的 Seedance 文本提示词。
 *
 * 调用前置条件由路由保证：shots 非空、所有镜头属于同一项目且同一分集。
 */
export function buildGroupPreviewPrompt(
  shots: readonly GroupPreviewShot[],
  localizationProfile?: LocalizationProfile,
  referenceBindings: readonly GroupPromptReferenceBinding[] = [],
  audioBindings: readonly GroupPromptAudioBinding[] = [],
  projectArtStyle?: string | null,
  prevLastFrameHint = false,
): GroupPreviewPromptResult {
  if (shots.length === 0) {
    throw new RangeError('镜头组不能为空');
  }

  // 预览顺序以持久化 sortOrder 为准；shotIndex 仅用于旧数据同序时稳定排序。
  const sortedShots = [...shots].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.shotIndex - right.shotIndex,
  );
  const rawTotalDuration = sortedShots.reduce(
    (sum, shot) => sum + getShotDuration(shot),
    0,
  );
  const totalDuration = Math.round(rawTotalDuration * 10) / 10;

  const productionPrompt = combineGroupPrompts(sortedShots, {
    localizationProfile,
    assetRefs: referenceBindings,
    audioRefs: audioBindings,
    projectArtStyle,
    prevLastFrameHint,
  });
  return {
    ...productionPrompt,
    // 保持既有 C/S API 契约：预览 totalDuration 表示原始镜头和；生产组合器
    // 的 totalDuration 则表示补齐到有效档位后的真实生成时间线。
    totalDuration,
  };
}
