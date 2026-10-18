// ============================================================
// /api/user/seedance-presets/[presetId] — 当前用户模板更新 / 删除
// ============================================================
// PUT 支持 name、params、isDefault 部分更新；DELETE 删除指定模板。
// server 子域会同时匹配 presetId + userId，杜绝跨用户读写。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  updateSeedancePreset,
  deleteSeedancePreset,
} from '@dramaforge/server';
import { apiSuccess, apiFail } from '@web/lib/response';
import {
  requirePresetUser,
  readPresetBody,
  handlePresetRouteError,
} from '../_shared';

/** Next.js 动态路由上下文。 */
interface PresetRouteContext {
  params: Promise<{ presetId: string }>;
}

/** PUT /api/user/seedance-presets/[presetId] — 部分更新当前用户模板。 */
export async function PUT(
  request: NextRequest,
  context: PresetRouteContext,
): Promise<Response> {
  try {
    const auth = await requirePresetUser();
    const { presetId } = await context.params;
    const body = await readPresetBody(request);
    if (!body) {
      return apiFail(
        { error: '请求体必须是 JSON 对象', code: 'VALIDATION_ERROR' },
        400,
      );
    }

    // 仅把支持的字段交给服务层；服务层仍会校验类型并拒绝空更新。
    const patch: { name?: unknown; params?: unknown; isDefault?: unknown } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'name')) patch.name = body.name;
    if (Object.prototype.hasOwnProperty.call(body, 'params')) patch.params = body.params;
    if (Object.prototype.hasOwnProperty.call(body, 'isDefault')) {
      patch.isDefault = body.isDefault;
    }

    const preset = await updateSeedancePreset(auth.userId, presetId, patch);
    return apiSuccess(preset);
  } catch (error) {
    return handlePresetRouteError(error, 'PUT /api/user/seedance-presets/[presetId]');
  }
}

/** DELETE /api/user/seedance-presets/[presetId] — 删除当前用户模板。 */
export async function DELETE(
  _request: NextRequest,
  context: PresetRouteContext,
): Promise<Response> {
  try {
    const auth = await requirePresetUser();
    const { presetId } = await context.params;
    await deleteSeedancePreset(auth.userId, presetId);
    return apiSuccess({ deleted: true, id: presetId });
  } catch (error) {
    return handlePresetRouteError(error, 'DELETE /api/user/seedance-presets/[presetId]');
  }
}
