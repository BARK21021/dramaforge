// ============================================================
// web/lib/force-logout — 会话失效强退的纯决策逻辑
// ============================================================
//
// 文件职责：
//   导出会话失效判定相关的纯函数（无副作用、无浏览器/next-auth 依赖），
//   供 SessionGuard 的全局 fetch 拦截器与会话状态监听复用，并可独立单测。
//
// 为什么独立成纯模块：
//   SessionGuard 侧的强退动作（sessionStorage 写原因 + signOut 跳落地页）
//   依赖浏览器 API 与 next-auth/react，无法在 node 环境单测；把「是否该强退」
//   的判定抽成纯函数后，判定逻辑（受保护路由 / auth 端点 / 401 触发条件）
//   可在 node 契约测里覆盖，副作用在组件里保持薄。
//
// 设计要点：
//   - 受保护路由 = 除落地页 / 与 /auth/* 之外的所有路径。拦截器只在受保护路由
//     上对 401 触发强退，避免已登出用户在落地页/登录页的 401 造成刷新死循环。
//   - /api/auth/* 是 NextAuth 内部端点（signin/callback/signout/session），
//     其 401（如登录密码错误）不得触发强退，否则会把正在登录的用户弹走。
// ============================================================

/** sessionStorage 键：强退原因。落地页挂载时读取 → 弹 toast → 清除。 */
export const FORCE_LOGOUT_REASON_KEY = "sf_force_logout_reason";

/**
 * 当前路径是否为受保护路由（需登录才能使用）。
 *
 * 落地页 `/` 与 `/auth/*`（登录/注册等）视为非受保护——这些页面本身就是
 * 未登录态可访问的，其上的 401 不应触发强退（否则已登出用户会被反复弹回）。
 */
export function isProtectedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === "/") return false;
  if (pathname.startsWith("/auth")) return false;
  return true;
}

/**
 * 是否为 NextAuth 内部鉴权端点（`/api/auth/*`）。
 *
 * 拦截器对此类端点的 401 放行：登录时密码错误、session 探测等场景的 401
 * 是正常业务流，不应触发强退，否则会与登录流程互相死循环。
 */
export function isAuthEndpoint(url: string): boolean {
  return url.includes("/api/auth/");
}

/**
 * 401 响应是否应触发强退。
 *
 * 同时满足三条才强退：
 *   1. HTTP 401（会话失效的唯一可靠信号：改密/重置轮换 stamp、JWT 过期、
 *      异地登录挤下线，服务端最终都表现为受保护接口 401）
 *   2. 非 `/api/auth/*` 内部端点（防登录流死循环）
 *   3. 当前在受保护路由（防落地页/登录页死循环）
 */
export function shouldForceLogoutOn401(
  status: number,
  url: string,
  pathname: string | null | undefined,
): boolean {
  return status === 401 && !isAuthEndpoint(url) && isProtectedPath(pathname);
}
