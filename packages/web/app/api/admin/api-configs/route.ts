// ============================================================
// /api/admin/api-configs — 平台 API key 池 列表 / 新建（GC-1 非 BYOK）
// ============================================================
//
// 端点：
//   GET  — 列出所有平台 key（"userId" IS NULL），apiKey 已掩码
//   POST — 新建平台 key（provider + apiKey 必填；label/weight/baseUrl 可选）
//
// requireAdmin 守卫（DB 权威角色重查，防 JWT stale 越权）。
// 响应：200/201 { success:true, data } / 400 / 401 / 403
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { listPlatformConfigs, createPlatformConfig } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/**
 * GET /api/admin/api-configs — 平台 key 列表。
 *
 * 返回 ApiConfigView[]（apiKeyMasked 掩码；GC-1 安全约束：明文永不外泄）。
 *
 * 注：req 参数未使用（list 无搜索/分页参数），保留是为对齐 Next.js route handler
 * 签名约定 + 其他 admin/* 路由风格（GET(req)）。
 */
export async function GET(_req: NextRequest): Promise<Response> {
  try {
    await requireAdmin();
    const data = await listPlatformConfigs();
    return apiSuccess(data);
  } catch (err) {
    return handleApiError(err, 'GET /api/admin/api-configs');
  }
}

/**
 * POST /api/admin/api-configs — 新建平台 key。
 *
 * body：{ provider:string, apiKey:string, label?:string, weight?:number, baseUrl?:string }
 * 创建时强制 "userId"=NULL（平台 key），"keyStatus"='active'，"isEnabled"=true。
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => null)) as {
      provider?: unknown;
      apiKey?: unknown;
      label?: unknown;
      weight?: unknown;
      baseUrl?: unknown;
      maxConcurrent?: unknown;
    } | null;

    if (!body || typeof body.provider !== 'string' || !body.provider.trim()) {
      return apiFail({ error: 'provider 不能为空', code: 'BAD_PROVIDER' }, 400);
    }
    if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
      return apiFail({ error: 'apiKey 不能为空', code: 'BAD_API_KEY' }, 400);
    }

    const data = await createPlatformConfig({
      provider: body.provider,
      apiKey: body.apiKey,
      label: typeof body.label === 'string' ? body.label : null,
      weight: typeof body.weight === 'number' ? body.weight : 1,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : null,
      // service 层 normalizeMaxConcurrent 统一规范化（正整数floor 否则 null=不限）。
      maxConcurrent: typeof body.maxConcurrent === 'number' ? body.maxConcurrent : null,
    });
    return apiSuccess(data, 201);
  } catch (err) {
    return handleApiError(err, 'POST /api/admin/api-configs');
  }
}
