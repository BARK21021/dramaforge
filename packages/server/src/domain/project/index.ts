// ============================================================
// ③ server/domain/project — barrel
// ============================================================
// 项目子域：projects 表 CRUD + 字段校验 schema。
// 当前 slice（P3 Task 1）只暴露 listByUser / create 两个操作；
// 后续 slice 会补 getById / update / delete / 乐观锁。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
//
// 契约类型（ProjectRecord / CreateProjectInput / 枚举）的单一来源是
// @dramaforge/shared/project，这里 re-export 让 web 能从 @dramaforge/server
// 直接 import 而无需引第二个包。
// ============================================================

// 契约类型 re-export（来自 shared 单一来源）
export type {
  ProjectRecord,
  ProjectStatus,
  ProjectCategory,
  ProjectSourceMode,
  ProjectArtStyle,
  CreateProjectInput,
} from '@shared/project';

// Zod schema（server 子域走 validation.ts 入口，对齐 asset 子域风格）
export { createProjectSchema } from './validation';

// 子域实现
export {
  listByUser,
  create,
  getById,
  update,
  remove,
  updateCharacterMappingRoleIdentityByAliasMap,
  mapRow,
  projectRepo,
  ProjectValidationError,
  type ProjectRow,
} from './service';

export {
  exportProjectSnapshot,
  importProjectSnapshot,
  ProjectTransferError,
  type ProjectTransferSnapshot,
} from './transfer';
