/**
 * 单 Web 进程内的视频生成“同任务、同单元”请求合并。
 *
 * Electron 请求超时或连接断开不代表服务端停止执行；客户端重试若再次调用供应商，
 * 会产生孤儿视频和重复成本。当前生产为单 Web 实例，因此进程内 Promise 合并即可
 * 覆盖并发重试；未来横向扩容时应把同一协议迁移到 Redis 分布式锁与结果缓存。
 */

interface GenerationCall {
  promise: Promise<unknown>;
  expiresAt: number;
}

const calls = new Map<string, GenerationCall>();
const PENDING_TTL_MS = 30 * 60 * 1000;
const RESULT_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;

/** 清理过期完成项，避免常驻 Web 进程无限增长。 */
function reapExpired(now: number): void {
  for (const [key, entry] of calls) {
    if (entry.expiresAt <= now) calls.delete(key);
  }
}

/**
 * 合并同一幂等键的并发/短期重试调用。
 * 暂时性失败会立即释放键；确定性失败短期缓存，避免旧客户端重复提交相同违规输入。
 */
export function runDedupedVideoGeneration<T>(
  key: string,
  operation: () => Promise<T>,
  retainFailure: (error: unknown) => boolean,
): Promise<T> {
  const now = Date.now();
  reapExpired(now);
  const existing = calls.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.promise as Promise<T>;
  }

  const promise = operation();
  const entry: GenerationCall = {
    promise,
    // 生成中的请求必须覆盖供应商最长等待，完成后再延长为结果缓存时间。
    expiresAt: now + PENDING_TTL_MS,
  };
  calls.set(key, entry);
  void promise.then(
    () => {
      entry.expiresAt = Date.now() + RESULT_TTL_MS;
    },
    (error) => {
      if (retainFailure(error)) {
        entry.expiresAt = Date.now() + FAILURE_TTL_MS;
      } else if (calls.get(key) === entry) {
        calls.delete(key);
      }
    },
  );
  return promise;
}
