// ============================================================
// POST /api/projects/[id]/video-batch-process — 契约测试（转绘 X4.2）
// ============================================================
// 覆盖：
//   - 401 / 404（非本人）
//   - 400 NO_SEGMENTS / INVALID_SEGMENTS(非 JSON) / SEGMENTS_OVER_LIMIT(>5)
//   - 200 happy 2 集全成功 → results 全 success:true + videoScriptDraft 各写一次
//   - 200 partial：ep1 成功 ep2 callAI 失败 → ep2 success:false + error，ep1 不受影响
//   - 200 episodeId 不属本项目 → fail "分集不属于当前项目"（dramaforge 安全加严）
//   - 200 缺对应视频文件 → fail "未找到...视频文件"
// mock：@dramaforge/server（callAI/episodeRepo/projectRepo）+ session
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
} from '../../../../../../test/mocks';
import { POST } from '../route';

const { callAI, projectRepo, episodeRepo } = serverMock;

const PROJECT_ID = 'proj-1';

function ctx() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

/** 构造 multipart：segments(JSON) + 每集视频（key=episodeId）。 */
function batchRequest(segments: unknown, files: Record<string, Blob>) {
  const fd = new FormData();
  fd.append('segments', JSON.stringify(segments));
  for (const [ep, blob] of Object.entries(files)) fd.append(ep, blob, `${ep}.mp4`);
  return new NextRequest(`http://localhost/api/projects/${PROJECT_ID}/video-batch-process`, {
    method: 'POST',
    body: fd,
  });
}

const smallVideo = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });

describe('POST /api/projects/[id]/video-batch-process (转绘 X4.2)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    callAI.mockReset();
    projectRepo.getById.mockReset();
    episodeRepo.listByProject.mockReset();
    episodeRepo.update.mockReset();
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'user-1' });
    episodeRepo.listByProject.mockResolvedValue([{ id: 'ep-1' }, { id: 'ep-2' }]);
    callAI.mockResolvedValue({ meta: { script: '剧本内容' } });
    episodeRepo.update.mockResolvedValue({});
  });

  it('401 未登录', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(
      batchRequest([{ episodeId: 'ep-1' }], { 'ep-1': smallVideo() }),
      ctx(),
    );
    expect(res.status).toBe(401);
    expect(callAI).not.toHaveBeenCalled();
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'someone-else' });
    const res = await POST(
      batchRequest([{ episodeId: 'ep-1' }], { 'ep-1': smallVideo() }),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('400 缺 segments', async () => {
    const fd = new FormData();
    const res = await POST(
      new NextRequest(`http://localhost/api/projects/${PROJECT_ID}/video-batch-process`, {
        method: 'POST',
        body: fd,
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NO_SEGMENTS');
  });

  it('400 segments 非 JSON', async () => {
    const fd = new FormData();
    fd.append('segments', '{not json');
    const res = await POST(
      new NextRequest(`http://localhost/api/projects/${PROJECT_ID}/video-batch-process`, {
        method: 'POST',
        body: fd,
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_SEGMENTS');
  });

  it('400 超过 5 集（SEGMENTS_OVER_LIMIT）', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ episodeId: `ep-${i + 1}` }));
    const res = await POST(batchRequest(six, {}), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('SEGMENTS_OVER_LIMIT');
    expect(callAI).not.toHaveBeenCalled();
  });

  it('200 happy 2 集全成功', async () => {
    const res = await POST(
      batchRequest(
        [{ episodeId: 'ep-1' }, { episodeId: 'ep-2' }],
        { 'ep-1': smallVideo(), 'ep-2': smallVideo() },
      ),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results).toHaveLength(2);
    expect(body.data.results.every((r: { success: boolean }) => r.success)).toBe(true);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(episodeRepo.update).toHaveBeenCalledTimes(2);
  });

  it('200 partial：ep1 成功 ep2 失败，互不影响', async () => {
    callAI
      .mockResolvedValueOnce({ meta: { script: 'ep1 剧本' } })
      .mockRejectedValueOnce(new Error('Kimi 超时'));
    const res = await POST(
      batchRequest(
        [{ episodeId: 'ep-1' }, { episodeId: 'ep-2' }],
        { 'ep-1': smallVideo(), 'ep-2': smallVideo() },
      ),
      ctx(),
    );
    expect(res.status).toBe(200);
    const results = (await res.json()).data.results as Array<{
      episodeId: string;
      success: boolean;
      error?: string;
    }>;
    const ep1 = results.find((r) => r.episodeId === 'ep-1');
    const ep2 = results.find((r) => r.episodeId === 'ep-2');
    expect(ep1?.success).toBe(true);
    expect(ep2?.success).toBe(false);
    expect(ep2?.error).toContain('Kimi');
  });

  it('200 episodeId 不属本项目 → fail（dramaforge 安全加严）', async () => {
    const res = await POST(
      batchRequest([{ episodeId: 'ep-evil' }], { 'ep-evil': smallVideo() }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const results = (await res.json()).data.results as Array<{
      episodeId: string;
      success: boolean;
      error?: string;
    }>;
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('不属于');
    expect(callAI).not.toHaveBeenCalled();
    expect(episodeRepo.update).not.toHaveBeenCalled();
  });

  it('200 缺对应视频文件 → fail', async () => {
    const res = await POST(batchRequest([{ episodeId: 'ep-1' }], {}), ctx());
    expect(res.status).toBe(200);
    const results = (await res.json()).data.results as Array<{
      success: boolean;
      error?: string;
    }>;
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('未找到');
  });
});
