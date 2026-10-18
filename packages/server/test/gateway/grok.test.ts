// ============================================================
// ② server/gateway — Grok provider 单测（Bearer + prompt 截断 + 轮询）
// ============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { callGrok } from '../../src/gateway/providers/grok';
import { mockFetch, jsonResponse, bodyJson, header } from './_helpers';

describe('callGrok', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('video_generation: POST /videos/generations + poll /videos/{id}', async () => {
    const { calls } = mockFetch([
      {
        match: (url, init) => url.includes('/videos/generations') && init?.method === 'POST',
        response: jsonResponse({ request_id: 'grok_r_1', video: { duration: 8 } }),
      },
      {
        match: (url) => url.includes('/videos/grok_r_1'),
        response: jsonResponse({ status: 'done', video: { url: 'https://grok/v.mp4' } }),
      },
    ]);

    const result = await callGrok(
      'grok/grok-imagine-video',
      {
        capability: 'video_generation',
        input: { prompt: 'cosmic journey', duration: 8, aspectRatio: '16:9', resolution: '720p' },
      },
      { apiKey: 'xai-key', baseUrl: 'https://api.x.ai/v1' },
    );

    expect(result.url).toBe('https://grok/v.mp4');
    expect(result.meta?.duration).toBe(8);
    expect(result.meta?.requestId).toBe('grok_r_1');

    // 提交 URL（注意是 /videos/generations）
    const submitCall = calls[0];
    expect(submitCall.url).toBe('https://api.x.ai/v1/videos/generations');
    expect(header(submitCall, 'Authorization')).toBe('Bearer xai-key');
    const body = bodyJson(submitCall);
    expect(body.model).toBe('grok-imagine-video');
    expect(body.prompt).toBe('cosmic journey');
    expect(body.aspect_ratio).toBe('16:9');
    expect(body.resolution).toBe('720p');
    expect(body.duration).toBe(8);

    // 轮询 URL（注意是 /videos/{id}，不带 /generations）
    const pollCall = calls.find((c) => c.url === 'https://api.x.ai/v1/videos/grok_r_1');
    expect(pollCall).toBeDefined();
  });

  it('truncates prompt over 1500 chars', async () => {
    const longPrompt = 'A'.repeat(2000);
    const { calls } = mockFetch([
      {
        match: (url, init) => url.includes('/videos/generations') && init?.method === 'POST',
        response: jsonResponse({ request_id: 'r1' }),
      },
      {
        match: '/videos/r1',
        response: jsonResponse({ status: 'done', video: { url: 'https://x' } }),
      },
    ]);

    await callGrok(
      'grok/grok-imagine',
      { capability: 'video_generation', input: { prompt: longPrompt } },
      { apiKey: 'k' },
    );

    const body = bodyJson(calls[0]);
    expect((body.prompt as string).length).toBe(1500);
  });

  it('rejects unsupported capability', async () => {
    mockFetch([]);
    await expect(
      callGrok('grok/x', { capability: 'text_generation', input: {} }, { apiKey: 'k' }),
    ).rejects.toThrow('Grok 不支持的能力: text_generation');
  });

  it('rejects empty prompt', async () => {
    mockFetch([]);
    await expect(
      callGrok('grok/x', { capability: 'video_generation', input: { prompt: '   ' } }, { apiKey: 'k' }),
    ).rejects.toThrow('Grok 视频生成需要 prompt');
  });
});
