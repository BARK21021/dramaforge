// ============================================================
// /generate — runGenerate 提交流契约测试（P4 Task 2）
// ============================================================
//
// 测试对象：./generate-flow.ts 的 runGenerate 纯函数。
//
// 为什么测纯函数而非渲染 page.tsx：
//   仓库 vitest.config 是 environment='node'，未装 jsdom / @testing-library
//   （所有 web 测试都是 node-env 契约测试）。React 组件渲染测试需新依赖，
//   与仓库风格 + ponytail 哲学冲突。把提交逻辑抽成纯函数后，行为面（fetch
//   envelope 解析 / sfShell IPC 分支 / 错误归类 / UNAUTHORIZED 跳登录触发）
//   全部可被 node-env 单测覆盖；page.tsx 只做 UI 胶水（JSX 结构由 build 把关）。
//
// 覆盖（plan §5 Task 2 验收点）：
//   1) submit 成功 + Electron     → 调路由 + 调 downloadAsset + protocolUrl 是 sf-asset://
//   2) 非 Electron fallback        → 不调 downloadAsset + 直接返回临时 URL
//   3) 路由 success:false / 502    → error outcome（page 据 message toast）
//   4) 路由 401 UNAUTHORIZED       → error outcome code=UNAUTHORIZED（page 据此跳登录）
//   5) 网络错误 / JSON 解析失败 / 缺 url / downloadAsset 失败 → 全部降级为 error，永不 reject
//
// mock：fetchImpl 注入 vi.fn()；sfShell 用最小 mock 对象（isElectron + downloadAsset）。
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runGenerate,
  type DownloadAssetResult,
  type SfShellBridgeLike,
} from "./generate-flow";

/** 构造一个真实 Web Response（node 环境内置 Response ctor，Vitest 可用）。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runGenerate (P4 Task 2 /generate flow)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  // -------- plan 验收点 1：submit 成功 + Electron 路径 --------

  it("Electron 路径：成功→fetch 路由（含 model+prompt）→调 downloadAsset→返回 sf-asset:// protocolUrl", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { url: "https://ark.temp/tmp-x.mp4" },
      }),
    );
    const downloadAsset = vi.fn().mockResolvedValue({
      ok: true,
      key: "abc-123.mp4",
      protocolUrl: "sf-asset://abc-123.mp4",
    } satisfies DownloadAssetResult);
    const sfShell = {
      isElectron: true,
      downloadAsset,
    } as unknown as SfShellBridgeLike;

    const out = await runGenerate({
      prompt: "a cat playing",
      model: "ark/doubao-seedance-2-0-mini-260615",
      sfShell,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // 渲染层据 protocolUrl 写 <video src="sf-asset://abc-123.mp4">
    expect(out).toEqual({
      kind: "local",
      key: "abc-123.mp4",
      protocolUrl: "sf-asset://abc-123.mp4",
      tempUrl: "https://ark.temp/tmp-x.mp4",
    });

    // fetch 路由：URL + method + body 透传 model+prompt
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/generate/video",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "ark/doubao-seedance-2-0-mini-260615",
          prompt: "a cat playing",
        }),
      }),
    );

    // downloadAsset 收到路由返回的 ARK 临时 URL（落盘到 userData/clips/）
    expect(downloadAsset).toHaveBeenCalledTimes(1);
    expect(downloadAsset).toHaveBeenCalledWith("https://ark.temp/tmp-x.mp4");
  });

  // -------- plan 验收点 2：非 Electron fallback --------

  it("非 Electron fallback：不调 downloadAsset，直接返回临时 URL（page 渲染 <video src=临时url> + 提示）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { url: "https://ark.temp/tmp-y.mp4" },
      }),
    );
    const downloadAsset = vi.fn();

    const out = await runGenerate({
      prompt: "a dog running",
      model: "ark/x",
      sfShell: null,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out).toEqual({ kind: "fallback", url: "https://ark.temp/tmp-y.mp4" });
    expect(downloadAsset).not.toHaveBeenCalled();
  });

  it("isElectron 非 true（undefined / false）也走 fallback 分支", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { url: "https://u" } }),
    );
    // sfShell 存在但 isElectron undefined（dev 注入不完整 / 非 Electron 环境）
    const sfShell = { downloadAsset: vi.fn() } as unknown as SfShellBridgeLike;

    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out.kind).toBe("fallback");
    expect(sfShell.downloadAsset).not.toHaveBeenCalled();
  });

  // -------- plan 验收点 3：路由 success:false / 502 --------

  it("路由 success:false（400 MISSING_MODEL）→ error outcome 带 code（page toast 显示）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, error: "body 缺少 model 字段", code: "MISSING_MODEL" },
        400,
      ),
    );

    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell: null,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out).toEqual({
      kind: "error",
      message: "body 缺少 model 字段",
      code: "MISSING_MODEL",
    });
  });

  it("路由 502 AI_GATEWAY_ERROR（retryable）→ error outcome 带 code（page toast 可提示重试）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: "AI 生成失败 [provider=ark]: rate limited",
          code: "AI_GATEWAY_ERROR",
          category: "provider",
          retryable: true,
        },
        502,
      ),
    );

    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell: null,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.code).toBe("AI_GATEWAY_ERROR");
      expect(out.message).toMatch(/rate limited/);
    }
  });

  // -------- plan 验收点 4：未登录跳登录（401 UNAUTHORIZED 触发） --------

  it("路由 401 UNAUTHORIZED → error outcome code=UNAUTHORIZED（page 据此 router.push 跳 /auth/signin）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, error: "未登录或登录已过期", code: "UNAUTHORIZED" },
        401,
      ),
    );

    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell: null,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out).toEqual({
      kind: "error",
      message: "未登录或登录已过期",
      code: "UNAUTHORIZED",
    });
  });

  // -------- 兜底：网络/解析/缺字段/downloadAsset 失败 全部降级为 error --------

  it("网络错误（fetch reject）→ error outcome 友好文案，永不 reject", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell: null,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.message).toMatch(/网络错误/);
      expect(out.code).toBeUndefined();
    }
  });

  it("响应非 JSON（200 但 body 是 HTML）→ error outcome", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );

    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell: null,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out.kind).toBe("error");
  });

  it("envelope success:true 但缺 url → error outcome（防御性）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: {} }),
    );

    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell: null,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out).toEqual({ kind: "error", message: "响应缺少视频 URL" });
  });

  it("Electron downloadAsset 失败 → error outcome 带 dl.error.message + code（page toast）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { url: "https://ark/tmp-z.mp4" } }),
    );
    const downloadAsset = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "DOWNLOAD_TIMEOUT", message: "下载超时（180s）", status: 0 },
    } satisfies DownloadAssetResult);
    const sfShell = {
      isElectron: true,
      downloadAsset,
    } as unknown as SfShellBridgeLike;

    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out).toEqual({
      kind: "error",
      message: "下载超时（180s）",
      code: "DOWNLOAD_TIMEOUT",
    });
  });

  // -------- 回归：downloadAsset IPC reject → error outcome，runGenerate 不 reject
  // 锁 FIX-1（whole-branch must-fix）：IPC 通道本身异常（通道未注册 / main 崩 /
  // preload 被篡改）会让 ipcRenderer.invoke reject；若 runGenerate 不接，会向上
  // reject，而 page.tsx `void handleSubmit()` fire-and-forget + 提前 setLoading(true)
  // → loading 永久卡住（stuck-state bug）。
  it("Electron downloadAsset IPC reject（throw）→ 降级 error outcome code=DOWNLOAD_IPC_ERROR，永不 reject", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { url: "https://ark/tmp-ipc.mp4" } }),
    );
    const downloadAsset = vi.fn().mockRejectedValue(
      new Error("Error invoking remote method 'sfShell:downloadAsset': channel unknown"),
    );
    const sfShell = {
      isElectron: true,
      downloadAsset,
    } as unknown as SfShellBridgeLike;

    // runGenerate 必须把 IPC reject 降级为 error outcome，本身不 reject
    const out = await runGenerate({
      prompt: "p",
      model: "ark/x",
      sfShell,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.code).toBe("DOWNLOAD_IPC_ERROR");
      // message 友好，不暴露底层 IPC 错给用户
      expect(out.message).toMatch(/本地保存失败/);
    }

    expect(downloadAsset).toHaveBeenCalledTimes(1);
    expect(downloadAsset).toHaveBeenCalledWith("https://ark/tmp-ipc.mp4");
  });
});
