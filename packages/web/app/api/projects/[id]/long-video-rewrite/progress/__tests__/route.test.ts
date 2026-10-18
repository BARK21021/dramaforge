// ============================================================
// GET/PUT /long-video-rewrite/progress — 契约测试（转绘 X3.6a）
// ============================================================
// 覆盖：
//   GET  401 / 404 / 200 返回 longVideoProgress
//   PUT  401 / 404 / 400 非法 stage / 200 写回 progress（projectRepo.update.longVideoProgress）
// mock：@dramaforge/server（projectRepo）+ getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
} from '../../../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../../../test/helpers';
import { GET, PUT } from '../route';

const { projectRepo } = serverMock;

const PROJECT_ID = 'proj-1';

function ctx() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

const PROGRESS_BODY = {
  stage: 'outlining' as const,
  progress: 60,
  currentStep: '生成大纲',
  updatedAt: '2026-07-21T00:00:00.000Z',
};

describe('GET /api/projects/[id]/long-video-rewrite/progress (转绘 X3.6a)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    projectRepo.getById.mockReset();
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      longVideoProgress: PROGRESS_BODY,
    });
  });

  it('401 未登录', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await GET(makeRequest({ method: 'GET' }), ctx());
    expect(res.status).toBe(401);
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'someone-else' });
    const res = await GET(makeRequest({ method: 'GET' }), ctx());
    expect(res.status).toBe(404);
  });

  it('200 返回 longVideoProgress', async () => {
    const res = await GET(makeRequest({ method: 'GET' }), ctx());
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { progress: unknown } };
    expect(body.success).toBe(true);
    expect(body.data.progress).toEqual(PROGRESS_BODY);
  });

  it('200 progress 为 null 时返回 null（未开始）', async () => {
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'user-1', longVideoProgress: null });
    const res = await GET(makeRequest({ method: 'GET' }), ctx());
    const body = (await readJson(res)) as { data: { progress: unknown } };
    expect(body.data.progress).toBeNull();
  });
});

describe('PUT /api/projects/[id]/long-video-rewrite/progress (转绘 X3.6a)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    projectRepo.getById.mockReset();
    projectRepo.update.mockReset();
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'user-1' });
    projectRepo.update.mockResolvedValue({ id: PROJECT_ID });
  });

  it('401 未登录不写', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await PUT(makeRequest({ method: 'POST', body: PROGRESS_BODY }), ctx());
    expect(res.status).toBe(401);
    expect(projectRepo.update).not.toHaveBeenCalled();
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'someone-else' });
    const res = await PUT(makeRequest({ method: 'POST', body: PROGRESS_BODY }), ctx());
    expect(res.status).toBe(404);
    expect(projectRepo.update).not.toHaveBeenCalled();
  });

  it('400 非法 stage', async () => {
    const res = await PUT(
      makeRequest({ method: 'POST', body: { ...PROGRESS_BODY, stage: 'bogus' } }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(projectRepo.update).not.toHaveBeenCalled();
  });

  it('400 progress 越界（>100）', async () => {
    const res = await PUT(
      makeRequest({ method: 'POST', body: { ...PROGRESS_BODY, progress: 150 } }),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('200 写回 longVideoProgress', async () => {
    const res = await PUT(makeRequest({ method: 'POST', body: PROGRESS_BODY }), ctx());
    expect(res.status).toBe(200);
    expect(projectRepo.update).toHaveBeenCalledTimes(1);
    const [id, patch] = projectRepo.update.mock.calls[0];
    expect(id).toBe(PROJECT_ID);
    expect(patch.longVideoProgress).toEqual(PROGRESS_BODY);
  });
});
