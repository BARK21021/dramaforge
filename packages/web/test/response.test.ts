// ============================================================
// lib/response — UI-facing envelope helpers (apiSuccess / apiFail / handleApiError)
// ============================================================
//
// 覆盖：
//   - apiSuccess: 默认 200 + 自定义 status + data 透传 + 仅 success/data 两键
//   - apiFail:    默认 400 + 自定义 status + 可选字段提供时出现/未提供时不出现在 JSON
//   - handleApiError:
//       * AuthError   → 401 envelope（透传 code）
//       * ZodError    → 400 envelope（code=VALIDATION_ERROR，error 含校验信息）
//       * 普通 Error   → 500 envelope（code=INTERNAL_ERROR）
//       * 非 Error 值  → 500 envelope
//
// GC-4 契约（binding）：
//   成功: { success: true, data }                          （仅这两键）
//   失败: { success: false, error, code?, category?,
//           retryable?, suggestion? }                       （仅这 6 键）
//
// 不 mock 任何东西 —— 直接驱动真实 helper 与真实 zod 抛错。
// ============================================================

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { apiSuccess, apiFail, handleApiError } from '../lib/response';
import { AuthError } from '../lib/auth';

function bodyKeys(res: Response): Promise<Set<string>> {
  return res.json().then((b) => new Set(Object.keys(b)));
}

describe('apiSuccess', () => {
  it('returns 200 with { success: true, data } by default', async () => {
    const res = apiSuccess({ id: 1, name: 'foo' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { id: 1, name: 'foo' } });
  });

  it('only has success and data keys (no extras)', async () => {
    const res = apiSuccess('hello');
    expect(await bodyKeys(res)).toEqual(new Set(['success', 'data']));
  });

  it('accepts a custom status code (e.g., 201)', async () => {
    const res = apiSuccess({ id: 7 }, 201);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ id: 7 });
  });

  it('passes data verbatim (object / array / primitive / null)', async () => {
    expect((await apiSuccess([1, 2, 3]).json()).data).toEqual([1, 2, 3]);
    expect((await apiSuccess('x').json()).data).toBe('x');
    expect((await apiSuccess(null).json()).data).toBeNull();
  });
});

describe('apiFail', () => {
  it('returns 400 with { success: false, error } minimum', async () => {
    const res = apiFail({ error: '出错了' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('出错了');
  });

  it('includes optional fields when provided', async () => {
    const res = apiFail({
      error: '额度不足',
      code: 'QUOTA_INSUFFICIENT',
      category: 'provider',
      retryable: true,
      suggestion: '请充值后重试',
    });
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: '额度不足',
      code: 'QUOTA_INSUFFICIENT',
      category: 'provider',
      retryable: true,
      suggestion: '请充值后重试',
    });
  });

  it('omits optional fields entirely when not provided (not null/undefined)', async () => {
    const res = apiFail({ error: '出错了' });
    expect(await bodyKeys(res)).toEqual(new Set(['success', 'error']));
  });

  it('accepts a custom status code', async () => {
    const res = apiFail({ error: 'not found', code: 'NOT_FOUND' }, 404);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('NOT_FOUND');
  });
});

describe('handleApiError', () => {
  it('maps AuthError → 401 envelope, forwarding the code', async () => {
    const err = new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const res = handleApiError(err);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('未登录或登录已过期');
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('maps AuthError with 403 (forbidden) when status code is 403', async () => {
    const err = new AuthError('需要管理员权限', 403, 'FORBIDDEN');
    const res = handleApiError(err);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');
  });

  it('maps ZodError → 400 envelope with VALIDATION_ERROR code', async () => {
    let thrown: unknown;
    try {
      z.object({ url: z.string() }).parse({ url: 123 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(z.ZodError);

    const res = handleApiError(thrown);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('maps generic Error → 500 envelope with INTERNAL_ERROR code', async () => {
    const res = handleApiError(new Error('boom'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('boom');
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('maps non-Error thrown value → 500 envelope', async () => {
    const res = handleApiError('string thrown');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});
