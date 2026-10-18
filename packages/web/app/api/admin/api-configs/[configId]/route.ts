// ============================================================
// /api/admin/api-configs/[configId] — 平台 key 更新 / 删除
// ============================================================
//
// 端点：
//   PATCH  — 部分更新 label/weight/isEnabled/baseUrl，或安全替换 apiKey
//   DELETE — 删除指定平台 key
//
// requireAdmin 守卫；service 层 WHERE "userId" IS NULL 守卫确保只命中平台池。
// 响应：200 { success:true, data } / 401 / 403 / 404（id 不存在）
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { updatePlatformConfig, deletePlatformConfig } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

/**
 * PATCH /api/admin/api-configs/[configId]
 *
 * body：{ label?, weight?, isEnabled?, baseUrl?, apiKey? }（仅显式提供的字段被更新）
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ configId: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { configId } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      label?: unknown;
      weight?: unknown;
      isEnabled?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
      maxConcurrent?: unknown;
    };

    const patch: {
      label?: string | null;
      weight?: number;
      isEnabled?: boolean;
      baseUrl?: string | null;
      apiKey?: string;
      maxConcurrent?: number | null;
    } = {};
    if (body.label !== undefined) {
      patch.label = typeof body.label === 'string' ? body.label : null;
    }
    if (body.weight !== undefined) {
      patch.weight = typeof body.weight === 'number' ? body.weight : 1;
    }
    if (body.isEnabled !== undefined) {
      patch.isEnabled = Boolean(body.isEnabled);
    }
    if (body.baseUrl !== undefined) {
      patch.baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : null;
    }
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      // 空字符串表示保留原 Key；只有管理员输入新值才触发替换。
      patch.apiKey = body.apiKey.trim();
    }
    // maxConcurrent：undefined=不改；显式传值才更新（含 null=清空为不限）。
    // service 层 normalizeMaxConcurrent 把非正整数归一为 null。
    if (body.maxConcurrent !== undefined) {
      patch.maxConcurrent =
        typeof body.maxConcurrent === 'number' ? body.maxConcurrent : null;
    }

    const data = await updatePlatformConfig(configId, patch);
    return apiSuccess(data);
  } catch (err) {
    return handleApiError(err, 'PATCH /api/admin/api-configs/[configId]');
  }
}

/**
 * DELETE /api/admin/api-configs/[configId]
 *
 * 删除后返回 { deleted: true }；service 层守卫确保不会误删用户 BYOK 行。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ configId: string }> },
): Promise<Response> {
  try {
    await requireAdmin();
    const { configId } = await params;
    await deletePlatformConfig(configId);
    return apiSuccess({ deleted: true });
  } catch (err) {
    return handleApiError(err, 'DELETE /api/admin/api-configs/[configId]');
  }
}
