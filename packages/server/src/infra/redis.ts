// ============================================================
// Redis 连接单例 - ioredis，懒加载
// ============================================================
//
// 文件职责：
//   提供 ioredis 单例，懒加载，从 env.REDIS_URL 初始化。
//   BullMQ 要求 maxRetriesPerRequest: null，此处统一配置。
//
// 设计要点：
//   - 懒加载：模块导入不建连，首次 getRedis() 时才解析 env + 建连
//   - 单例：全局复用同一连接，避免连接泄漏
//   - 重连策略：指数退避，最大 5 秒（沿用 app1 src/core/config/redis.ts 策略）
//   - lazyConnect: true：首次使用时才真正建连，加快启动
//
// 与 app1 的差异：app1 用 host/port/password/db 分字段配置；
// dramaforge-cs 统一用 REDIS_URL 连接字符串（docker-compose 友好）。
// ============================================================

import Redis, { type RedisOptions } from 'ioredis';
import { env } from './env';

/** Redis 单例 */
let _redis: Redis | null = null;

/**
 * 默认连接选项
 *
 * - maxRetriesPerRequest: null — BullMQ v5 强制要求
 * - retryStrategy — 指数退避，min(times*200ms, 5000ms)
 * - lazyConnect: true — 延迟到首次命令时建连
 */
const DEFAULT_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  retryStrategy(times: number): number {
    return Math.min(times * 200, 5000);
  },
  lazyConnect: true,
  enableOfflineQueue: true,
  connectTimeout: 10000,
};

/**
 * 获取 Redis 连接单例
 *
 * 首次调用时从 env().REDIS_URL 创建 ioredis 实例，注册 error/close/reconnecting
 * 监听器；后续调用返回缓存实例。
 *
 * @returns ioredis 实例
 */
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env().REDIS_URL, DEFAULT_OPTIONS);
    _redis.on('error', (err: Error) => {
      const msg = err.message || String(err);
      if (
        msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('CONNECTION_BROKEN')
      ) {
        console.warn(`[redis] 连接异常（将自动重试）: ${msg}`);
      } else {
        console.warn(`[redis] 错误: ${msg}`);
      }
    });
    _redis.on('close', () => {
      console.warn('[redis] 连接已关闭，将通过 retryStrategy 自动重连');
    });
    _redis.on('reconnecting', (delay: number) => {
      console.log(`[redis] ${delay}ms 后尝试重连...`);
    });
  }
  return _redis;
}

/**
 * 断开 Redis 连接（应用关闭/测试结束时调用）
 */
export async function disconnectRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
