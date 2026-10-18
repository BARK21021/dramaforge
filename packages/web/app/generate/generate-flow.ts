// ============================================================
// /generate — 视频生成提交纯函数（从 page.tsx 抽出供 node-env 单测）
// ============================================================
//
// 设计原因：vitest.config.ts 的 environment='node'，且仓库未装 jsdom /
// @testing-library（所有 web 测试都是 node-env 契约测试）。React 组件渲染
// 测试需要 DOM 环境 + 新依赖，与 ponytail 哲学冲突。把可测的提交逻辑
// （fetch envelope 解析 + sfShell IPC 分支 + 错误归类）抽成纯函数
// runGenerate，page.tsx 只做 UI 胶水；单测直接打纯函数，不渲染 React。
//
// 契约对齐：
//   - envelope 形状：见 app/api/generate/video/route.ts
//     200 { success:true, data:{ url, meta? } }
//     4xx/5xx { success:false, error, code?, ... }
//   - sfShell bridge：见 packages/client/main/preload.ts
//     DownloadAssetResult = { ok:true, key, protocolUrl } | { ok:false, error }
//     （跨 IPC 时 localPath 已被 strip，渲染进程只能拿到 protocolUrl）
//
// 硬约束：
//   - 资产客户端本地（dramaforge-assets-client-local）：渲染进程绝不直接 file://，
//     Electron 路径必须经 window.sfShell.downloadAsset 落盘再播 sf-asset://
//   - AI key 隔离（GC-1）：本文件不接触任何 key，只 POST 同站路由让服务器去调
// ============================================================

/**
 * 与 client/preload.ts 的 DownloadAssetResult 同构的最小类型。
 * 复制而非 import：preload 是 Electron 端模块，web 不应依赖 client 包
 * （否则会把 electron 拖进 web bundle）。结构必须与 preload 保持一致。
 */
export type DownloadAssetResult =
  | { ok: true; key: string; protocolUrl: string }
  | { ok: false; error: { code: string; message: string; status?: number } };

/**
 * 渲染进程从 window.sfShell 读到的 IPC bridge 形状（最小子集）。
 * preload 实际暴露更多（getAppVersion / getMachineId / triggerUpdateCheck），
 * 此处只列 page.tsx + runGenerate 用到的两个字段。
 */
export interface SfShellBridgeLike {
  readonly isElectron?: true;
  downloadAsset(url: string): Promise<DownloadAssetResult>;
}

/**
 * runGenerate 输出：驱动 page.tsx 的 <video src>、toast、跳转决策。
 *
 * - local:    Electron 路径。protocolUrl = sf-asset://<clipId>.mp4，直接塞
 *             <video src>。tempUrl 留作调试参考（实际不播放，避免暴露 ARK 临时
 *             URL 与本地双路径混淆）。
 * - fallback: 浏览器/dev 路径。url = ARK 1h 过期临时 URL，直接 <video src>。
 * - error:    路由 success:false / 网络异常 / JSON 解析失败 / 缺 url /
 *             downloadAsset 失败。code 可选（UNAUTHORIZED→跳登录；
 *             AI_GATEWAY_ERROR→可重试 toast）。
 */
export type GenerateOutcome =
  | { kind: "local"; key: string; protocolUrl: string; tempUrl: string }
  | { kind: "fallback"; url: string }
  | { kind: "error"; message: string; code?: string };

/**
 * 提交视频生成。
 *
 * 流程：POST /api/generate/video → 解 envelope → 成功取 data.data.url →
 *   - sfShell.isElectron===true：调 downloadAsset 落盘到 userData/clips/ →
 *     返回 local + protocolUrl（渲染进程 <video> 播本地，永不触 file://）
 *   - 否则（浏览器/dev）：返回 fallback + 临时 URL（仅当次会话，不落盘）
 *
 * 失败：返回 error + message + 可选 code（UI 层只判 kind 与 code）。
 *
 * 该函数永不 reject：网络异常 / JSON 解析失败 / 路由 4xx-5xx / downloadAsset
 * 失败 / envelope 缺 url 全部降级为 error outcome，让 UI 层只走 toast 分支。
 *
 * @param input.prompt  用户输入的提示词（调用方负责 trim + 非空校验）
 * @param input.model   "provider/model-id" 格式，默认由 page.tsx 传
 *                      'ark/doubao-seedance-2-0-mini-260615'（与 app1 一致）
 * @param input.sfShell 渲染进程从 window.sfShell 读到的 bridge；浏览器为 null
 * @param input.fetchImpl 可选 fetch 注入（测试用）；生产省略走 globalThis.fetch
 */
export async function runGenerate(input: {
  prompt: string;
  model: string;
  sfShell: SfShellBridgeLike | null;
  fetchImpl?: typeof fetch;
}): Promise<GenerateOutcome> {
  const fetchFn = input.fetchImpl ?? fetch;

  // ---- 1. POST /api/generate/video（同站路由，cookie 自动带）----
  let res: Response;
  try {
    res = await fetchFn("/api/generate/video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: input.model, prompt: input.prompt }),
    });
  } catch {
    // 网络中断 / DNS / CORS / AbortError → 友好文案，不暴露底层错给用户
    return { kind: "error", message: "网络错误，请稍后重试" };
  }

  // ---- 2. 解 envelope（容忍非 JSON 响应）----
  // 注意：不能写 `as typeof data`——data 刚被初始化为 null 会让 TS 把 typeof
  // 窄化成 null，后面所有字段访问都报 never。用具名 type 别名断言最稳。
  type Envelope = {
    success?: boolean;
    data?: { url?: unknown };
    error?: string;
    code?: string;
  };
  let data: Envelope | null = null;
  try {
    data = (await res.json()) as Envelope;
  } catch {
    data = null;
  }

  if (!data || data.success !== true) {
    return {
      kind: "error",
      message: data?.error ?? `请求失败 (${res.status})`,
      code: data?.code,
    };
  }

  // ---- 3. 取 url（envelope.success===true 但缺 url 也算错，防御性）----
  const url = data.data?.url;
  if (typeof url !== "string" || url.length === 0) {
    return { kind: "error", message: "响应缺少视频 URL" };
  }

  // ---- 4. Electron 路径：经 IPC 落盘 → sf-asset:// 播本地 ----
  // 资产客户端本地约束：渲染进程沙箱绝不直接 file://，所有落盘走 main IPC，
  // preload 返回 protocolUrl（localPath 跨 IPC 前已 strip）。
  //
  // try/catch 守 IPC 通道本身异常（通道未注册 / main 崩 / preload 被篡改等导致
  // ipcRenderer.invoke reject）。即便 preload 契约保证 downloadAsset 不抛，IPC
  // 仍可能 reject；若不接，runGenerate 会向上 reject，与 docstring "永不 reject"
  // 承诺冲突，且 page.tsx `void handleSubmit()` fire-and-forget 不接 → loading
  // 永久卡住。catch 降级 error outcome（code=DOWNLOAD_IPC_ERROR），让 UI 走 toast。
  if (input.sfShell?.isElectron === true) {
    let dl: DownloadAssetResult;
    try {
      dl = await input.sfShell.downloadAsset(url);
    } catch {
      return {
        kind: "error",
        message: "本地保存失败，请稍后重试",
        code: "DOWNLOAD_IPC_ERROR",
      };
    }
    if (dl.ok) {
      return { kind: "local", key: dl.key, protocolUrl: dl.protocolUrl, tempUrl: url };
    }
    return { kind: "error", message: dl.error.message, code: dl.error.code };
  }

  // ---- 5. 非 Electron：退化播 ARK 临时 URL（1h 过期，不落盘）----
  return { kind: "fallback", url };
}
