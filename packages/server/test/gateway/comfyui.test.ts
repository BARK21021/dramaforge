// ============================================================
// ② server/gateway — ComfyUI provider 单测
// ============================================================
// 重点验证：本地模式免鉴权、POST /prompt 提交、轮询 /history、产物解析。
// 工作流内部结构（节点 ID）不做严格断言，只校验关键请求形状。
// ============================================================

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { callComfyUI } from '../../src/gateway/providers/comfyui';
import { mockFetch, jsonResponse } from './_helpers';

describe('callComfyUI', () => {
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv.COMFYUI_MODE = process.env.COMFYUI_MODE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedEnv.COMFYUI_MODE === undefined) delete process.env.COMFYUI_MODE;
    else process.env.COMFYUI_MODE = savedEnv.COMFYUI_MODE;
  });

  it('local mode: no Authorization header on POST /prompt', async () => {
    delete process.env.COMFYUI_MODE; // 默认 local
    const { calls } = mockFetch([
      {
        match: (url, init) => url.includes('/prompt') && init?.method === 'POST',
        response: jsonResponse({ prompt_id: 'cp_1' }),
      },
      {
        match: '/history/cp_1',
        response: jsonResponse({
          cp_1: {
            status: { completed: true },
            outputs: {
              node9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
            },
          },
        }),
      },
      {
        match: '/view',
        response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      },
    ]);

    const result = await callComfyUI(
      'comfyui/z-image-turbo',
      {
        capability: 'image_generation',
        input: { prompt: 'pencil sketch', width: 1280, height: 720 },
      },
      { apiKey: 'unused-in-local', baseUrl: 'http://127.0.0.1:8188' },
    );

    expect(result.url).toMatch(/^data:image\/png;base64,/);

    const submitCall = calls[0];
    expect(submitCall.url).toBe('http://127.0.0.1:8188/prompt');
    // local 模式不注入 Authorization
    const headers = submitCall.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');

    // body 含 prompt 工作流
    const body = JSON.parse(String(submitCall.init?.body)) as { prompt: Record<string, unknown> };
    expect(body.prompt).toBeDefined();
    expect(body.prompt['9']).toBeDefined(); // SaveImage 节点
  });

  it('api mode: injects Bearer auth', async () => {
    process.env.COMFYUI_MODE = 'api';
    const { calls } = mockFetch([
      {
        match: (url, init) => url.includes('/prompt') && init?.method === 'POST',
        response: jsonResponse({ prompt_id: 'cp_2' }),
      },
      {
        match: '/history/cp_2',
        response: jsonResponse({
          cp_2: { status: { completed: true }, outputs: {} },
        }),
      },
    ]);

    // outputs 为空 → 应抛 "未返回任何图片产物"
    await expect(
      callComfyUI(
        'comfyui/z-image-turbo',
        { capability: 'image_generation', input: { prompt: 'x' } },
        { apiKey: 'comfy-bearer', baseUrl: 'http://remote:8188' },
      ),
    ).rejects.toThrow('ComfyUI 未返回任何图片产物');

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer comfy-bearer');
  });

  it('rejects non-image capability', async () => {
    mockFetch([]);
    await expect(
      callComfyUI('z-image', { capability: 'video_generation', input: {} }, { apiKey: 'k' }),
    ).rejects.toThrow('ComfyUI 暂不支持的能力: video_generation');
  });

  it('surfaces workflow execution error from history', async () => {
    mockFetch([
      {
        match: (url, init) => url.includes('/prompt') && init?.method === 'POST',
        response: jsonResponse({ prompt_id: 'cp_err' }),
      },
      {
        match: '/history/cp_err',
        response: jsonResponse({
          cp_err: { status: { status_str: 'error', messages: ['OOM'] } },
        }),
      },
    ]);

    await expect(
      callComfyUI(
        'comfyui/z-image-turbo',
        { capability: 'image_generation', input: { prompt: 'x' } },
        { apiKey: 'k', baseUrl: 'http://127.0.0.1:8188' },
      ),
    ).rejects.toThrow('ComfyUI 执行失败');
  });
});
