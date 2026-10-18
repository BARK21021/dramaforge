// ============================================================
// /api/user/seedance-presets — 路由契约单测
// ============================================================
// 覆盖认证、GET/POST/PUT/DELETE 参数传递和领域错误 envelope。
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
} from '../../../../../test/mocks';
import {
  makeRequest,
  makeParamsCtx,
  readJson,
} from '../../../../../test/helpers';
import { GET, POST } from '../route';
import { PUT, DELETE } from '../[presetId]/route';

/** API 返回用的稳定模板样例。 */
const PRESET = {
  id: 'preset-1',
  userId: 'user-1',
  name: '横屏高清',
  params: { resolution: '1080p' },
  isDefault: false,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
};

beforeEach(() => {
  getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
  serverMock.listSeedancePresets.mockReset().mockResolvedValue([PRESET]);
  serverMock.createSeedancePreset.mockReset().mockResolvedValue(PRESET);
  serverMock.updateSeedancePreset.mockReset().mockResolvedValue(PRESET);
  serverMock.deleteSeedancePreset.mockReset().mockResolvedValue(undefined);
});

describe('GET /api/user/seedance-presets', () => {
  it('拒绝未登录请求', async () => {
    getServerSessionMock.mockResolvedValue(null);

    const response = await GET(makeRequest({ method: 'GET' }));

    expect(response.status).toBe(401);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'UNAUTHORIZED',
    });
    expect(serverMock.listSeedancePresets).not.toHaveBeenCalled();
  });

  it('只以当前会话 userId 查询模板', async () => {
    const response = await GET(makeRequest({ method: 'GET' }));

    expect(serverMock.listSeedancePresets).toHaveBeenCalledWith('user-1');
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: [PRESET] });
  });
});

describe('POST /api/user/seedance-presets', () => {
  it('把 UI 字段交给服务层并返回 201 envelope', async () => {
    const response = await POST(
      makeRequest({
        method: 'POST',
        body: {
          name: '横屏高清',
          params: { resolution: '1080p' },
          isDefault: true,
        },
      }),
    );

    expect(serverMock.createSeedancePreset).toHaveBeenCalledWith('user-1', {
      name: '横屏高清',
      params: { resolution: '1080p' },
      isDefault: true,
    });
    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual({ success: true, data: PRESET });
  });

  it('拒绝数组请求体且不调用服务层', async () => {
    const response = await POST(makeRequest({ method: 'POST', body: [] }));

    expect(response.status).toBe(400);
    expect(serverMock.createSeedancePreset).not.toHaveBeenCalled();
  });

  it('把重名领域错误映射为稳定的 409 envelope', async () => {
    serverMock.createSeedancePreset.mockRejectedValue(
      new serverMock.SeedancePresetError(
        '模板“横屏高清”已存在，请更换名称',
        409,
        'DUPLICATE_PRESET_NAME',
      ),
    );

    const response = await POST(
      makeRequest({
        method: 'POST',
        body: { name: '横屏高清', params: { resolution: '1080p' } },
      }),
    );

    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'DUPLICATE_PRESET_NAME',
      category: 'validation',
    });
  });
});

describe('PUT /api/user/seedance-presets/[presetId]', () => {
  it('只转发支持的更新字段并携带当前 userId', async () => {
    const response = await PUT(
      makeRequest({
        method: 'PUT',
        body: { name: '竖屏', isDefault: true, ignored: '不会转发' },
      }),
      makeParamsCtx({ presetId: 'preset-1' }),
    );

    expect(serverMock.updateSeedancePreset).toHaveBeenCalledWith(
      'user-1',
      'preset-1',
      { name: '竖屏', isDefault: true },
    );
    expect(response.status).toBe(200);
  });
});

describe('DELETE /api/user/seedance-presets/[presetId]', () => {
  it('按当前 userId 删除并返回旧项目兼容的 deleted + id', async () => {
    const response = await DELETE(
      makeRequest({ method: 'DELETE' }),
      makeParamsCtx({ presetId: 'preset-1' }),
    );

    expect(serverMock.deleteSeedancePreset).toHaveBeenCalledWith('user-1', 'preset-1');
    expect(await readJson(response)).toEqual({
      success: true,
      data: { deleted: true, id: 'preset-1' },
    });
  });
});
