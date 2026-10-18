// ============================================================
// POST /api/admin/api-configs/test — 平台 key 连通性测试
// ============================================================
//
// body：{ configId:string }
// 调用 testConfig 对指定 key 做轻量 ping（GET /models Bearer，8s 超时）。
//
// 注意路由优先级：Next.js App Router 静态段 'test' 优先于 [configId] 动态段，
// 故 /api/admin/api-configs/test 不会进 [configId] 路由。
//
// requireAdmin 守卫；响应：200 { success:true, data:{ ok, message } } / 400 / 401 / 403 / 404
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { testConfig } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => null)) as { configId?: unknown } | null;
    if (!body || typeof body.configId !== 'string' || !body.configId.trim()) {
      return apiFail({ error: 'configId 不能为空', code: 'BAD_CONFIG_ID' }, 400);
    }
    const result = await testConfig(body.configId);
    return apiSuccess(result);
  } catch (err) {
    return handleApiError(err, 'POST /api/admin/api-configs/test');
  }
}
