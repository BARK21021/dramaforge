// ============================================================
// ③ server/domain/storage — barrel
// ============================================================
// 存储子域：local / minio / cos 后端 + 工厂。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
// ============================================================

export type { StorageBackend, StorageProvider, StorageUploadResult } from './types';
export { LocalStorage } from './local';
export { MinioStorage, parseMinioEndpoint } from './minio';
export { CosStorage } from './cos';
export { getStorage, createStorage, resetStorage } from './factory';
