// ============================================================
// ② server/gateway — callAI 统一入口单测（分发 + 错误归一化）
// ============================================================
//
// 覆盖：
//   - 分发到正确 provider（openai / ark_intl → callArk）
//   - 不支持的 provider → GatewayError
//   - 401 → GatewayError(status=401)
//   - 429 + Retry-After → GatewayError(status=429, retryAfter)
//   - key 缺失 → GatewayError
//   - payload 归一化校验
//
// mock 管理员 Key 池 + global fetch。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callAI, PROVIDERS, GatewayError } from '../../src/gateway/index';
import { jsonResponse } from './_helpers';

// 网关单测只验证分发与错误归一化，因此用可控的管理员池替代真实数据库。
const { pickMock, recordSuccessMock, recordFailureMock } = vi.hoisted(() => ({
  pickMock: vi.fn(),
  recordSuccessMock: vi.fn(),
  recordFailureMock: vi.fn(),
}));

vi.mock('../../src/gateway/api-key-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/gateway/api-key-pool')>();
  return {
    ...actual,
    getApiKeyPool: () => ({
      pick: pickMock,
      pickById: vi.fn(),
      recordSuccess: recordSuccessMock,
      recordFailure: recordFailureMock,
      // callAI finally 块会调 release() 释放在途名额（与 pick 预留配对）；
      // 缺少此方法会让所有走真实 callAI 路径的用例在 finally 抛 TypeError。
      release: vi.fn(),
    }),
  };
});

describe('callAI', () => {
  beforeEach(() => {
    pickMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    // 每个 provider 默认从同一个管理员池模型取得测试 Key。
    pickMock.mockImplementation(async (provider: string) => ({
      configId: `pool-${provider}`,
      apiKey: `admin-${provider}-key`,
      weight: 1,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PROVIDERS excludes platforms that are not part of the product', () => {
    expect(PROVIDERS).toHaveLength(9);
    for (const p of [
      'ark', 'ark_intl', 'openai', 'google', 'deepseek',
      'kimi', 'minimax', 'grok', 'comfyui',
    ]) {
      expect(PROVIDERS).toContain(p);
    }
    for (const removed of ['dashscope', 'fal', 'vidu', 'siliconflow']) {
      expect(PROVIDERS).not.toContain(removed);
    }
  });

  it('dispatches to openai with an administrator-pool key', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ url: 'https://o.ai/img.png' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callAI('openai', 'gpt-image-1', {
      capability: 'image_generation',
      input: { prompt: 'cat' },
    });

    expect(result.url).toBe('https://o.ai/img.png');
    // Authorization 只能使用管理员池选中的 Key。
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer admin-openai-key');
  });

  it('ark_intl dispatches to callArk with overseas baseUrl', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/images/generations')) {
        return jsonResponse({ data: [{ url: 'https://ark/img.png' }] });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callAI('ark_intl', 'seedream-3', {
      capability: 'image_generation',
      input: { prompt: 'p', width: 2560, height: 1440 },
    });

    expect(result.url).toBe('https://ark/img.png');
    // URL 应该走海外端点
    expect(fetchMock.mock.calls[0][0]).toContain('ark.ap-southeast.bytepluses.com');
  });

  it('throws GatewayError for unsupported provider', async () => {
    await expect(
      callAI('unknown-prov', 'm', { capability: 'text_generation', input: {} }),
    ).rejects.toMatchObject({
      name: 'GatewayError',
      provider: 'unknown-prov',
    });
  });

  it('401 → GatewayError with status=401', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":"invalid api key"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await callAI('openai', 'gpt-4o', {
        capability: 'text_generation',
        input: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      const ge = err as GatewayError;
      expect(ge.provider).toBe('openai');
      expect(ge.status).toBe(401);
      expect(ge.message).toContain('401');
    }
  });

  it('429 + Retry-After → GatewayError with status=429 and retryAfter', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await callAI('openai', 'gpt-4o', {
        capability: 'text_generation',
        input: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      const ge = err as GatewayError;
      expect(ge.status).toBe(429);
      expect(ge.retryAfter).toBe(30_000); // 30s → 30000ms
    }
  });

  it('missing key → GatewayError', async () => {
    // 管理员池为空时不得读取服务器环境变量或用户级记录。
    pickMock.mockResolvedValue(null);
    await expect(
      callAI('openai', 'gpt-4o', {
        capability: 'text_generation',
        input: { messages: [{ role: 'user', content: 'hi' }] },
      }),
    ).rejects.toMatchObject({ name: 'GatewayError', provider: 'openai' });
  });

  it('invalid payload (no capability) → GatewayError', async () => {
    await expect(
      callAI('openai', 'gpt-4o', { input: {} } as unknown as never),
    ).rejects.toMatchObject({ name: 'GatewayError', provider: 'openai' });
  });

  it('provider-thrown Error wraps into GatewayError with null status', async () => {
    // FAL unknown model → callFal throws "FAL 未配置端点"
    await expect(
      callAI('fal', 'unknown-model', {
        capability: 'image_generation',
        input: { prompt: 'x' },
      }),
    ).rejects.toMatchObject({
      name: 'GatewayError',
      provider: 'fal',
      status: null,
    });
  });
});
