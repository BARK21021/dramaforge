// ============================================================
// ② server/gateway — OpenAI provider 单测
// ============================================================
// 断言：text/image 请求 URL、Authorization 头、body 形状。
// mock fetch，无真实 API 调用。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callOpenAI } from '../../src/gateway/providers/openai';
import { mockFetch, jsonResponse, bodyJson, header, type FetchCall } from './_helpers';

const CRED = { apiKey: 'sk-test-openai-key', baseUrl: 'https://api.openai.com/v1' };

describe('callOpenAI', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('text_generation: POST /chat/completions with Bearer + correct body', async () => {
    const { calls } = mockFetch([
      {
        match: '/chat/completions',
        response: jsonResponse({
          choices: [{ message: { content: 'hello world' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      },
    ]);

    const result = await callOpenAI(
      'openai/gpt-4o',
      {
        capability: 'text_generation',
        input: {
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0.3,
          maxTokens: 1000,
        },
      },
      CRED,
    );

    expect(result.url).toBe('');
    expect(result.meta?.content).toBe('hello world');
    expect(result.meta?.tokensUsed).toEqual({ input: 5, output: 2 });

    const call = calls[0];
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.init?.method).toBe('POST');
    expect(header(call, 'Authorization')).toBe('Bearer sk-test-openai-key');
    expect(header(call, 'Content-Type')).toBe('application/json');

    const body = bodyJson(call);
    expect(body.model).toBe('gpt-4o'); // 剥离了 provider/ 前缀
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(1000);
    expect(body.stream).toBe(false);
  });

  it('image_generation: POST /images/generations with size + prompt', async () => {
    const { calls } = mockFetch([
      {
        match: '/images/generations',
        response: jsonResponse({
          data: [{ url: 'https://cdn.openai.com/img1.png' }],
        }),
      },
    ]);

    const result = await callOpenAI(
      'gpt-image-1',
      {
        capability: 'image_generation',
        input: { prompt: 'a cat', width: 768, height: 1024, count: 1 },
      },
      CRED,
    );

    expect(result.url).toBe('https://cdn.openai.com/img1.png');
    expect(result.meta?.images).toEqual([
      { url: 'https://cdn.openai.com/img1.png', width: 768, height: 1024 },
    ]);

    const call = calls[0];
    expect(call.url).toBe('https://api.openai.com/v1/images/generations');
    expect(header(call, 'Authorization')).toBe('Bearer sk-test-openai-key');

    const body = bodyJson(call);
    expect(body.prompt).toBe('a cat');
    expect(body.size).toBe('768x1024');
    expect(body.n).toBe(1);
    expect(body.model).toBe('gpt-image-1');
  });

  it('throws on unsupported capability', async () => {
    mockFetch([]);
    await expect(
      callOpenAI('gpt-4o', { capability: 'tts', input: {} }, CRED),
    ).rejects.toThrow('OpenAI 不支持的能力: tts');
  });

  it('uses default size 1024x1024 when width/height absent', async () => {
    const { calls } = mockFetch([
      {
        match: '/images/generations',
        response: jsonResponse({ data: [{ url: 'https://x/y.png' }] }),
      },
    ]);

    await callOpenAI(
      'gpt-image-1',
      { capability: 'image_generation', input: { prompt: 'x' } },
      CRED,
    );

    expect(bodyJson(calls[0]).size).toBe('1024x1024');
  });
});
