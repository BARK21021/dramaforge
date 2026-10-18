// ============================================================
// /api/user/seedance-presets — 当前用户模板列表 / 创建
// ============================================================
// GET 返回默认模板置顶的列表；POST 保存经过白名单清洗的 Seedance 参数。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  listSeedancePresets,
  createSeedancePreset,
} from '@dramaforge/server';
import { apiSuccess, apiFail } from '@web/lib/response';
import {
  requirePresetUser,
  readPresetBody,
  handlePresetRouteError,
} from './_shared';

/** GET /api/user/seedance-presets — 只列出当前登录用户的模板。 */
export async function GET(_request: NextRequest): Promise<Response> {
  try {
    const auth = await requirePresetUser();
    const presets = await listSeedancePresets(auth.userId);
    return apiSuccess(presets);
  } catch (error) {
    return handlePresetRouteError(error, 'GET /api/user/seedance-presets');
  }
}

/** POST /api/user/seedance-presets — 创建当前用户的参数模板。 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const auth = await requirePresetUser();
    const body = await readPresetBody(request);
    if (!body) {
      return apiFail(
        { error: '请求体必须是 JSON 对象', code: 'VALIDATION_ERROR' },
        400,
      );
    }

    // 字段类型与 Seedance 白名单由服务层统一校验，避免不同入口规则漂移。
    const preset = await createSeedancePreset(auth.userId, {
      name: body.name,
      params: body.params,
      isDefault: body.isDefault,
    });
    return apiSuccess(preset, 201);
  } catch (error) {
    return handlePresetRouteError(error, 'POST /api/user/seedance-presets');
  }
}
