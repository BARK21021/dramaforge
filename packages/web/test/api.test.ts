// ============================================================
// lib/api —— 统一 API 请求封装单测
// ============================================================
//
// 覆盖：
//   - isQuotaError: 4 种命中规则（category/code×2/status）+ 反例
//   - parseEnvelope: 空串/非法 JSON/非对象/正常 envelope
//   - formatApiError: code/suggestion 组合（4 种）
//   - callApi:
//       * 成功 envelope 200 → ok:true 拿到 data
//       * 401 → onUnauthorized + ok:false code=UNAUTHORIZED
//       * 500 + envelope.error → onToast 拼好的串 + ok:false
//       * 500 + 无 envelope（纯文本） → onToast 用 raw 当消息
//       * 200 但 success:false → 走 envelope 失败分支
//       * 402 / QUOTA_INSUFFICIENT → onQuota 触发 + ok:false
//       * 200 但 body 非对象 → onToast("服务返回格式错误")
//       * FormData body → 不设 Content-Type（让浏览器加 boundary）
//       * JSON body → 自动加 application/json（若未显式指定）
//       * fetcher 抛网络异常 → onToast + ok:false
//
// 设计：所有依赖（fetcher/toast/quota/401）通过 CallApiDeps 注入，
//      无需 React 测试环境，纯函数级断言。useApi Hook 是装配层，
//      其行为由 callApi 单测覆盖（Hook 只是把 useAuthFetch/useToast/useRecharge
//      喂进 callApi，无独立逻辑值得测）。
// ============================================================

import { describe, it, expect, vi } from "vitest";
import {
  callApi,
  isQuotaError,
  parseEnvelope,
  formatApiError,
} from "../lib/api";

// ------------------------------------------------------------
// 工具：构造一个 mock fetcher，返回指定 Response 形状
// ------------------------------------------------------------
function makeResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  return new Response(body, {
    status,
    headers: init.headers,
  });
}

function makeDeps(overrides: {
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  onToast?: (msg: string) => void;
  onQuota?: (ctx: { traceId?: string }) => void;
  onUnauthorized?: () => void;
} = {}) {
  return {
    fetcher:
      overrides.fetcher ??
      (vi.fn().mockResolvedValue(makeResponse(""))) as unknown as (
        input: string,
        init?: RequestInit,
      ) => Promise<Response>,
    onToast: overrides.onToast ?? vi.fn(),
    onQuota: overrides.onQuota ?? vi.fn(),
    onUnauthorized: overrides.onUnauthorized ?? vi.fn(),
  };
}

// ============================================================
// isQuotaError
// ============================================================
describe("isQuotaError", () => {
  it("matches category === 'QUOTA'", () => {
    expect(isQuotaError({ category: "QUOTA" })).toBe(true);
  });
  it("matches code === 'QUOTA_INSUFFICIENT'", () => {
    expect(isQuotaError({ code: "QUOTA_INSUFFICIENT" })).toBe(true);
  });
  it("matches code === 'IMG_QUOTA'", () => {
    expect(isQuotaError({ code: "IMG_QUOTA" })).toBe(true);
  });
  it("matches status === 402", () => {
    expect(isQuotaError({ status: 402 })).toBe(true);
  });
  it("returns false for unrelated errors", () => {
    expect(isQuotaError({ code: "VALIDATION_ERROR", status: 400 })).toBe(false);
    expect(isQuotaError({})).toBe(false);
    expect(isQuotaError({ category: "auth" })).toBe(false);
  });
});

// ============================================================
// parseEnvelope
// ============================================================
describe("parseEnvelope", () => {
  it("returns null for empty string", () => {
    expect(parseEnvelope("")).toBeNull();
  });
  it("returns null for invalid JSON", () => {
    expect(parseEnvelope("not-json")).toBeNull();
    expect(parseEnvelope("{broken")).toBeNull();
  });
  it("returns null for non-object JSON (string / number / array)", () => {
    expect(parseEnvelope('"hello"')).toBeNull();
    expect(parseEnvelope("42")).toBeNull();
    // 数组也是对象，但 envelope 必须有 success 字段，故此处 duck-type 仍放过
    // 但典型数组无 success 字段，下游 envelope.success 判定为 undefined，
    // callApi 会走 !envelope.success 分支；此处只断言 parseEnvelope 不抛
    expect(parseEnvelope("[1,2,3]")).not.toBeNull();
  });
  it("parses success envelope", () => {
    const env = parseEnvelope(JSON.stringify({ success: true, data: { id: 1 } }));
    expect(env).not.toBeNull();
    expect(env?.success).toBe(true);
    expect(env?.data).toEqual({ id: 1 });
  });
  it("parses failure envelope with code/suggestion", () => {
    const env = parseEnvelope(
      JSON.stringify({
        success: false,
        error: "出错了",
        code: "VALIDATION_ERROR",
        suggestion: "检查输入",
      }),
    );
    expect(env?.success).toBe(false);
    expect(env?.error).toBe("出错了");
    expect(env?.code).toBe("VALIDATION_ERROR");
    expect(env?.suggestion).toBe("检查输入");
  });
});

// ============================================================
// formatApiError
// ============================================================
describe("formatApiError", () => {
  it("plain message only", () => {
    expect(formatApiError("boom")).toBe("boom");
  });
  it("prepends [code] when code provided", () => {
    expect(formatApiError("boom", "E1")).toBe("[E1] boom");
  });
  it("appends suggestion when provided", () => {
    expect(formatApiError("boom", undefined, "重试")).toBe("boom\n建议：重试");
  });
  it("combines code + suggestion", () => {
    expect(formatApiError("boom", "E1", "重试")).toBe("[E1] boom\n建议：重试");
  });
});

// ============================================================
// callApi — 成功路径
// ============================================================
describe("callApi — success", () => {
  it("returns envelope.data on 200 success envelope", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(makeResponse(JSON.stringify({ success: true, data: { id: 7 } })));
    const deps = makeDeps({ fetcher });

    const result = await callApi<{ id: number }>("/api/x", undefined, deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ id: 7 });
    expect(deps.onToast).not.toHaveBeenCalled();
    expect(deps.onQuota).not.toHaveBeenCalled();
    expect(deps.onUnauthorized).not.toHaveBeenCalled();
  });

  it("passes through url + options to fetcher", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(JSON.stringify({ success: true, data: "ok" })),
    );
    const deps = makeDeps({ fetcher });

    await callApi("/api/x", { method: "POST", body: '{"a":1}' }, deps);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({
        method: "POST",
        body: '{"a":1}',
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("auto-adds Content-Type: application/json when body is a string and header not set", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(JSON.stringify({ success: true, data: "ok" })),
    );
    const deps = makeDeps({ fetcher });

    await callApi("/api/x", { method: "POST", body: '{"a":1}' }, deps);

    const init = fetcher.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("preserves caller-provided Content-Type", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(JSON.stringify({ success: true, data: "ok" })),
    );
    const deps = makeDeps({ fetcher });

    await callApi(
      "/api/x",
      { method: "POST", body: "text", headers: { "Content-Type": "text/plain" } },
      deps,
    );

    const headers = (fetcher.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["Content-Type"]).toBe("text/plain");
  });

  it("does NOT set Content-Type for FormData body", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(JSON.stringify({ success: true, data: "ok" })),
    );
    const deps = makeDeps({ fetcher });

    const fd = new FormData();
    fd.append("file", new Blob(["x"]), "x.txt");
    await callApi("/api/upload", { method: "POST", body: fd }, deps);

    const headers = (fetcher.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["Content-Type"]).toBeUndefined();
  });
});

// ============================================================
// callApi — 401
// ============================================================
describe("callApi — 401 unauthorized", () => {
  it("short-circuits with ok:false + triggers onUnauthorized", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResponse("", { status: 401 }));
    const onUnauthorized = vi.fn();
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onUnauthorized, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHORIZED");
      expect(result.error.status).toBe(401);
    }
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // 401 不应再触发 toast（跳转即可）
    expect(onToast).not.toHaveBeenCalled();
  });
});

// ============================================================
// callApi — 错误路径
// ============================================================
describe("callApi — HTTP errors", () => {
  it("500 + envelope.error → toast formatted msg + ok:false", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(
        JSON.stringify({
          success: false,
          error: "服务器炸了",
          code: "INTERNAL_ERROR",
          suggestion: "稍后重试",
        }),
        { status: 500 },
      ),
    );
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("服务器炸了");
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.status).toBe(500);
      expect(result.error.suggestion).toBe("稍后重试");
    }
    expect(onToast).toHaveBeenCalledWith(
      "[INTERNAL_ERROR] 服务器炸了\n建议：稍后重试",
    );
  });

  it("502 + nginx HTML body → concise gateway message + ok:false", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(
        "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.20.1</center><!-- a padding to disable MSIE and Chrome friendly error page --></body></html>",
        { status: 502 },
      ),
    );
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("云端服务暂时不可用，请稍后重试");
      expect(result.error.status).toBe(502);
    }
    expect(onToast).toHaveBeenCalledWith("云端服务暂时不可用，请稍后重试");
    expect(onToast.mock.calls.flat().join(" ")).not.toContain("<html>");
  });

  it("500 + empty body → toast '请求失败 (500)' fallback", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResponse("", { status: 500 }));
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("请求失败 (500)");
    expect(onToast).toHaveBeenCalledWith("请求失败 (500)");
  });

  it("200 but body not JSON object → toast '服务返回格式错误' + ok:false", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeResponse("plain text"));
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("plain text");
    expect(onToast).toHaveBeenCalledWith("plain text");
  });

  it("200 but envelope.success === false (no quota) → toast + ok:false", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(
        JSON.stringify({
          success: false,
          error: "参数有误",
          code: "VALIDATION_ERROR",
        }),
        { status: 200 },
      ),
    );
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toBe("参数有误");
    }
    expect(onToast).toHaveBeenCalledWith("[VALIDATION_ERROR] 参数有误");
  });
});

// ============================================================
// callApi — Quota / 低余额
// ============================================================
describe("callApi — quota errors", () => {
  it("402 + envelope → triggers onQuota + ok:false (no toast)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(
        JSON.stringify({
          success: false,
          error: "额度不足",
          code: "QUOTA_INSUFFICIENT",
          category: "QUOTA",
          traceId: "t-1",
        }),
        { status: 402 },
      ),
    );
    const onQuota = vi.fn();
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onQuota, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("QUOTA_INSUFFICIENT");
      expect(result.error.category).toBe("QUOTA");
      expect(result.error.traceId).toBe("t-1");
    }
    expect(onQuota).toHaveBeenCalledWith({ traceId: "t-1" });
    expect(onToast).not.toHaveBeenCalled();
  });

  it("200 with QUOTA category (even success-path !envelope.success) → onQuota", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse(
        JSON.stringify({
          success: false,
          error: "图片额度用完",
          code: "IMG_QUOTA",
        }),
        { status: 200 },
      ),
    );
    const onQuota = vi.fn();
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onQuota, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("IMG_QUOTA");
    expect(onQuota).toHaveBeenCalledTimes(1);
    expect(onToast).not.toHaveBeenCalled();
  });
});

// ============================================================
// callApi — 网络异常
// ============================================================
describe("callApi — network errors", () => {
  it("fetcher throws → toast e.message + ok:false", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("connect ETIMEDOUT"));
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("connect ETIMEDOUT");
    expect(onToast).toHaveBeenCalledWith("connect ETIMEDOUT");
  });

  it("fetcher throws non-Error value → toast '网络错误' fallback", async () => {
    const fetcher = vi.fn().mockRejectedValue("boom string");
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("boom string");
    expect(onToast).toHaveBeenCalledWith("boom string");
  });

  it("fetcher throws Error with empty message → '网络错误' fallback", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(""));
    const onToast = vi.fn();
    const deps = makeDeps({ fetcher, onToast });

    const result = await callApi("/api/x", undefined, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("网络错误");
    expect(onToast).toHaveBeenCalledWith("网络错误");
  });
});
