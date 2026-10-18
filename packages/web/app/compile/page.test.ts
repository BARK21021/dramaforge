// Unit tests for /compile flow functions.
//
// node-env 契约测试（对齐 generate/page.test.ts 风格）：mock global fetch 打
// dispatchCompile/fetchCompileStatus；matchCompileEvent 是纯函数直接断言。page.tsx 的
// EventSource + polling 订阅 UI 胶水不单测（同 /generate）。
//
// 覆盖：
//   dispatchCompile:
//     - 成功 → { ok:true, taskId, renderJobId } + body 是 FILM_EXPORT + clips[]
//     - envelope success:false → error + 透传 error/code（UNAUTHORIZED）
//     - 网络错 → error（永不 reject）
//     - 缺 taskId → error
//   matchCompileEvent:
//     - COMPLETED + outputUrl → done（sf-asset:// filmUrl）
//     - FAILED → failed（带 error / 默认 message）
//     - taskId 不匹配 → null
//     - RUNNING / connected / COMPLETED 缺 url → null（继续等）

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dispatchCompile,
  fetchCompileStatus,
  matchCompileEvent,
} from "./compile-flow";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("dispatchCompile", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs FILM_EXPORT and returns { ok:true, taskId, renderJobId } on success", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { renderJobId: "job-1", taskId: "task-1" },
      }),
    );

    const out = await dispatchCompile({
      clips: ["https://a.mp4", "https://b.mp4"],
    });

    expect(out).toEqual({ ok: true, taskId: "task-1", renderJobId: "job-1" });

    // Body shape: POST /api/render/dispatch with type=FILM_EXPORT + clips[].
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      type: string;
      input: { clips: { url: string }[] };
    };
    expect(body.type).toBe("FILM_EXPORT");
    expect(body.input.clips).toEqual([
      { url: "https://a.mp4" },
      { url: "https://b.mp4" },
    ]);
  });

  it("surfaces envelope success:false error/code (UNAUTHORIZED)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { success: false, error: "未登录或登录已过期", code: "UNAUTHORIZED" },
        401,
      ),
    );
    const out = await dispatchCompile({ clips: ["https://a.mp4"] });
    expect(out).toEqual({
      ok: false,
      message: "未登录或登录已过期",
      code: "UNAUTHORIZED",
    });
  });

  it("never rejects on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const out = await dispatchCompile({ clips: ["https://a.mp4"] });
    expect(out.ok).toBe(false);
    expect(out).toHaveProperty("message");
  });

  it("returns error when taskId missing from a success envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { renderJobId: "job-1" } }), // no taskId
    );
    const out = await dispatchCompile({ clips: ["https://a.mp4"] });
    expect(out.ok).toBe(false);
  });
});

describe("matchCompileEvent", () => {
  const taskId = "task-1";

  it("COMPLETED + outputUrl → done with the sf-asset:// filmUrl", () => {
    expect(
      matchCompileEvent(
        { taskId, status: "COMPLETED", result: { outputUrl: "sf-asset://abc.mp4" } },
        taskId,
      ),
    ).toEqual({ kind: "done", filmUrl: "sf-asset://abc.mp4" });
  });

  it("FAILED → failed with the error message", () => {
    expect(
      matchCompileEvent({ taskId, status: "FAILED", error: "ffmpeg boom" }, taskId),
    ).toEqual({ kind: "failed", message: "ffmpeg boom" });
  });

  it("FAILED without error → default message", () => {
    expect(matchCompileEvent({ taskId, status: "FAILED" }, taskId)).toEqual({
      kind: "failed",
      message: "合片失败",
    });
  });

  it("non-matching taskId → null (ignore other users' events)", () => {
    expect(
      matchCompileEvent(
        { taskId: "other", status: "COMPLETED", result: { outputUrl: "sf-asset://x" } },
        taskId,
      ),
    ).toBeNull();
  });

  it("RUNNING / connected / progress → null (keep waiting)", () => {
    expect(matchCompileEvent({ taskId, status: "RUNNING" }, taskId)).toBeNull();
    expect(matchCompileEvent({ type: "connected" }, taskId)).toBeNull();
  });

  it("COMPLETED without outputUrl → null (malformed, keep waiting)", () => {
    expect(matchCompileEvent({ taskId, status: "COMPLETED" }, taskId)).toBeNull();
  });
});

describe("fetchCompileStatus", () => {
  it("maps a persisted COMPLETED result to done", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        job: {
          status: "COMPLETED",
          result: { outputUrl: "sf-asset://job-1.mp4" },
          error: null,
        },
      }),
    );

    await expect(
      fetchCompileStatus({ renderJobId: "job/with space", fetchImpl }),
    ).resolves.toEqual({ kind: "done", filmUrl: "sf-asset://job-1.mp4" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/render/jobs/job%2Fwith%20space",
      {
        method: "GET",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("maps a persisted FAILED result to failed", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        job: { status: "FAILED", result: null, error: "ffmpeg failed" },
      }),
    );

    await expect(
      fetchCompileStatus({ renderJobId: "job-1", fetchImpl }),
    ).resolves.toEqual({ kind: "failed", message: "ffmpeg failed" });
  });

  it("returns null for non-terminal, malformed, non-2xx, and network responses", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({ job: { status: "RUNNING" } }),
      async () => new Response("not-json", { status: 200 }),
      async () => jsonResponse({ error: "not found" }, 404),
      async () => {
        throw new Error("network down");
      },
    ];

    for (const implementation of cases) {
      await expect(
        fetchCompileStatus({
          renderJobId: "job-1",
          fetchImpl: implementation as typeof fetch,
        }),
      ).resolves.toBeNull();
    }
  });

  it("settles at its deadline even when fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }) as unknown as typeof fetch;

      const pending = fetchCompileStatus({
        renderJobId: "job-1",
        fetchImpl,
        timeoutMs: 25,
      });
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toBeNull();
      expect(capturedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
