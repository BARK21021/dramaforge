// ============================================================
// POST /api/projects/[id]/video-split — 契约测试（转绘 X4.3）
// ============================================================
// 覆盖：
//   - 401 / 404（非本人）
//   - 400 INVALID_FILE_TYPE / SEGMENTS_OVER_LIMIT / zod（segmentSec 越界 / duration 缺）
//   - 200 happy：预建 N 集（ceil(900/90)=10）+ dispatch 收到 episodeIds +
//     scriptData.videoSplit 持久化 + 返回 {renderJobId, taskId, episodeIds, segmentCount}
//   - 200 segmentSec 默认 90（对齐 app1）
// mock：@dramaforge/server（projectRepo/episodeRepo/dispatchVideoSplit）+ getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
} from '../../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../../test/helpers';
import { POST } from '../route';

const { projectRepo, episodeRepo, dispatchVideoSplit } = serverMock;

const PROJECT_ID = 'proj-1';

function ctx() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

function baseBody(over: Record<string, unknown> = {}) {
  return {
    videoUrl: '/userData/splits/source.mp4',
    filename: 'source.mp4',
    totalBytes: 500 * 1024 * 1024,
    totalDurationSec: 900,
    segmentSec: 90,
    ...over,
  };
}

describe('POST /api/projects/[id]/video-split (转绘 X4.3)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    projectRepo.getById.mockReset();
    projectRepo.update.mockReset();
    episodeRepo.create.mockReset();
    dispatchVideoSplit.mockReset();
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'DOMESTIC',
    });
    // episodeRepo.create 回填 id（按调用顺序 ep-1, ep-2, ...）
    let n = 0;
    episodeRepo.create.mockImplementation(async () => ({
      id: `ep-${++n}`,
      episodeNumber: n,
      title: `第 ${n} 段`,
    }));
    dispatchVideoSplit.mockResolvedValue({ id: 'job-1' });
    projectRepo.update.mockResolvedValue({});
  });

  it('401 未登录不派发', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(makeRequest({ method: 'POST', body: baseBody() }), ctx());
    expect(res.status).toBe(401);
    expect(dispatchVideoSplit).not.toHaveBeenCalled();
    expect(episodeRepo.create).not.toHaveBeenCalled();
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'someone-else',
      category: 'DOMESTIC',
    });
    const res = await POST(makeRequest({ method: 'POST', body: baseBody() }), ctx());
    expect(res.status).toBe(404);
    expect(dispatchVideoSplit).not.toHaveBeenCalled();
  });

  it('400 非法扩展名（INVALID_FILE_TYPE）', async () => {
    const res = await POST(
      makeRequest({ method: 'POST', body: baseBody({ filename: 'source.avi' }) }),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { code?: string };
    expect(body.code).toBe('INVALID_FILE_TYPE');
    expect(episodeRepo.create).not.toHaveBeenCalled();
  });

  it('400 拆分集数超上限（SEGMENTS_OVER_LIMIT）', async () => {
    // 2010s / 10s = 201 > 200
    const res = await POST(
      makeRequest({
        method: 'POST',
        body: baseBody({ totalDurationSec: 2010, segmentSec: 10 }),
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { code?: string };
    expect(body.code).toBe('SEGMENTS_OVER_LIMIT');
    expect(episodeRepo.create).not.toHaveBeenCalled();
    expect(dispatchVideoSplit).not.toHaveBeenCalled();
  });

  it('400 segmentSec 越界（zod）', async () => {
    const res = await POST(
      makeRequest({ method: 'POST', body: baseBody({ segmentSec: 5 }) }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(dispatchVideoSplit).not.toHaveBeenCalled();
  });

  it('200 happy：预建 10 集 + dispatch 带 episodeIds + 持久化 videoSplit meta', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: baseBody() }), ctx());
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      data: {
        renderJobId: string;
        taskId: string;
        episodeIds: string[];
        segmentCount: number;
        segmentSec: number;
      };
    };
    expect(body.data.renderJobId).toBe('job-1');
    expect(body.data.taskId).toBeTruthy();
    // ceil(900/90) = 10 集
    expect(body.data.segmentCount).toBe(10);
    expect(body.data.segmentSec).toBe(90);
    expect(body.data.episodeIds).toHaveLength(10);
    expect(body.data.episodeIds[0]).toBe('ep-1');
    expect(body.data.episodeIds[9]).toBe('ep-10');

    // 预建 10 集（顺序）
    expect(episodeRepo.create).toHaveBeenCalledTimes(10);
    // 集号连续（title 含时间区间）
    const firstTitleCall = episodeRepo.create.mock.calls[0][1] as { title: string };
    expect(firstTitleCall.title).toContain('00:00-01:30');
    const lastTitleCall = episodeRepo.create.mock.calls[9][1] as { title: string };
    expect(lastTitleCall.title).toContain('13:30-15:00');

    // dispatch 收到 episodeIds（顺序对应片段）
    expect(dispatchVideoSplit).toHaveBeenCalledTimes(1);
    const [, userId, input] = dispatchVideoSplit.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(input.durationSec).toBe(90);
    expect(input.episodeIds).toHaveLength(10);
    expect(input.episodeIds).toEqual(body.data.episodeIds);

    // scriptData.videoSplit 持久化（taskId + episodeIds + expectedCount）
    expect(projectRepo.update).toHaveBeenCalledTimes(1);
    const [, patch] = projectRepo.update.mock.calls[0];
    expect(patch.scriptData.videoSplit).toMatchObject({
      taskId: body.data.taskId,
      expectedCount: 10,
      segmentSec: 90,
    });
    expect(patch.scriptData.videoSplit.episodeIds).toHaveLength(10);
  });

  it('200 segmentSec 缺省时默认 90（对齐 app1）', async () => {
    const { segmentSec, ...withoutSeg } = baseBody();
    void segmentSec;
    const res = await POST(
      makeRequest({ method: 'POST', body: withoutSeg }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { data: { segmentSec: number; segmentCount: number } };
    expect(body.data.segmentSec).toBe(90);
    expect(body.data.segmentCount).toBe(10);
  });
});
