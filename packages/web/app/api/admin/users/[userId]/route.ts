// ============================================================
// GET /api/admin/users/[userId] — 用户详情 + 积分汇总（对齐 app1）
// PATCH /api/admin/users/[userId] — 管理员调参用户并发上限 maxConcurrent
// ============================================================
//
// 基本信息（含 updatedAt/maxConcurrent）+ 积分汇总（累计充值/累计消耗，按
// billing_ledger.credits 正负号）。requireAdmin 守卫。
// PATCH body: { maxConcurrent: 1-64 整数 } — 同时收紧 AI 任务槽与 render 认领上限。
// 响应：200 { success:true, data:{ user, summary } } / 401 / 403 / 404
// ============================================================

import type { NextRequest } from 'next/server';
import { getUserDetailForAdmin, updateUserConcurrency } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { userId } = await params;
    const data = await getUserDetailForAdmin(userId);
    if (!data) return apiFail({ error: '用户不存在', code: 'NOT_FOUND' }, 404);
    return apiSuccess(data);
  } catch (err) {
    return handleApiError(err, 'GET /api/admin/users/[userId]');
  }
}

/** PATCH 请求体：只接受 maxConcurrent 单字段（1-64 整数）。 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { userId } = await params;

    let body: { maxConcurrent?: unknown };
    try {
      body = (await req.json()) as { maxConcurrent?: unknown };
    } catch {
      return apiFail({ error: '无效 JSON', code: 'INVALID_BODY' }, 400);
    }
    const n = body.maxConcurrent;
    if (
      typeof n !== 'number'
      || !Number.isInteger(n)
      || n < 1
      || n > 64
    ) {
      return apiFail(
        { error: 'maxConcurrent 必须是 1-64 的整数', code: 'INVALID_MAX_CONCURRENT' },
        400,
      );
    }

    const updated = await updateUserConcurrency(userId, n);
    if (!updated) return apiFail({ error: '用户不存在', code: 'NOT_FOUND' }, 404);
    return apiSuccess({ user: updated });
  } catch (err) {
    return handleApiError(err, 'PATCH /api/admin/users/[userId]');
  }
}
