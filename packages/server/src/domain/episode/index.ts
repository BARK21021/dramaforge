// ============================================================
// ③ server/domain/episode — barrel
// ============================================================
// 分集子域：episodes 表 CRUD（listByProject/create/getById/update/remove/
// reorder）+ zod schema re-export。
//
// 注意：mapRow / EpisodeRow 模块私有，不从本 barrel 导出——domain/index.ts
// 用 `export *` 聚合各子域，project 已导出 mapRow，再导一份会 TS2308 撞名
// （P6 payment 子域的同款修复）。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
// ============================================================

// 契约类型 re-export（来自 @shared/episode 单一来源）
export type {
  EpisodeRecord,
  EpisodeStatus,
  EpisodeStageStatus,
  CreateEpisodeInput,
  UpdateEpisodePatch,
  ReorderEpisodesInput,
} from '@shared/episode';

// Zod schema（server 子域走 validation.ts 入口，对齐 project/asset 风格）
export {
  createEpisodeSchema,
  updateEpisodeSchema,
  reorderEpisodesSchema,
} from './validation';

// 子域实现
export {
  listByProject,
  create,
  getById,
  update,
  remove,
  reorder,
  sweepStuckAnalyzing,
  resetAnalyzingToInput,
  episodeRepo,
} from './service';

export {
  buildEpisodeSplitPrompt,
  parseEpisodeSplitResponse,
  analyzeScriptEpisodeStructure,
  styleAndSplitOriginalSeries,
  splitScriptIntoEpisodes,
  StaleProjectScriptError,
  type SplitEpisodeDraft,
  type EpisodeSplitOutput,
  type EpisodeStructureAnalysis,
  type WholeSeriesStyledEpisodeDraft,
  type WholeSeriesStyleSplitOutput,
  type EpisodeSplitProjectCommit,
} from './split-service';
