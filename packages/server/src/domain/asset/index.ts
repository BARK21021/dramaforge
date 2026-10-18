// ============================================================
// ③ server/domain/asset — barrel
// ============================================================
// 资产子域：assets 表 CRUD + 字段校验。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
// ============================================================

export {
  validateAssetCreate,
  validateAssetUpdate,
  ASSET_KINDS,
  CHARACTER_TYPES,
  VOICE_SOURCES,
  AUDITION_STATUSES,
  type AssetCreateInput,
  type AssetUpdatePatch,
  type AssetValidationResult,
} from './validation';

export {
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  updateAssetCostumesPreservingImages,
  deleteAsset,
  deleteAssetsByProject,
  replaceExtractedAssets,
  type AssetRecord,
} from './service';
export {
  normalizeAssetName,
  getAssetNameAliases,
  getAssetLookupKey,
  mergeStringArray,
  mergeNumberArray,
  mergeCostumes,
  shouldPreserveAssetTextFields,
  shouldProtectAssetFromDeletion,
} from './asset-reuse';

// 角色改名 + 项目级名字同步（移植自 app1 src/core/asset/rename-service.ts）
export {
  renameAsset,
  replaceNameDeep,
  RenameValidationError,
  RENAME_NAME_MAX_LENGTH,
  type RenameResult,
} from './rename-service';

export {
  beginAssetImageRevision,
  markAssetImageRevisionGenerated,
  markAssetImageRevisionFailed,
  commitAssetImageRevision,
  activateAssetImageRevision,
  listAssetImageRevisions,
  type AssetImageRevision,
} from './image-revision';

// 整剧资产提取（转绘 X4.4，移植自 app1 src/core/video/whole-script-asset-extraction.ts）
export {
  extractWholeScriptAssets,
  shouldDeferWholeScriptAssetExtraction,
  type WholeScriptAssetExtractionOutput,
} from './whole-script-extraction';

// 造型变体 AI 去重（一次性修复中英文重复变体 + 维护）
export {
  dedupProjectCostumes,
  type CostumeDedupOutput,
} from './costume-dedup';

// 季继承（资产外观对比继承，纯只读出计划；写入+图片复制在 route + 客户端 IPC）
export {
  planSeasonInheritance,
  isWholeScriptProject,
  type InheritPlan,
  type InheritItem,
  type InheritSkipped,
} from './season-inherit';

export { supplementExtractedCostumes } from './costume-supplement';

// 资产"出场集"聚合（资产总表用，2026-07-28）——从 shots 派生 asset×episode 矩阵
export {
  computeAssetMaster,
  type AssetMasterResult,
  type AssetAppearance,
  type AssetVariantAppearance,
  type EpisodeSummary,
} from './appearance';
