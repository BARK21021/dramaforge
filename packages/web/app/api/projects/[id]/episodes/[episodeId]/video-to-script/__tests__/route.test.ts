// ============================================================
// POST /episodes/[episodeId]/video-to-script — 契约测试（转绘 X2）
// ============================================================
// 覆盖：
//   - 401 未登录
//   - 404 项目不属于用户 / episode 不属于项目
//   - 400 没有视频文件
//   - 200 happy：FormData 视频 → callAI video_to_script → episodeRepo.update(videoScriptDraft)
//   - 502 Kimi 返空 script
//   - GatewayError 429 → retryable
// mock：@dramaforge/server（callAI/GatewayError/episodeRepo/projectRepo）+ getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
} from '../../../../../../../../test/mocks';
import { POST } from '../route';

const {
  callAI,
  GatewayError,
  projectRepo,
  episodeRepo,
  startInlineAiTask,
  reportInlineAiTaskProgress,
  completeInlineAiTask,
  failInlineAiTask,
  chargeCredits,
} = serverMock;

const PROJECT_ID = 'proj-1';
const EPISODE_ID = 'ep-1';

function ctx() {
  return { params: Promise.resolve({ id: PROJECT_ID, episodeId: EPISODE_ID }) };
}

/** 构造带视频 Blob 的 multipart NextRequest（file 可省略 → 测无文件分支）。 */
function videoRequest(file?: Blob, filename = 'clip.mp4'): NextRequest {
  const fd = new FormData();
  if (file) fd.append('video', file, filename);
  return new NextRequest(
    `http://localhost/api/projects/${PROJECT_ID}/episodes/${EPISODE_ID}/video-to-script`,
    { method: 'POST', body: fd },
  );
}

/** 构造新客户端使用的裸视频流请求，验证 route 不再调用 formData/arrayBuffer。 */
function streamedVideoRequest(
  bytes = new Uint8Array([1, 2, 3, 4]),
  taskId?: string,
): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${PROJECT_ID}/episodes/${EPISODE_ID}/video-to-script?sourceDurationSeconds=12.5`,
    {
      method: 'POST',
      body: new Blob([bytes], { type: 'video/mp4' }),
      headers: {
        'Content-Type': 'video/mp4',
        'X-SF-Video-Stream': '1',
        'X-SF-Video-Name': encodeURIComponent('中文片段.mp4'),
        'X-SF-Video-Size': String(bytes.byteLength),
        // 新页面在正文上传前生成 ID，SSE 因而能与长 HTTP 请求并行展示真实阶段。
        ...(taskId ? { 'X-SF-Task-Id': taskId } : {}),
      },
    },
  );
}

const smallVideo = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });

describe('POST /episodes/[episodeId]/video-to-script (转绘 X2)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    callAI.mockReset();
    projectRepo.getById.mockReset();
    episodeRepo.getById.mockReset();
    episodeRepo.update.mockReset();
    startInlineAiTask.mockReset();
    reportInlineAiTaskProgress.mockReset();
    completeInlineAiTask.mockReset();
    failInlineAiTask.mockReset();
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'user-1' });
    episodeRepo.getById.mockResolvedValue({ id: EPISODE_ID, projectId: PROJECT_ID });
    episodeRepo.update.mockResolvedValue({});
    startInlineAiTask.mockResolvedValue({ id: 'task-inline' });
    reportInlineAiTaskProgress.mockResolvedValue(undefined);
    completeInlineAiTask.mockResolvedValue(undefined);
    failInlineAiTask.mockResolvedValue(undefined);
    chargeCredits.mockReset();
  });

  it('401 未登录时不调 callAI', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(videoRequest(smallVideo()), ctx());
    expect(res.status).toBe(401);
    expect(callAI).not.toHaveBeenCalled();
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'someone-else' });
    const res = await POST(videoRequest(smallVideo()), ctx());
    expect(res.status).toBe(404);
    expect(callAI).not.toHaveBeenCalled();
  });

  it('404 episode 不属于该项目', async () => {
    episodeRepo.getById.mockResolvedValue({ id: EPISODE_ID, projectId: 'other-project' });
    const res = await POST(videoRequest(smallVideo()), ctx());
    expect(res.status).toBe(404);
    expect(callAI).not.toHaveBeenCalled();
  });

  it('400 没有视频文件', async () => {
    const res = await POST(videoRequest(undefined), ctx());
    expect(res.status).toBe(400);
    expect(callAI).not.toHaveBeenCalled();
  });

  it('200 happy：callAI 返 script → episodeRepo.update 写 videoScriptDraft', async () => {
    callAI.mockResolvedValue({
      url: '',
      meta: {
        script: '剧本内容…',
        characters: [{ name: 'Alice' }],
        locations: ['咖啡馆'],
        timePeriod: '现代',
        fileId: 'fv',
      },
    });

    const res = await POST(videoRequest(smallVideo(), 'clip.mp4'), ctx());
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    const payload = callAI.mock.calls[0][2] as { capability: string; input: { videoBytes: unknown } };
    expect(payload.capability).toBe('video_to_script');
    expect(Buffer.isBuffer(payload.input.videoBytes)).toBe(true);
    expect(episodeRepo.update).toHaveBeenCalledWith(EPISODE_ID, { videoScriptDraft: '剧本内容…' });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.script).toBe('剧本内容…');
    expect(body.data.persistedTo).toBe('episode');
  });

  it('200 callAI 返 cost>0 → billDirectGeneration 调 chargeCredits（P0-3 计费落地）', async () => {
    // callAI 成本归因把 token 用量换算成元后写入 result.cost；route 据此扣费。
    callAI.mockResolvedValue({
      url: '',
      meta: { script: '扣费剧本', fileId: 'fv' },
      cost: 0.5,
    });

    const res = await POST(videoRequest(smallVideo()), ctx());
    expect(res.status).toBe(200);

    // chargeCredits(userId, yuanToCredits(0.5), { description, metadata:{cost,taskType,...} })
    expect(chargeCredits).toHaveBeenCalledTimes(1);
    const [userId, credits, opts] = chargeCredits.mock.calls[0];
    expect(userId).toBe('user-1');
    // mocks.ts 的 yuanToCredits = max(1, ceil(yuan*12)) → ceil(0.5*12)=6
    expect(credits).toBe(6);
    expect(opts).toMatchObject({
      description: '单集视频转剧本',
      metadata: { cost: 0.5, taskType: 'VIDEO_TO_SCRIPT', source: 'sync-direct' },
    });
  });

  it('callAI 未返 cost（token 用量缺失）→ 不调 chargeCredits（宁可漏扣不误扣）', async () => {
    callAI.mockResolvedValue({ url: '', meta: { script: '免费剧本', fileId: 'fv' } });

    await POST(videoRequest(smallVideo()), ctx());
    expect(chargeCredits).not.toHaveBeenCalled();
  });

  it('200 流式 happy：正文以 ReadableStream 接力且保存源视频时长', async () => {
    callAI.mockResolvedValue({ url: '', meta: { script: '流式剧本', fileId: 'stream-file' } });

    const res = await POST(streamedVideoRequest(), ctx());

    expect(res.status).toBe(200);
    const payload = callAI.mock.calls[0][2] as {
      input: { videoBytes?: unknown; videoStream?: ReadableStream<Uint8Array>; videoSize?: number; filename?: string };
    };
    expect(payload.input.videoBytes).toBeUndefined();
    expect(typeof payload.input.videoStream?.getReader).toBe('function');
    expect(payload.input.videoSize).toBe(4);
    expect(payload.input.filename).toBe('中文片段.mp4');
    expect(episodeRepo.update).toHaveBeenCalledWith(EPISODE_ID, {
      videoScriptDraft: '流式剧本',
      scriptData: { sourceVideoDurationSeconds: 12.5 },
    });
  });

  it('200 query ?model= 透传到 callAI（视频转剧本模型选择器）', async () => {
    callAI.mockResolvedValue({ url: '', meta: { script: 'K3 剧本', fileId: 'fv' } });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // 模型 id 带 provider 前缀（kimi/kimi-k3），/ 需 URL 编码；route 透传给 callAI 第 2 参。
    const req = new NextRequest(
      `http://localhost/api/projects/${PROJECT_ID}/episodes/${EPISODE_ID}/video-to-script?sourceDurationSeconds=12.5&model=${encodeURIComponent('kimi/kimi-k3')}`,
      {
        method: 'POST',
        body: new Blob([bytes], { type: 'video/mp4' }),
        headers: {
          'Content-Type': 'video/mp4',
          'X-SF-Video-Stream': '1',
          'X-SF-Video-Name': encodeURIComponent('clip.mp4'),
          'X-SF-Video-Size': String(bytes.byteLength),
        },
      },
    );

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    // callAI(provider, model, payload) —— model 是第 2 个参数。
    expect(callAI.mock.calls[0][1]).toBe('kimi/kimi-k3');
  });

  it('raw 流携带任务 ID 时：通过 tasks/SSE 上报真实阶段，落库后才完成', async () => {
    const taskId = '1323838f-4388-4531-b86d-b67ac1412b61';
    callAI.mockImplementation(async (_provider, _model, payload) => {
      const input = (payload as {
        input: {
          onProgress?: (event: { stage: string }) => Promise<void>;
        };
      }).input;
      await input.onProgress?.({ stage: 'file_received' });
      await input.onProgress?.({ stage: 'extracting_context' });
      await input.onProgress?.({ stage: 'context_extracted' });
      await input.onProgress?.({ stage: 'generating_script' });
      await input.onProgress?.({ stage: 'script_generated' });
      return { url: '', meta: { script: '真实阶段剧本', fileId: 'stream-file' } };
    });

    const res = await POST(streamedVideoRequest(undefined, taskId), ctx());

    expect(res.status).toBe(200);
    expect(startInlineAiTask).toHaveBeenCalledWith({
      id: taskId,
      userId: 'user-1',
      projectId: PROJECT_ID,
      type: 'VIDEO_TO_SCRIPT',
      progress: 8,
      stage: '正在上传视频',
      storedInput: {
        episodeId: EPISODE_ID,
        filename: '中文片段.mp4',
        mimeType: 'video/mp4',
        videoSize: 4,
      },
    });
    expect(reportInlineAiTaskProgress.mock.calls.map((call) => call.slice(1))).toEqual([
      ['user-1', 25, '文件已接收', 100],
      ['user-1', 35, '正在提取角色和场景', 0],
      ['user-1', 55, '角色和场景提取完成', 100],
      ['user-1', 65, '正在生成剧本', 0],
      ['user-1', 88, '剧本生成完成', 100],
      ['user-1', 95, '正在保存剧本', 0],
    ]);
    for (const call of reportInlineAiTaskProgress.mock.calls) {
      expect(call[0]).toBe(taskId);
    }
    expect(episodeRepo.update).toHaveBeenCalledWith(
      EPISODE_ID,
      expect.objectContaining({ videoScriptDraft: '真实阶段剧本' }),
    );
    expect(completeInlineAiTask).toHaveBeenCalledWith(taskId, 'user-1', {
      episodeId: EPISODE_ID,
      persistedTo: 'episode',
      scriptLength: 6,
      fileId: 'stream-file',
    });
    expect(failInlineAiTask).not.toHaveBeenCalled();
    expect(episodeRepo.update.mock.invocationCallOrder[0]).toBeLessThan(
      completeInlineAiTask.mock.invocationCallOrder[0],
    );
  });

  it('raw 流任务失败时写安全失败状态，不把 provider 详情送入 SSE', async () => {
    const taskId = '1323838f-4388-4531-b86d-b67ac1412b61';
    callAI.mockRejectedValue(new GatewayError('kimi', 'upstream internal detail', 503));

    const res = await POST(streamedVideoRequest(undefined, taskId), ctx());

    expect(res.status).toBe(503);
    expect(failInlineAiTask).toHaveBeenCalledWith(
      taskId,
      'user-1',
      '视频转剧本失败，请重试',
    );
    expect(completeInlineAiTask).not.toHaveBeenCalled();
  });

  it('拒绝格式非法的客户端任务 ID，且不创建任务', async () => {
    const res = await POST(streamedVideoRequest(undefined, 'not-a-task-id'), ctx());

    expect(res.status).toBe(400);
    expect(startInlineAiTask).not.toHaveBeenCalled();
    expect(callAI).not.toHaveBeenCalled();
  });

  it('502 Kimi 返空 script → 不落库', async () => {
    callAI.mockResolvedValue({ url: '', meta: { script: '   ' } });
    const res = await POST(videoRequest(smallVideo()), ctx());
    expect(res.status).toBe(502);
    expect(episodeRepo.update).not.toHaveBeenCalled();
  });

  it('GatewayError 429 → 429 + retryable:true', async () => {
    callAI.mockRejectedValue(new GatewayError('kimi', 'rate limited', 429, 3000));
    const res = await POST(videoRequest(smallVideo()), ctx());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.retryable).toBe(true);
    expect(body.code).toBe('PROVIDER_ERROR');
  });
});
