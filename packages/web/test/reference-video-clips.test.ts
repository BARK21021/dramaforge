// ============================================================
// POST/DELETE /api/projects/[id]/reference-video/clips — 契约测试
// ============================================================
//
// 覆盖：
//   - 正常 POST：零字节元数据落 project.scriptData.referenceVideo（浅合并）
//   - fileKey 白名单：他人用户前缀 / 非 clip-<i>.mp4 形态 / 任意 key → 403
//   - 未登录 401；项目不存在/非本人 404
//   - body 校验：clips 空 / durationSec 超 15s / 超 40 片 → 400
//   - DELETE：清 scriptData.referenceVideo + best-effort 删 MinIO 对象（幂等）
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from './mocks';
import { makeRequest, readJson } from './helpers';
import { POST, DELETE } from '../app/api/projects/[id]/reference-video/clips/route';

const CLIP_0 = {
  index: 0,
  startSec: 0,
  endSec: 8.4,
  durationSec: 8.4,
  fileKey: 'uploads/user-1/reference-video/proj-1/clip-0.mp4',
  height: 720,
};
const CLIP_1 = {
  index: 1,
  startSec: 8.4,
  endSec: 15,
  durationSec: 6.6,
  fileKey: 'uploads/user-1/reference-video/proj-1/clip-1.mp4',
  height: 720,
};

function makeProject(scriptData: Record<string, unknown> | null = null) {
  return {
    id: 'proj-1',
    userId: 'user-1',
    title: '海外参考视频项目',
    category: 'OVERSEAS',
    scriptData,
  } as never;
}

const params = Promise.resolve({ id: 'proj-1' });

describe('POST /api/projects/[id]/reference-video/clips', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.getStorage.mockReset();
    serverMock.getStorage.mockReturnValue({
      delete: vi.fn().mockResolvedValue(undefined),
      presignUpload: vi.fn().mockResolvedValue('https://mock-upload-url'),
    });
    serverMock.projectRepo.getById.mockReset();
    serverMock.projectRepo.update.mockReset();
    serverMock.projectRepo.update.mockResolvedValue(makeProject());
  });

  it('persists zero-byte clip metadata into project.scriptData.referenceVideo', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const res = await POST(
      makeRequest({
        method: 'POST',
        body: { clips: [CLIP_0, CLIP_1], sourceDurationSec: 60 },
      }),
      { params },
    );

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean };
    expect(body.success).toBe(true);
    expect(serverMock.projectRepo.update).toHaveBeenCalledWith('proj-1', {
      scriptData: expect.objectContaining({
        referenceVideo: expect.objectContaining({
          clips: [CLIP_0, CLIP_1],
          sourceDurationSec: 60,
          uploadedAt: expect.any(String),
        }),
      }),
    });
  });

  it('rejects fileKey outside the user+project namespace with 403', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const evil = { ...CLIP_0, fileKey: 'uploads/user-2/reference-video/proj-1/clip-0.mp4' };
    const res = await POST(
      makeRequest({ method: 'POST', body: { clips: [evil], sourceDurationSec: 10 } }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(serverMock.projectRepo.update).not.toHaveBeenCalled();
  });

  it('rejects arbitrary keys (not clip-<i>.mp4 shape) with 403', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const evil = { ...CLIP_0, fileKey: 'uploads/user-1/renders/evil.mp4' };
    const res = await POST(
      makeRequest({ method: 'POST', body: { clips: [evil], sourceDurationSec: 10 } }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(serverMock.projectRepo.update).not.toHaveBeenCalled();
  });

  it('rejects empty clips / duration beyond 15s / more than 40 clips with 400', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const cases = [
      { clips: [], sourceDurationSec: 10 },
      { clips: [{ ...CLIP_0, durationSec: 16 }], sourceDurationSec: 10 },
      {
        clips: Array.from({ length: 41 }, (_, i) => ({
          ...CLIP_0,
          index: i,
          fileKey: `uploads/user-1/reference-video/proj-1/clip-${i}.mp4`,
        })),
        sourceDurationSec: 10,
      },
    ];
    for (const body of cases) {
      const res = await POST(makeRequest({ method: 'POST', body }), { params });
      expect(res.status).toBe(400);
    }
    expect(serverMock.projectRepo.update).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ method: 'POST', body: { clips: [CLIP_0], sourceDurationSec: 10 } }),
      { params },
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when project missing or not owned', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ method: 'POST', body: { clips: [CLIP_0], sourceDurationSec: 10 } }),
      { params },
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/projects/[id]/reference-video/clips', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.getStorage.mockReset();
    serverMock.getStorage.mockReturnValue({
      delete: vi.fn().mockResolvedValue(undefined),
      presignUpload: vi.fn().mockResolvedValue('https://mock-upload-url'),
    });
    serverMock.projectRepo.getById.mockReset();
    serverMock.projectRepo.update.mockReset();
    serverMock.projectRepo.update.mockResolvedValue(makeProject());
  });

  it('deletes MinIO objects and clears scriptData.referenceVideo (idempotent)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(
      makeProject({
        referenceVideo: { clips: [CLIP_0, CLIP_1], sourceDurationSec: 60, uploadedAt: 'x' },
      }),
    );

    const res = await DELETE(makeRequest({ method: 'DELETE' }), { params });

    expect(res.status).toBe(200);
    const storage = serverMock.getStorage();
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(storage.delete).toHaveBeenCalledWith(CLIP_0.fileKey);
    expect(serverMock.projectRepo.update).toHaveBeenCalledWith('proj-1', {
      scriptData: { referenceVideo: null },
    });
  });

  it('is a no-op when no referenceVideo recorded', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    const res = await DELETE(makeRequest({ method: 'DELETE' }), { params });
    expect(res.status).toBe(200);
    expect(serverMock.getStorage().delete).not.toHaveBeenCalled();
    expect(serverMock.projectRepo.update).toHaveBeenCalledWith('proj-1', {
      scriptData: { referenceVideo: null },
    });
  });
});
