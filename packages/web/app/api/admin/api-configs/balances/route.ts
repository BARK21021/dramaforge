// GET /api/admin/api-configs/balances — 平台 Key 实时余额（admin-only）
// 原始 Key 只在 server domain 内参与供应商请求，本路由仅返回脱敏的统一余额视图。

import type { NextRequest } from 'next/server';
import { listPlatformConfigBalances } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

export async function GET(_request: NextRequest): Promise<Response> {
  try {
    await requireAdmin();
    return apiSuccess(await listPlatformConfigBalances());
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/api-configs/balances');
  }
}
