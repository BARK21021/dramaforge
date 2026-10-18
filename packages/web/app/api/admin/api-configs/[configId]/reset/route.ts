// ============================================================
// /api/admin/api-configs/[configId]/reset — 重置平台 key 状态
// ============================================================
//
// 端点：POST — 把 cooldown/invalid 的 key 重置回 active（清 disabledUntil +
// consecutiveFailures + lastErrorMessage）。admin 修复坏 key（换新值/解除限流）后手动重置。
//
// requireAdmin 守卫；service 层 WHERE "userId" IS NULL 守卫确保只命中平台池。
// 响应：200 { success:true, data: ApiConfigView } / 401 / 403 / 404
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { resetConfigStatus } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

/**
 * POST /api/admin/api-configs/[configId]/reset
 *
 * 重置后 key 重新进入加权轮询候选池（keyStatus=active）。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ configId: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { configId } = await params;
    const data = await resetConfigStatus(configId);
    return apiSuccess(data);
  } catch (err) {
    return handleApiError(err, 'POST /api/admin/api-configs/[configId]/reset');
  }
}
