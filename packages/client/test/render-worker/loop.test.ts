// Unit tests for ⑨ render-worker poll loop.
//
// Mocks the ffmpeg module and the uploader module (via vi.mock) so the real
// executeJob runs against no-op spies — "executes (mocked)" and "uploads
// (mocked)" are then assertable as distinct calls. Mocks global `fetch` to
// drive the HTTP sequence (204 → 200 job → progress/result/failed POSTs) and
// uses fake timers to step the poll interval.
//
// Covers:
//   - polls /next, claims job (200), posts /progress, executes, uploads, posts /result
//   - job failure (executeJob throws) → posts /failed, loop keeps polling
//   - stop() cancels further polling

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RenderJob } from '@dramaforge/shared';
import { startRenderWorker } from '../../src/render-worker/loop';

// Mock ffmpeg so executeJob's ffmpeg calls are no-op vi.fn spies. The factory
// is self-contained (vi.mock is hoisted; no outer refs allowed).
vi.mock('../../src/ffmpeg', () => ({
  execFfmpegConcat: vi.fn().mockResolvedValue(undefined),
  extractLastFrame: vi.fn().mockResolvedValue(undefined),
  splitVideoByDuration: vi.fn().mockResolvedValue(['/tmp/seg-000.mp4']),
  splitVideoEvenly: vi.fn().mockResolvedValue(['/tmp/seg-000.mp4']),
  getVideoDuration: vi.fn().mockResolvedValue(10),
  downloadClips: vi.fn().mockResolvedValue([]),
  gridOverlay: vi.fn().mockResolvedValue(undefined),
  getFfmpegPath: vi.fn().mockReturnValue('/usr/bin/ffmpeg'),
  resolveStorageUrl: vi.fn((s: string) => s),
}));

// Mock the uploader so uploadArtifact is a no-op spy (executeJob imports it).
vi.mock('../../src/render-worker/uploader', () => ({
  uploadArtifact: vi.fn().mockResolvedValue(undefined),
}));

// CONCAT persists to disk in production. Keep this loop test deterministic by
// replacing that filesystem boundary; executor-specific persistence is covered
// in executor.test.ts.
vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

import { execFfmpegConcat } from '../../src/ffmpeg';
import { uploadArtifact } from '../../src/render-worker/uploader';
import path from 'node:path';
import os from 'node:os';

/** Films dir + sf-asset:// builder injected into opts for P5 client-local CONCAT. */
const TEST_FILMS_DIR = path.join(os.tmpdir(), 'sf-loop-films-test');
const testToAssetUrl = (key: string): string => `sf-asset://${key}`;

const originalFetch = globalThis.fetch;

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
};

function makeConcatJob(): RenderJob {
  return {
    id: 'job_1',
    taskId: 'task_1',
    userId: 'user_1',
    type: 'CONCAT',
    status: 'CLAIMED',
    input: {
      clips: [{ url: 'https://a.mp4' }, { url: 'https://b.mp4' }],
      outputUploadUrl: 'https://upload/out.mp4',
    },
    result: null,
    claimedBy: 'm1',
    error: null,
    createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
    completedAt: null,
    // The server issues a per-claim fencing token. Cast keeps this test source
    // compatible while the shared contract lands in parallel.
    claimToken: 'claim-token-1',
    heartbeatAt: new Date().toISOString(),
  } as RenderJob;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function emptyResponse(status = 204): Response {
  return jsonResponse(undefined, status);
}

function findCall(
  calls: [unknown, unknown][],
  needle: string,
): [string, RequestInit] | undefined {
  return calls.find((c) => String(c[0]).includes(needle)) as
    | [string, RequestInit]
    | undefined;
}

/**
 * Advance fake time by `ms` (firing the poll interval) and DRAIN the microtask
 * queue thoroughly afterwards. A single `advanceTimersByTimeAsync` flush can
 * leave tail continuations of the tick() async chain pending — the chain is
 * long (fetch /next → res.json → /progress POST → executeJob → /result|/failed
 * POST, each an `await` hop), so we explicitly run all ticks until the queue is
 * stable. Without this the /result (or /failed) POST is intermittently not yet
 * issued when the assertion runs.
 */
async function tickMs(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  // undici's Response body consumption (res.json() / the fetch mock's async
  // wrapper) schedules macrotasks (setTimeout) that the microtask flush inside
  // advanceTimersByTimeAsync does NOT fire. The tick() chain has several such
  // hops (fetch /next → res.json → /progress POST → executeJob → /result POST),
  // so we nudge the clock forward in 1ms steps to fire those macrotasks and
  // drain their microtasks. 1ms steps stay well clear of the next 5000ms
  // interval, so no extra poll fires.
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

/** Fully settle teardown even when a test intentionally leaves a report pending. */
async function stopWorker(handle: { stop: (timeoutMs?: number) => Promise<void> }): Promise<void> {
  const stopping = handle.stop(10);
  await vi.advanceTimersByTimeAsync(10);
  await stopping;
}

describe('startRenderWorker', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    vi.mocked(execFfmpegConcat).mockClear();
    vi.mocked(execFfmpegConcat).mockResolvedValue(undefined);
    vi.mocked(uploadArtifact).mockClear();
    vi.mocked(uploadArtifact).mockResolvedValue(undefined);
  });

  it('times out a hung /next request and polls again', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 500,
      requestTimeoutMs: 100,
      drainTimeoutMs: 100,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(1_100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await stopWorker(handle);
  });

  it('times out a hung /next response body and polls again', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => {}),
      } as Response),
    );

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 500,
      requestTimeoutMs: 100,
      drainTimeoutMs: 100,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(1_100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execFfmpegConcat).not.toHaveBeenCalled();
    await stopWorker(handle);
  });

  it('emits no progress when a /next body resolves after stop has drained', async () => {
    const job = makeConcatJob();
    let resolveBody!: (body: { job: RenderJob }) => void;
    const body = new Promise<{ job: RenderJob }>((resolve) => {
      resolveBody = resolve;
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => body,
    } as Response);

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 500,
      requestTimeoutMs: 10_000,
      drainTimeoutMs: 50,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stopping = handle.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopping;

    resolveBody({ job });
    await tickMs(0);

    expect(findCall(fetchMock.mock.calls, '/progress')).toBeUndefined();
    expect(execFfmpegConcat).not.toHaveBeenCalled();
  });

  it('times out a hung progress POST and retries the exact claim without executing', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    let progressCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        return Promise.resolve(
          nextCalls === 1 ? jsonResponse({ job }, 200) : emptyResponse(),
        );
      }
      if (u.includes('/progress')) {
        progressCalls++;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 500,
      requestTimeoutMs: 100,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(1_100);

    expect(nextCalls).toBe(1);
    expect(progressCalls).toBe(2);
    expect(execFfmpegConcat).not.toHaveBeenCalled();
    await stopWorker(handle);
  });

  it('renews the lease while ffmpeg runs without overlapping heartbeat requests', async () => {
    const job = makeConcatJob();
    let finishFfmpeg!: () => void;
    const ffmpegFinished = new Promise<void>((resolve) => {
      finishFfmpeg = resolve;
    });
    let finishFirstHeartbeat!: () => void;
    const firstHeartbeatFinished = new Promise<Response>((resolve) => {
      finishFirstHeartbeat = () => resolve(jsonResponse({}, 200));
    });
    let runningProgressCalls = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) return jsonResponse({ job }, 200);
      if (u.includes('/progress')) {
        const stage = JSON.parse(String(init?.body)).stage as string;
        if (stage === 'running') {
          runningProgressCalls++;
          if (runningProgressCalls === 1) return firstHeartbeatFinished;
        }
      }
      return jsonResponse({}, 200);
    });
    vi.mocked(execFfmpegConcat).mockReturnValueOnce(ffmpegFinished);

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      heartbeatMs: 100,
      requestTimeoutMs: 1_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    await tickMs(350);
    expect(runningProgressCalls).toBe(1);

    finishFirstHeartbeat();
    await tickMs(100);
    expect(runningProgressCalls).toBeGreaterThanOrEqual(2);

    for (const call of fetchMock.mock.calls as [string, RequestInit][]) {
      if (!String(call[0]).includes('/progress')) continue;
      expect((call[1].headers as Record<string, string>)['x-claim-token']).toBe(
        'claim-token-1',
      );
    }

    finishFfmpeg();
    await tickMs(0);
    await stopWorker(handle);
  });

  it('lease 心跳被 409 拒绝后终止本地执行，且不再上报结果或失败', async () => {
    const job = makeConcatJob();
    let finishFfmpeg!: () => void;
    const ffmpegFinished = new Promise<void>((resolve) => {
      finishFfmpeg = resolve;
    });
    let runningProgressCalls = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) return jsonResponse({ job }, 200);
      if (u.includes('/progress')) {
        const stage = JSON.parse(String(init?.body)).stage as string;
        if (stage === 'running') {
          runningProgressCalls++;
          // 409 表示服务端已取消任务或租约所有权已经转移。
          return jsonResponse({}, 409);
        }
      }
      return jsonResponse({}, 200);
    });
    vi.mocked(execFfmpegConcat).mockReturnValueOnce(ffmpegFinished);

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      heartbeatMs: 100,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    await tickMs(100);
    expect(runningProgressCalls).toBe(1);

    // 即使某个旧式依赖没有及时响应 AbortSignal、最终自行返回，失去租约的
    // worker 也绝不能把结果或失败写回已经取消的任务。
    finishFfmpeg();
    await tickMs(0);

    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/result')).toBeUndefined();
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/failed')).toBeUndefined();
    await stopWorker(handle);
  });

  it('does not execute a claimed job that has no claim token', async () => {
    const job = { ...makeConcatJob(), claimToken: null } as RenderJob;
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/render/jobs/next')
        ? jsonResponse({ job }, 200)
        : jsonResponse({}, 200),
    );

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);

    expect(execFfmpegConcat).not.toHaveBeenCalled();
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/progress')).toBeUndefined();
    await stopWorker(handle);
  });

  it('retries a 503 terminal report before polling and never executes the job twice', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    let resultCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        return jsonResponse({ job }, 200);
      }
      if (u.includes('/result')) {
        resultCalls++;
        return jsonResponse({}, resultCalls === 1 ? 503 : 200);
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    expect(resultCalls).toBe(1);

    await tickMs(5_000);
    expect(resultCalls).toBe(2);
    expect(nextCalls).toBe(1);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);

    const resultRequests = (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) =>
      String(url).includes('/result'),
    );
    for (const [, init] of resultRequests) {
      expect((init.headers as Record<string, string>)['x-claim-token']).toBe(
        'claim-token-1',
      );
    }
    await stopWorker(handle);
  });

  it('retains a terminal report across 401 and retries it with the refreshed cookie', async () => {
    const job = makeConcatJob();
    let authCookie = 'session=valid';
    let nextCalls = 0;
    const resultCookies: Array<string | undefined> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        return jsonResponse({ job }, 200);
      }
      if (u.includes('/progress')) {
        // The claim started while authenticated, then the session expired
        // before the expensive render result was reported.
        authCookie = 'session=expired';
        return jsonResponse({}, 200);
      }
      if (u.includes('/result')) {
        const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
        resultCookies.push(cookie);
        return jsonResponse({}, cookie === 'session=refreshed' ? 200 : 401);
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      get authCookie(): string {
        return authCookie;
      },
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    expect(resultCookies).toEqual(['session=expired']);

    authCookie = 'session=refreshed';
    await tickMs(5_000);

    expect(resultCookies).toEqual(['session=expired', 'session=refreshed']);
    expect(nextCalls).toBe(1);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);
    await stopWorker(handle);
  });

  it('drains a terminal report that becomes pending during stop', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    let resultCalls = 0;
    let finishFirstResult!: () => void;
    const firstResult = new Promise<Response>((resolve) => {
      finishFirstResult = () => resolve(jsonResponse({}, 503));
    });
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        return jsonResponse({ job }, 200);
      }
      if (u.includes('/result')) {
        resultCalls++;
        return resultCalls === 1 ? firstResult : jsonResponse({}, 200);
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      drainTimeoutMs: 1_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    expect(resultCalls).toBe(1);
    const stopping = handle.stop();
    finishFirstResult();
    await tickMs(0);
    await stopping;

    expect(resultCalls).toBe(2);
    expect(nextCalls).toBe(1);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);
  });

  it.each([403, 409])(
    'discards a definitive %i terminal rejection and polls on the next tick',
    async (status) => {
      const job = makeConcatJob();
      let nextCalls = 0;
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/render/jobs/next')) {
          nextCalls++;
          return nextCalls === 1 ? jsonResponse({ job }, 200) : emptyResponse();
        }
        if (u.includes('/result')) return jsonResponse({}, status);
        return jsonResponse({}, 200);
      });

      const handle = startRenderWorker({
        apiBase: 'https://api.example.com',
        machineId: 'm1',
        logger: noopLogger,
        pollMs: 5_000,
        filmsDir: TEST_FILMS_DIR,
        toAssetUrl: testToAssetUrl,
      });

      await tickMs(5_000);
      await tickMs(5_000);

      expect(nextCalls).toBe(2);
      expect(execFfmpegConcat).toHaveBeenCalledTimes(1);
      await stopWorker(handle);
    },
  );

  it('does not start ffmpeg when stop is requested after progress', async () => {
    const job = makeConcatJob();
    let finishProgress!: () => void;
    const progressFinished = new Promise<Response>((resolve) => {
      finishProgress = () => resolve(jsonResponse({}, 200));
    });
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) return jsonResponse({ job }, 200);
      if (u.includes('/progress')) return progressFinished;
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      drainTimeoutMs: 1_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    const stopped = handle.stop();
    finishProgress();
    await tickMs(0);
    await stopped;

    expect(execFfmpegConcat).not.toHaveBeenCalled();
  });

  it('bounds stop while ffmpeg is stuck and emits no report after the drain expires', async () => {
    const job = makeConcatJob();
    let finishFfmpeg!: () => void;
    const ffmpegFinished = new Promise<void>((resolve) => {
      finishFfmpeg = resolve;
    });
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/render/jobs/next')
        ? jsonResponse({ job }, 200)
        : jsonResponse({}, 200),
    );
    vi.mocked(execFfmpegConcat).mockReturnValueOnce(ffmpegFinished);

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      drainTimeoutMs: 100,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    let stopSettled = false;
    const stopping = handle.stop().then(() => {
      stopSettled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(stopSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopSettled).toBe(true);

    finishFfmpeg();
    await tickMs(0);
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/result')).toBeUndefined();
  });

  it('slots:1 不重入 — ffmpeg 未跑完前不认领新 job（历史单槽行为）', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    let finishFfmpeg!: () => void;
    const ffmpegFinished = new Promise<void>((resolve) => {
      finishFfmpeg = resolve;
    });

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/render/jobs/next')) {
        nextCalls++;
        return jsonResponse({ job }, 200);
      }
      return jsonResponse({}, 200);
    });
    vi.mocked(execFfmpegConcat).mockReturnValueOnce(ffmpegFinished);

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      slots: 1,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    expect(nextCalls).toBe(1);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);

    // Three more poll intervals elapse while ffmpeg is still running. The
    // single slot must not claim another job until this one has fully settled.
    await tickMs(15_000);
    expect(nextCalls).toBe(1);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);

    finishFfmpeg();
    await tickMs(0);

    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/result')).toBeDefined();
    await stopWorker(handle);
  });

  it('slots:2 并行 — 第一个 job 还在跑时第二个槽认领并执行新 job', async () => {
    let nextCalls = 0;
    let finishFfmpegA!: () => void;
    let finishFfmpegB!: () => void;
    const ffmpegA = new Promise<void>((resolve) => {
      finishFfmpegA = resolve;
    });
    const ffmpegB = new Promise<void>((resolve) => {
      finishFfmpegB = resolve;
    });

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/render/jobs/next')) {
        nextCalls++;
        return jsonResponse({ job: makeConcatJob() }, 200);
      }
      return jsonResponse({}, 200);
    });
    vi.mocked(execFfmpegConcat)
      .mockReturnValueOnce(ffmpegA)
      .mockReturnValueOnce(ffmpegB);

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      slots: 2,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    // 一个间隔：两个槽各认领一个 job 并开始执行（两个 ffmpeg 在飞）。
    await tickMs(5_000);
    expect(nextCalls).toBe(2);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(2);

    // 两个都在跑：下一间隔不再认领。
    await tickMs(5_000);
    expect(nextCalls).toBe(2);

    finishFfmpegA();
    finishFfmpegB();
    await tickMs(0);

    const resultCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/result'),
    );
    expect(resultCalls.length).toBe(2);
    await stopWorker(handle);
  });

  it('slots:2 一槽卡死不阻塞另一槽继续认领', async () => {
    let nextCalls = 0;
    const neverFfmpeg = new Promise<void>(() => {}); // 槽 A 的 ffmpeg 永不结束

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/render/jobs/next')) {
        nextCalls++;
        return jsonResponse({ job: makeConcatJob() }, 200);
      }
      return jsonResponse({}, 200);
    });
    vi.mocked(execFfmpegConcat)
      .mockReturnValueOnce(neverFfmpeg)
      .mockReturnValueOnce(neverFfmpeg);

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      slots: 2,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    // 槽 A 卡在 ffmpeg，槽 B 仍能在后续间隔认领自己的 job。
    await tickMs(5_000);
    expect(nextCalls).toBe(2);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(2);
    await stopWorker(handle);
  });

  it('stop() 两个在飞执行都在排空超时被中止、不发出终态报告', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/render/jobs/next')) {
        return jsonResponse({ job: makeConcatJob() }, 200);
      }
      return jsonResponse({}, 200);
    });
    vi.mocked(execFfmpegConcat).mockReturnValue(new Promise<void>(() => {}));

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      slots: 2,
      drainTimeoutMs: 50,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(2);

    const stopping = handle.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopping;
    await tickMs(0);

    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/result')).toBeUndefined();
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/failed')).toBeUndefined();
  });

  it('slots 归一化：0 → 1（保持单槽行为）', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/render/jobs/next')) {
        nextCalls++;
        return jsonResponse({ job }, 200);
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      slots: 0,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    expect(nextCalls).toBe(1);
    await stopWorker(handle);
  });

  it('slots 归一化：20 → 16（上限截断）', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/render/jobs/next')) {
        nextCalls++;
        return jsonResponse({ job }, 200);
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      slots: 20,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);
    expect(nextCalls).toBe(16);
    await stopWorker(handle);
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('polls, claims job, posts /progress, executes, uploads, posts /result', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        if (nextCalls === 1) return emptyResponse();
        return jsonResponse({ job }, 200);
      }
      // POST /progress, /result, /failed — all ack 200.
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    // Tick 1: poll → 204 (no jobs).
    await tickMs(5_000);
    expect(nextCalls).toBe(1);

    // Tick 2: poll → 200 (job claimed) → progress → execute → upload → result.
    await tickMs(5_000);

    expect(nextCalls).toBe(2);

    // POST /progress {progress:0, stage:'started'}
    const progressCall = findCall(fetchMock.mock.calls as [unknown, unknown][], '/progress');
    expect(progressCall).toBeDefined();
    expect(progressCall![1].method).toBe('POST');
    expect((progressCall![1].headers as Record<string, string>)['x-machine-id']).toBe('m1');
    expect((progressCall![1].headers as Record<string, string>)['x-claim-token']).toBe(
      'claim-token-1',
    );
    expect(JSON.parse(progressCall![1].body as string)).toEqual({
      progress: 0,
      stage: 'started',
    });

    // executeJob ran ffmpeg (mocked). P5: films are client-local → NO upload.
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);
    expect(uploadArtifact).not.toHaveBeenCalled();

    // POST /result with the client-local film's sf-asset:// URL + localKey.
    const resultCall = findCall(fetchMock.mock.calls as [unknown, unknown][], '/result');
    expect(resultCall).toBeDefined();
    expect((resultCall![1].headers as Record<string, string>)['x-machine-id']).toBe('m1');
    expect((resultCall![1].headers as Record<string, string>)['x-claim-token']).toBe(
      'claim-token-1',
    );
    expect(JSON.parse(resultCall![1].body as string)).toEqual({
      outputUrl: 'sf-asset://job_1.mp4',
      meta: { localKey: 'job_1.mp4' },
    });

    // No /failed call on success.
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/failed')).toBeUndefined();

    await stopWorker(handle);
  });

  it('retries a 503 start acknowledgement without polling and then executes once', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    let progressCalls = 0;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => {}),
    };

    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({ job }, 200)
          : emptyResponse();
      }
      if (u.includes('/progress')) {
        progressCalls++;
        return jsonResponse({}, progressCalls === 1 ? 503 : 200);
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);

    expect(execFfmpegConcat).not.toHaveBeenCalled();
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/result')).toBeUndefined();
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/failed')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'post failed',
      expect.objectContaining({
        url: expect.stringContaining('/progress'),
        status: 503,
      }),
    );

    await tickMs(5_000);
    expect(nextCalls).toBe(1);
    expect(progressCalls).toBe(2);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);

    await stopWorker(handle);
  });

  it('retains the exact claim when its start acknowledgement has a network error', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    let progressCalls = 0;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => {}),
    };

    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({ job }, 200)
          : emptyResponse();
      }
      if (u.includes('/progress')) {
        progressCalls++;
        if (progressCalls === 1) throw new Error('progress network down');
        return jsonResponse({}, 200);
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);

    expect(execFfmpegConcat).not.toHaveBeenCalled();
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/result')).toBeUndefined();
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/failed')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'post failed',
      expect.objectContaining({
        url: expect.stringContaining('/progress'),
        error: 'Error: progress network down',
      }),
    );

    await tickMs(5_000);
    expect(nextCalls).toBe(1);
    expect(progressCalls).toBe(2);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);

    await stopWorker(handle);
  });

  it('does not log completion or poll while a retryable result report is pending', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => {}),
    };

    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({ job }, 200)
          : emptyResponse();
      }
      if (u.includes('/result')) return jsonResponse({}, 500);
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);

    expect(logger.info).not.toHaveBeenCalledWith('job completed', { jobId: job.id });
    expect(logger.warn).toHaveBeenCalledWith(
      'post failed',
      expect.objectContaining({
        url: expect.stringContaining('/result'),
        status: 500,
      }),
    );

    await tickMs(5_000);
    expect(nextCalls).toBe(1);

    await stopWorker(handle);
  });

  it('posts /failed when executeJob throws and keeps polling', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        if (nextCalls === 2) return jsonResponse({ job }, 200);
        return emptyResponse();
      }
      return jsonResponse({}, 200);
    });

    // The CONCAT job's executeJob calls execFfmpegConcat — make it throw.
    vi.mocked(execFfmpegConcat).mockRejectedValueOnce(new Error('ffmpeg boom'));

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    // Tick 1: 204.
    await tickMs(5_000);
    expect(nextCalls).toBe(1);

    // Tick 2: job claimed → executeJob throws → /failed posted.
    await tickMs(5_000);

    expect(nextCalls).toBe(2);
    expect(execFfmpegConcat).toHaveBeenCalledTimes(1);

    const failedCall = findCall(fetchMock.mock.calls as [unknown, unknown][], '/failed');
    expect(failedCall).toBeDefined();
    expect(failedCall![1].method).toBe('POST');
    expect((failedCall![1].headers as Record<string, string>)['x-machine-id']).toBe('m1');
    expect((failedCall![1].headers as Record<string, string>)['x-claim-token']).toBe(
      'claim-token-1',
    );
    const failedBody = JSON.parse(failedCall![1].body as string) as {
      error: string;
      logSnippet: string;
    };
    expect(failedBody.error).toBe('ffmpeg boom');
    // logSnippet is the recent in-memory log ring buffer (non-empty).
    expect(typeof failedBody.logSnippet).toBe('string');
    expect(failedBody.logSnippet.length).toBeGreaterThan(0);

    // No /result call on failure.
    expect(findCall(fetchMock.mock.calls as [unknown, unknown][], '/result')).toBeUndefined();

    // Tick 3: loop keeps polling (resilience — one failure doesn't stop it).
    await tickMs(5_000);
    expect(nextCalls).toBe(3);

    await stopWorker(handle);
  });

  it('keeps retrying a retryable failure report without polling', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(async () => {}),
    };

    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({ job }, 200)
          : emptyResponse();
      }
      if (u.includes('/failed')) return jsonResponse({}, 502);
      return jsonResponse({}, 200);
    });
    vi.mocked(execFfmpegConcat).mockRejectedValueOnce(new Error('ffmpeg boom'));

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    await tickMs(5_000);

    const failedCall = findCall(fetchMock.mock.calls as [unknown, unknown][], '/failed');
    expect(failedCall).toBeDefined();
    expect((failedCall![1].headers as Record<string, string>)['x-machine-id']).toBe('m1');
    expect(logger.warn).toHaveBeenCalledWith(
      'post failed',
      expect.objectContaining({
        url: expect.stringContaining('/failed'),
        status: 502,
      }),
    );

    await tickMs(5_000);
    expect(nextCalls).toBe(1);

    await stopWorker(handle);
  });

  it('stop() cancels further polling', async () => {
    fetchMock.mockImplementation(async () => emptyResponse());

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    // First tick fires.
    await tickMs(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await stopWorker(handle);

    // No further ticks after stop().
    await tickMs(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resilient to network errors on /next (logs and continues polling)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/render/jobs/next')) {
        throw new Error('network down');
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    // Tick 1: fetch rejects — tick swallows it (no throw).
    await tickMs(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Loop continues on the next interval despite the prior failure.
    await tickMs(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await stopWorker(handle);
  });

  it('sends the authCookie as a Cookie header when set', async () => {
    const job = makeConcatJob();
    let nextCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/render/jobs/next')) {
        nextCalls++;
        if (nextCalls === 1) return emptyResponse();
        return jsonResponse({ job }, 200);
      }
      return jsonResponse({}, 200);
    });

    const handle = startRenderWorker({
      apiBase: 'https://api.example.com',
      machineId: 'm1',
      logger: noopLogger,
      pollMs: 5_000,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
      authCookie: 'next-auth.session.token=abc123',
    });

    await tickMs(5_000); // 204
    await tickMs(5_000); // 200 + job

    // Every request carries the Cookie header.
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>).Cookie).toBe(
        'next-auth.session.token=abc123',
      );
    }

    await stopWorker(handle);
  });
});
