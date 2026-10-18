// ============================================================
// GET /api/tasks/[taskId] — AI/C-S 双任务域恢复契约
// ============================================================
//
// C/S render_job 只有 task_id，不会复制一条 tasks 记录。这个测试锁定线上
// “Seedance 已成功生成，但全局任务轮询先收到 404 并显示请求失败”的真实回归。
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SESSION, getServerSessionMock, serverMock } from '../../../../../test/mocks';
import { makeParamsCtx, makeRequest, readJson } from '../../../../../test/helpers';
import { GET } from '../route';

describe('GET /api/tasks/[taskId]', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.getAiTask.mockReset();
    serverMock.renderJobRepo.getByTaskId.mockReset();
    serverMock.renderJobRepo.getById.mockReset();
  });

  it('keeps the AI task response authoritative when the legacy task exists', async () => {
    const aiTask = { id: 'task-ai', status: 'RUNNING', output: null, error: null };
    serverMock.getAiTask.mockResolvedValue(aiTask);

    const response = await GET(
      makeRequest({ url: 'http://localhost/api/tasks/task-ai' }),
      makeParamsCtx({ taskId: 'task-ai' }),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: aiTask });
    expect(serverMock.renderJobRepo.getByTaskId).not.toHaveBeenCalled();
  });

  it('strips base64-heavy input from the AI task response', async () => {
    // 2026-08-02 流量爆炸回归测试：VIDEO_GENERATE input 内含 3-6MB base64 参考图，
    // 接口若原样返回，客户端轮询一次就拉走数 MB（某客户 两天烧 64GB 出站流量）。
    const aiTask = {
      id: 'task-ai',
      status: 'COMPLETED',
      output: { outputUrl: 'https://cdn.example/v.mp4' },
      error: null,
      input: {
        referenceImageBase64: 'iVBORw0KGgoAAAANSUhEUg...AAAABJRU5ErkJggg==',
        referenceImageUrls: ['data:image/jpeg;base64,/9j/4AAQSk...'],
        characterReferenceImageUrls: ['data:image/jpeg;base64,/9j/2wBD...'],
        prompt: '# 建场组 | 15秒',
      },
    };
    serverMock.getAiTask.mockResolvedValue(aiTask);

    const response = await GET(
      makeRequest({ url: 'http://localhost/api/tasks/task-ai' }),
      makeParamsCtx({ taskId: 'task-ai' }),
    );
    const body = await readJson(response) as {
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.data.id).toBe('task-ai');
    expect(body.data.status).toBe('COMPLETED');
    expect(body.data.output).toEqual({ outputUrl: 'https://cdn.example/v.mp4' });
    expect(body.data.input).toBeUndefined();
    expect(JSON.stringify(body.data)).not.toContain('base64');
  });

  it('returns a C/S render job by taskId instead of a false 404', async () => {
    serverMock.getAiTask.mockResolvedValue(null);
    serverMock.renderJobRepo.getByTaskId.mockResolvedValue({
      id: 'render-1',
      taskId: 'task-render',
      userId: 'user-1',
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      result: { outputUrl: 'sf-asset://render-1.mp4' },
      error: null,
      createdAt: '2026-07-22T07:12:53.000Z',
      completedAt: '2026-07-22T07:16:08.000Z',
    });

    const response = await GET(
      makeRequest({ url: 'http://localhost/api/tasks/task-render' }),
      makeParamsCtx({ taskId: 'task-render' }),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: expect.objectContaining({
        id: 'task-render',
        renderJobId: 'render-1',
        backend: 'render',
        status: 'COMPLETED',
        output: { outputUrl: 'sf-asset://render-1.mp4' },
      }),
    });
    expect(serverMock.renderJobRepo.getByTaskId).toHaveBeenCalledWith('task-render', 'user-1');
  });

  it('maps a failed render job to a failed stage instead of 客户端处理中', async () => {
    serverMock.getAiTask.mockResolvedValue(null);
    serverMock.renderJobRepo.getByTaskId.mockResolvedValue({
      id: 'render-failed',
      taskId: 'task-failed',
      userId: 'user-1',
      type: 'CHAIN_COMPILE',
      status: 'FAILED',
      result: null,
      error: 'provider rejected input',
      createdAt: '2026-07-23T02:37:33.000Z',
      heartbeatAt: '2026-07-23T02:44:25.000Z',
      completedAt: '2026-07-23T02:44:25.000Z',
    });

    const response = await GET(
      makeRequest({ url: 'http://localhost/api/tasks/task-failed' }),
      makeParamsCtx({ taskId: 'task-failed' }),
    );
    const body = await readJson(response) as {
      data: { status: string; stage: string; error: string };
    };

    expect(body.data.status).toBe('FAILED');
    expect(body.data.stage).toBe('生成失败');
    expect(body.data.error).toBe('provider rejected input');
  });

  it('still returns 404 when neither task domain contains an owned task', async () => {
    serverMock.getAiTask.mockResolvedValue(null);
    serverMock.renderJobRepo.getByTaskId.mockResolvedValue(null);
    serverMock.renderJobRepo.getById.mockResolvedValue(null);

    const response = await GET(
      makeRequest({ url: 'http://localhost/api/tasks/missing' }),
      makeParamsCtx({ taskId: 'missing' }),
    );

    expect(response.status).toBe(404);
  });
});
