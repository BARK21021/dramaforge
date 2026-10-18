// ============================================================
// GET /api/admin/users/[userId]/films — 用户成片（admin 只读，对齐 app1）
// ============================================================
//
// 查 render_jobs COMPLETED CONCAT/CHAIN_COMPILE（dramaforge C/S 成片表，非 app1 task 表）。
// 返 FilmRecord[]（跨项目，前端按 projectTitle 分组）。requireAdmin 守卫。
// 响应：200 { success:true, data: FilmRecord[] } / 401 / 403 / 404
// ============================================================

import type { NextRequest } from 'next/server';
import { listUserFilmsForAdmin } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { userId } = await params;
    const films = await listUserFilmsForAdmin(userId);
    return apiSuccess(films);
  } catch (err) {
    return handleApiError(err, 'GET /api/admin/users/[userId]/films');
  }
}
