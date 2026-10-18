// ⑬ ops-heartbeat — periodic heartbeat to /api/client/heartbeat.
//
// Every `intervalMs` (default 30s) the client POSTs its version + machineId.
// The server responds with `{ status: 'ok' | 'force_upgrade', ... }`. On
// `force_upgrade` the client activates the UI lockout and invokes the caller's
// `onForceUpgrade` callback (the shell swaps to the upgrade-only screen).
//
// The heartbeat MUST be resilient: any network error or non-ok response is
// swallowed (logged to console) so the client never crashes on a heartbeat
// hiccup. Uses the global `fetch` (Node 18+ / Electron).

import type { HeartbeatRequest, HeartbeatResponse } from '@dramaforge/shared';
import * as lockout from './lockout';

/**
 * 运行平台 → 心跳 os 字段。
 * 之前硬编码 'win'（跨平台不准，mac/linux 客户端会被服务器误判）。
 * 与 main/index.ts 的 mapOs 同语义；这里内联以保持 heartbeat 自洽、不改调用契约。
 */
function detectOs(): 'win' | 'mac' | 'linux' {
  const p = process.platform;
  if (p === 'win32') return 'win';
  if (p === 'darwin') return 'mac';
  return 'linux';
}

export interface StartHeartbeatOptions {
  version: string;
  machineId: string;
  apiBase: string;
  intervalMs?: number;
  /** Hard deadline for the complete fetch + JSON body read. Default 15000ms. */
  requestTimeoutMs?: number;
  onForceUpgrade: (resp: HeartbeatResponse) => void;
}

export interface HeartbeatHandle {
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_PATH = '/api/client/heartbeat';

interface SendHeartbeatOptions {
  url: string;
  body: HeartbeatRequest;
  requestTimeoutMs: number;
  /** stop() 时终止在途请求；缺失则无外部中止（单发调用）。 */
  externalSignal?: AbortSignal;
  /** 网络错误/超时/中止回调（tick 用于 stopped 感知的日志；单发调用可不传）。 */
  onError?: (error: unknown) => void;
}

/**
 * 发送一次 heartbeat 请求并解析响应。
 *
 * 共享给周期心跳（startHeartbeat.tick）与启动时一次性读取
 * （fetchHeartbeatOnce）。任何失败（网络/超时/非 ok）都返回 null 不抛错——
 * heartbeat 路径必须坚韧，绝不能因一次抖动弄崩客户端。
 */
async function sendHeartbeat(opts: SendHeartbeatOptions): Promise<HeartbeatResponse | null> {
  const controller = new AbortController();
  const abortOnExternal = (): void => controller.abort();
  opts.externalSignal?.addEventListener('abort', abortOnExternal, { once: true });
  let deadline: ReturnType<typeof setTimeout> | null = null;
  try {
    const request = (async (): Promise<HeartbeatResponse | null> => {
      const res = await globalThis.fetch(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[heartbeat] non-ok response: ${res.status} ${res.statusText}`);
        return null;
      }
      return (await res.json()) as HeartbeatResponse;
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        reject(new Error(`heartbeat request timed out after ${opts.requestTimeoutMs}ms`));
        controller.abort();
      }, opts.requestTimeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('heartbeat request aborted')),
        { once: true },
      );
    });
    return await Promise.race([request, timeout, aborted]);
  } catch (err) {
    // Heartbeat must be resilient — never crash the client on network errors.
    opts.onError?.(err);
    return null;
  } finally {
    if (deadline !== null) clearTimeout(deadline);
    opts.externalSignal?.removeEventListener('abort', abortOnExternal);
  }
}

/**
 * 启动时一次性读取 heartbeat 响应（供 bootstrapShell 取 renderJobSlots）。
 * 首跳不再等完整间隔；失败静默返回 null，调用方回退默认。
 */
export async function fetchHeartbeatOnce(opts: {
  version: string;
  machineId: string;
  apiBase: string;
  requestTimeoutMs?: number;
}): Promise<HeartbeatResponse | null> {
  return sendHeartbeat({
    url: `${opts.apiBase}${HEARTBEAT_PATH}`,
    body: { version: opts.version, os: detectOs(), machineId: opts.machineId },
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
}

export function startHeartbeat(opts: StartHeartbeatOptions): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const url = `${opts.apiBase}${HEARTBEAT_PATH}`;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeController: AbortController | null = null;

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    const controller = new AbortController();
    activeController = controller;
    const body: HeartbeatRequest = {
      version: opts.version,
      os: detectOs(),
      machineId: opts.machineId,
    };
    try {
      const resp = await sendHeartbeat({
        url,
        body,
        requestTimeoutMs,
        externalSignal: controller.signal,
        onError: (err) => {
          if (!stopped) console.error('[heartbeat] error:', err);
        },
      });
      // Guard against a stop() racing with an in-flight request.
      if (stopped) return;
      if (resp?.status === 'force_upgrade') {
        // Activate the lockout first so the UI is guarded before any callback
        // side effects run.
        lockout.activate();
        opts.onForceUpgrade(resp);
      }
    } finally {
      if (activeController === controller) activeController = null;
      inFlight = false;
    }
  }

  // First fire is after one full interval (no immediate fire); this keeps the
  // cadence a clean "every N ms" and avoids a burst at startup.
  timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      activeController?.abort();
      activeController = null;
    },
  };
}
