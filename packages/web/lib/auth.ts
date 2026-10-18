// ============================================================
// web/lib/auth — session helper for App Router route handlers
// ============================================================
//
// 文件职责：
//   requireUser() — 调用 NextAuth v4 getServerSession(authOptions) 解析当前
//   会话，返回 { userId, role } 或 null。所有受保护路由统一通过本函数鉴权。
//   AuthError    — UI-facing 路由的认证失败 thrown 形态，携 statusCode + code，
//                  供 lib/response.ts 的 handleApiError 识别并转 401/403 envelope。
//
// 设计要点：
//   - authOptions 复用 ⑦ server/infra/auth 的 NextAuth v4 配置（Credentials +
//     JWT + 单设备登录），web 不重新实现 auth。
//   - session.user.id / role 由 ⑦ auth.ts 的 callbacks.session 注入；此处用
//     类型断言读取（server 未提供 next-auth.d.ts 模块增强）。
//   - 返回 null 表示未登录；UI-facing 路由可选择 `if (!auth) throw new AuthError(...)`
//     交由 handleApiError 统一转 envelope（app1 同款模式）。M2M 路由维持现有
//     `if (!auth) return unauthorized()` 直接返回模式不变。
//
// web 禁止 import 任何 ffmpeg 模块；本模块仅做 session 读取。
// ============================================================

import { getServerSession } from 'next-auth';
import { authOptions, getUserRoleById } from '@dramaforge/server';

/** 已认证会话的精简结果 */
export interface AuthResult {
  userId: string;
  role: string;
}

/**
 * 认证错误（UI-facing 路由用）
 *
 * 仿 app1 `core/api/auth.ts` 的 AuthError。route handler 在 requireUser 返回
 * null 时可抛出此错误，lib/response.ts 的 handleApiError 通过 instanceof 识别
 * 并转为对应 status 的失败 envelope（401/403 等）。
 *
 * M2M 路由不需要此 class —— 它们维持 `if (!auth) return unauthorized()` 的
 * 早返回模式（bare error shape），不进入 handleApiError 流。
 */
export class AuthError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 解析当前请求的 NextAuth 会话，返回 userId/role。
 *
 * @returns AuthResult（已登录）或 null（未登录）
 */
export async function requireUser(): Promise<AuthResult | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const user = session.user as { id?: string; role?: string };
  if (!user.id) return null;
  return { userId: user.id, role: user.role ?? 'FREE' };
}

/**
 * 要求管理员权限（对齐 app1 requireAdmin）。
 *
 * - 先 requireUser 拿 session（未登录 → AuthError 401）
 * - 再 DB 权威重查角色（getUserRoleById），防 JWT 角色 stale 越权：
 *   用户被降级后即使 JWT 未过期也立即失效
 * - 非 ADMIN → AuthError 403 FORBIDDEN（handleApiError 转 envelope）
 *
 * @returns AuthResult（已登录且为 ADMIN）
 * @throws AuthError 401 未登录/用户不存在 | 403 非管理员
 */
export async function requireAdmin(): Promise<AuthResult> {
  const auth = await requireUser();
  if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
  const role = await getUserRoleById(auth.userId);
  if (!role) throw new AuthError('用户不存在或已被删除', 401, 'UNAUTHORIZED');
  if (role !== 'ADMIN') throw new AuthError('需要管理员权限', 403, 'FORBIDDEN');
  return { userId: auth.userId, role };
}
