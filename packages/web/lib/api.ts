// ============================================================
// web/lib/api — 统一 API 请求封装（批2 C，抽自 app1 page.tsx:227-272 的 api()）
// ============================================================
//
// 文件职责：
//   1. callApi —— 与 React 解耦的纯请求函数。注入 fetcher + 一组 callbacks
//      （onToast / onQuota / onUnauthorized），驱动 envelope 解析、错误归一、
//      401/低额度回调。返回 ApiResult<T>（Result 类型）供调用方判断。
//   2. useApi —— React Hook，把 useAuthFetch + useToast + useRecharge + useRouter
//      装配到 callApi，返回与 app1 同签名的 api(url, options?) => Promise<T | null>，
//      以及 apiGet/apiPost/apiPatch/apiDelete 四个动词 wrapper。
//   3. isQuotaError / parseEnvelope / formatApiError —— 纯工具函数，供 callApi
//      与未来的 SSE 错误链路复用（app1 lib/error-utils 镜像）。
//   4. ApiError / ApiResult / Envelope 类型 —— 客户端规范化错误/结果类型。
//
// 与 app1 差异（有意为之，非降级）：
//   - app1 的 api() 是个 useCallback，依赖 router/toast/showRecharge 内联；
//     dramaforge 抽成 callApi（纯）+ useApi（装配），让核心可单测。
//   - app1 自行实现 credentials:"include" + 401 跳转；dramaforge 复用批0 移植的
//     useAuthFetch（已含这两个能力），不在 lib/api.ts 里重造。
//   - app1 的 showRecharge 接收 {providerName, rechargeUrl, errorMessage, traceId}；
//     dramaforge RechargeProvider 的 showRecharge 只接收 {traceId?}（批1 简化，
//     PlatformRechargeModal 是平台统一充值面板，不按 provider 跳外链）。
//     故 lib/api.ts 调 showRecharge({traceId}) 时只透传 traceId，其他字段忽略。
//   - 错误格式化逻辑（code + suggestion 拼接）与 app1 完全一致。
//
// web 禁止 import 任何 ffmpeg 模块；本模块为纯工具 + 轻量 Hook。
// ============================================================

"use client";

import { useCallback } from "react";
import { useAuthFetch } from "../hooks/useAuthFetch";
import { useToast } from "../components/ui/Toast";
import { useRecharge } from "../components/ui/RechargeProvider";

// ============================================================
// 类型
// ============================================================

/**
 * 客户端规范化错误（跨 HTTP 响应 / SSE 事件 / 异常捕获统一形态）
 *
 * 字段全部 optional 除 message 外，因为不同错误源能提供的字段不同：
 *   - HTTP envelope 失败：code/category/suggestion/retryable 齐全
 *   - 网络异常：只有 message
 *   - SSE 错误事件：可能只有 code + message
 */
export interface ApiError {
  /** 用户可读错误信息（必填） */
  message: string;
  /** 错误代码（如 'QUOTA_INSUFFICIENT' / 'UNAUTHORIZED' / 'VALIDATION_ERROR'） */
  code?: string;
  /** 错误类别（如 'QUOTA' / 'auth' / 'provider' / 'validation'） */
  category?: string;
  /** HTTP 状态码（来自 res.status，网络异常时缺省） */
  status?: number;
  /** 处理建议（给用户的下一步，与 envelope.suggestion 同义） */
  suggestion?: string;
  /** traceId（错误链路去重用，透传给 showRecharge） */
  traceId?: string;
  /** 是否可重试（透传 envelope.retryable） */
  retryable?: boolean;
}

/**
 * Result 类型 —— callApi 返回值
 *
 * ok:true 携带业务数据；ok:false 携带规范化错误。
 * 调用方用 if (result.ok) 分支判断，避免 app1 null-return 风格的隐式失败。
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

/**
 * 后端 envelope 形状（与 lib/response.ts 的 apiSuccess/apiFail 对偶）
 *
 * 成功: { success: true, data }
 * 失败: { success: false, error, code?, category?, retryable?, suggestion? }
 *
 * 此处仅作运行时形状参考，不强制 Zod 校验（envelope 字段已是后端契约，
 * 在客户端二次校验属过度防御；parseEnvelope 用 duck-typing 判 success 即可）。
 */
export interface Envelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  category?: string;
  retryable?: boolean;
  suggestion?: string;
  /** 充值外链（app1 后端可能下发；dramaforge 后端目前不发，保留兼容） */
  rechargeUrl?: string;
  /** 服务商名（同上） */
  providerName?: string;
  /** traceId（错误链路追踪与去重） */
  traceId?: string;
}

// ============================================================
// 纯 helper
// ============================================================

/**
 * 判断是否为额度不足类错误（移植自 app1 lib/error-utils.ts）
 *
 * 匹配规则（任一命中即返回 true）：
 *   - category === "QUOTA"
 *   - code === "QUOTA_INSUFFICIENT"（LLM/文本类额度不足）
 *   - code === "IMG_QUOTA"（图片类额度不足）
 *   - status === 402（HTTP 402 Payment Required）
 *
 * 兼容三种字段来源：HTTP envelope(code/category/status)、SSE 事件
 * (errorCode/errorCategory)、ParsedApiError(code/category/status)。
 */
export function isQuotaError(err: {
  code?: string;
  category?: string;
  status?: number;
}): boolean {
  return (
    err?.category === "QUOTA" ||
    err?.code === "QUOTA_INSUFFICIENT" ||
    err?.code === "IMG_QUOTA" ||
    err?.status === 402
  );
}

/**
 * 解析 res.text() 为 envelope 形状（容错）
 *
 * 行为：
 *   - 空响应体 → null（caller 自行决定如何处理，通常视为格式错误）
 *   - JSON 解析失败 → null
 *   - 解析成功但非对象 → null
 *
 * 不抛错，所有异常路径都返 null；caller 通过 falsy 判定解析失败。
 */
export function parseEnvelope(raw: string): Envelope | null {
  if (!raw) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as Envelope;
}

/**
 * 拼接给用户看的错误文案（移植自 app1 page.tsx 的 toast 拼接逻辑）
 *
 * 格式：`[code] message\n建议：suggestion`
 * code / suggestion 缺省时省略对应片段。
 *
 * @param message   主错误信息（必填）
 * @param code      错误代码（optional，前面加方括号）
 * @param suggestion 处理建议（optional，前面加换行 + "建议："）
 */
export function formatApiError(
  message: string,
  code?: string,
  suggestion?: string,
): string {
  const codePrefix = code ? `[${code}] ` : "";
  const suggestionSuffix = suggestion ? `\n建议：${suggestion}` : "";
  return `${codePrefix}${message}${suggestionSuffix}`;
}

/**
 * 反向代理在应用不可达时常返回整页 HTML。该正文适合服务端日志，不适合直接
 * 显示给用户；统一在 API 边界归一，避免每个业务页面各自识别 nginx 页面。
 */
export function normalizeHttpFailureBody(
  raw: string,
  status: number,
): string {
  const value = raw.trim();
  const looksLikeHtml =
    /<(?:!doctype|html|head|body|title|h1)\b/i.test(value) ||
    /\bnginx\/\d/i.test(value);

  if (looksLikeHtml && [502, 503, 504].includes(status)) {
    return "云端服务暂时不可用，请稍后重试";
  }
  if (looksLikeHtml) return `服务请求失败（HTTP ${status}）`;
  return value || `请求失败 (${status})`;
}

// ============================================================
// callApi —— 纯请求函数（无 React 依赖，可单测）
// ============================================================

/**
 * callApi 注入的依赖（让核心逻辑可测，不耦合 React hooks）
 */
export interface CallApiDeps {
  /**
   * fetcher —— 实际发起请求的函数。
   * 通常由 useAuthFetch().authFetch 提供（含 credentials + 401 自动跳转）。
   * 此处只要求签名兼容 fetch，不强依赖具体实现。
   */
  fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  /** toast 回调（错误时弹通知） */
  onToast?: (msg: string) => void;
  /** 低额度回调（弹充值面板），返回是否已触发（用于断言） */
  onQuota?: (ctx: { traceId?: string }) => void;
  /**
   * 401 回调（占位）。
   * 注：401 → 强退现由 SessionGuard 的全局 fetch 拦截器单一接管（覆盖所有
   * 调用方），本回调默认 no-op；保留占位以便未来切换非拦截器路径时复用。
   * 默认行为：返回 ok:false 不再继续解析 body（401 body 通常无意义）。
   */
  onUnauthorized?: () => void;
}

/**
 * 发起 API 请求并规范化结果为 ApiResult<T>
 *
 * 完整流程（对齐 app1 page.tsx:227-272）：
 *   1. 处理 headers：body 为 FormData 不加 Content-Type（让浏览器自动设 boundary）；
 *      否则未显式指定时补 application/json。
 *   2. fetcher(url, init) 发请求。
 *   3. 401 → onUnauthorized + 返回 ok:false（code='UNAUTHORIZED'）。
 *   4. res.text() 读 raw body；parseEnvelope 尝试 JSON 解析。
 *   5. !res.ok：
 *      - 是 quota 错 → onQuota + ok:false
 *      - 否 → onToast 拼好的错误串 + ok:false
 *   6. 解析后非对象 → onToast("服务返回格式错误") + ok:false
 *   7. !envelope.success：同 !res.ok 的 quota/普通分支
 *   8. envelope.success === true → ok:true data=envelope.data
 *   9. fetcher 抛错（网络异常） → onToast(e.message || "网络错误") + ok:false
 *
 * @typeParam T 业务数据类型（由调用方断言，本函数不做 schema 校验）
 */
export async function callApi<T = unknown>(
  url: string,
  options: RequestInit | undefined,
  deps: CallApiDeps,
): Promise<ApiResult<T>> {
  const isFormData = options?.body instanceof FormData;
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (!isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const res = await deps.fetcher(url, { ...options, headers });

    // 401：交给 useAuthFetch 跳登录；此处短路，不再解析 body
    if (res.status === 401) {
      deps.onUnauthorized?.();
      return {
        ok: false,
        error: {
          message: "未登录或登录已过期",
          code: "UNAUTHORIZED",
          status: 401,
        },
      };
    }

    const raw = await res.text();
    const envelope = parseEnvelope(raw);

    // !res.ok：HTTP 层失败
    if (!res.ok) {
      if (
        envelope &&
        isQuotaError({
          code: envelope.code,
          category: envelope.category,
          status: res.status,
        })
      ) {
        deps.onQuota?.({ traceId: envelope.traceId });
        return {
          ok: false,
          error: {
            message: envelope.error || "额度不足",
            code: envelope.code,
            category: envelope.category,
            status: res.status,
            suggestion: envelope.suggestion,
            traceId: envelope.traceId,
            retryable: envelope.retryable,
          },
        };
      }
      const errMsg = envelope?.error || normalizeHttpFailureBody(raw, res.status);
      const msg = formatApiError(errMsg, envelope?.code, envelope?.suggestion);
      deps.onToast?.(msg);
      return {
        ok: false,
        error: {
          message: errMsg,
          code: envelope?.code,
          category: envelope?.category,
          status: res.status,
          suggestion: envelope?.suggestion,
          traceId: envelope?.traceId,
          retryable: envelope?.retryable,
        },
      };
    }

    // res.ok 但 body 非对象（成功响应必须有 envelope）
    if (!envelope) {
      const fallback = raw || "服务返回格式错误";
      deps.onToast?.(fallback);
      return {
        ok: false,
        error: { message: fallback, status: res.status },
      };
    }

    // res.ok 但 envelope.success === false（业务层失败）
    if (!envelope.success) {
      if (
        isQuotaError({
          code: envelope.code,
          category: envelope.category,
          status: res.status,
        })
      ) {
        deps.onQuota?.({ traceId: envelope.traceId });
        return {
          ok: false,
          error: {
            message: envelope.error || "请求失败",
            code: envelope.code,
            category: envelope.category,
            status: res.status,
            suggestion: envelope.suggestion,
            traceId: envelope.traceId,
            retryable: envelope.retryable,
          },
        };
      }
      const errMsg = envelope.error || "请求失败";
      const msg = formatApiError(errMsg, envelope.code, envelope.suggestion);
      deps.onToast?.(msg);
      return {
        ok: false,
        error: {
          message: errMsg,
          code: envelope.code,
          category: envelope.category,
          status: res.status,
          suggestion: envelope.suggestion,
          traceId: envelope.traceId,
          retryable: envelope.retryable,
        },
      };
    }

    // 成功
    return { ok: true, data: envelope.data as T };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e) || "网络错误";
    deps.onToast?.(msg || "网络错误");
    return {
      ok: false,
      error: { message: msg || "网络错误" },
    };
  }
}

// ============================================================
// useApi —— React Hook，把 callApi 接到 React 运行时
// ============================================================

/**
 * useApi 返回的 API 调用函数集合
 *
 * - api(url, init?) —— 与 app1 同签名的低阶入口，调用方自带 method/body/headers
 * - apiGet(url) / apiPost(url, body) / apiPatch(url, body) / apiDelete(url) ——
 *   动词 wrapper，预设 method + JSON.stringify(body)。所有 wrapper 内部都走 api()，
 *   继承 envelope 解析 / toast / quota / 401 跳转能力。
 *
 * 兼容性：api(url, options?) => Promise<T | null> 与 app1 完全一致，可直接喂给
 * useEpisodeApiQueue 的 baseApi 参数（同集串行队列）。失败时返回 null
 * （而非 throw 或 ApiResult），与 app1 调用方约定一致；新版代码可用
 * callApi 拿 ApiResult 显式判断。
 */
export interface UseApiReturn {
  api: <T = unknown>(url: string, options?: RequestInit) => Promise<T | null>;
  apiGet: <T = unknown>(url: string) => Promise<T | null>;
  apiPost: <T = unknown>(url: string, body?: unknown) => Promise<T | null>;
  apiPatch: <T = unknown>(url: string, body?: unknown) => Promise<T | null>;
  apiDelete: <T = unknown>(url: string) => Promise<T | null>;
}

/**
 * API 请求 Hook —— 在 callApi 上挂 useAuthFetch + useToast + useRecharge
 *
 * 使用：
 *   const { api, apiGet, apiPost } = useApi();
 *   const proj = await apiGet(`/api/projects/${pid}`);
 *   const updated = await apiPatch(`/api/episodes/${eid}`, { stageStatus: 'storyboard' });
 *
 * 注意：必须挂在 ToastProvider + RechargeProvider 内层（layout.tsx 已配置）。
 */
export function useApi(): UseApiReturn {
  const { authFetch } = useAuthFetch();
  const toast = useToast();
  const { showRecharge } = useRecharge();

  const deps = {
    fetcher: authFetch,
    onToast: (msg: string) => toast.error(msg),
    onQuota: ({ traceId }: { traceId?: string }) =>
      showRecharge(traceId ? { traceId } : {}),
    // 401 → 强退由 SessionGuard 全局 fetch 拦截器统一接管（见
    // components/providers/SessionGuard.tsx）；此处 no-op，仅保留占位。
    onUnauthorized: () => {
      /* 拦截器已处理强退 */
    },
  };

  const api = useCallback(
    async <T = unknown,>(url: string, options?: RequestInit): Promise<T | null> => {
      const result = await callApi<T>(url, options, deps);
      if (result.ok) return result.data;
      return null;
    },
    // ToastProvider 会 memoize context value；authFetch/showRecharge 也提供稳定引用。
    // 保持这三个依赖稳定，可避免下游依赖 api 的 effect 因无关 Toast 状态更新而重跑。
    // 这里只陈述引用约束，不把具体线上请求峰值归因于单一代码路径。
    [authFetch, toast, showRecharge],
  );

  const apiGet = useCallback(
    <T = unknown,>(url: string) => api<T>(url, { method: "GET" }),
    [api],
  );
  const apiPost = useCallback(
    <T = unknown,>(url: string, body?: unknown) =>
      api<T>(url, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    [api],
  );
  const apiPatch = useCallback(
    <T = unknown,>(url: string, body?: unknown) =>
      api<T>(url, {
        method: "PATCH",
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    [api],
  );
  const apiDelete = useCallback(
    <T = unknown,>(url: string) => api<T>(url, { method: "DELETE" }),
    [api],
  );

  return { api, apiGet, apiPost, apiPatch, apiDelete };
}
