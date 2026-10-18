// ============================================================
// POST /original-video-upload — 契约测试（转绘 X3.6b）
// ============================================================
// 覆盖：
//   - 401 / 404 / 400 category !== ORIGINAL (NOT_ORIGINAL)
//   - 200 reused（longVideoProgress 处于 in-flight 阶段，复用 taskId）
//   - 400 INVALID_FILE_TYPE / FILE_TOO_LARGE(zod)
//   - 200 happy：dispatchLongVideoRewrite 收到算好的 segmentPlan + 初始化 progress
//   - 校验 calculateKimiSegmentPlan：duration=1200 + bytes=100MiB → 3 段（字节约束）
// mock：@dramaforge/server（projectRepo/dispatchLongVideoRewrite）+ getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
} from '../../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../../test/helpers';
import { POST } from '../route';

const { projectRepo, dispatchLongVideoRewrite } = serverMock;

const PROJECT_ID = 'proj-1';

function ctx() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

const MB = 1024 * 1024;

function baseBody(over: Record<string, unknown> = {}) {
  return {
    videoUrl: '/userData/original-uploads/source.mp4',
    filename: 'source.mp4',
    totalBytes: 100 * MB,
    totalDurationSec: 1200,
    ...over,
  };
}

describe('POST /api/projects/[id]/original-video-upload (转绘 X3.6b)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    projectRepo.getById.mockReset();
    projectRepo.update.mockReset();
    dispatchLongVideoRewrite.mockReset();
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'ORIGINAL',
      longVideoProgress: null,
    });
    dispatchLongVideoRewrite.mockResolvedValue({ id: 'job-1' });
    projectRepo.update.mockResolvedValue({});
  });

  it('401 未登录不派发', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(makeRequest({ method: 'POST', body: baseBody() }), ctx());
    expect(res.status).toBe(401);
    expect(dispatchLongVideoRewrite).not.toHaveBeenCalled();
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'someone-else',
      category: 'ORIGINAL',
      longVideoProgress: null,
    });
    const res = await POST(makeRequest({ method: 'POST', body: baseBody() }), ctx());
    expect(res.status).toBe(404);
    expect(dispatchLongVideoRewrite).not.toHaveBeenCalled();
  });

  it('400 非 ORIGINAL 项目（NOT_ORIGINAL）', async () => {
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'DOMESTIC',
      longVideoProgress: null,
    });
    const res = await POST(makeRequest({ method: 'POST', body: baseBody() }), ctx());
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { code?: string };
    expect(body.code).toBe('NOT_ORIGINAL');
    expect(dispatchLongVideoRewrite).not.toHaveBeenCalled();
  });

  it('200 reused：progress in-flight 时复用 taskId，不重复派发', async () => {
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'ORIGINAL',
      longVideoProgress: { stage: 'outlining', progress: 60, taskId: 'old-task' },
    });
    const res = await POST(makeRequest({ method: 'POST', body: baseBody() }), ctx());
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { data: { reused: boolean; taskId: string } };
    expect(body.data.reused).toBe(true);
    expect(body.data.taskId).toBe('old-task');
    expect(dispatchLongVideoRewrite).not.toHaveBeenCalled();
  });

  it('400 非法扩展名', async () => {
    const res = await POST(
      makeRequest({ method: 'POST', body: baseBody({ filename: 'source.avi' }) }),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { code?: string };
    expect(body.code).toBe('INVALID_FILE_TYPE');
  });

  it('400 超过 3GB（zod）', async () => {
    const res = await POST(
      makeRequest({ method: 'POST', body: baseBody({ totalBytes: 4 * 1024 * MB }) }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(dispatchLongVideoRewrite).not.toHaveBeenCalled();
  });

  it('200 happy：dispatch 收到算好的 segmentPlan + 初始化 splitting progress', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: baseBody() }), ctx());
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      data: { taskId: string; renderJobId: string; segmentPlan: { segmentCount: number; segmentDurationSec: number } };
    };
    expect(body.data.renderJobId).toBe('job-1');
    expect(body.data.taskId).toBeTruthy();
    // duration=1200 + bytes=100MiB：max(ceil(1200/600)=2, ceil(100MiB/48MiB)=3) = 3 段
    expect(body.data.segmentPlan.segmentCount).toBe(3);
    expect(body.data.segmentPlan.segmentDurationSec).toBeCloseTo(400);

    expect(dispatchLongVideoRewrite).toHaveBeenCalledTimes(1);
    const [, userId, input] = dispatchLongVideoRewrite.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(input.segments).toBe(3);
    expect(input.projectId).toBe(PROJECT_ID);
    expect(input.segmentSec).toBeCloseTo(400);
    expect(input.kimiModel).toBe('kimi-k2.6');

    // progress 初始化为 splitting 0%
    expect(projectRepo.update).toHaveBeenCalledTimes(1);
    const [, patch] = projectRepo.update.mock.calls[0];
    expect(patch.longVideoProgress).toMatchObject({ stage: 'splitting', progress: 0 });
  });

  it('200 显式模型透传', async () => {
    await POST(
      makeRequest({
        method: 'POST',
        body: baseBody({
          kimiModel: 'kimi-k2.5',
          outlineModel: 'deepseek/r1',
          rewriteModel: 'deepseek/pro',
        }),
      }),
      ctx(),
    );
    const [, , input] = dispatchLongVideoRewrite.mock.calls[0];
    expect(input.kimiModel).toBe('kimi-k2.5');
    expect(input.outlineModel).toBe('deepseek/r1');
    expect(input.rewriteModel).toBe('deepseek/pro');
  });

  it('从指定集恢复时仅注入项目已有文本元数据，不上传媒体', async () => {
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'ORIGINAL',
      longVideoProgress: null,
      novelText: '第1集\n旧剧本',
      scriptData: {
        longVideoRewrite: {
          sourceScript: 'Kimi 原分析稿',
          analysisFingerprint: 'fingerprint',
          initialOutline: '大纲',
          directorBoard: '导演板',
          targetEpisodeCount: 60,
        },
      },
    });
    await POST(makeRequest({
      method: 'POST',
      body: baseBody({ regenerateFromEpisode: 21, reuseTargetStageDraft: true }),
    }), ctx());

    const [, , input] = dispatchLongVideoRewrite.mock.calls[0];
    expect(input).toMatchObject({
      regenerateFromEpisode: 21,
      reuseTargetStageDraft: true,
      previousNovelText: '第1集\n旧剧本',
      sourceScriptOverride: 'Kimi 原分析稿',
      sourceFilename: 'source.mp4',
    });
    expect(input.previousLongVideoRewrite).toMatchObject({ analysisFingerprint: 'fingerprint' });
  });
});
