// ============================================================
// ③ server/domain/episode — 校验 schema re-export
// ============================================================
//
// Zod schema 的单一来源在 @dramaforge/shared/episode.ts（前后端共享），
// 本文件只做 re-export，便于 server 内部按子域组织 import。对齐
// domain/project/validation.ts 的风格。
// ============================================================

export {
  createEpisodeSchema,
  updateEpisodeSchema,
  reorderEpisodesSchema,
} from '@shared/episode';
