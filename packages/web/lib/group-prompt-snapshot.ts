import { createHash } from 'node:crypto';

import {
  collectReferenceAssets,
  combineGroupPrompts,
  computeGroupsForChain,
  extractBaseSceneId,
  readShotSceneId,
  splitShotsByAssetLimit,
  type CollectedReferenceAssets,
  type GroupPreviewShot,
  type GroupPromptAsset,
  type GroupPromptCostumeMapEntry,
  type GroupPromptReferenceBinding,
} from '@server/domain/prompt/group-preview';
import type { LocalizationProfile } from '@server/domain/prompt/target-languages';
import { MAX_REFERENCE_CHARACTERS, MAX_REFERENCE_IMAGES } from '@server/domain/prompt/seedance-helpers';
import { resolveCostumeCode } from '@server/domain/prompt/asset-prompt';

// v4：buildShotNarrative 修复台词遮蔽（storyboard.soundCue 不再吃掉 metadata.dialogue）。
// 旧 v3 prompt 的「声音：」行只有抽象音效、没有 {台词} 块 → Seedance 无字可说。
// 升版本让所有 v3 缓存判 STALE、下次生成走 fresh prepared.prompt 重建含台词的 prompt。
export const GROUP_PROMPT_VERSION = 4;

export interface PreparedGroupPromptReferences {
  characterImageUrls: string[];
  imageUrls: string[];
  /** Backward-compatible key consumed by chain-generate: bare client files. */
  audioUrls: string[];
  /** Bare manifest filenames accepted by client readPresetVoice. */
  clientAudioFiles: string[];
  /** Resolved URLs used only to fingerprint/bind the prompt-side voice source. */
  promptAudioUrls: string[];
  assetRefs: CollectedReferenceAssets['assetRefs'];
  audioRefs: CollectedReferenceAssets['audioRefs'];
  /** Present only when a script-selected costume cannot be resolved safely. */
  unresolvedCostumes?: CollectedReferenceAssets['unresolvedCostumes'];
}

export interface GroupPromptVariantAuditEntry {
  /** 镜头 ID（组内引用该角色的镜头）。 */
  shotId: string;
  character: string;
  costumeKey: string;
  /**
   * 该变体的全局稳定编号（如 "Leo-03"，见 CostumeVariant.code）。
   * 对齐用 code 而非名称匹配；资产/变体缺失时为 null。
   */
  expectedCode: string | null;
  /** 资产 costumes 里该变体声明的 imageUrl（sf-asset://…）；资产/变体缺失时为 null。 */
  expectedImageUrl: string | null;
  /** 期望变体图是否真的进入了本组参考图数组（references.characterImageUrls）。 */
  inRefs: boolean;
}

export interface PreparedGroupPrompt {
  shotIds: string[];
  firstShotId: string;
  prompt: string;
  contextHash: string;
  /**
   * Reference-image fingerprint: hash of ONLY the character/scene image URL
   * arrays, independent of prompt text, duration, or other contextHash inputs.
   *
   * When a costume-variant image transitions from missing→present (e.g. the
   * child-Arthur "child-artie" portrait is uploaded after the first chain run),
   * this hash changes even though the prompt words didn't.  The reuse gate
   * checks this hash to reject stale videos whose generation used the wrong
   * (default-fallback) reference images.
   */
  referenceHash: string;
  totalDuration: number;
  validDuration: number;
  references: PreparedGroupPromptReferences;
  prevLastFrameHint: boolean;
  /**
   * 角色变体引用审计：每个镜头显式 characterCostumes（幼年形态等）→ 该变体图是否
   * 真的进了本组参考图数组。查 metadata.seedanceGroupPromptVariantAudit 一眼确认
   * "资产图片是否导入到了目标视频生成请求"（22 集幼态未引用排查的直接证据）。
   */
  variantAudit: GroupPromptVariantAuditEntry[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function contextHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex');
}

function promptContextMetadata(value: unknown): Record<string, unknown> | null {
  const metadata = asRecord(value);
  const entries = Object.entries(metadata).filter(
    ([key]) => !key.startsWith('seedanceGroupPrompt'),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizedSourceNames(metadata: unknown): string[] {
  const sourceNames = asRecord(metadata).sourceNames;
  if (!Array.isArray(sourceNames)) return [];
  return Array.from(new Set(sourceNames
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLocaleLowerCase().replace(/[\s\-_·.,'"“”()（）]/g, ''))))
    .sort((left, right) => left.localeCompare(right));
}

function assetPromptFingerprint(asset: GroupPromptAsset): Record<string, unknown> {
  const metadata = asRecord(asset.metadata);
  const confirmedVoice = asRecord(metadata.confirmed_voice);
  return {
    name: asset.name,
    kind: asset.kind,
    description: asset.description ?? null,
    imageUrl: asset.imageUrl ?? null,
    sourceNames: normalizedSourceNames(metadata),
    assetType: asset.assetType ?? null,
    pencilImageUrl: asset.pencilImageUrl ?? null,
    pencilPaintEnabled: asset.pencilPaintEnabled ?? null,
    pencilPaintingUrl: typeof metadata.pencilPaintingUrl === 'string'
      ? metadata.pencilPaintingUrl.trim()
      : null,
    gridOverlayEnabled: asset.gridOverlayEnabled ?? null,
    voiceId: asset.voiceId ?? null,
    confirmedVoiceFile: typeof confirmedVoice.file === 'string'
      ? confirmedVoice.file.trim()
      : null,
    audioUrl: typeof metadata.audioUrl === 'string' ? metadata.audioUrl.trim() : null,
    intExt: asset.intExt ?? null,
    mood: asset.mood ?? null,
  };
}

function selectedCostumeFingerprint(
  selection: CollectedReferenceAssets['context']['selectedCostumes'][number],
): Record<string, unknown> {
  const costume = selection.costume;
  return {
    assetId: selection.assetId,
    sceneId: selection.sceneId,
    character: selection.character,
    costume: {
      key: costume.key ?? null,
      label: costume.label ?? null,
      description: costume.description ?? null,
      identityLock: Array.isArray(costume.identityLock) ? costume.identityLock : [],
      imageUrl: costume.imageUrl ?? null,
      coverageScenes: Array.isArray(costume.coverageScenes) ? costume.coverageScenes : [],
      variantType: costume.variantType ?? null,
    },
  };
}

function costumeEntryFingerprint(entry: GroupPromptCostumeMapEntry): Record<string, unknown> {
  return {
    sceneId: entry.sceneId ?? null,
    character: entry.character ?? null,
    costumeLabel: entry.costumeLabel ?? null,
    costumeDesc: entry.costumeDesc ?? null,
    isNew: entry.isNew ?? null,
  };
}

export function readCostumeMap(scriptData: unknown): GroupPromptCostumeMapEntry[] {
  const value = asRecord(scriptData).costumeMap;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is GroupPromptCostumeMapEntry => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
}

function costumeMapIdentity(entry: GroupPromptCostumeMapEntry): string {
  const normalize = (value: unknown): string => typeof value === 'string'
    ? value.trim().toLocaleLowerCase().replace(/[\s\-_·.,'"“”()（）]/g, '')
    : '';
  const sceneId = typeof entry.sceneId === 'string'
    ? (entry.sceneId.trim().match(/^(S\d+)/i)?.[1] ?? entry.sceneId.trim()).toLocaleUpperCase()
    : '';
  return `${sceneId}:${normalize(entry.character)}`;
}

/**
 * Merge the legacy project-wide table with the current episode table.
 * Scene ids restart from S1 in every episode, so the episode row must replace
 * a project row with the same scene + character identity.
 */
export function mergeCostumeMaps(
  projectScriptData: unknown,
  episodeScriptData: unknown,
): GroupPromptCostumeMapEntry[] {
  const merged = new Map<string, GroupPromptCostumeMapEntry>();
  for (const entry of readCostumeMap(projectScriptData)) {
    merged.set(costumeMapIdentity(entry), entry);
  }
  for (const entry of readCostumeMap(episodeScriptData)) {
    merged.set(costumeMapIdentity(entry), entry);
  }
  return Array.from(merged.values());
}

/**
 * Server-authoritative grouping for chain-generate and prepare routes.
 *
 * Wires the P0-6 three-stage algorithm `computeGroupsForChain` (ported from
 * app1 grouping.ts): greedy fill by groupIndex → split oversized groups →
 * merge small adjacent groups. Then applies per-group asset-limit splitting
 * via `splitShotsByAssetLimit` (9 images / 4 characters).
 *
 * Every returned sub-group is guaranteed ≤ Seedance 15s upper bound, so the
 * downstream `combineGroupPrompts` (via `prepareGroupPromptSnapshot`) cannot
 * raise RangeError mid-generation. Replaces the legacy simplified splitter
 * (groupIndex + 15s greedy fill, no merge stage) which produced different
 * groups than the front-end `ProductionStage.tsx` — causing "front-end shows
 * 1 group, server generates as 2" mismatches.
 */
export function groupShotsForPreparedPrompts<T extends GroupPreviewShot>(
  shots: readonly T[],
  assets: readonly GroupPromptAsset[],
  costumeMap: readonly GroupPromptCostumeMapEntry[] = [],
  maxDuration: number = 15,
): T[][] {
  if (shots.length === 0) return [];

  // P0-6 权威分组：返回 ShotGroupInfo[]（仅 shotIds），保证每组 ≤15s 且与前端
  // ProductionStage.tsx 的同名算法一致。
  const groupInfos = computeGroupsForChain(shots, maxDuration);
  // computeGroupsForChain 只暴露 shotIds；按 ID 映射回实际镜头对象以保留调用方子类型 T。
  const shotById = new Map<string, T>();
  for (const shot of shots) {
    if (!shotById.has(shot.id)) shotById.set(shot.id, shot);
  }

  const result: T[][] = [];
  for (const groupInfo of groupInfos) {
    const groupShots: T[] = [];
    for (const shotId of groupInfo.shotIds) {
      const shot = shotById.get(shotId);
      if (shot) groupShots.push(shot);
    }
    if (groupShots.length === 0) continue;
    // 资产参考图上限拆分（9 图 / 4 角色上限）：每组再按 Seedance 模型硬限拆为子组，
    // 单镜自身超限时保留为独立子组交由 provider 截断兜底（对齐 app1）。
    // splitShotsByAssetLimit 只切分原对象、运行时不克隆，保留调用方子类型 T。
    // 角色上限取 MAX_REFERENCE_CHARACTERS(=4，对齐 app1 防双胞胎拆组阈值)；prepareGroupPromptSnapshot
    // 内的实际角色上限是动态的 min(4, 9 − 环境保底 − 物品保底)，分组器只负责拆组防超限。
    const subGroups = splitShotsByAssetLimit(groupShots, assets, MAX_REFERENCE_IMAGES, MAX_REFERENCE_CHARACTERS, costumeMap) as T[][];
    for (const subGroup of subGroups) {
      if (subGroup.length > 0) result.push(subGroup);
    }
  }
  return result;
}

/**
 * 从 episode.scriptData.scenes 构建 sceneId→spatialLayout 映射。
 * spatialLayout 由 analyzing LLM 写入（多角色固定空间场景的位置不变量，如车内座位），
 * 供 combineGroupPrompts 注入"座位布局"行，使同场景各组跨镜保持位置一致。
 * key 用 extractBaseSceneId 归一化（如 "S1"），与镜头 metadata.sceneId 归一化对齐；无 layout 的场景跳过。
 */
export function buildSceneSpatialLayoutMap(scriptData: unknown): Record<string, string> {
  const scenes = asRecord(scriptData).scenes;
  if (!Array.isArray(scenes)) return {};
  const map: Record<string, string> = {};
  for (const scene of scenes) {
    if (!scene || typeof scene !== 'object') continue;
    const rec = scene as Record<string, unknown>;
    const id = extractBaseSceneId(rec.id);
    const layout = typeof rec.spatialLayout === 'string' ? rec.spatialLayout.trim() : '';
    if (id && layout) map[id] = layout;
  }
  return map;
}

/**
 * 从 episode.scriptData.scenes 构建 sceneId→时段(time)映射。
 * time 由 analyzing LLM 从场景头「地点·时间·内外景」解析（日/夜/晨/昏/午/次日凌晨等），
 * 供 combineGroupPrompts 注入"时段光照"锁定行，使同场景各组跨镜保持时段/光照一致，
 * 不在镜头间乱切早/午/晚（除非剧本明确换场换时）。app1 无此锁，dramaforge 独建。
 * key 用 extractBaseSceneId 归一化，与 buildSceneSpatialLayoutMap 对齐；无 time 的场景跳过。
 */
export function buildSceneTimeOfDayMap(scriptData: unknown): Record<string, string> {
  const scenes = asRecord(scriptData).scenes;
  if (!Array.isArray(scenes)) return {};
  const map: Record<string, string> = {};
  for (const scene of scenes) {
    if (!scene || typeof scene !== 'object') continue;
    const rec = scene as Record<string, unknown>;
    const id = extractBaseSceneId(rec.id);
    const time = typeof rec.time === 'string' ? rec.time.trim() : '';
    if (id && time) map[id] = time;
  }
  return map;
}

/**
 * 每场景站位图(blocking image)记录：写实定场图 + 无脸人形占位 + 烘焙道具，
 * 作为场景定调参考图喂给该场景所有镜头组，锁死跨组空间地理。
 *
 * 存储在 `scriptData.sceneBlockingImages`（顶层兄弟 map，被 analyze 的
 * `...existingScriptData` spread 保留——不能挂 SceneInfo，re-analyze 会整体替换
 * scenes 数组）。镜像 costumeMap 先例。
 */
export interface BlockingImageRecord {
  /** 客户端本地资产 key（sf-asset://...）。 */
  key: string;
  /** 客户端本地协议 URL，注入参考图场景通道。 */
  url: string;
  /** 重新生成自增，进 contextHash。 */
  version: number;
  /** 生成时所基于的 spatialLayout 文本；re-analyze 改了布局 → 判过期。 */
  sourceSpatialLayout: string;
  /** 生成时送 ARK 的 prompt（追溯用）。 */
  prompt?: string;
  status: 'GENERATING' | 'COMMITTED' | 'FAILED';
  createdAt?: string;
}

/**
 * 从 `scriptData.sceneBlockingImages` 构建 baseSceneId→record 映射，仅返回
 * `COMMITTED` 且 `sourceSpatialLayout` 与当前 spatialLayout 完全一致的记录。
 *
 * re-analyze 改了座位布局、或场景已无座位布局 → 该 scene 不返回站位图
 * （安全降级：不注入过期图，文字「座位布局→图片N」仍生效）。
 *
 * key 用 extractBaseSceneId 归一化（与 buildSceneSpatialLayoutMap 对齐）。
 * currentSpatialLayoutByKey 为空 / 未传 → 返回 {}（无法核验新鲜度，保守不注入）。
 */
export function buildSceneBlockingImageMap(
  scriptData: unknown,
  currentSpatialLayoutByKey?: Readonly<Record<string, string>> | null,
): Record<string, BlockingImageRecord> {
  const map: Record<string, BlockingImageRecord> = {};
  if (!currentSpatialLayoutByKey || Object.keys(currentSpatialLayoutByKey).length === 0) return map;
  const raw = asRecord(scriptData).sceneBlockingImages;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [sceneKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    const id = extractBaseSceneId(sceneKey);
    if (!id) continue;
    if (rec.status !== 'COMMITTED') continue;
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (!url) continue;
    const sourceLayout = typeof rec.sourceSpatialLayout === 'string' ? rec.sourceSpatialLayout : '';
    const currentLayout = currentSpatialLayoutByKey[id] ?? '';
    if (!currentLayout || sourceLayout !== currentLayout) continue;
    map[id] = {
      key: typeof rec.key === 'string' ? rec.key : '',
      url,
      version: typeof rec.version === 'number' ? rec.version : 0,
      sourceSpatialLayout: sourceLayout,
      ...(typeof rec.prompt === 'string' && rec.prompt ? { prompt: rec.prompt } : {}),
      status: 'COMMITTED',
      ...(typeof rec.createdAt === 'string' ? { createdAt: rec.createdAt } : {}),
    };
  }
  return map;
}

export function prepareGroupPromptSnapshot(input: {
  shots: readonly GroupPreviewShot[];
  assets: readonly GroupPromptAsset[];
  costumeMap?: readonly GroupPromptCostumeMapEntry[];
  localizationProfile?: LocalizationProfile | null;
  projectArtStyle?: string | null;
  aspectRatio?: string | null;
  prevLastFrameHint?: boolean;
  sceneSpatialLayoutMap?: Readonly<Record<string, string>> | null;
  /** 每场景时段（baseSceneId→"日/夜/黄昏"等 scene.time）；有则注入"时段光照"锁定行。 */
  sceneTimeOfDayMap?: Readonly<Record<string, string>> | null;
  /** 每场景站位图（baseSceneId→record）；有则注入场景定调参考图并抑制普通道具参考。 */
  sceneBlockingImageMap?: Readonly<Record<string, BlockingImageRecord>> | null;
  /** 单组最大时长（秒）。Seedance 2.0 默认 15s；2.5 传 30 启用扩展档位合并。 */
  maxDuration?: number;
}): PreparedGroupPrompt {
  const sorted = [...input.shots].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.shotIndex - right.shotIndex,
  );
  if (sorted.length === 0) throw new RangeError('镜头组不能为空');
  const costumeMap = input.costumeMap ?? [];
  // 位置不变量映射（analyzing 提取的"座位布局"）；空映射归一化为 null，保证三路由 hash 一致
  const sceneSpatialLayoutMap = input.sceneSpatialLayoutMap && Object.keys(input.sceneSpatialLayoutMap).length > 0
    ? input.sceneSpatialLayoutMap
    : null;
  const sceneTimeOfDayMap = input.sceneTimeOfDayMap && Object.keys(input.sceneTimeOfDayMap).length > 0
    ? input.sceneTimeOfDayMap
    : null;
  const sceneBlockingImageMap = input.sceneBlockingImageMap ?? null;
  const collected = collectReferenceAssets(sorted, input.assets, costumeMap);
  // The prompt's 图片N bindings and the actual provider arrays must be the
  // same truncated sequence. Truncating only in the provider silently points
  // 图片N at the wrong asset once a single complex shot exceeds a hard limit.
  // 优先级「人物 > 环境 > 物品」：先给环境(LOCATION)、物品(PROP) 各保底 ≥1 张
  // 参考图（若有声明），剩余槽位再分给角色；末帧/首帧不保底（provider 层 slice 兜底）。
  // collected.assetRefs = [...characterRefs, ...imageRefs]，imageRefs 从 characterImageUrls.length 起。
  const selectedCharacterChannel: Array<{
    url: string;
    reference: CollectedReferenceAssets['assetRefs'][number];
  }> = [];
  const sceneEntries = collected.assetRefs
    .slice(collected.characterImageUrls.length)
    .map((reference, index) => ({ reference, url: collected.imageUrls[index] ?? '' }))
    .filter((entry) => Boolean(entry.url));
  const envEntries = sceneEntries.filter((entry) => entry.reference.kind === 'LOCATION');
  // 该组的场景站位图（baseSceneId 归一化）：有则作为场景定调参考图注入，并把该场景
  // 普通道具参考抑制（已烘焙进站位图），只保留标 metadata.standaloneReference 的
  // 「怕变形·需独立参考」道具。人物身份仍由角色参考图提供，站位图只锁地理/道具。
  const baseSceneId = extractBaseSceneId(readShotSceneId(sorted[0]));
  const blockingEntry = baseSceneId ? (sceneBlockingImageMap?.[baseSceneId] ?? null) : null;
  const hasBlocking = Boolean(blockingEntry?.url);
  const standalonePropNames = new Set(
    input.assets
      .filter((asset) => asset.kind === 'PROP' && asRecord(asset.metadata).standaloneReference === true)
      .map((asset) => asset.name),
  );
  const propEntries = sceneEntries
    .filter((entry) => entry.reference.kind === 'PROP')
    .filter((entry) => !hasBlocking || standalonePropNames.has(entry.reference.name));
  const blockingReserved = hasBlocking ? 1 : 0;
  const envReserved = envEntries.length > 0 ? 1 : 0;
  const propReserved = propEntries.length > 0 ? 1 : 0;
  // 角色动态上限：总槽 9 减去站位图/环境/物品保底，且不超过分组预算 MAX_REFERENCE_CHARACTERS。
  const characterCap = Math.min(
    MAX_REFERENCE_CHARACTERS,
    MAX_REFERENCE_IMAGES - envReserved - propReserved - blockingReserved,
  );
  let actualCharacterCount = 0;
  for (let index = 0; index < collected.characterImageUrls.length; index += 1) {
    const reference = collected.assetRefs[index];
    if (!reference || selectedCharacterChannel.length >= MAX_REFERENCE_IMAGES) break;
    if (reference.kind === 'CHARACTER') {
      if (actualCharacterCount >= characterCap) continue;
      actualCharacterCount += 1;
    }
    selectedCharacterChannel.push({
      url: collected.characterImageUrls[index],
      reference,
    });
  }
  // 场景槽：站位图优先占 1 槽（环境/物品之前），剩余给环境保底→物品保底；末帧不保底。
  const sceneBudget = MAX_REFERENCE_IMAGES - selectedCharacterChannel.length;
  const envTake = Math.max(envReserved, Math.min(envEntries.length, sceneBudget - blockingReserved - propReserved));
  const propTake = Math.max(propReserved, Math.min(propEntries.length, sceneBudget - blockingReserved - envTake));
  const blockingSceneEntry: Array<{ reference: GroupPromptReferenceBinding; url: string }> =
    hasBlocking && blockingEntry
      ? [{ reference: { kind: 'BLOCKING', name: '场景空间布局' }, url: blockingEntry.url }]
      : [];
  const selectedScene = [
    ...blockingSceneEntry,
    ...envEntries.slice(0, envTake),
    ...propEntries.slice(0, propTake),
  ];
  const supportedAudio = collected.audioUrls
    .map((promptUrl, index) => ({
      promptUrl,
      clientFile: collected.clientAudioFiles[index],
      reference: collected.audioRefs[index],
    }))
    .filter((entry): entry is {
      promptUrl: string;
      clientFile: string;
      reference: CollectedReferenceAssets['audioRefs'][number];
    } => Boolean(entry.clientFile && entry.reference))
    .slice(0, 3);
  const references: PreparedGroupPromptReferences = {
    characterImageUrls: selectedCharacterChannel.map((entry) => entry.url),
    imageUrls: selectedScene.map((entry) => entry.url),
    // chain-generate historically consumes audioUrls as referenceAudioFiles.
    // Keep that key bare-file-only while exposing the prompt URLs separately.
    audioUrls: supportedAudio.map((entry) => entry.clientFile),
    clientAudioFiles: supportedAudio.map((entry) => entry.clientFile),
    promptAudioUrls: supportedAudio.map((entry) => entry.promptUrl),
    assetRefs: [
      ...selectedCharacterChannel.map((entry) => entry.reference),
      ...selectedScene.map((entry) => entry.reference),
    ],
    audioRefs: supportedAudio.map((entry) => entry.reference),
    ...(collected.unresolvedCostumes.length > 0
      ? { unresolvedCostumes: collected.unresolvedCostumes }
      : {}),
  };
  const result = combineGroupPrompts(sorted, {
    allAssets: input.assets,
    assetRefs: references.assetRefs,
    audioRefs: references.audioRefs,
    projectArtStyle: input.projectArtStyle,
    aspectRatio: input.aspectRatio,
    localizationProfile: input.localizationProfile,
    prevLastFrameHint: input.prevLastFrameHint === true,
    sceneSpatialLayoutMap,
    sceneTimeOfDayMap,
    maxDuration: input.maxDuration,
  });
  const shotIds = sorted.map((shot) => shot.id);
  const hash = contextHash({
    version: GROUP_PROMPT_VERSION,
    shots: sorted.map((shot) => ({
      id: shot.id,
      sortOrder: shot.sortOrder,
      shotIndex: shot.shotIndex,
      durationSeconds: shot.durationSeconds,
      visualPrompt: shot.visualPrompt,
      purposeTag: shot.purposeTag,
      audioType: shot.audioType,
      sceneId: shot.sceneId,
      aspectRatio: shot.aspectRatio,
      referencedAssets: shot.referencedAssets,
      metadata: promptContextMetadata(shot.metadata),
    })),
    references,
    assets: collected.context.assets.map(assetPromptFingerprint),
    costumeEntries: collected.context.costumeEntries.map(costumeEntryFingerprint),
    selectedCostumes: collected.context.selectedCostumes.map(selectedCostumeFingerprint),
    projectArtStyle: input.projectArtStyle ?? null,
    localizationProfile: input.localizationProfile ?? null,
    aspectRatio: input.aspectRatio ?? null,
    prevLastFrameHint: input.prevLastFrameHint === true,
    sceneSpatialLayoutMap,
    sceneTimeOfDayMap,
  });
  // Reference-image fingerprint: independent of contextHash, tracks ONLY the
  // image URL arrays.  When a variant portrait is uploaded after the first run,
  // this hash changes → reuse gate rejects the stale (wrong-reference) video.
  const refHash = contextHash({
    characterImageUrls: references.characterImageUrls,
    imageUrls: references.imageUrls,
  });
  // 角色变体引用审计：镜头显式 characterCostumes → 期望变体图（assets.costumes[].imageUrl）
  // 是否真的进入本组参考图数组。inRefs=false 说明该镜头的幼态/变体图没被带进生成请求
  // （快照过期 / 收集链路丢图），重新生成前就能发现。
  const variantAudit: GroupPromptVariantAuditEntry[] = [];
  const resolveVariant = (character: string, costumeKey: string):
    { code: string | null; imageUrl: string | null } | null => {
    const asset = input.assets.find(
      (a) => a.kind === 'CHARACTER' && a.name.trim().toLocaleLowerCase() === character.trim().toLocaleLowerCase(),
    );
    const costumes = Array.isArray(asset?.costumes) ? asset.costumes : [];
    const index = costumes.findIndex((c) => {
      const k = typeof c.key === 'string' ? c.key.trim().toLocaleLowerCase() : '';
      return k && k === costumeKey.trim().toLocaleLowerCase();
    });
    const costume = index >= 0 ? costumes[index] : undefined;
    if (!asset || !costume) return null;
    const imageUrl = typeof costume.imageUrl === 'string' && costume.imageUrl ? costume.imageUrl : null;
    return {
      code: resolveCostumeCode(costume, asset.name, index + 1),
      imageUrl,
    };
  };
  for (const shot of sorted) {
    const refs = asRecord(shot.referencedAssets);
    const costumeRefs = Array.isArray(refs.characterCostumes) ? refs.characterCostumes : [];
    for (const entry of costumeRefs) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const name = (entry as { name?: unknown }).name;
      const costumeKey = (entry as { costumeKey?: unknown }).costumeKey;
      if (typeof name !== 'string' || !name.trim()) continue;
      if (typeof costumeKey !== 'string' || !costumeKey.trim()) continue;
      const resolved = resolveVariant(name, costumeKey);
      const expectedImageUrl = resolved?.imageUrl ?? null;
      variantAudit.push({
        shotId: shot.id,
        character: name,
        costumeKey,
        expectedCode: resolved?.code ?? null,
        expectedImageUrl,
        inRefs: expectedImageUrl !== null && references.characterImageUrls.includes(expectedImageUrl),
      });
    }
  }

  return {
    shotIds,
    firstShotId: shotIds[0],
    prompt: result.combinedPrompt,
    contextHash: hash,
    referenceHash: refHash,
    totalDuration: result.totalDuration,
    validDuration: result.validDuration,
    references,
    prevLastFrameHint: input.prevLastFrameHint === true,
    variantAudit,
  };
}

export type StoredGroupPromptStatus = 'MISSING' | 'STALE' | 'READY';

export function readStoredGroupPrompt(
  metadata: unknown,
  expected: Pick<PreparedGroupPrompt, 'shotIds' | 'contextHash' | 'referenceHash'>,
): {
  status: StoredGroupPromptStatus;
  prompt: string | null;
  source: 'auto' | 'user' | null;
  approved: boolean;
  /** GROUP_PROMPT_VERSION 是否一致：v3→v4 的台词修复等版本升级必须强制重生成视频。 */
  versionMatches: boolean;
  /** 参考图组合是否一致。旧数据无 referenceHash 时为 true（不阻断已有组复用，只防未来变化）。 */
  referenceHashMatches: boolean;
} {
  const value = asRecord(metadata);
  const prompt = typeof value.seedanceGroupPrompt === 'string' && value.seedanceGroupPrompt.trim()
    ? value.seedanceGroupPrompt.trim()
    : null;
if (!prompt) {
   return { status: 'MISSING', prompt: null, source: null, approved: false, versionMatches: false, referenceHashMatches: false };
}
 const ids = Array.isArray(value.seedanceGroupPromptShotIds)
    ? value.seedanceGroupPromptShotIds.filter((id): id is string => typeof id === 'string')
    : [];
  const hash = typeof value.seedanceGroupPromptContextHash === 'string'
    ? value.seedanceGroupPromptContextHash
    : '';
  const version = value.seedanceGroupPromptVersion;
  const versionMatches = version === GROUP_PROMPT_VERSION;
  const matches = version === GROUP_PROMPT_VERSION
    && hash === expected.contextHash
    && ids.length === expected.shotIds.length
    && ids.every((id, index) => id === expected.shotIds[index]);
  const source = value.seedanceGroupPromptSource === 'user' ? 'user' : 'auto';
  // 用户已认可锁定：即使 contextHash 漂移（STALE），chain-generate 也跳过 LLM 重写、只用此 prompt。
 const approved = value.seedanceGroupPromptApproved === true;
 const storedRefHash = typeof value.seedanceGroupPromptReferenceHash === 'string'
   ? value.seedanceGroupPromptReferenceHash
   : '';
 // Old data without referenceHash (generated before this field existed) → assume
 // match so existing groups keep reusing.  Only NEW snapshots carry the field;
 // when it differs the reference-image set changed (e.g. variant portrait uploaded
 // after the first run) → reject the stale video.
 const referenceHashMatches = storedRefHash
   ? storedRefHash === expected.referenceHash
   : true;
 return { status: matches ? 'READY' : 'STALE', prompt, source, approved, versionMatches, referenceHashMatches };
}

/**
 * 决定某镜头组实际送生成的提示词 + 是否需要 LLM 审核友好重写。
 *
 * 抽成纯函数便于单测（决策有计费影响——needsRewrite=true 会花一次 LLM 重写积分）。
 *
 * 优先级（尊重用户意图，兑现 UI「修改后生成将优先使用您的版本」承诺）：
 *   1. 用户手改（source='user'）或认可锁定（approved）且有正文 → 直接用 stored.prompt，
 *      needsRewrite=false。**绝不重写用户版本**——否则弹窗里看到的 ≠ 实际生成用的，
 *      用户改了等于白改（历史 bug：source='user' 因无 contextHash 被判 STALE，落入 LLM 重写覆盖）。
 *   2. READY 且已过 LLM 重写（rewritten=true）的缓存 → 用 stored.prompt，不重写（缓存复用）。
 *   3. 其余（MISSING / STALE 的 auto 来源）→ 用现算 preparedPrompt；
 *      MISSING/STALE 还需 needsRewrite=true（route 跑 LLM 重写后落库）。
 *
 * 违禁词 / 退化画面 / 海外文化等机械替换在 route 层无条件执行，不受此决策影响。
 */
export interface GroupExecutablePromptDecision {
  executablePrompt: string;
  /** true=route 应跑 rewriteGroupPromptForModeration（LLM 审核友好重写）后落库。 */
  needsRewrite: boolean;
}

export function resolveGroupExecutablePrompt(input: {
  storedPrompt: {
    status: StoredGroupPromptStatus;
    prompt: string | null;
    source: 'auto' | 'user' | null;
    approved: boolean;
  };
  storedRewritten: boolean;
  preparedPrompt: string;
}): GroupExecutablePromptDecision {
  const { storedPrompt, storedRewritten, preparedPrompt } = input;
  // 1. 用户手改 / 认可锁定 → 原样用，不重写。
  if ((storedPrompt.source === 'user' || storedPrompt.approved) && storedPrompt.prompt) {
    return { executablePrompt: storedPrompt.prompt, needsRewrite: false };
  }
  // 2. READY 且已重写缓存 → 复用，不重写。
  if (storedPrompt.status === 'READY' && storedRewritten && storedPrompt.prompt) {
    return { executablePrompt: storedPrompt.prompt, needsRewrite: false };
  }
  // 3. 其余 → 现算 prepared；MISSING/STALE 需 LLM 重写（READY&&!rewritten 用 prepared 但不重写）。
  return { executablePrompt: preparedPrompt, needsRewrite: storedPrompt.status !== 'READY' };
}

/**
 * 复用门决策（staleness-aware）：整组已 COMPLETED 且共用同一素材、且上下文未变（READY）
 * 才复用旧视频；否则按组重生成。READY 由 readStoredGroupPrompt 基于 contextHash 判定
 * （含资产 imageUrl / 运镜 cameraMovement / 座位布局 sceneSpatialLayout）。
 * 抽成纯函数便于单测（决策有计费影响）。
 */
export function shouldReuseGroupVideo(
  force: boolean,
  _storedPromptStatus: StoredGroupPromptStatus,
  completedUrls: readonly string[],
  groupLength: number,
  promptVersionMatches = true,
): boolean {
  // force=true → 全部重生成。
  // promptVersionMatches=false → prompt 版本过期（如 v3→v4 台词修复）：旧视频内容
  //   已确认有缺陷（Ep5 台词丢失），绝不允许复用，必须重生成拿新 prompt 的视频。
  // force=false（默认 / 补失败 / 一键出片）：整组都已 COMPLETED 且同一素材 → 复用（跳过），
  // 与 storedPromptStatus（READY/STALE/MISSING）无关——提示词 hash 漂移不代表用户想重生成视频；
  // 已完成的组除非显式 force=true，否则一律跳过复用，只重生成未完成（FAILED/PENDING）的组。
  if (force || !promptVersionMatches) return false;
  if (completedUrls.length !== groupLength) return false;
  return new Set(completedUrls).size === 1;
}

export function groupPromptMetadata(
  existingMetadata: unknown,
  prepared: PreparedGroupPrompt,
  prompt = prepared.prompt,
  source: 'auto' | 'user' = 'auto',
  rewritten = false,
  // approved 三态：true=用户认可锁定 / false=显式解除（如重新生成新提示词） /
  // undefined=保留 existingMetadata 现值（避免 prepare/preview 等旁路写回误清锁定）。
  approved?: boolean,
): Record<string, unknown> {
  const prev = asRecord(existingMetadata);
  const approvedNow = approved ?? (prev.seedanceGroupPromptApproved === true);
  return {
    ...prev,
    seedanceGroupPrompt: prompt,
    seedanceGroupPromptVersion: GROUP_PROMPT_VERSION,
    seedanceGroupPromptShotIds: prepared.shotIds,
    seedanceGroupPromptContextHash: prepared.contextHash,
    seedanceGroupPromptReferenceHash: prepared.referenceHash,
    seedanceGroupPromptSource: source,
    // 层2：标记此 snapshot 是否已过 LLM 审核友好重写。chain-generate 的 READY 复用
    // 判定额外要求 rewritten===true，避免 prepare 路由写回的未重写 prompt 被直接复用。
    seedanceGroupPromptRewritten: rewritten,
    // 用户认可锁定标志：chain-generate 据此跳过 LLM 重写、只用此 prompt（见 route.ts 门）。
    seedanceGroupPromptApproved: approvedNow,
    seedanceGroupPromptApprovedAt: approvedNow
      ? (typeof prev.seedanceGroupPromptApprovedAt === 'string'
        ? prev.seedanceGroupPromptApprovedAt
        : new Date().toISOString())
      : null,
    seedanceGroupPromptUpdatedAt: new Date().toISOString(),
    // 角色变体引用审计（幼态图是否真的进了本组参考图数组）——见 PreparedGroupPrompt.variantAudit。
    seedanceGroupPromptVariantAudit: prepared.variantAudit,
    // 真实引用资产图（与提交时参考图数组严格同序：图片N = refs[N-1]）。
    // 生产制作界面在组提示词上方直接展示这些图，一眼核对"实际运用的目标资产图"，
    // 不再靠事后查库。refs[].variantCode 为变体稳定编号（如 Leo-03）。
    seedanceGroupPromptReferences: {
      refs: prepared.references.assetRefs.map((reference, index) => ({
        url: index < prepared.references.characterImageUrls.length
          ? prepared.references.characterImageUrls[index]
          : prepared.references.imageUrls[index - prepared.references.characterImageUrls.length] ?? '',
        name: reference.name,
        kind: reference.kind,
        ...(reference.variantLabel ? { variantLabel: reference.variantLabel } : {}),
        ...(reference.variantCode ? { variantCode: reference.variantCode } : {}),
      })),
    },
  };
}
