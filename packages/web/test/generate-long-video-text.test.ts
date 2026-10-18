// ============================================================
// /api/generate/long-video-text — 转绘 X3.3 DeepSeek 文本生成 route 测试
// ============================================================
//
// 覆盖：
//   - 401 未登录
//   - 400 缺 messages / 空数组 / 非法元素
//   - 200 happy path：deepseek text_generation，返回 content+finishReason+provider
//   - 余额熔断回退：deepseek 429 → kimi 成功 → provider:'kimi'
//   - 默认 model=deepseek/deepseek-v4-flash；显式 model + fallbackModel 透传
//   - 两 provider 都败 → GatewayError 映射 status + retryable
//
// mock：@dramaforge/server（callAI=vi.fn / GatewayError 真实 class）+ getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { getServerSessionMock, serverMock, DEFAULT_SESSION } from './mocks';
import { makeRequest, readJson } from './helpers';
import { POST } from '../app/api/generate/long-video-text/route';

const { GatewayError } = serverMock;

const MESSAGES = [{ role: 'system', content: '你是大纲生成器' }, { role: 'user', content: '生成大纲' }];

describe('POST /api/generate/long-video-text (转绘 X3.3 DeepSeek 文本生成)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.callAI.mockReset();
  });

  it('401 未登录时不调 callAI', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(makeRequest({ method: 'POST', body: { messages: MESSAGES } }));
    expect(res.status).toBe(401);
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('400 缺 messages', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { temperature: 0.5 } }));
    expect(res.status).toBe(400);
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('400 messages 空数组', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { messages: [] } }));
    expect(res.status).toBe(400);
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('200 happy path：deepseek text_generation 返回 content+finishReason+provider', async () => {
    serverMock.callAI.mockResolvedValue({
      url: '',
      meta: {
        content: '第1集…第N集…',
        finishReason: 'stop',
        tokensUsed: { input: 1200, output: 3400 },
      },
    });
    const res = await POST(
      makeRequest({
        method: 'POST',
        body: { messages: MESSAGES, temperature: 0.3, maxTokens: 8000 },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { content: string; finishReason: string; provider: string; tokensUsed: { input: number; output: number } };
    };
    expect(body.success).toBe(true);
    expect(body.data.content).toBe('第1集…第N集…');
    expect(body.data.finishReason).toBe('stop');
    expect(body.data.provider).toBe('deepseek');
    expect(body.data.tokensUsed).toEqual({ input: 1200, output: 3400 });

    expect(serverMock.callAI).toHaveBeenCalledTimes(1);
    const [provider, model, payload] = serverMock.callAI.mock.calls[0];
    expect(provider).toBe('deepseek');
    expect(model).toBe('deepseek/deepseek-v4-flash');
    expect(payload.capability).toBe('text_generation');
    expect(payload.input.messages).toEqual(MESSAGES);
    expect(payload.input.temperature).toBe(0.3);
    expect(payload.input.maxTokens).toBe(8000);
  });

  it('余额熔断回退：deepseek reject(429) 重试耗尽 → kimi 成功 → provider=kimi', async () => {
    serverMock.callAI
      .mockRejectedValueOnce(new GatewayError('deepseek', 'rate limited', 429, 5000))
      .mockRejectedValueOnce(new GatewayError('deepseek', 'rate limited', 429, 5000))
      .mockResolvedValueOnce({
        meta: { content: 'kimi 兜底', finishReason: 'stop', tokensUsed: { input: 0, output: 0 } },
      });
    const res = await POST(makeRequest({ method: 'POST', body: { messages: MESSAGES } }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { data: { provider: string } };
    expect(body.data.provider).toBe('kimi');
  });

  it('显式 model + fallbackModel 透传', async () => {
    serverMock.callAI.mockResolvedValue({ meta: { content: 'c', finishReason: 'stop' } });
    await POST(
      makeRequest({
        method: 'POST',
        body: { messages: MESSAGES, model: 'deepseek/deepseek-v4-flash', fallbackModel: 'kimi-k2.6' },
      }),
    );
    expect(serverMock.callAI.mock.calls[0][1]).toBe('deepseek/deepseek-v4-flash');
  });

  it('两 provider 都败 → GatewayError 映射 status + retryable', async () => {
    serverMock.callAI.mockRejectedValue(new GatewayError('deepseek', 'down', 503, null));
    const res = await POST(makeRequest({ method: 'POST', body: { messages: MESSAGES } }));
    // deepseek 重试 2 次都 503 → 回退 kimi 也 mockRejectedValue(同) → 抛 GatewayError
    expect(res.status).toBe(503);
    const body = (await readJson(res)) as { success: boolean; retryable?: boolean; code?: string };
    expect(body.success).toBe(false);
    expect(body.retryable).toBe(true);
    expect(body.code).toBe('PROVIDER_ERROR');
  });
});
