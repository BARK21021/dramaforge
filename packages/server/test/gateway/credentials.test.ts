// 凭证来源测试：C/S 只使用管理员平台池，禁止服务器环境变量绕过后台设置。
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 会提升到模块顶部，相关 spy 也必须由 vi.hoisted 提前初始化。
const { queryMock, pickMock, pickByIdMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  pickMock: vi.fn(),
  pickByIdMock: vi.fn(),
}));

vi.mock('@server/infra', () => ({ query: queryMock }));
vi.mock('../../src/gateway/api-key-pool', () => ({
  getApiKeyPool: () => ({ pick: pickMock, pickById: pickByIdMock }),
}));

import { getCredential } from '../../src/gateway/credentials';

describe('getCredential platform pool priority', () => {
  beforeEach(() => {
    queryMock.mockReset();
    pickMock.mockReset();
    pickByIdMock.mockReset();
  });

  it('uses the weighted administrator platform pool', async () => {
    pickMock.mockResolvedValue({
      configId: 'platform-1',
      apiKey: 'platform-secret',
      provider: 'deepseek',
      weight: 8,
      baseUrl: null,
      label: '主池',
    });

    await expect(getCredential('deepseek', 'user-1')).resolves.toMatchObject({
      configId: 'platform-1',
      apiKey: 'platform-secret',
    });
    // 平台池已命中时不得查询其他凭证记录，否则管理员启停会失效。
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects when the administrator pool is empty even if an environment key exists', async () => {
    pickMock.mockResolvedValue(null);
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'environment-secret';

    try {
      await expect(getCredential('deepseek', 'user-1')).rejects.toThrow(
        '管理员 API Key 池未配置可用 Key',
      );
      // 普通选取不查询用户级记录，避免重新形成第二套凭证来源。
      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});
