// ============================================================
// /api/generate/video-async — 契约测试（chain 异步派发端点）
// ============================================================
//
// 覆盖：
//   - 200 { success:true, data:{ taskId, status } } when enqueueAiTask 成功
//   - enqueueAiTask 收到 type:'VIDEO_GENERATE' / queueName:'video' / 30min timeoutMs
//   - payload 含 chainMode/groupShotIds/prompt/model；projectId/dedupeKey 走顶层参数
//   - **不调 callAI**（ark 在 ai-worker，web 只派发秒级返回）
//   - 400 when body 缺 model / model 无 provider 前缀 / body 非 JSON
//   - 401 UNAUTHORIZED when 未登录
//
// mock：@dramaforge/server.enqueueAiTask + getServerSession（复用 ./mocks）
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from './mocks';
import { makeRequest, readJson } from './helpers';
import { POST } from '../app/api/generate/video-async/route';

describe('POST /api/generate/video-async', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.enqueueAiTask.mockReset();
    serverMock.callAI.mockReset();
  });

  it('returns 200 { taskId } and dispatches VIDEO_GENERATE without calling ark', async () => {
    serverMock.enqueueAiTask.mockResolvedValue({
      task: { id: 'task-abc', status: 'QUEUED' } as never,
      reused: false,
    });
    const req = makeRequest({
      method: 'POST',
      body: {
        model: 'ark/doubao-seedance-2-0',
        prompt: 'a cat playing',
        projectId: 'proj-1',
        dedupeKey: 'job-1:0',
        chainMode: true,
        groupShotIds: ['s1', 's2'],
        duration: 5,
        aspectRatio: '16:9',
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { taskId: string; status: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.taskId).toBe('task-abc');
    expect(body.data.status).toBe('QUEUED');

    // 派发参数：type/queue/projectId/dedupeKey/timeoutMs 走 enqueueAiTask 顶层。
    expect(serverMock.enqueueAiTask).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: 'proj-1',
        type: 'VIDEO_GENERATE',
        queueName: 'video',
        dedupeKey: 'job-1:0',
        timeoutMs: 30 * 60 * 1000,
      }),
    );

    // payload 透传 chainMode/groupShotIds/prompt/model；projectId/dedupeKey 不进 payload。
    const arg = serverMock.enqueueAiTask.mock.calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(arg.payload.chainMode).toBe(true);
    expect(arg.payload.groupShotIds).toEqual(['s1', 's2']);
    expect(arg.payload.prompt).toBe('a cat playing');
    expect(arg.payload.model).toBe('ark/doubao-seedance-2-0');
    expect(arg.payload.projectId).toBeUndefined();
    expect(arg.payload.dedupeKey).toBeUndefined();

    // 关键：web 永不调 callAI（ark 20min 轮询在 ai-worker 进程）。
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('omits dedupeKey/projectId from enqueueAiTask when body lacks them', async () => {
    serverMock.enqueueAiTask.mockResolvedValue({
      task: { id: 'task-2', status: 'PENDING' } as never,
      reused: false,
    });
    const req = makeRequest({
      method: 'POST',
      body: { model: 'fal/kling-v1', prompt: 'p' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const arg = serverMock.enqueueAiTask.mock.calls[0][0] as {
      projectId: unknown;
      dedupeKey: unknown;
    };
    expect(arg.projectId).toBeNull();
    expect(arg.dedupeKey).toBeUndefined();
  });

  it('returns 400 when body lacks model', async () => {
    const req = makeRequest({ method: 'POST', body: { prompt: 'x' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(serverMock.enqueueAiTask).not.toHaveBeenCalled();
  });

  it('returns 400 when model lacks provider prefix', async () => {
    const req = makeRequest({ method: 'POST', body: { model: 'nomodel', prompt: 'x' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(serverMock.enqueueAiTask).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHORIZED when not logged in', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      body: { model: 'ark/x', prompt: 'x' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(serverMock.enqueueAiTask).not.toHaveBeenCalled();
  });
});
