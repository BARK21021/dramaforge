// ============================================================
// ③ server/domain/storyboard — barrel
// ============================================================
// 分镜子域：shots 表 CRUD + 字段校验 + Seedance 参数清洗。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
// ============================================================

export {
  sanitizeSeedanceParams,
  readParamsHistory,
  MAX_HISTORY_LENGTH,
  SHOT_ASPECT_RATIOS,
  SHOT_RESOLUTIONS,
  type ParamsHistoryEntry,
} from './seedance-params';

export {
  validateShotCreate,
  validateShotUpdate,
  validateReferencedAssetsShape,
  REFERENCED_ASSETS_LIMITS,
  SHOT_STATUSES,
  SHOT_VIDEO_STATUSES,
  type ShotCreateInput,
  type ShotUpdatePatch,
  type ShotValidationResult,
} from './validation';

export {
  listShots,
  getEpisodesCompletionMap,
  getShot,
  createShot,
  updateShot,
  deleteShot,
  deleteShotsByProject,
  deleteShotsByEpisode,
  replaceEpisodeShots,
  type ShotRecord,
  type EpisodeCompletion,
} from './service';

// 分镜生成提示词 + 供应商结果解析（纯函数）
export {
  buildStoryboardPrompt,
  type StoryboardScene,
  type StoryboardAssetRef,
  type StoryboardPromptOptions,
} from './prompt';

export {
  parseStoryboardShots,
  type ParsedStoryboardShot,
} from './parse';

export {
  splitMultiTimecodeShots,
  postprocessStoryboardShots,
  inferCostumeVariants,
  type DialogueCoverageResult,
  type StoryboardPostprocessResult,
} from './postprocess';

export {
  archiveCurrentShotsIfAny,
  listStoryboardVersions,
  getStoryboardVersion,
  deleteStoryboardVersion,
  restoreStoryboardVersion,
  type StoryboardVersionSummary,
  type StoryboardVersion,
} from './storyboard-versions';
