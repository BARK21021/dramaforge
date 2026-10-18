// ============================================================
// ② server/gateway — Google provider 单测（?key= URL 鉴权）
// ============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { callGoogle } from '../../src/gateway/providers/google';
import { mockFetch, jsonResponse, bodyJson } from './_helpers';

describe('callGoogle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('image_generation: POST /models/{model}:predict?key= ', async () => {
    const { calls } = mockFetch([
      {
        match: ':predict?key=',
        response: jsonResponse({
          predictions: [{ bytesBase64Encoded: 'BASE64BYTES' }],
        }),
      },
    ]);

    const result = await callGoogle(
      'google/imagen-3.0',
      {
        capability: 'image_generation',
        input: { prompt: 'a dog', count: 1, width: 1024, height: 1024 },
      },
      { apiKey: 'google-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    );

    expect(result.url).toBe('data:image/png;base64,BASE64BYTES');
    expect(result.meta?.images).toHaveLength(1);

    const call = calls[0];
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0:predict?key=google-key',
    );
    expect(call.init?.method).toBe('POST');
    // Google 不用 Authorization 头，key 在 URL query
    const body = bodyJson(call);
    expect(body.instances).toEqual([{ prompt: 'a dog' }]);
    expect(body.parameters).toEqual({ sampleCount: 1 });
  });

  it('text_generation: POST :generateContent?key= with contents/systemInstruction', async () => {
    const { calls } = mockFetch([
      {
        match: ':generateContent?key=',
        response: jsonResponse({
          candidates: [{ content: { parts: [{ text: 'response text' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
        }),
      },
    ]);

    const result = await callGoogle(
      'gemini-1.5-pro',
      {
        capability: 'text_generation',
        input: {
          messages: [
            { role: 'system', content: 'be helpful' },
            { role: 'user', content: 'hi' },
          ],
          maxTokens: 500,
        },
      },
      { apiKey: 'g-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    );

    expect(result.meta?.content).toBe('response text');
    expect(result.meta?.tokensUsed).toEqual({ input: 10, output: 3 });

    const call = calls[0];
    expect(call.url).toContain(':generateContent?key=g-key');
    const body = bodyJson(call);
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be helpful' }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 500 });
  });

  it('video_generation: predictLongRunning + poll operation', async () => {
    const { calls } = mockFetch([
      {
        match: ':predictLongRunning?key=',
        response: jsonResponse({ name: 'operations/abc-123' }),
      },
      {
        match: (url) => url.includes('/operations/abc-123'),
        response: jsonResponse({
          done: true,
          response: { generatedSamples: [{ video: { uri: 'https://veo/video.mp4' } }] },
        }),
      },
    ]);

    const result = await callGoogle(
      'veo-3.0',
      { capability: 'video_generation', input: { prompt: 'sunset', duration: 5 } },
      { apiKey: 'g-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    );

    expect(result.url).toContain('https://veo/video.mp4');
    expect(result.url).toContain('key=g-key'); // Veo videoUri 需带 key 才能下载
    expect(result.meta?.operation).toBe('operations/abc-123');

    // 提交校验
    const submitCall = calls[0];
    expect(submitCall.url).toContain(':predictLongRunning?key=g-key');
    const body = bodyJson(submitCall);
    expect(body.parameters).toEqual({ durationSeconds: 5 });
  });
});
