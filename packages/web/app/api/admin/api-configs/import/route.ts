// POST /api/admin/api-configs/import — 管理员批量导入已在客户端解析的 Key 项。
// 路由不记录请求体；响应只含掩码 Key，明文不会回显。

import type { NextRequest } from 'next/server';
import { importPlatformConfigs } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';

export async function POST(request: NextRequest): Promise<Response> {
  try {
    await requireAdmin();
    const body = await request.json().catch(() => null) as { items?: unknown } | null;
    if (!body || !Array.isArray(body.items)) {
      return apiFail({ error: 'items 必须是数组', code: 'BAD_IMPORT_ITEMS' }, 400);
    }
    const items = body.items.map((raw) => {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return {
        provider: typeof item.provider === 'string' ? item.provider : '',
        apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
        label: typeof item.label === 'string' ? item.label : null,
      };
    });
    return apiSuccess(await importPlatformConfigs(items), 201);
  } catch (error) {
    return handleApiError(error, 'POST /api/admin/api-configs/import');
  }
}
