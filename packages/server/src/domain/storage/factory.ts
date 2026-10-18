// ============================================================
// ③ server/domain/storage — 存储后端工厂
// ============================================================
//
// 文件职责：
//   根据 STORAGE_PROVIDER 环境变量选择 local / minio / cos 后端，单例管理。
//
// 移植自 app1 src/core/storage/factory.ts，改造点：
//   - getStorageAdapter → getStorage（任务要求的命名）
//   - STORAGE_PROVIDER 直接读 process.env（infra 的 env schema 不含此字段，按需读）
//   - resetStorageAdapter → resetStorage
//
// 设计要点：
//   - 单例：全局复用同一后端实例，避免重复初始化
//   - 默认 local：未配置 STORAGE_PROVIDER 时回退本地存储（开发友好）
//   - cos 选择时 console.warn（骨架实现提醒）
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import type { StorageBackend, StorageProvider } from './types';
import { LocalStorage } from './local';
import { MinioStorage } from './minio';
import { CosStorage } from './cos';

/** 全局存储后端单例 */
let _backend: StorageBackend | null = null;

/**
 * 读取 STORAGE_PROVIDER 环境变量（默认 'local'）。
 *
 * infra 的 env schema 不含 STORAGE_PROVIDER（它是可选部署配置），
 * 故直接读 process.env，非法值回退 'local'。
 */
function readProvider(): StorageProvider {
  const raw = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase();
  if (raw === 'minio' || raw === 'cos' || raw === 'local') return raw;
  return 'local';
}

/**
 * 根据 provider 类型创建后端实例（纯工厂函数）。
 *
 * @param provider - 存储后端类型
 * @returns 对应的 StorageBackend 实例
 * @throws Error 当传入不支持的 provider 类型
 */
export function createStorage(provider: StorageProvider): StorageBackend {
  switch (provider) {
    case 'local':
      return new LocalStorage();
    case 'minio':
      return new MinioStorage();
    case 'cos':
      // COS 为骨架实现，所有方法抛错；选择时告警
      console.warn(
        '[storage] COS 后端为骨架实现，所有操作将抛错。需接入 cos-nodejs-sdk-v5 后方可使用。',
      );
      return new CosStorage();
    default: {
      // Exhaustiveness check: provider is narrowed to never here
      const _exhaustive: never = provider;
      throw new Error(`不支持的存储后端: ${_exhaustive}`);
    }
  }
}

/**
 * 获取存储后端单例。
 *
 * 首次调用时根据 STORAGE_PROVIDER 环境变量创建对应后端；后续直接返回缓存。
 *
 * @returns 当前配置的 StorageBackend 实例
 */
export function getStorage(): StorageBackend {
  if (!_backend) {
    _backend = createStorage(readProvider());
  }
  return _backend;
}

/**
 * 重置存储后端单例（仅供测试）。
 *
 * 下次调用 getStorage() 时会重新创建。
 */
export function resetStorage(): void {
  _backend = null;
}
