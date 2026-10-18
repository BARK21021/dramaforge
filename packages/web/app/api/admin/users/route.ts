// ============================================================
// GET /api/admin/users — 管理员用户列表（对齐 app1 admin/users）
// ============================================================
//
// 搜索 email/phone/name（q）+ 分页。requireAdmin 守卫（DB 权威角色）。
// 响应：200 { success:true, data:{ users, total, page, pageSize } } / 401 / 403
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { listUsersForAdmin } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireAdmin();
    const sp = req.nextUrl.searchParams;
    const q = sp.get('q') ?? '';
    const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') ?? '50', 10) || 50));
    const data = await listUsersForAdmin({ q, page, pageSize });
    return apiSuccess(data);
  } catch (err) {
    return handleApiError(err, 'GET /api/admin/users');
  }
}
