// ============================================================
// ③ server/domain/concurrency — barrel
// ============================================================
// 并发控制子域：用户并发任务门控（Redis INCR/DECR 计数器）。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
// ============================================================

export {
  acquireSlot,
  releaseSlot,
  getStatus,
  clearAll,
  recomputeAllFromDb,
  type AcquireSlotResult,
} from './slot-gate';
