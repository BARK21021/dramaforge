// ============================================================
// 认证请求封装 - cookie-based session 的 fetch 包装（移植自 app1）
// ============================================================
//
// 文件职责：
//   1. authFetch — 独立的 fetch 包装函数，自动附加 credentials: "include"
//      和 Content-Type 头，供非组件代码（如 useTaskStatus 的轮询逻辑）直接调用。
//   2. useAuthFetch — React Hook，返回带 401 自动跳转登录页能力的 authFetch。
//
// dramaforge 认证模型（与 app1 一致）：
//   NextAuth cookie-based session，前端只需 credentials: "include"
//   即可携带鉴权 cookie，无需手动附加 Bearer Token。
//
// 与 app1 差异：无。原样移植，仅调整文件头注释。
// ============================================================

import { useCallback } from "react";

/**
 * 独立的认证 fetch 包装（裸函数，非 Hook）
 *
 * 为 fetch 请求自动附加：
 *   - credentials: "include" — 携带 NextAuth 的 cookie session
 *   - Content-Type: application/json — 当 body 为字符串且未显式指定时
 *
 * 此函数不处理 401 跳转（非组件场景无法使用 router），
 * 调用方需自行检查 res.status === 401 并处理。
 *
 * @param input - 请求 URL
 * @param init - fetch 初始化选项（可选）
 * @returns fetch 响应
 */
export async function authFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  // body 为字符串时自动附加 JSON Content-Type（未显式指定时）
  if (!headers["Content-Type"] && init?.body && typeof init.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  return fetch(input, { ...init, headers, credentials: "include" });
}

/**
 * 认证请求 Hook
 *
 * 返回一个 authFetch 函数，与独立版 authFetch 行为一致（附加 cookie +
 * Content-Type），提供引用稳定的封装供组件复用。
 *
 * 401 → 强退不再由此 Hook 处理：改由 SessionGuard 的全局 fetch 拦截器
 * 统一接管（单一所有者），覆盖裸 fetch / SSE / 轮询等所有调用方，并做
 * 真正的 signOut + 跳落地页（而非软 router.push）。见 components/providers/
 * SessionGuard.tsx 与 lib/force-logout.ts。
 *
 * @returns { authFetch } 带 cookie 的认证 fetch 函数
 */
export function useAuthFetch(): {
  authFetch: (input: string, init?: RequestInit) => Promise<Response>;
} {
  // authFetch 是模块级函数（引用稳定）；useCallback 仅给出稳定标识。
  return {
    authFetch: useCallback(
      (input: string, init?: RequestInit) => authFetch(input, init),
      [],
    ),
  };
}
