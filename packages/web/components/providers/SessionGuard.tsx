// ============================================================
// SessionGuard — 会话失效强退的全局兜底
// ============================================================
//
// 文件职责：
//   挂在 AuthProvider 内（紧跟 SessionProvider），用两道网兜住全部会话失效
//   场景，统一触发「强退到落地页 + 留原因给落地页弹 toast」：
//
//     场景               服务端最终表现        被哪道网接住
//     ─────────────────  ───────────────────  ─────────────────────
//     改密/管理员重置     stamp 轮换 → 401      网1（fetch 拦截）
//     登录过期(JWT失效)   getServerSession空→401  网1 + 网2(status)
//     被挤下线(异地登录)   stamp 轮换 → 401      网1（fetch 拦截）
//
//   网1（主网）—— 全局 fetch 401 拦截：包装 window.fetch，遇 401 且
//     非内部端点、在受保护路由 → 强退。覆盖所有调用方，包括走 useApi 的、
//     裸 fetch 的（如 ProductionStage/compile-flow）、SSE、轮询。
//   网2（补网）—— useSession status 监听：status 翻 unauthenticated 且在
//     受保护路由 → 强退。覆盖「无 API 调用」的纯过期（页面静置后刷新）。
//
// 强退动作（forceLogout）：
//   - 模块级 once-flag 防风暴（多个并发 401 只触发一次 signOut）
//   - 先往 sessionStorage 写原因，落地页挂载时读出弹 toast 再清除
//   - signOut({ callbackUrl:'/', redirect:true })：清 cookie + 硬跳落地页，
//     重置 SPA 状态（满足"强退出到初始主界面"）
//
// 与既有 useAuthFetch 的关系：
//   useAuthFetch 原本的 router.push('/auth/signin') 已移除——401→强退改由本
//   拦截器单一所有者负责，避免双重跳转与软跳转不清 cookie 的问题。
// ============================================================

"use client";

import { useEffect, useRef } from "react";
import { useSession, signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import {
  FORCE_LOGOUT_REASON_KEY,
  isProtectedPath,
  isAuthEndpoint,
} from "../../lib/force-logout";

/** once-flag：一次失效事件只触发一次 signOut（并发 401 防风暴）。 */
let forceLogoutStarted = false;

/**
 * 触发强退：写原因 → signOut 跳落地页。
 *
 * 幂等保护：forceLogoutStarted 置位后直接返回。signOut 的 redirect:true 会
 * 做全页跳转，组件随之卸载；下一次会话失效事件在新页面加载后 flag 已随
 * 模块重新求值而复位。
 */
function forceLogout(reason: string): void {
  if (forceLogoutStarted) return;
  forceLogoutStarted = true;
  try {
    sessionStorage.setItem(FORCE_LOGOUT_REASON_KEY, reason);
  } catch {
    /* sessionStorage 不可用（隐私模式等）时忽略，仍继续登出 */
  }
  void signOut({ callbackUrl: "/", redirect: true });
}

export default function SessionGuard() {
  const { status } = useSession();
  const pathname = usePathname();
  // 用 ref 取最新 pathname 供 fetch 拦截器闭包读取（拦截器只在挂载时安装一次）。
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // 网1：全局 fetch 401 拦截（主网，覆盖所有调用方）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const originalFetch = window.fetch;
    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const res = await originalFetch(input, init);
      try {
        if (
          res.status === 401 &&
          isProtectedPath(pathnameRef.current)
        ) {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input?.url ?? "";
          if (!isAuthEndpoint(url)) {
            forceLogout("登录已失效，请重新登录");
          }
        }
      } catch {
        /* 拦截器自身异常绝不影响把原始响应交还调用方 */
      }
      return res;
    }) as typeof window.fetch;
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  // 网2：会话状态翻 unauthenticated（补网，覆盖无 API 调用的纯过期）
  useEffect(() => {
    if (status === "unauthenticated" && isProtectedPath(pathname)) {
      forceLogout("登录已过期，请重新登录");
    }
  }, [status, pathname]);

  return null;
}
