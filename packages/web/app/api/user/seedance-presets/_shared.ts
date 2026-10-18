// ============================================================
// /api/user/seedance-presets — 路由共享守卫与错误映射
// ============================================================
// 这里只处理 HTTP 边界；字段清洗、用户隔离和事务语义统一留在 server 子域。
// ============================================================

import type { NextRequest } from 'next/server';
import { SeedancePresetError } from '@dramaforge/server';
import { requireUser, AuthError, type AuthResult } from '@web/lib/auth';
import { apiFail, handleApiError } from '@web/lib/response';

/** 获取当前用户；未登录时抛出统一的 UI-facing 认证错误。 */
export async function requirePresetUser(): Promise<AuthResult> {
  const auth = await requireUser();
  if (!auth) {
    throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
  }
  return auth;
}

/**
 * 安全读取 JSON 对象。
 *
 * 非法 JSON、数组和 null 都返回 null，由路由转换为稳定的 400 响应。
 */
export async function readPresetBody(
  request: NextRequest,
): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/** 把预设领域错误映射成稳定 envelope，其余异常交给统一兜底处理。 */
export function handlePresetRouteError(error: unknown, context: string): Response {
  if (error instanceof SeedancePresetError) {
    return apiFail(
      { error: error.message, code: error.code, category: 'validation' },
      error.statusCode,
    );
  }
  return handleApiError(error, context);
}
