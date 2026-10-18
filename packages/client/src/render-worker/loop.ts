// ============================================================
// Client render-worker poll loop.
// ============================================================
//
// The worker owns up to `slots` claimed jobs (default 1) — one per independent
// poll/execution slot — so queued render jobs (e.g. several episodes' chains)
// run in parallel on one machine. A per-claim token fences every mutation,
// periodic progress calls renew the server lease, and terminal reports remain
// pending in memory until the server acknowledges them.

import type { RenderJob, RenderJobProgress, RenderJobResult } from '@dramaforge/shared';
import { executeJob } from './executor';
import type { Orchestrators } from './executor';
import type { createLogger } from '../ops/logger';
import * as ffmpeg from '../ffmpeg';

export type RenderWorkerLogger = ReturnType<typeof createLogger>;

export interface StartRenderWorkerOptions {
  apiBase: string;
  machineId: string;
  logger: RenderWorkerLogger;
  orchestrators?: Orchestrators;
  /** Poll interval in ms. Default 5000. */
  pollMs?: number;
  /**
   * Number of independent poll/execution slots. Each slot claims and runs its
   * own job, so N slots = up to N concurrent render jobs on this machine.
   * The server hard-caps per-user active claims at users."maxConcurrent"
   * (via /api/render/jobs/next), so slots beyond the cap simply idle on 204.
   * Default 1 (historical single-slot behavior). Clamped to 1..16.
   */
  slots?: number;
  /** Deadline applied to every /next and report request. Default 15000. */
  requestTimeoutMs?: number;
  /** Lease-renewal cadence while a job is executing. Default 30000. */
  heartbeatMs?: number;
  /** Maximum time stop() drains the active tick. Default 5000. */
  drainTimeoutMs?: number;
  /** Optional Cookie header value for auth (e.g. NextAuth session cookie). */
  authCookie?: string;
  /** Local directory where CONCAT persists the final film. */
  filmsDir: string;
  /** Packaged preset-voice directory for Seedance reference_audio. */
  voicesDir?: string;
  /** Builds the sf-asset:// URL for a client-local film. */
  toAssetUrl: (key: string) => string;
}

export interface RenderWorkerHandle {
  /** Stop new polling and drain the current tick up to the configured limit. */
  stop: (timeoutMs?: number) => Promise<void>;
}

type ClaimedRenderJob = RenderJob;

/** 单槽执行态：一个槽同时最多持有 1 个已认领 job。 */
interface RenderSlot {
  index: number;
  /** 本槽在飞 tick（单飞护栏）。 */
  tick: Promise<void> | null;
  /** 本槽待确认的已认领 job（启动确认重试所有权）。 */
  pendingStart: PendingStart | null;
  /** 本槽待投递的终态报告（重试所有权）。 */
  pendingReport: PendingTerminalReport | null;
  /** 本槽当前执行的 AbortController（stop 排空超时中止用）。 */
  executionController: AbortController | null;
  /** 本槽当前执行的心跳定时器。 */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

type PostOutcome =
  | { kind: 'ok' }
  | { kind: 'retryable'; status?: number; error?: string }
  | { kind: 'discard'; status: number };

interface PendingTerminalReport {
  jobId: string;
  claimToken: string;
  kind: 'result' | 'failed';
  body: RenderJobResult | { error: string; logSnippet: string };
  executionError?: string;
}

interface PendingStart {
  job: ClaimedRenderJob;
  claimToken: string;
}

interface AbortableRequest {
  abort: () => void;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const LOG_SNIPPET_MAX_LINES = 50;
const NEXT_PATH = '/api/render/jobs/next';

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function isRetryableStatus(status: number): boolean {
  // Only definitive client errors release local ownership. Redirect-like or
  // otherwise unusual non-ok responses are treated conservatively as retryable.
  // A 401 can recover when Electron's cookie refresher observes a renewed login;
  // 403/409 instead mean this user/claim is definitively not authorised.
  return (
    status >= 500 ||
    status < 400 ||
    status === 401 ||
    status === 408 ||
    status === 429
  );
}

export function startRenderWorker(opts: StartRenderWorkerOptions): RenderWorkerHandle {
  const pollMs = positiveMs(opts.pollMs, DEFAULT_POLL_MS);
  const requestTimeoutMs = positiveMs(
    opts.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const heartbeatMs = positiveMs(opts.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const defaultDrainTimeoutMs = positiveMs(
    opts.drainTimeoutMs,
    DEFAULT_DRAIN_TIMEOUT_MS,
  );
  // 槽位数归一化 1..16；服务端 /next 的 per-user 上限（users."maxConcurrent"）
  // 才是真上限，超出的槽只是空轮询（204）。
  const slotCount = Math.min(16, Math.max(1, Math.floor(positiveNumber(opts.slots, 1))));
  const baseLogger = opts.logger;

  const recentLines: string[] = [];
  function capture(level: string, msg: string, ctx?: Record<string, unknown>): void {
    const ctxStr = ctx && Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : '';
    recentLines.push(`[${level}] ${msg}${ctxStr}`);
    while (recentLines.length > LOG_SNIPPET_MAX_LINES) recentLines.shift();
  }

  const logger: RenderWorkerLogger = {
    info: (message, context) => {
      baseLogger.info(message, context);
      capture('info', message, context);
    },
    warn: (message, context) => {
      baseLogger.warn(message, context);
      capture('warn', message, context);
    },
    error: (message, context) => {
      baseLogger.error(message, context);
      capture('error', message, context);
    },
    flush: (taskId) => baseLogger.flush(taskId),
  };

  let stopped = false;
  let drainTimedOut = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopPromise: Promise<void> | null = null;
  const activeRequests = new Set<AbortableRequest>();

  // 每槽独立执行态；共享态只有上面的 stopped/drainTimedOut/timer/stopPromise/
  // activeRequests（activeRequests 本就是 Set，stop 遍历已支持 N）。
  const slots: RenderSlot[] = Array.from({ length: slotCount }, (_, index) => ({
    index,
    tick: null,
    pendingStart: null,
    pendingReport: null,
    executionController: null,
    heartbeatTimer: null,
  }));

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (opts.authCookie) headers.Cookie = opts.authCookie;
    return headers;
  }

  /**
   * Fetch with a hard deadline. The explicit race also protects tests/custom
   * fetch implementations that fail to settle when AbortSignal is aborted.
   */
  async function fetchWithTimeout<T = Response>(
    url: string,
    init: RequestInit = {},
    readResponse?: (response: Response) => Promise<T> | T,
  ): Promise<T> {
    const controller = new AbortController();
    let rejectExternalAbort!: (error: Error) => void;
    let rejectDeadline!: (error: Error) => void;
    const externalAbort = new Promise<never>((_resolve, reject) => {
      rejectExternalAbort = reject;
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const request: AbortableRequest = {
      abort: () => {
        controller.abort();
        rejectExternalAbort(new Error('request aborted during render-worker shutdown'));
      },
    };
    activeRequests.add(request);
    const timeout = setTimeout(() => {
      controller.abort();
      rejectDeadline(new Error(`request timed out after ${requestTimeoutMs}ms`));
    }, requestTimeoutMs);

    try {
      const requestPromise = globalThis
        .fetch(url, { ...init, signal: controller.signal })
        .then((response) =>
          readResponse
            ? readResponse(response)
            : (response as unknown as T),
        );
      return await Promise.race([
        requestPromise,
        deadline,
        externalAbort,
      ]);
    } finally {
      clearTimeout(timeout);
      activeRequests.delete(request);
    }
  }

  async function postJson(
    url: string,
    body: unknown,
    claimToken: string,
  ): Promise<PostOutcome> {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-machine-id': opts.machineId,
          'x-claim-token': claimToken,
          ...authHeaders(),
        },
        body: JSON.stringify(body),
      });
      if (response.ok) return { kind: 'ok' };

      logger.warn('post failed', { url, status: response.status });
      return isRetryableStatus(response.status)
        ? { kind: 'retryable', status: response.status }
        : { kind: 'discard', status: response.status };
    } catch (error) {
      const message = String(error);
      logger.warn('post failed', { url, error: message });
      return { kind: 'retryable', error: message };
    }
  }

  async function deliverTerminalReport(
    report: PendingTerminalReport,
    slot: RenderSlot,
  ): Promise<void> {
    const outcome = await postJson(
      `${opts.apiBase}/api/render/jobs/${report.jobId}/${report.kind}`,
      report.body,
      report.claimToken,
    );

    if (outcome.kind === 'ok') {
      if (slot.pendingReport === report) slot.pendingReport = null;
      if (report.kind === 'result') {
        logger.info('job completed', { jobId: report.jobId });
      } else {
        logger.error('job failure reported', {
          jobId: report.jobId,
          error: report.executionError,
        });
      }
      return;
    }

    if (outcome.kind === 'retryable') {
      slot.pendingReport = report;
      logger.warn('terminal report pending retry', {
        jobId: report.jobId,
        kind: report.kind,
        status: outcome.status,
        error: outcome.error,
      });
      return;
    }

    if (slot.pendingReport === report) slot.pendingReport = null;
    logger.error('terminal report rejected permanently', {
      jobId: report.jobId,
      kind: report.kind,
      status: outcome.status,
    });
  }

  async function executeClaimedJob(
    slot: RenderSlot,
    job: ClaimedRenderJob,
    claimToken: string,
  ): Promise<void> {
    let heartbeatPromise: Promise<void> | null = null;
    let leaseLost = false;
    const executionController = new AbortController();
    slot.executionController = executionController;

    // 编排器（chainCompile）按阶段/组上报的实时进度；renewLease 心跳也带上最新值，
    // 避免心跳把真实进度冲回 0/'running'（原心跳恒发 {0,'running'} 是 GAP1 根因）。
    let latestProgress = 0;
    let latestStage = 'running';

    const handleProgressOutcome = (outcome: PostOutcome): void => {
      if (outcome.kind !== 'discard') return;
      // 403/409 等确定性拒绝说明服务端已取消任务或租约所有权已转移。
      // 先立起本地所有权屏障，再中断下游，避免晚到的执行结果污染新状态。
      leaseLost = true;
      executionController.abort(
        new Error(`render job lease rejected with HTTP ${outcome.status}`),
      );
      logger.warn('job lease rejected; cancelling local execution', {
        jobId: job.id,
        status: outcome.status,
      });
    };

    // POST /progress（markRunning + 发 SSE）；discard 由 handleProgressOutcome 兜底中断执行。
    // reportProgress 与 renewLease 共用，避免两路进度上报的 discard 处理分叉。
    const sendProgress = (
      progress: number,
      stage: string,
      groupClip?: { shotIds: string[]; videoUrl: string },
    ): Promise<void> =>
      postJson(
        `${opts.apiBase}/api/render/jobs/${job.id}/progress`,
        // groupClip 仅在某组视频落盘时随本次进度带上;心跳 renewLease 不传 → 不复带。
        { progress, stage, ...(groupClip ? { groupClip } : {}) } satisfies RenderJobProgress,
        claimToken,
      ).then(handleProgressOutcome);

    // 编排器实时进度回调：更新最新值 + fire-and-forget 上报（不阻断编排，对齐 app1）。
    const reportProgress = (
      progress: number,
      stage: string,
      groupClip?: { shotIds: string[]; videoUrl: string },
    ): void => {
      latestProgress = progress;
      latestStage = stage;
      // groupClip 是一次性事件(某组视频已落本地),不存进 latest —— 心跳 renewLease 只复带
      // latestProgress/latestStage,不会把同一 groupClip 反复推给前端。
      void sendProgress(progress, stage, groupClip).catch(() => undefined);
    };

    const renewLease = (): void => {
      if (stopped || heartbeatPromise !== null) return;
      const renewal = sendProgress(latestProgress, latestStage).finally(() => {
        if (heartbeatPromise === renewal) heartbeatPromise = null;
      });
      heartbeatPromise = renewal;
    };

    slot.heartbeatTimer = setInterval(renewLease, heartbeatMs);

    let terminal: PendingTerminalReport | null = null;
    try {
      const result = await executeJob(job, {
        ffmpeg,
        orchestrators: opts.orchestrators,
        logger,
        apiBase: opts.apiBase,
        authCookie: opts.authCookie,
        machineId: opts.machineId,
        filmsDir: opts.filmsDir,
        voicesDir: opts.voicesDir,
        toAssetUrl: opts.toAssetUrl,
        signal: executionController.signal,
        reportProgress,
      });
      if (!leaseLost) {
        terminal = {
          jobId: job.id,
          claimToken,
          kind: 'result',
          body: result,
        };
      }
    } catch (error) {
      if (!leaseLost) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        terminal = {
          jobId: job.id,
          claimToken,
          kind: 'failed',
          body: { error: errorMsg, logSnippet: recentLines.join('\n') },
          executionError: errorMsg,
        };
        logger.error('job failed', { jobId: job.id, error: errorMsg });
      }
    } finally {
      if (slot.heartbeatTimer !== null) {
        clearInterval(slot.heartbeatTimer);
        slot.heartbeatTimer = null;
      }
      if (heartbeatPromise !== null) await heartbeatPromise;
      if (slot.executionController === executionController) {
        slot.executionController = null;
      }
    }

    // A bounded shutdown may have returned while an uninterruptible ffmpeg
    // process was still running. At that point the worker is abandoned and
    // must not emit network traffic after stop() has resolved.
    if (drainTimedOut || leaseLost || terminal === null) return;
    await deliverTerminalReport(terminal, slot);
  }

  async function startPendingJob(slot: RenderSlot, start: PendingStart): Promise<void> {
    const outcome = await postJson(
      `${opts.apiBase}/api/render/jobs/${start.job.id}/progress`,
      { progress: 0, stage: 'started' } satisfies RenderJobProgress,
      start.claimToken,
    );

    if (outcome.kind === 'retryable') {
      slot.pendingStart = start;
      logger.warn('job start pending retry', { jobId: start.job.id });
      return;
    }

    slot.pendingStart = null;
    if (outcome.kind === 'discard') {
      logger.error('job start rejected permanently', {
        jobId: start.job.id,
        status: outcome.status,
      });
      return;
    }

    // stop() may race the progress response. Acknowledging the lease is not
    // permission to launch a new ffmpeg process after shutdown has begun.
    if (stopped) return;
    await executeClaimedJob(slot, start.job, start.claimToken);
  }

  async function tick(slot: RenderSlot): Promise<void> {
    if (stopped) return;

    // A terminal report is a local ownership barrier: retry it first and do
    // not ask the server for another job in the same tick.
    if (slot.pendingReport !== null) {
      await deliverTerminalReport(slot.pendingReport, slot);
      return;
    }

    // Likewise, a failed/lost started acknowledgement retains ownership of
    // the exact claim. Retry it before /next and execute that job only once.
    if (slot.pendingStart !== null) {
      await startPendingJob(slot, slot.pendingStart);
      return;
    }

    const nextUrl = `${opts.apiBase}${NEXT_PATH}?machineId=${encodeURIComponent(opts.machineId)}`;
    let job: ClaimedRenderJob;
    try {
      const next = await fetchWithTimeout(
        nextUrl,
        { headers: authHeaders() },
        async (response) => {
          if (response.status === 204) return { kind: 'empty' as const };
          if (!response.ok) {
            return { kind: 'error' as const, status: response.status };
          }
          const body = (await response.json()) as { job: ClaimedRenderJob };
          return { kind: 'job' as const, job: body.job };
        },
      );
      if (stopped || drainTimedOut) return;
      if (next.kind === 'empty') return;
      if (next.kind === 'error') {
        logger.warn('non-ok response from /next', { status: next.status });
        return;
      }
      job = next.job;
    } catch (error) {
      logger.error('poll error', { error: String(error) });
      return;
    }

    const claimToken = job.claimToken;
    if (typeof claimToken !== 'string' || claimToken.length === 0) {
      logger.error('claimed job missing claim token', { jobId: job.id });
      return;
    }

    logger.info('claimed job', { jobId: job.id, type: job.type });
    const start = { job, claimToken };
    slot.pendingStart = start;
    await startPendingJob(slot, start);
  }

  function launchSlotTick(slot: RenderSlot): void {
    if (stopped || slot.tick !== null) return;
    const running = tick(slot)
      .catch((error) => {
        logger.error('render-worker tick failed', {
          slot: slot.index,
          error: String(error),
        });
      })
      .finally(() => {
        if (slot.tick === running) slot.tick = null;
      });
    slot.tick = running;
  }

  // 一个共享 timer 驱动所有槽；每槽单飞（slot.tick），互不阻塞。
  timer = setInterval(() => {
    for (const slot of slots) launchSlotTick(slot);
  }, pollMs);

  return {
    stop: (timeoutOverride?: number): Promise<void> => {
      if (stopPromise !== null) return stopPromise;

      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      for (const slot of slots) {
        if (slot.heartbeatTimer !== null) {
          clearInterval(slot.heartbeatTimer);
          slot.heartbeatTimer = null;
        }
      }

      const ticksToDrain = slots
        .map((s) => s.tick)
        .filter((p): p is Promise<void> => p !== null);
      if (ticksToDrain.length === 0 && slots.every((s) => s.pendingReport === null)) {
        stopPromise = Promise.resolve();
        return stopPromise;
      }

      const drainTimeoutMs = positiveMs(timeoutOverride, defaultDrainTimeoutMs);
      stopPromise = (async () => {
        let drainTimer: ReturnType<typeof setTimeout> | null = null;
        let retryDelayTimer: ReturnType<typeof setTimeout> | null = null;
        const drainWork = async (): Promise<void> => {
          // 等所有槽的在飞 tick 收敛（每槽 tick 结束会先冲自己的终态报告）。
          await Promise.allSettled(ticksToDrain);

          // Ticks may have just persisted retryable terminal reports. Flush
          // every slot's report while Electron still grants us the bounded
          // drain window, with the same per-report backoff. 注意：投递成功
          // （pendingReport 已被清空）后立即退出循环、不再等 backoff ——
          // 否则排空窗口被无谓的 250ms 拉长。
          while (!drainTimedOut) {
            const slot = slots.find((s) => s.pendingReport !== null);
            if (slot === undefined || slot.pendingReport === null) break;
            const report = slot.pendingReport;
            await deliverTerminalReport(report, slot);
            if (drainTimedOut) break;
            if (slot.pendingReport === null) continue;
            await new Promise<void>((resolve) => {
              retryDelayTimer = setTimeout(resolve, Math.min(pollMs, 250));
            });
            retryDelayTimer = null;
          }
        };
        const drained = await Promise.race([
          drainWork().then(() => true),
          new Promise<boolean>((resolve) => {
            drainTimer = setTimeout(() => resolve(false), drainTimeoutMs);
          }),
        ]);
        if (drainTimer !== null) clearTimeout(drainTimer);

        if (!drained) {
          drainTimedOut = true;
          if (retryDelayTimer !== null) clearTimeout(retryDelayTimer);
          logger.warn('render-worker drain timed out', { timeoutMs: drainTimeoutMs });
          // Electron 已结束排空窗口时终止本地子流程，避免 FFmpeg 在后台继续占用资源。
          for (const slot of slots) {
            slot.executionController?.abort(
              new Error('render-worker drain timed out'),
            );
          }
          for (const request of activeRequests) request.abort();
        }
      })();
      return stopPromise;
    },
  };
}
