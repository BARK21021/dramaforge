// ============================================================
// ② server/gateway — HTTP 工具（fetchJson / pollAsync / 错误归一化）
// ============================================================
//
// 文件职责：
//   - fetchJson：带兜底超时的 fetch + JSON 解析，非 2xx 抛 GatewayHttpError
//   - pollAsync：异步任务轮询（minimax/google veo/ark video 等）
//   - sleep / parseRetryAfter：辅助
//
// 设计要点：
//   - 全部使用全局 fetch，不引第三方 HTTP 库
//   - 超时默认 180s，防外部 API 卡死拖垮进程（app1 历史 bug）
//   - GatewayHttpError 携带 status / retryAfter，供 callAI 包装成 GatewayError
//   - pollAsync 不内置进度回调，保持纯函数；进度由 worker 层管理
// ============================================================

/** 网关 HTTP 错误：携带状态码与 Retry-After，供上层退避/重试决策 */
export class GatewayHttpError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(status: number, body: string, retryAfterHeader?: string | null) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'GatewayHttpError';
    this.status = status;
    this.retryAfter = parseRetryAfter(retryAfterHeader);
  }
}

/**
 * 解析 Retry-After 头（delta-seconds 或 HTTP-date）为毫秒。
 * 解析失败或非正数返回 null。
 */
export function parseRetryAfter(header?: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

import { sleep } from '@dramaforge/shared';

/**
 * 带兜底超时的 fetch + JSON 解析。
 *
 * @param url       请求 URL
 * @param init      RequestInit（method/headers/body/signal 等）
 * @param timeoutMs 总超时，默认 180s
 */
export async function fetchJson(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const effectiveTimeout = timeoutMs ?? 180_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  try {
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    const res = await fetch(url, { ...init, signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayHttpError(res.status, text, res.headers.get('retry-after'));
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof GatewayHttpError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `请求超时（${Math.round(effectiveTimeout / 1000)}s）: ${url.slice(0, 100)}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 轮询单次返回值 */
export interface PollResult<T> {
  completed: boolean;
  failed: boolean;
  result?: T;
  error?: string;
}

export interface PollOptions {
  label: string;
  timeoutMs?: number;
  intervalMs?: number;
  maxIntervalMs?: number;
}

/**
 * 异步任务轮询：循环调用 fn 直到 completed，失败抛错。
 *
 * - 空闲间隔指数退避（intervalMs → maxIntervalMs）
 * - 总超时 timeoutMs 后 abort
 *
 * 测试友好：fn 首次返回 completed=true 时不会触发 sleep。
 */
export async function pollAsync<T>(
  fn: (signal: AbortSignal) => Promise<PollResult<T>>,
  opts: PollOptions,
  externalSignal?: AbortSignal,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const startInterval = opts.intervalMs ?? 2_000;
  const maxInterval = opts.maxIntervalMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 合并外部取消信号（用户主动取消）与内部超时信号；任一 abort 都让 fn 的 fetch 中断。
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  try {
    let interval = startInterval;
    // 首次立即调用，不 sleep
    let first = true;
    while (true) {
      if (!first) {
        await sleep(interval);
        interval = Math.min(interval * 1.5, maxInterval);
        // 外部取消：不等下一次 fn 查询，立即抛"用户已取消"（非"超时"，避免被
        // mapGatewayError 误判 504 + classifyKeyError 误判 timeout 烧 key）。
        if (externalSignal?.aborted) {
          throw new Error(`${opts.label} 用户已取消`);
        }
      }
      first = false;
      const r = await fn(signal);
      if (r.completed) {
        if (r.failed) {
          throw new Error(r.error || `${opts.label} 任务失败`);
        }
        return r.result as T;
      }
      if (controller.signal.aborted) {
        // 「轮询超时」措辞被 web/app/api/generate/video/route.ts mapGatewayError 匹配 → 504 non-retryable
        // （防 chain 假死重试放大）。重命名需同步 route.ts，否则静默退回 502 retryable=true（=现状，不恶化）。
        throw new Error(`${opts.label} 轮询超时（${Math.round(timeoutMs / 1000)}s）`);
      }
    }
  } catch (err) {
    // fn 因 externalSignal abort 抛"请求超时"（fetchJson 把 AbortError 转成超时措辞）→ 覆盖为"用户已取消"。
    if (externalSignal?.aborted) {
      throw new Error(`${opts.label} 用户已取消`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
