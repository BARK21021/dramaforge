// ============================================================
// ③ server/domain/admin — barrel
// ============================================================
// 管理员用户管理查询子域统一导出。零 ffmpeg。
// ============================================================

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
} from './service';
