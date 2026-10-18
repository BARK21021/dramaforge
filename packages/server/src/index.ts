// ============================================================
//
// ============================================================
//
//
//
//
//
//
//
//
//
//

//
export { callAI, PROVIDERS, GatewayError, getCredential, setLicenseGate } from './gateway';

// Local license（自 local-server 迁入）—— 激活/指纹/门禁，供 web(本地) 与 local-server 复用
export { checkLicenseGate, isLicenseActive, getLicenseStatus, clearLicenseState } from './license/gate';
export { loadLicense, saveLicense, removeLicense, validateLicense, activateLicense, deactivateLicense, generateLicenseCode } from './license/index';
export { getMachineId, getMachineIdShort } from './license/fingerprint';
export type {
  GatewayPayload,
  GatewayResult,
  ProviderCredential,
  ModelCapability,
} from './gateway';

//
//
//
export {
  renderJobRepo,
  buildEpisodeConcatClips,
  dispatchFilmExport,
  dispatchChainGenerate,
  dispatchChainGenerateOnce,
  dispatchVideoSplit,
  dispatchLongVideoRewrite,
  dispatchAiTask,
  removeQueuedAiJob,
  getAiTask,
  cancelAiTask,
  listAiTasks,
  enqueueAiTask,
  startInlineAiTask,
  reportInlineAiTaskProgress,
  completeInlineAiTask,
  failInlineAiTask,
  listActiveInlineTasks,
  type AiTaskView,
  QUEUE_NAMES,
  queues,
  addJob,
  publishTaskEvent,
  listEventsAfter,
  listActiveTasksSnapshot,
  listTaskProgressClips,
  TASK_EVENTS_CHANNEL,
  type QueueName,
  type QueueJobData,
  type RenderJobRow,
  type RenderJobTransition,
  type ChainGenerateDispatchResult,
} from './task';

//
export {
  getPool,
  query,
  tx,
  runInTransaction,
  endPool,
  EnvSchema,
  loadEnv,
  env,
  getRedis,
  disconnectRedis,
//
  sendCode,
  isDevMockMode,
  normalizePhone,
  genCode,
  storeCode,
  isResendLocked,
  verifyCode,
  rateLimitAllow,
//
  findUserByPhoneOrEmail,
  createUserFromPhone,
  changeUserPassword,
  type QueryFn,
  type QueryResult,
  type Env,
  type SendSmsResult,
  type PhoneUserRow,
  type CreatePhoneUserResult,
  type ChangeUserPasswordResult,
} from './infra';

//
//
export { authOptions } from './infra/auth';

export {
  getBalance,
  chargeCredits,
  chargeAggregatedTaskCost,
  refundTaskDebit,
  creditRefund,
  creditPurchase,
  creditManual,
  recordPendingDebit,
  yuanToCredits,
  BillingError,
  type UserBalance,
  type BillingEntry,
  type LedgerEntryType,
} from './domain';
export { acquireSlot, releaseSlot, type AcquireSlotResult } from './domain';

//
export { getConcurrencyLimit } from './ai-worker/task-repo';

//
export {
  getUserRoleById,
  listUsersForAdmin,
  getUserDetailForAdmin,
  listLedgerForAdmin,
  listUserFilms,
  listUserFilmsForAdmin,
  getAdminStats,
  updateUserConcurrency,
  type AdminUserListRow,
  type AdminUserDetailRow,
  type AdminLedgerEntry,
  type AdminFilm,
  type AdminStats,
} from './domain/admin';
export {
  getStorage,
  createStorage,
  resetStorage,
  type StorageBackend,
  type StorageProvider,
  type StorageUploadResult,
} from './domain';

//
export {
  projectRepo,
  updateCharacterMappingRoleIdentityByAliasMap,
  exportProjectSnapshot,
  importProjectSnapshot,
  ProjectTransferError,
  type ProjectTransferSnapshot,
  type ProjectRecord,
  type ProjectRow,
} from './domain/project';

//
export {
  episodeRepo,
  buildEpisodeSplitPrompt,
  parseEpisodeSplitResponse,
  styleAndSplitOriginalSeries,
  splitScriptIntoEpisodes,
  type EpisodeRecord,
  type EpisodeStatus,
  type EpisodeStageStatus,
  type CreateEpisodeInput,
  type UpdateEpisodePatch,
  type SplitEpisodeDraft,
  type EpisodeSplitOutput,
  type WholeSeriesStyleSplitOutput,
} from './domain/episode';

//
export {
  buildScriptAnalysisPrompt,
  parseScriptResult,
  validateAnalysisConsistency,
  detectLanguage,
  languageFromCategory,
  assetImageLanguageFromCategory,
  type ParsedScript,
  type SceneInfo,
  type InfoPoint,
  type SceneMeta,
  type CostumeMapEntry,
  type ScriptAnalysisContext,
  type ScriptLanguage,
} from './domain/prompt';

//
export {
  buildGroupPreviewPrompt,
  type GroupPreviewShot,
  type GroupPreviewPromptResult,
} from './domain/prompt';

//
export {
  buildAssetExtractionPrompt,
  parseAssetExtraction,
  reconcileExtractedAssetCharacterNames,
  validateSuggestedVoices,
  isAnonymousCharacterName,
  buildAssetImagePrompt,
  buildBlockingImagePrompt,
  PENCIL_PAINTING_RESTORATION_PROMPT,
  sanitizePromptForModeration,
  ASSET_RESOLUTIONS,
  getResolutionByKey,
  loadPresetVoiceManifest,
  assignCostumeCodes,
  resolveCostumeCode,
  type AssetExtractionOptions,
  type ExtractedAssets,
  type ExtractedCharacter,
  type ExtractedItem,
  type ExtractedEnvironment,
  type PresetVoice,
} from './domain/prompt';

export {
  buildTextStylePrompt,
  cleanAiOutput,
  parseCharacterAliasMap,
  buildLocalizationProfile,
  readLocalizationProfile,
  buildLocalizedDurationBudget,
  buildExplicitDurationBudget,
  resolveExplicitStoryboardTarget,
  buildVideoLanguageContract,
  hasLockedTargetLanguage,
  TARGET_LANGUAGES,
  type TargetLanguage,
  type LocalizationProfile,
  type LocalizedDurationBudget,
} from './domain/prompt';

//
export {
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  updateAssetCostumesPreservingImages,
  deleteAsset,
  deleteAssetsByProject,
  replaceExtractedAssets,
  supplementExtractedCostumes,
//
//
  normalizeAssetName,
  renameAsset,
  replaceNameDeep,
  RenameValidationError,
  RENAME_NAME_MAX_LENGTH,
  extractWholeScriptAssets,
  shouldDeferWholeScriptAssetExtraction,
//
  dedupProjectCostumes,
  planSeasonInheritance,
  isWholeScriptProject,
  beginAssetImageRevision,
  markAssetImageRevisionGenerated,
  markAssetImageRevisionFailed,
  commitAssetImageRevision,
  activateAssetImageRevision,
  listAssetImageRevisions,
  type WholeScriptAssetExtractionOutput,
  type CostumeDedupOutput,
  type InheritPlan,
  type InheritItem,
  type InheritSkipped,
  type AssetRecord,
  type RenameResult,
  type AssetImageRevision,
  computeAssetMaster,
  type AssetMasterResult,
  type AssetAppearance,
  type AssetVariantAppearance,
  type EpisodeSummary as AssetEpisodeSummary,
} from './domain/asset';

//
export {
  listShots,
  getEpisodesCompletionMap,
  getShot,
  createShot,
  updateShot,
  deleteShotsByEpisode,
  replaceEpisodeShots,
  validateReferencedAssetsShape,
  buildStoryboardPrompt,
  parseStoryboardShots,
  splitMultiTimecodeShots,
  postprocessStoryboardShots,
  inferCostumeVariants,
  type ShotRecord,
  type ShotCreateInput,
  type EpisodeCompletion,
  type ShotUpdatePatch,
  type ParsedStoryboardShot,
  type DialogueCoverageResult,
  type StoryboardPostprocessResult,
  type StoryboardScene,
  type StoryboardAssetRef,
  listStoryboardVersions,
  getStoryboardVersion,
  deleteStoryboardVersion,
  restoreStoryboardVersion,
  type StoryboardVersionSummary,
  type StoryboardVersion,
} from './domain/storyboard';

export {
  getPaymentService,
  PaymentError,
  paymentOrderRepo,
  type PaymentOrder,
  type PaymentOrderStatus,
  type CreateOrderResult,
  type OrderStatusResult,
} from './domain/payment';

//
export {
  listPlatformConfigs,
  revealPlatformConfigKey,
  listPlatformConfigBalances,
  createPlatformConfig,
  importPlatformConfigs,
  updatePlatformConfig,
  deletePlatformConfig,
  resetConfigStatus,
  testConfig,
  apiConfigRepo,
  type ApiConfigView,
  type ApiConfigBalanceView,
  type PlatformConfigImportItem,
} from './domain/api-configs';

export {
  MAX_SEEDANCE_PRESETS_PER_USER,
  MAX_SEEDANCE_PRESET_NAME_LENGTH,
  SeedancePresetError,
  listSeedancePresets,
  createSeedancePreset,
  updateSeedancePreset,
  deleteSeedancePreset,
  seedancePresetRepo,
  type SeedancePreset,
  type CreateSeedancePresetInput,
  type UpdateSeedancePresetInput,
  type SeedancePresetErrorCode,
} from './domain/seedance-presets';


// ============================================================
// License domain (for /api/license/* routes)
// ============================================================
export {
  ensureLicenseTables,
  generateLicenseBatch,
  activateLicenseCode,
  deactivateLicenseCode,
  listLicenseCodes,
  getLicenseActivations,
  signLicense,
  getPublicKey,
  type LicensePayload,
} from './domain/license';
