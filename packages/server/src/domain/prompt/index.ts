// ============================================================
// ③ server/domain/prompt — barrel
// ============================================================
// 提示词子域：从 app1 src/core/ai/{group-prompt,asset-prompt,script-prompt}.ts
// 移植的纯函数（模板构建、解析、敏感词委婉化、情绪外化、时间码格式化等）。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
//
// P7.2-T1（2026-07-20）：搬入 app1 完整原版 script-prompt.ts + asset-prompt.ts
// 作为权威源（构建器 + 主解析函数）。早期抽取的 helpers 子集（cleanAiOutput 等
// 3 个 + asset-helpers 常量）保留不动、测试仍绿；本 barrel 只**新增**导出
// helpers 里没有的构建器/解析器，避免同名重复导出冲突。
// 2026-08-14：asset-prompt.ts 里的 PROMPT_SANITIZATION_MAP/sanitizePromptForModeration
// 死副本已删除（零调用方且落后于 asset-helpers 活版，缺「帝国→王国」条目）——
// 敏感词委婉化唯一权威源 = asset-helpers.ts。
// TODO：COSTUME_KEY_SLUG_HINTS 在 asset-prompt.ts 与 asset-helpers.ts 仍是两份
// （同源 app1，当前一致），后续如改动需同步或收敛。
// ============================================================

export {
  VALID_DURATIONS,
  durationLadderFor,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_CHARACTERS,
  MAX_REFERENCE_AUDIOS,
  SEEDANCE_MOTION_CALIBRATION,
  fmtTime,
  snapToValidDuration,
  externalizeEmotion,
  appendSeedanceMotionCalibration,
  extractBaseSceneId,
  validateSavedPromptAssetRefs,
  type AssetRef,
} from './seedance-helpers';

// 成组提示词预览：仅做内存文本拼装，供 Web 路由安全复用。
export {
  buildGroupPreviewPrompt,
  buildShotNarrative,
  combineGroupPrompts,
  collectReferenceAssets,
  computeGroupsForChain,
  extractCoreSceneUnit,
  extractSceneAtmosphere,
  parseShotSoundDesign,
  resolveCharacterVoiceUrl,
  splitShotsByAssetLimit,
  splitShotsByDuration,
  suggestGroupSplit,
  type GroupPreviewShot,
  type GroupPreviewPromptResult,
  type GroupPromptAsset,
  type GroupPromptCostumeMapEntry,
  type CollectedReferenceAssets,
  type CombineGroupPromptOptions,
  type ParsedShotSoundDesign,
  type GroupPromptReferenceBinding,
  type GroupPromptAudioBinding,
  type ShotGroupInfo,
} from './group-preview';

export {
  COSTUME_KEY_SLUG_HINTS,
  PROMPT_SANITIZATION_MAP,
  ASSET_RESOLUTIONS,
  ASSET_IMAGE_STYLES,
  slugifyCostumeKey,
  isAnonymousCharacterName,
  sanitizePromptForModeration,
  getResolutionByKey,
  getStyleNegativePrompt,
  getDeliveryComplianceNegativePrompt,
} from './asset-helpers';

// 海外（OVERSEAS）改编提示词三入口共享权威源（一致性测试锁定锚点原子）。
export {
  OVERSEAS_PREMISE_CORE,
  OVERSEAS_TARGET_ETHNICITY_EXAMPLE,
  OVERSEAS_FORBIDDEN_GARMENTS,
  OVERSEAS_STATUS_MAPPING_EXAMPLE,
  OVERSEAS_NAME_LOCK,
  buildWholeScriptOverseasSection,
  EXTRACTION_OVERSEAS_GUIDANCE_LINE_EN,
  buildExtractionOverseasSectionEn,
  buildExtractionOverseasSectionZh,
  buildImageOverseasIdentityRule,
} from './overseas-adaptation';

export {
  cleanAiOutput,
  extractCharacterAliasMapAndManuscript,
  parseCharacterAliasMap,
  extractDialoguesFromContent,
  stripDialogueTags,
  type ExtractedDialogue,
} from './script-helpers';

// P7.2-T1：language 纯函数模块（剧本语言检测，供 route/worker 判定 zh/en）
export {
  detectLanguage,
  detectLanguageFromAssets,
  languageFromCategory,
  assetImageLanguageFromCategory,
  normalizeNameForPrompt,
  getBilingualNameAliases,
  type ScriptLanguage,
} from './language';

// P7.2-T1 新增：app1 完整版编剧分析构建器 + 主解析函数 + 跨集上下文类型
export {
  buildScriptAnalysisPrompt,
  buildTextStylePrompt,
  buildWholeSeriesTextStylePrompt,
  parseScriptResult,
  validateAnalysisConsistency,
  type ParsedScript,
  type SceneInfo,
  type InfoPoint,
  type SceneMeta,
  type CostumeMapEntry,
  type ScriptAnalysisContext,
} from './script-prompt';

// P7.2-T1 新增：app1 完整版资产提取构建器 + 解析器 + 角色名归一化
export {
  buildAssetExtractionPrompt,
  PENCIL_PAINTING_RESTORATION_PROMPT,
  parseAssetExtraction,
  reconcileExtractedAssetCharacterNames,
  validateSuggestedVoices,
  dedupCostumes,
  assignCostumeCodes,
  resolveCostumeCode,
  canonicalizeCharacterName,
  getCharacterNameAliases,
  normalizeCanonicalCharacterRoster,
  type AssetExtractionOptions,
  type CostumeVariant,
  type ExtractedCharacter,
  type ExtractedItem,
  type ExtractedEnvironment,
  type ExtractedEntity,
  type ExtractedAssets,
} from './asset-prompt';

// P7.3-T2 新增：app1 资产生图提示词构建器（CHARACTER 三视图 / PROP 道具特写 /
// LOCATION 双框 / ENTITY UI）。纯函数，供 web generate-image route 构造出图 prompt。
export { buildAssetImagePrompt } from './asset-prompt';

// 场景站位图（blocking image）出图提示词：写实定场 + 无脸人形占位 + 烘焙道具，
// 锁跨组空间地理。纯函数，供 web blocking-image route 构造出图 prompt。
export { buildBlockingImagePrompt, type BlockingImageScene } from './scene-prompt';

// 批3 P7.x-T3 新增：app1 海外转绘目标语言清单 + 本地化档案构造器。
// web 的 LanguageMenu.tsx 消费 TARGET_LANGUAGES（34 语言）+ TargetLanguage 类型；
// text-to-style route 用 buildLocalizationProfile 把 stylePrompt 派生为可持久化的
// LocalizationProfile。纯函数 + 常量，零 ffmpeg。
export {
  TARGET_LANGUAGES,
  parseTargetLanguage,
  buildLocalizationProfile,
  readLocalizationProfile,
  buildLocalizedDurationBudget,
  buildExplicitDurationBudget,
  resolveExplicitStoryboardTarget,
  type TargetLanguage,
  type LocalizationProfile,
  type LocalizedDurationBudget,
} from './target-languages';

export {
  buildVideoLanguageContract,
  hasLockedTargetLanguage,
} from './video-language';

// 批6 音色库新增：预设音色清单（200 条文本 manifest，server 持副本供 AI 资产提取
// 建议音色；wav 字节由 client preload IPC 从客户端本地读，server 零音频字节）。
export {
  loadPresetVoiceManifest,
  type PresetVoice,
} from './voice-manifest';
