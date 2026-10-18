// ============================================================
// ② server/gateway — 产品文本 provider 单测（deepseek / kimi）
// ============================================================
// 两者共用 OpenAI 兼容 /chat/completions，重点验证 baseUrl 与默认温度差异。
// ============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { callDeepSeek } from '../../src/gateway/providers/deepseek';
import { callKimi } from '../../src/gateway/providers/kimi';
import { mockFetch, jsonResponse, sseResponse, bodyJson, header } from './_helpers';

describe('callDeepSeek', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POST {deepseek}/chat/completions with Bearer', async () => {
    const { calls } = mockFetch([
      {
        match: '/chat/completions',
        response: sseResponse([
          { choices: [{ delta: { content: 'ds ' }, finish_reason: null }], usage: null },
          { choices: [{ delta: { content: 'reply' }, finish_reason: 'stop' }], usage: null },
          {
            choices: [],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 1,
              prompt_cache_hit_tokens: 2,
              prompt_cache_miss_tokens: 1,
            },
          },
        ]),
      },
    ]);

    const r = await callDeepSeek(
      'deepseek/deepseek-chat',
      { capability: 'text_generation', input: { messages: [{ role: 'user', content: 'hi' }] } },
      { apiKey: 'ds-key', baseUrl: 'https://api.deepseek.com/v1' },
    );

    expect(r.meta?.content).toBe('ds reply');
    const call = calls[0];
    expect(call.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(header(call, 'Authorization')).toBe('Bearer ds-key');
    expect(bodyJson(call)).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(r.meta?.tokensUsed).toEqual({
      input: 3,
      output: 1,
      cacheHit: 2,
      cacheMiss: 1,
    });
  });
});

describe('callKimi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses max_completion_tokens (not max_tokens) for moonshot', async () => {
    const { calls } = mockFetch([
      {
        match: '/chat/completions',
        response: jsonResponse({
          choices: [{ message: { content: 'kimi' } }],
          usage: {},
        }),
      },
    ]);

    await callKimi(
      'kimi/kimi-k1.5',
      {
        capability: 'text_generation',
        input: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 },
      },
      { apiKey: 'kimi-key', baseUrl: 'https://api.moonshot.cn/v1' },
    );

    const call = calls[0];
    expect(call.url).toBe('https://api.moonshot.cn/v1/chat/completions');
    expect(header(call, 'Authorization')).toBe('Bearer kimi-key');
    const body = bodyJson(call);
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
  });

  it('default temperature 1 for kimi', async () => {
    const { calls } = mockFetch([
      {
        match: '/chat/completions',
        response: jsonResponse({ choices: [{ message: { content: 'x' } }] }),
      },
    ]);

    await callKimi(
      'kimi/kimi-k1.5',
      { capability: 'text_generation', input: { messages: [{ role: 'user', content: 'hi' }] } },
      { apiKey: 'k', baseUrl: 'https://api.moonshot.cn/v1' },
    );

    expect(bodyJson(calls[0]).temperature).toBe(1);
  });
});
