// ============================================================
// ③ server/domain — barrel
// ============================================================
// 域层统一导出：billing / concurrency / storage / prompt / storyboard / asset / project。
// 服务器禁止 import 任何 ffmpeg 模块（整个 domain 层零 ffmpeg 依赖）。
//
// 各子域主函数：
//   - billing:      getBalance / chargeCredits / chargeAggregatedTaskCost / creditRefund
//   - concurrency:  acquireSlot / releaseSlot
//   - storage:      getStorage（返回 StorageBackend）
//   - prompt:       fmtTime / snapToValidDuration / cleanAiOutput / ...
//   - storyboard:   listShots / getShot / createShot / updateShot / deleteShot
//   - asset:        listAssets / getAsset / createAsset / updateAsset / deleteAsset
//   - project:      listByUser / create（P3 项目列表 slice）
// ============================================================

export * as billing from './billing';
export * as concurrency from './concurrency';
export * as storage from './storage';
export * as prompt from './prompt';
export * as storyboard from './storyboard';
export * as asset from './asset';
export * as project from './project';
export * as episode from './episode';
export * as payment from './payment';
export * as seedancePresets from './seedance-presets';

// 同时导出各子域的具名符号，便于直接 import { getBalance, acquireSlot, ... }
export * from './billing';
export * from './concurrency';
export * from './storage';
export * from './prompt';
export * from './storyboard';
export * from './asset';
export * from './project';
export * from './payment';
export * from './seedance-presets';
