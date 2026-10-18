// ============================================================
// GET /api/admin/stats — 平台指标（admin 顶部汇总卡用）
// ============================================================
//
// 4 指标 + 总用户：总消耗积分 / 充值总积分 / 用户氪金总金额 / 利润（氪金−AI成本）/ 总用户。
// 数据源：billing_ledger（credits 正负号 + metadata.cost）+ payment_orders（PAID amount_yuan）+ users。
// requireAdmin 守卫。
// 响应：200 { success:true, data: AdminStats } / 401 / 403
// ============================================================

import type { NextRequest } from 'next/server';
import { getAdminStats } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

export async function GET(_req: NextRequest): Promise<Response> {
  try {
    await requireAdmin();
    const stats = await getAdminStats();
    return apiSuccess(stats);
  } catch (err) {
    return handleApiError(err, 'GET /api/admin/stats');
  }
}
