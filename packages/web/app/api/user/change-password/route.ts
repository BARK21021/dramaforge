import type { NextRequest } from 'next/server';
import { changeUserPassword, rateLimitAllow } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { readBodyWithLimit } from '@web/lib/sms-security';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const BODY_LIMIT_BYTES = 4096;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `新密码至少需要 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return '新密码过长（最多 72 字节）';
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '新密码必须同时包含字母和数字';
  }
  return null;
}

/** POST /api/user/change-password — 验证当前密码后更新凭据。 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    const bodyResult = await readBodyWithLimit<{
      oldPassword?: unknown;
      newPassword?: unknown;
    }>(request, BODY_LIMIT_BYTES);
    if (!bodyResult.ok) {
      return apiFail(bodyResult.payload, bodyResult.status);
    }

    const { oldPassword, newPassword } = bodyResult.body;
    if (typeof oldPassword !== 'string' || oldPassword.length === 0) {
      return apiFail(
        { error: '当前密码不能为空', code: 'VALIDATION_ERROR' },
        400,
      );
    }
    if (typeof newPassword !== 'string' || newPassword.length === 0) {
      return apiFail(
        { error: '新密码不能为空', code: 'VALIDATION_ERROR' },
        400,
      );
    }
    if (oldPassword === newPassword) {
      return apiFail(
        { error: '新密码不能与当前密码相同', code: 'VALIDATION_ERROR' },
        400,
      );
    }
    const passwordError = validateNewPassword(newPassword);
    if (passwordError) {
      return apiFail(
        { error: passwordError, code: 'WEAK_PASSWORD' },
        400,
      );
    }

    const allowed = await rateLimitAllow(
      `auth:change-password:user:${auth.userId}`,
      RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_MAX,
    );
    if (!allowed) {
      return apiFail(
        {
          error: '操作过于频繁，请稍后再试',
          code: 'RATE_LIMITED',
          retryable: true,
        },
        429,
      );
    }

    const result = await changeUserPassword(
      auth.userId,
      oldPassword,
      newPassword,
    );
    if (!result.changed) {
      if (result.reason === 'INVALID_CURRENT_PASSWORD') {
        return apiFail(
          { error: '当前密码错误', code: 'INVALID_CURRENT_PASSWORD' },
          400,
        );
      }
      return apiFail(
        { error: '用户不存在', code: 'NOT_FOUND' },
        404,
      );
    }

    return apiSuccess({ changed: true });
  } catch (error) {
    return handleApiError(error, 'POST /api/user/change-password');
  }
}
