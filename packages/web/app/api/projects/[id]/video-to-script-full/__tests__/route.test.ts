// ============================================================
// POST /api/projects/[id]/video-to-script-full — 契约测试（转绘 X4.1）
// ============================================================
// 覆盖：
//   - 401 / 404（非本人 / 带 episodeId 但不属项目）
//   - 400 NO_FILE / INVALID_FILE_TYPE / FILE_TOO_LARGE
//   - 200 happy 无 episodeId：自动建集 + 写 scriptData + stageStatus=analyzing +
//     project DRAFT→SCREENWRITING
//   - 200 happy 带 episodeId：不建集 + scriptData 与 existing merge
//   - 200 project 非 DRAFT：不 bump project status
//   - 502 EMPTY_SCRIPT
// mock：@dramaforge/server（callAI/GatewayError/episodeRepo/projectRepo）+ session
// helper runVideoToScript 经 callAI mock 间接覆盖（@dramaforge/server 全局 mock）。
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

function videoRequest(opts: { file?: Blob; filename?: string; episodeId?: string; episodeTitle?: string } = {}) {
  const fd = new FormData();
  if (opts.file) fd.append('video', opts.file, opts.filename ?? 'clip.mp4');
  if (opts.episodeId) fd.append('episodeId', opts.episodeId);
  if (opts.episodeTitle) fd.append('episodeTitle', opts.episodeTitle);
  return new NextRequest(`http://localhost/api/projects/${PROJECT_ID}/video-to-script-full`, {
    method: 'POST',
    body: fd,
  });
}

const smallVideo = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });
const bigVideo = () => new Blob([new Uint8Array(101 * 1024 * 1024)], { type: 'video/mp4' });

describe('POST /api/projects/[id]/video-to-script-full (转绘 X4.1)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    callAI.mockReset();
    projectRepo.getById.mockReset();
    projectRepo.update.mockReset();
    episodeRepo.getById.mockReset();
    episodeRepo.create.mockReset();
    episodeRepo.update.mockReset();
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'user-1', status: 'DRAFT' });
    callAI.mockResolvedValue({
      meta: { script: '第1集 张三走进酒馆。', characters: [{ name: '张三' }], locations: [{ name: '酒馆' }], timePeriod: '现代' },
    });
    episodeRepo.create.mockResolvedValue({ id: 'ep-new', projectId: PROJECT_ID, scriptData: null });
    episodeRepo.update.mockResolvedValue({});
    projectRepo.update.mockResolvedValue({});
  });

  it('401 未登录不调 callAI', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(videoRequest({ file: smallVideo() }), ctx());
    expect(res.status).toBe(401);
    expect(callAI).not.toHaveBeenCalled();
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'someone-else', status: 'DRAFT' });
    const res = await POST(videoRequest({ file: smallVideo() }), ctx());
    expect(res.status).toBe(404);
    expect(callAI).not.toHaveBeenCalled();
  });

  it('400 没有视频文件', async () => {
    const res = await POST(videoRequest({}), ctx());
    expect(res.status).toBe(400);
    expect(callAI).not.toHaveBeenCalled();
  });

  it('400 不支持的视频格式', async () => {
    // 扩展名非白名单 + MIME 非 video（route 接受 ext 或 mime 任一合法，故两者都非法才拒）
    const res = await POST(
      videoRequest({
        file: new Blob([new Uint8Array([1])], { type: 'application/octet-stream' }),
        filename: 'c.avi',
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_FILE_TYPE');
  });

  it('400 视频过大', async () => {
    const res = await POST(videoRequest({ file: bigVideo() }), ctx());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('FILE_TOO_LARGE');
  });

  it('200 happy 无 episodeId：自动建集 + scriptData + stage analyzing + project SCREENWRITING', async () => {
    const res = await POST(videoRequest({ file: smallVideo() }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.episodeId).toBe('ep-new');
    expect(body.data.script).toContain('张三');

    // 自动建集一次
    expect(episodeRepo.create).toHaveBeenCalledTimes(1);
    // episode 写 scriptData + videoScriptDraft + stageStatus
    expect(episodeRepo.update).toHaveBeenCalledTimes(1);
    const [, epPatch] = episodeRepo.update.mock.calls[0];
    expect(epPatch.videoScriptDraft).toContain('张三');
    expect(epPatch.stageStatus).toBe('analyzing');
    expect(epPatch.scriptData).toMatchObject({ novelText: expect.stringContaining('张三'), videoFilename: 'clip.mp4' });
    // project DRAFT → SCREENWRITING
    expect(projectRepo.update).toHaveBeenCalledTimes(1);
    const [, projPatch] = projectRepo.update.mock.calls[0];
    expect(projPatch.status).toBe('SCREENWRITING');
  });

  it('200 happy 带 episodeId：不建集 + scriptData 与 existing merge', async () => {
    episodeRepo.getById.mockResolvedValue({
      id: 'ep-existing',
      projectId: PROJECT_ID,
      scriptData: { existingKey: '保留' },
    });
    const res = await POST(
      videoRequest({ file: smallVideo(), episodeId: 'ep-existing' }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.episodeId).toBe('ep-existing');
    expect(episodeRepo.create).not.toHaveBeenCalled();
    const [, epPatch] = episodeRepo.update.mock.calls[0];
    // existing key 保留 + 新 key 注入
    expect(epPatch.scriptData).toMatchObject({ existingKey: '保留', novelText: expect.any(String) });
  });

  it('200 project 非 DRAFT：不 bump status，但同步写 novelText 供资产提取读取', async () => {
    projectRepo.getById.mockResolvedValue({ id: PROJECT_ID, userId: 'user-1', status: 'PRODUCTION' });
    await POST(videoRequest({ file: smallVideo() }), ctx());
    expect(projectRepo.update).toHaveBeenCalledTimes(1);
    const [, projPatch] = projectRepo.update.mock.calls[0];
    // 不 bump status
    expect(projPatch.status).toBeUndefined();
    // 同步写 project.novelText（whole-script-asset-extraction 只读 project.novelText）
    expect(projPatch.novelText).toContain('张三');
  });

  it('502 Kimi 返空 script', async () => {
    callAI.mockResolvedValue({ meta: { script: '' } });
    const res = await POST(videoRequest({ file: smallVideo() }), ctx());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('EMPTY_SCRIPT');
    expect(episodeRepo.update).not.toHaveBeenCalled();
  });
});
