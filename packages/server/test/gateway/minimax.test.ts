// ============================================================
// ② server/gateway — MiniMax provider 单测（Bearer + 3 步轮询）
// ============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { callMinimax } from '../../src/gateway/providers/minimax';
import { mockFetch, jsonResponse, bodyJson, header } from './_helpers';

describe('callMinimax', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('video_generation: submit → query → files/retrieve', async () => {
    const { calls } = mockFetch([
      {
        match: (url, init) => url.includes('/video_generation') && !url.includes('query') && init?.method === 'POST',
        response: jsonResponse({ base_resp: { status_code: 0 }, task_id: 'mm_t_1' }),
      },
      {
        match: '/query/video_generation',
        response: jsonResponse({ status: 'Success', file_id: 'file_abc' }),
      },
      {
        match: '/files/retrieve',
        response: jsonResponse({ file: { download_url: 'https://mm/download.mp4' } }),
      },
    ]);

    const result = await callMinimax(
      'minimax/video-01',
      {
        capability: 'video_generation',
        input: { prompt: 'dancing', imageUrl: 'https://img', duration: 6 },
      },
      { apiKey: 'mm-key', baseUrl: 'https://api.minimaxi.com/v1' },
    );

    expect(result.url).toBe('https://mm/download.mp4');
    expect(result.meta?.duration).toBe(6);
    expect(result.meta?.taskId).toBe('mm_t_1');

    // 提交校验
    const submitCall = calls[0];
    expect(submitCall.url).toBe('https://api.minimaxi.com/v1/video_generation');
    expect(header(submitCall, 'Authorization')).toBe('Bearer mm-key');
    const body = bodyJson(submitCall);
    expect(body.model).toBe('video-01');
    expect(body.prompt).toBe('dancing');
    expect(body.first_frame_image).toBe('https://img');
    expect(body.duration).toBe(6);
    expect(body.prompt_optimizer).toBe(true);
  });

  it('throws when base_resp.status_code != 0', async () => {
    mockFetch([
      {
        match: (url, init) => url.includes('/video_generation') && init?.method === 'POST',
        response: jsonResponse({ base_resp: { status_code: 1001, status_msg: 'invalid prompt' } }),
      },
    ]);
    await expect(
      callMinimax('video-01', { capability: 'video_generation', input: { prompt: 'x' } }, { apiKey: 'k' }),
    ).rejects.toThrow('MiniMax 提交失败: invalid prompt');
  });
});
