// ============================================================
// /api/render/dispatch — 契约测试（UI-facing envelope，GC-4）
// ============================================================
//
// 覆盖：
//   - FILM_EXPORT → dispatchFilmExport → { success:true, data:{ renderJobId } }
//   - CHAIN_GENERATE → dispatchChainGenerate → envelope
//   - VIDEO_SPLIT (durationSec) → dispatchVideoSplit
//   - VIDEO_SPLIT (segments) → dispatchVideoSplit
//   - 400 envelope { code:'VALIDATION_ERROR' } when type 不合法 / body 校验失败
//   - 401 envelope { code:'UNAUTHORIZED' } when 未登录
//
// mock：@dramaforge/server.dispatch* + getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from './mocks';
import { makeRequest, readJson } from './helpers';
import { POST } from '../app/api/render/dispatch/route';

describe('POST /api/render/dispatch', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.dispatchFilmExport.mockReset();
    serverMock.dispatchChainGenerate.mockReset();
    serverMock.dispatchVideoSplit.mockReset();
    serverMock.dispatchLongVideoRewrite.mockReset();
  });

  it('dispatches FILM_EXPORT and returns envelope { success:true, data:{ renderJobId } }', async () => {
    serverMock.dispatchFilmExport.mockResolvedValue({ id: 'job-concat-1' });
    const req = makeRequest({
      method: 'POST',
      body: {
        projectId: 'proj-1',
        type: 'FILM_EXPORT',
        input: {
          clips: [{ url: 'https://a.mp4' }, { url: 'https://b.mp4' }],
          outputUploadUrl: 'https://up',
        },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { renderJobId: string; taskId: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.renderJobId).toBe('job-concat-1');
    // P5: dispatch 也返回 taskId（UI 订阅 SSE 关联用；result/failed 事件带 taskId）。
    expect(body.data.taskId).toBeTypeOf('string');
    expect(serverMock.dispatchFilmExport).toHaveBeenCalledWith(
      expect.any(String), // taskId (genId)
      'user-1',
      {
        clips: [{ url: 'https://a.mp4' }, { url: 'https://b.mp4' }],
        outputUploadUrl: 'https://up',
      },
    );
  });

  it('accepts FILM_EXPORT WITHOUT outputUploadUrl and reaches dispatchFilmExport (regression for C1)', async () => {
    // Regression: concatInputSchema previously declared outputUploadUrl as a
    // required string. A FILM_EXPORT body without it — which is exactly what
    // the UI sends — was rejected at the route boundary with VALIDATION_ERROR
    // and never reached dispatchFilmExport. This test pins the contract: Zod
    // accepts the body and dispatchFilmExport IS called with the parsed input
    // verbatim. P5: films are client-local now, so dispatch adds NO MinIO URL
    // (see packages/server/test/task/dispatch.test.ts — input passes through
    // with no outputUploadUrl/outputKey; the render-worker writes userData/clips/).
    serverMock.dispatchFilmExport.mockResolvedValue({ id: 'job-mint-1' });
    const req = makeRequest({
      method: 'POST',
      body: {
        projectId: 'proj-1',
        type: 'FILM_EXPORT',
        input: {
          clips: [{ url: 'https://a.mp4' }, { url: 'https://b.mp4' }],
          // intentionally no outputUploadUrl — films are client-local (P5)
        },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { renderJobId: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.renderJobId).toBe('job-mint-1');
    // dispatchFilmExport IS reached (Zod no longer blocks).
    expect(serverMock.dispatchFilmExport).toHaveBeenCalledTimes(1);
    // The input arrives verbatim — P5: no MinIO URL/key added anywhere
    // (films are client-local; the render-worker writes userData/clips/).
    expect(serverMock.dispatchFilmExport).toHaveBeenCalledWith(
      expect.any(String), // taskId (genId)
      'user-1',
      {
        clips: [{ url: 'https://a.mp4' }, { url: 'https://b.mp4' }],
      },
    );
  });

  it('dispatches CHAIN_GENERATE and returns success envelope', async () => {
    serverMock.dispatchChainGenerate.mockResolvedValue({ id: 'job-chain-1' });
    const req = makeRequest({
      method: 'POST',
      body: {
        projectId: 'proj-1',
        type: 'CHAIN_GENERATE',
        input: {
          groupResults: [{ url: 'https://g1.mp4', params: { model: 'ark/x' } }],
          outputUploadUrl: 'https://up',
        },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { renderJobId: string } };
    expect(body.success).toBe(true);
    expect(body.data.renderJobId).toBe('job-chain-1');
    expect(serverMock.dispatchChainGenerate).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      expect.objectContaining({ outputUploadUrl: 'https://up' }),
    );
  });

  it('dispatches VIDEO_SPLIT with durationSec', async () => {
    serverMock.dispatchVideoSplit.mockResolvedValue({ id: 'job-split-1' });
    const req = makeRequest({
      method: 'POST',
      body: {
        projectId: 'proj-1',
        type: 'VIDEO_SPLIT',
        input: { videoUrl: 'https://v.mp4', durationSec: 30, outputPrefix: 'clip-' },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { renderJobId: string } };
    expect(body.success).toBe(true);
    expect(body.data.renderJobId).toBe('job-split-1');
    expect(serverMock.dispatchVideoSplit).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      { videoUrl: 'https://v.mp4', durationSec: 30, outputPrefix: 'clip-' },
    );
  });

  it('dispatches VIDEO_SPLIT with segments', async () => {
    serverMock.dispatchVideoSplit.mockResolvedValue({ id: 'job-split-2' });
    const req = makeRequest({
      method: 'POST',
      body: {
        projectId: 'proj-1',
        type: 'VIDEO_SPLIT',
        input: { videoUrl: 'https://v.mp4', segments: 4, outputPrefix: 'seg-' },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { renderJobId: string } };
    expect(body.success).toBe(true);
    expect(body.data.renderJobId).toBe('job-split-2');
    expect(serverMock.dispatchVideoSplit).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      { videoUrl: 'https://v.mp4', segments: 4, outputPrefix: 'seg-' },
    );
  });

  it('dispatches LONG_VIDEO_REWRITE and reaches dispatchLongVideoRewrite (转绘 X3.6b)', async () => {
    serverMock.dispatchLongVideoRewrite.mockResolvedValue({ id: 'job-lv-1' });
    const req = makeRequest({
      method: 'POST',
      body: {
        projectId: 'proj-1',
        type: 'LONG_VIDEO_REWRITE',
        input: {
          videoUrl: '/userData/original-uploads/source.mp4',
          segments: 5,
          projectId: 'proj-1',
          // 伪造身份必须被路由丢弃，实际 userId 只能取已鉴权 session。
          userId: 'attacker',
          totalDurationSec: 3000,
          totalBytes: 200 * 1024 * 1024,
          segmentSec: 600,
        },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { renderJobId: string } };
    expect(body.success).toBe(true);
    expect(body.data.renderJobId).toBe('job-lv-1');
    expect(serverMock.dispatchLongVideoRewrite).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      expect.objectContaining({
        videoUrl: '/userData/original-uploads/source.mp4',
        segments: 5,
        projectId: 'proj-1',
        userId: 'user-1',
        totalDurationSec: 3000,
        totalBytes: 200 * 1024 * 1024,
      }),
    );
  });

  it('rejects LONG_VIDEO_REWRITE before enqueue when required video metadata is missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: {
        type: 'LONG_VIDEO_REWRITE',
        input: { videoUrl: '/userData/original-uploads/source.mp4', segments: 5 },
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(serverMock.dispatchLongVideoRewrite).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR envelope when type is invalid', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { projectId: 'p', type: 'UNKNOWN', input: {} },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR envelope when input shape does not match type', async () => {
    const req = makeRequest({
      method: 'POST',
      body: {
        projectId: 'p',
        type: 'FILM_EXPORT',
        input: { wrong: 'shape' },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 UNAUTHORIZED envelope when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      body: { projectId: 'p', type: 'FILM_EXPORT', input: { clips: [], outputUploadUrl: 'x' } },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
  });
});
