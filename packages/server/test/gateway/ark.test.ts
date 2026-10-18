// ============================================================
// ② server/gateway — ARK provider 单测（含 ark_intl baseUrl 区分）
// ============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { callArk } from '../../src/gateway/providers/ark';
import { mockFetch, jsonResponse, bodyJson, header } from './_helpers';

describe('callArk', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('image_generation: POST /images/generations with Bearer + Seedream body', async () => {
    const { calls } = mockFetch([
      {
        match: '/images/generations',
        response: jsonResponse({ data: [{ url: 'https://ark.cdn/img.png' }] }),
      },
    ]);

    const result = await callArk(
      'ark/doubao-seedream-3-0',
      {
        capability: 'image_generation',
        input: { prompt: 'cute cat', width: 2560, height: 1440 },
      },
      { apiKey: 'ark-key-123', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    );

    expect(result.url).toBe('https://ark.cdn/img.png');
    expect(result.meta?.images).toHaveLength(1);

    const call = calls[0];
    expect(call.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    expect(header(call, 'Authorization')).toBe('Bearer ark-key-123');

    const body = bodyJson(call);
    expect(body.model).toBe('doubao-seedream-3-0');
    expect(body.prompt).toBe('cute cat');
    expect(body.size).toBe('2560x1440');
    expect(body.response_format).toBe('url');
    expect(body.watermark).toBe(false);
  });

  it('image_generation: aligns small images to ARK_MIN_PIXELS standard ratio', async () => {
    const { calls } = mockFetch([
      {
        match: '/images/generations',
        response: jsonResponse({ data: [{ url: 'https://ark.cdn/x.png' }] }),
      },
    ]);

    await callArk(
      'ark/seedream',
      {
        capability: 'image_generation',
        input: { prompt: 'p', width: 512, height: 512 }, // 262144 < 3686400
      },
      { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    );

    // 1:1 → 1920x1920
    expect(bodyJson(calls[0]).size).toBe('1920x1920');
  });

  it('ark_intl: uses overseas baseUrl', async () => {
    const { calls } = mockFetch([
      {
        match: '/images/generations',
        response: jsonResponse({ data: [{ url: 'https://x' }] }),
      },
    ]);

    await callArk(
      'ark_intl/seedream',
      { capability: 'image_generation', input: { prompt: 'p', width: 2560, height: 1440 } },
      { apiKey: 'k', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3' },
    );

    expect(calls[0].url).toBe('https://ark.ap-southeast.bytepluses.com/api/v3/images/generations');
  });

  it('video_generation: submit + poll, returns video URL', async () => {
    const { calls } = mockFetch([
      {
        match: (url) => url.includes('/contents/generations/tasks') && !url.includes('/task_'),
        response: jsonResponse({ id: 'task_abc' }),
      },
      {
        match: '/contents/generations/tasks/task_abc',
        response: jsonResponse({
          status: 'succeeded',
          content: { video_url: 'https://ark.video/v.mp4' },
        }),
      },
    ]);

    const result = await callArk(
      'ark/doubao-seedance-2-0',
      {
        capability: 'video_generation',
        input: { prompt: 'a sunset', duration: 5, aspectRatio: '16:9' },
      },
      { apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    );

    expect(result.url).toBe('https://ark.video/v.mp4');
    expect(result.meta?.duration).toBe(5);
    expect(result.meta?.taskId).toBe('task_abc');

    // 提交请求体校验
    const submitCall = calls.find((c) => c.init?.method === 'POST');
    expect(submitCall?.url).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    const body = bodyJson(submitCall);
    expect(body.model).toBe('doubao-seedance-2-0');
    expect(body.duration).toBe(5);
    expect(body.ratio).toBe('16:9');
    expect(Array.isArray(body.content)).toBe(true);
    expect(header(submitCall, 'Authorization')).toBe('Bearer ark-key');
  });

  it('video_generation: surfaces failed status as error', async () => {
    mockFetch([
      {
        match: (url) => url.includes('/contents/generations/tasks') && !url.includes('/task_'),
        response: jsonResponse({ id: 'task_fail' }),
      },
      {
        match: '/contents/generations/tasks/task_fail',
        response: jsonResponse({
          status: 'failed',
          error: { message: 'content policy violation' },
        }),
      },
    ]);

    await expect(
      callArk(
        'ark/seedance',
        { capability: 'video_generation', input: { prompt: 'x' } },
        { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      ),
    ).rejects.toThrow('Seedance 生成失败: content policy violation');
  });

  it('video_generation: rejects character references that were not grid processed', async () => {
    await expect(
      callArk(
        'ark/doubao-seedance-2-0-mini-260615',
        {
          capability: 'video_generation',
          input: {
            prompt: '# group | 10 seconds',
            characterReferenceImageUrls: ['https://example.com/person.png'],
          },
        },
        { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      ),
    ).rejects.toThrow('人物参考图必须先叠加 app1 稀疏网格');
  });

  it('video_generation: submits grid references with app1 reference_image role', async () => {
    const { calls } = mockFetch([
      {
        match: (url) => url.includes('/contents/generations/tasks') && !url.includes('/task_'),
        response: jsonResponse({ id: 'task_grid' }),
      },
      {
        match: '/contents/generations/tasks/task_grid',
        response: jsonResponse({ status: 'succeeded', content: { video_url: 'https://ark.video/grid.mp4' } }),
      },
    ]);
    await callArk(
      'ark/doubao-seedance-2-0-mini-260615',
      {
        capability: 'video_generation',
        input: {
          prompt: '# group | 10 seconds',
          characterReferenceImageUrls: ['data:image/png;base64,AAAA'],
          characterReferencesGridApplied: true,
          referenceAudioUrls: ['data:audio/wav;base64,UklGRg=='],
          resolution: '480p',
        },
      },
      { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    );
    const body = bodyJson(calls.find((call) => call.init?.method === 'POST'));
    expect(body.resolution).toBe('480p');
    expect(body.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
      role: 'reference_image',
    });
    expect(body.content[2]).toEqual({
      type: 'audio_url',
      audio_url: { url: 'data:audio/wav;base64,UklGRg==' },
      role: 'reference_audio',
    });
  });

  it('video_generation: keeps scene and continuity frames in omni-reference mode', async () => {
    const { calls } = mockFetch([
      {
        match: (url) => url.includes('/contents/generations/tasks') && !url.includes('/task_'),
        response: jsonResponse({ id: 'task_omni' }),
      },
      {
        match: '/contents/generations/tasks/task_omni',
        response: jsonResponse({ status: 'succeeded', content: { video_url: 'https://ark.video/omni.mp4' } }),
      },
    ]);
    await callArk(
      'ark/doubao-seedance-2-0-260128',
      {
        capability: 'video_generation',
        input: {
          prompt: 'omni reference group',
          referenceImageUrls: ['https://example.com/scene.png'],
          lastFrameImageUrl: 'https://example.com/continuity.png',
        },
      },
      { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    );
    const body = bodyJson(calls.find((call) => call.init?.method === 'POST'));
    expect(body.content.slice(1)).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'https://example.com/scene.png' },
        role: 'reference_image',
      },
      {
        type: 'image_url',
        image_url: { url: 'https://example.com/continuity.png' },
        role: 'reference_image',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('first_frame');
    expect(JSON.stringify(body)).not.toContain('last_frame');
  });

  it('video_generation: submits reference videos with reference_video role (video-to-video)', async () => {
    const { calls } = mockFetch([
      {
        match: (url) => url.includes('/contents/generations/tasks') && !url.includes('/task_'),
        response: jsonResponse({ id: 'task_refvid' }),
      },
      {
        match: '/contents/generations/tasks/task_refvid',
        response: jsonResponse({ status: 'succeeded', content: { video_url: 'https://ark.video/refvid.mp4' } }),
      },
    ]);
    await callArk(
      'ark/doubao-seedance-2-0-260128',
      {
        capability: 'video_generation',
        input: {
          prompt: 'recast to overseas',
          referenceImageUrls: ['https://example.com/overseas-char.png'],
          referenceVideoUrls: ['https://example.com/clip-0.mp4'],
        },
      },
      { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    );
    const body = bodyJson(calls.find((call) => call.init?.method === 'POST'));
    // content 顺序：text → video(reference_video) → image(reference_image)。
    // ⚠ ARK 要求 reference_video 在 reference_image 之前（真实验证 2026-08-02：
    // 视频放在图片后返回 400 "Invalid video_url"），此断言锁死顺序防回归。
    expect(body.content).toEqual([
      { type: 'text', text: 'recast to overseas' },
      {
        type: 'video_url',
        video_url: { url: 'https://example.com/clip-0.mp4' },
        role: 'reference_video',
      },
      {
        type: 'image_url',
        image_url: { url: 'https://example.com/overseas-char.png' },
        role: 'reference_image',
      },
    ]);
  });

  it('video_generation: rejects more than 3 reference videos', async () => {
    await expect(
      callArk(
        'ark/doubao-seedance-2-0-260128',
        {
          capability: 'video_generation',
          input: {
            prompt: 'x',
            referenceVideoUrls: [
              'https://example.com/0.mp4',
              'https://example.com/1.mp4',
              'https://example.com/2.mp4',
              'https://example.com/3.mp4',
            ],
          },
        },
        { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      ),
    ).rejects.toThrow('参考视频最多 3 个');
  });
});
