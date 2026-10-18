// ============================================================
// ③ server/domain/project — 校验 schema re-export
// ============================================================
//
// Zod schema 的单一来源在 @dramaforge/shared/project.ts（前后端共享），
// 本文件只做 re-export，便于 server 内部按子域组织 import。
// ============================================================

export { createProjectSchema } from '@shared/project';
