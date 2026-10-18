// 管理员按需查看单条平台 Key；常规列表继续只返回掩码，减少批量泄露风险。
import type { NextRequest } from 'next/server';
import { revealPlatformConfigKey } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

/** GET /api/admin/api-configs/[configId]/secret — 仅管理员可查看指定 Key 明文。 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ configId: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { configId } = await params;
    const response = apiSuccess({ apiKey: await revealPlatformConfigKey(configId) });
    // 密钥响应不允许浏览器、代理或 CDN 缓存。
    response.headers.set('Cache-Control', 'no-store, private');
    return response;
  } catch (error) {
    return handleApiError(error, 'GET /api/admin/api-configs/[configId]/secret');
  }
}
