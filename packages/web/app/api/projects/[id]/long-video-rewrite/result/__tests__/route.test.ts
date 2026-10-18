// ============================================================
// POST /long-video-rewrite/result — 契约测试（转绘 X3.6a）
// ============================================================
// 覆盖：
//   - 401 / 404
//   - 400 无任何产物字段（refine）
//   - 200 happy：novelText + longVideoRewrite + 默认 status=SCREENWRITING +
//     progress.completed(100)；projectRepo.update 收到合并后的 patch
//   - 200 显式 targetStatus 透传
// mock：@dramaforge/server（projectRepo）+ getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
} from '../../../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../../../test/helpers';
import { POST } from '../route';

const { projectRepo } = serverMock;

const PROJECT_ID = 'proj-1';

function ctx() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

const REWRITE_RESULT = {
  sourceScript: '片段剧本拼接…',
  initialOutline: '初始大纲…',
  outline: '最终大纲…',
  rewrittenScript: '重写完整剧本…',
  targetEpisodeCount: 12,
  analysisFingerprint: 'abc123',
  sourceFileSizeBytes: 3_000_000_000,
};

describe('POST /api/projects/[id]/long-video-rewrite/result (转绘 X3.6a)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    projectRepo.getById.mockReset();
    projectRepo.update.mockReset();
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'user-1' });
    projectRepo.update.mockResolvedValue({ id: PROJECT_ID });
  });

  it('401 未登录不写', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ method: 'POST', body: { novelText: 'x' } }),
      ctx(),
    );
    expect(res.status).toBe(401);
    expect(projectRepo.update).not.toHaveBeenCalled();
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'someone-else' });
    const res = await POST(
      makeRequest({ method: 'POST', body: { novelText: 'x' } }),
      ctx(),
    );
    expect(res.status).toBe(404);
    expect(projectRepo.update).not.toHaveBeenCalled();
  });

  it('400 无任何产物字段', async () => {
    const res = await POST(makeRequest({ method: 'POST', body: { foo: 'bar' } }), ctx());
    expect(res.status).toBe(400);
    expect(projectRepo.update).not.toHaveBeenCalled();
  });

  it('200 happy：novelText + longVideoRewrite → status=SCREENWRITING + progress.completed', async () => {
    const res = await POST(
      makeRequest({
        method: 'POST',
        body: { novelText: '全剧剧本…', videoScriptDraft: '分镜稿…', longVideoRewrite: REWRITE_RESULT },
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { status: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('SCREENWRITING');

    expect(projectRepo.update).toHaveBeenCalledTimes(1);
    const [id, patch] = projectRepo.update.mock.calls[0];
    expect(id).toBe(PROJECT_ID);
    expect(patch.novelText).toBe('全剧剧本…');
    expect(patch.videoScriptDraft).toBe('分镜稿…');
    expect(patch.status).toBe('SCREENWRITING');
    expect(patch.scriptData.longVideoRewrite).toEqual(REWRITE_RESULT);
    expect(patch.longVideoProgress).toMatchObject({ stage: 'completed', progress: 100 });
  });

  it('200 显式 targetStatus 透传', async () => {
    await POST(
      makeRequest({
        method: 'POST',
        body: { videoScriptDraft: '稿', targetStatus: 'STORYBOARD' },
      }),
      ctx(),
    );
    const [, patch] = projectRepo.update.mock.calls[0];
    expect(patch.status).toBe('STORYBOARD');
    expect(patch.novelText).toBeUndefined();
  });
});
