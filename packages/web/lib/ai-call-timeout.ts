// ============================================================
// web/lib/ai-call-timeout — callAI 超时守卫（B2 防挂死）
// ============================================================
//
// 文件职责：
//   callAIWithTimeout(opts) — 给任意 callAI 调用 Promise.race 加超时；超时抛
//   AiCallTimeoutError。不依赖 callAI 是否原生支持 AbortSignal（对现状最稳）。
//
// 来源：spec §B2「callAI 外包 AbortController（timeout，文本类建议 6min，>单次
// DeepSeek 典型时长 +余量；挂死即 abort → 走失败路径）」。
//
// 设计要点：
//   - 用 Promise.race(call, timeoutPromise) 实现；timeoutPromise 内部 setTimeout
//     reject AiCallTimeoutError。
//   - finally 清 timer 防 leak（call 先 resolve 时 timeout 定时器仍在跑）。
//   - 不主动 abort callAI 的底层 fetch——callAI 当前签名不带 signal，强加会改契约；
//     race 完胜出即返回/抛，底层 promise 继续运行至自然终态（无人 await，GC 回收）。
//     这足够达成「调用挂死 → 路径不卡 → 走 fail 分支」的目标。
//
// web 禁止 import 任何 ffmpeg 模块；本模块为纯工具。
// ============================================================

/**
 * AI 调用超时错误。
 *
 * 调用方按 instanceof 识别后走失败路径（failInlineAiTask + stageStatus 复位 + 不扣费）。
 * 携带 timeoutMs 便于日志/审计。
 */
export class AiCallTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`AI 调用超时（${timeoutMs}ms）`);
    this.name = 'AiCallTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 给任意 callAI 调用加超时。
 *
 * @param opts.call    返回 Promise 的 AI 调用（无参闭包，调用方负责绑定参数）
 * @param opts.timeoutMs 超时毫秒数；超时抛 AiCallTimeoutError
 * @returns call 的 resolve 值
 * @throws AiCallTimeoutError 超时；或 call 自身 reject 的任何错误（GatewayError 等）
 */
export async function callAIWithTimeout<T>(opts: {
  call: () => Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AiCallTimeoutError(opts.timeoutMs)),
      opts.timeoutMs,
    );
  });
  try {
    return await Promise.race([opts.call(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
