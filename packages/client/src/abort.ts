/**
 * 在异步边界统一检查任务取消状态。
 *
 * 直接复用平台的 AbortSignal 原因，调用方能区分租约丢失、关闭超时等来源。
 */
export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** 可被 AbortSignal 立即打断的退避等待，避免取消后仍空等重试计时器。 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // 覆盖“首次检查后、监听器注册前”发生取消的极窄竞态。
    if (signal.aborted) onAbort();
  });
}

/**
 * 带指数退避、同时尊重任务取消的重试器。
 * 取消错误不会被当成普通网络故障重试，防止任务已取消后继续请求云端。
 */
export async function withAbortableRetry<T>(
  fn: () => Promise<T>,
  opts: {
    tries: number;
    backoffMs: number;
    /** 业务层可明确禁止重试；省略时保持原有的通用重试行为。 */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  },
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.tries; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      if (opts.shouldRetry && !opts.shouldRetry(error, attempt)) {
        throw error;
      }
      if (attempt < opts.tries) {
        await abortableDelay(opts.backoffMs * 2 ** (attempt - 1), signal);
      }
    }
  }
  throw lastError;
}

/**
 * 同时受硬超时和外部任务取消控制的 fetch。
 * finally 会移除监听器，长任务反复下载时不会在 signal 上积累事件监听。
 */
export async function fetchWithAbortTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  try {
    return await globalThis.fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
