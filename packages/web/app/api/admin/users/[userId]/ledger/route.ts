// ============================================================
// GET /api/admin/users/[userId]/ledger — 用户账本明细（对齐 app1）
// ============================================================
//
// tab 过滤（type 参数：'' 全部 | 'recharge' 充值 | 'consume' 消耗）+ 分页。
// requireAdmin 守卫。
// 响应：200 { success:true, data:{ entries, total, page, pageSize } } / 401 / 403 / 404
// ============================================================

import type { NextRequest } from 'next/server';
import { listLedgerForAdmin } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { userId } = await params;
    const sp = req.nextUrl.searchParams;
    const filter = (sp.get('type') ?? '').trim(); // '' | 'recharge' | 'consume'
    const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') ?? '50', 10) || 50));
    const data = await listLedgerForAdmin(userId, { filter, page, pageSize });
    return apiSuccess(data);
  } catch (err) {
    return handleApiError(err, 'GET /api/admin/users/[userId]/ledger');
  }
}
