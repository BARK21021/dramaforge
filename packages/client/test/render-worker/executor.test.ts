// Unit tests for ⑨ render-worker executor.
//
// Passes a mock `ffmpeg` object directly as a dep (no vi.mock needed for
// ffmpeg) and mocks `./uploader` via vi.mock so uploadArtifact is a spy.
// Asserts dispatch by job.type:
//   - CONCAT (P5: client-local) writes the film to deps.filmsDir/<jobId>.mp4,
//     does NOT upload, returns { outputUrl: sf-asset://..., meta:{ localKey } }.
//   - EXTRACT_FRAME calls extractLastFrame + uploads (unchanged — out of P5).
//   - SPLIT_BY_DURATION / SPLIT_EVENLY call the respective split fn and
//     return { outputs }.
//   - CHAIN_COMPILE with no orchestrator throws 'orchestrator not configured
//     for CHAIN_COMPILE'; with an orchestrator it delegates.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import type { RenderJob } from '@dramaforge/shared';
import { executeJob } from '../../src/render-worker/executor';
import type { ExecuteJobDeps } from '../../src/render-worker/executor';

// Mock the uploader so uploadArtifact is a no-op spy. vi.mock is hoisted; the
// factory is self-contained (no outer refs).
vi.mock('../../src/render-worker/uploader', () => ({
  uploadArtifact: vi.fn().mockResolvedValue(undefined),
}));

import { uploadArtifact } from '../../src/render-worker/uploader';

/** A fresh mock ffmpeg module-shape for each test. */
function makeFfmpegMock() {
  return {
    execFfmpegConcat: vi.fn().mockResolvedValue(undefined),
    extractLastFrame: vi.fn().mockResolvedValue(undefined),
    splitVideoByDuration: vi.fn().mockResolvedValue(['/tmp/seg-000.mp4']),
    splitVideoEvenly: vi
      .fn()
      .mockResolvedValue(['/tmp/seg-000.mp4', '/tmp/seg-001.mp4']),
    getVideoDuration: vi.fn().mockResolvedValue(10),
    downloadClips: vi.fn().mockResolvedValue([]),
    gridOverlay: vi.fn().mockResolvedValue(undefined),
    getFfmpegPath: vi.fn().mockReturnValue('/usr/bin/ffmpeg'),
    resolveStorageUrl: vi.fn((s: string) => s),
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Films dir + sf-asset:// builder injected into deps for P5 client-local CONCAT. */
const TEST_FILMS_DIR = path.join(os.tmpdir(), 'sf-executor-films-test');
const testToAssetUrl = (key: string): string => `sf-asset://${key}`;

function makeJob(overrides: Partial<RenderJob> & { type: RenderJob['type']; input: RenderJob['input'] }): RenderJob {
  return {
    id: 'job_1',
    taskId: 'task_1',
    userId: 'user_1',
    status: 'CLAIMED',
    result: null,
    claimedBy: 'm1',
    error: null,
    createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe('executeJob', () => {
  let ffmpegMock: ReturnType<typeof makeFfmpegMock>;

  beforeEach(() => {
    ffmpegMock = makeFfmpegMock();
    vi.mocked(uploadArtifact).mockClear();
    vi.mocked(uploadArtifact).mockResolvedValue(undefined);
  });

  it('CONCAT (client-local): writes film to filmsDir/<jobId>.mp4, no upload, returns sf-asset URL + localKey', async () => {
    const job = makeJob({
      id: 'job_1',
      type: 'CONCAT',
      input: {
        clips: [{ url: 'https://a.mp4' }, { url: 'https://b.mp4' }],
      },
    });
    const deps: ExecuteJobDeps = {
      ffmpeg: ffmpegMock,
      logger: noopLogger,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    };

    const result = await executeJob(job, deps);

    expect(ffmpegMock.execFfmpegConcat).toHaveBeenCalledTimes(1);
    // The film is written directly to <filmsDir>/<jobId>.mp4 (persisted, NOT tmp).
    expect(ffmpegMock.execFfmpegConcat).toHaveBeenCalledWith(
      [{ url: 'https://a.mp4' }, { url: 'https://b.mp4' }],
      path.join(TEST_FILMS_DIR, 'job_1.mp4'),
    );
    // NO MinIO upload — the server is never in the byte path (dramaforge-assets-client-local).
    expect(uploadArtifact).not.toHaveBeenCalled();
    // Result carries the sf-asset:// URL + the local film key.
    expect(result).toEqual({
      outputUrl: 'sf-asset://job_1.mp4',
      meta: { localKey: 'job_1.mp4' },
    });
  });

  it('CONCAT needs no outputUploadUrl/outputKey (films are client-local, not MinIO)', async () => {
    // P5 regression: the legacy MinIO fields are gone from the product path.
    // A CONCAT input carrying neither must succeed and write locally — the old
    // executor THREW when outputUploadUrl was missing; it must not anymore.
    const job = makeJob({
      id: 'aaa-bbb-ccc',
      type: 'CONCAT',
      input: { clips: [{ url: 'https://only.mp4' }] },
    });
    const result = await executeJob(job, {
      ffmpeg: ffmpegMock,
      logger: noopLogger,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });
    expect(ffmpegMock.execFfmpegConcat).toHaveBeenCalledWith(
      [{ url: 'https://only.mp4' }],
      path.join(TEST_FILMS_DIR, 'aaa-bbb-ccc.mp4'),
    );
    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(result.outputUrl).toBe('sf-asset://aaa-bbb-ccc.mp4');
    expect(result.meta).toEqual({ localKey: 'aaa-bbb-ccc.mp4' });
  });

  it('CONCAT 把 sf-asset 视频安全解析为 filmsDir 本地路径后再交给 ffmpeg', async () => {
    const job = makeJob({
      id: 'episode-film-1',
      type: 'CONCAT',
      input: {
        clips: [
          { url: 'sf-asset://group-a.mp4', durationSec: 7 },
          { url: 'https://cdn.example/group-b.mp4', durationSec: 5 },
        ],
      },
    });

    await executeJob(job, {
      ffmpeg: ffmpegMock,
      logger: noopLogger,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
      apiBase: 'https://example.test',
    });

    expect(ffmpegMock.execFfmpegConcat).toHaveBeenCalledWith(
      [
        { url: path.resolve(TEST_FILMS_DIR, 'group-a.mp4'), durationSec: 7 },
        { url: 'https://cdn.example/group-b.mp4', durationSec: 5 },
      ],
      path.join(TEST_FILMS_DIR, 'episode-film-1.mp4'),
    );
  });

  it('CONCAT 拒绝 sf-asset 目录穿越、查询串和非 MP4 扩展名', async () => {
    const invalidUrls = [
      'sf-asset://clip.mp4/../../outside.mp4',
      'sf-asset://clip.mp4?download=1',
      'sf-asset://clip.png',
    ];

    for (const url of invalidUrls) {
      const job = makeJob({
        type: 'CONCAT',
        input: { clips: [{ url }] },
      });
      await expect(executeJob(job, {
        ffmpeg: ffmpegMock,
        logger: noopLogger,
        filmsDir: TEST_FILMS_DIR,
        toAssetUrl: testToAssetUrl,
        apiBase: 'https://example.test',
      })).rejects.toThrow(/CONCAT 本地素材地址非法|CONCAT 本地素材越界/);
    }
    expect(ffmpegMock.execFfmpegConcat).not.toHaveBeenCalled();
  });

  it('把任务 AbortSignal 传给 FFmpeg，并拒绝取消后才返回的结果', async () => {
    const controller = new AbortController();
    const cancelError = new Error('lease lost');
    ffmpegMock.execFfmpegConcat.mockImplementationOnce(async () => {
      // 模拟子依赖恰好在完成时收到服务端取消；执行器仍须在返回前再检查一次。
      controller.abort(cancelError);
    });
    const job = makeJob({
      type: 'CONCAT',
      input: { clips: [{ url: 'https://only.mp4' }] },
    });

    await expect(
      executeJob(job, {
        ffmpeg: ffmpegMock,
        logger: noopLogger,
        filmsDir: TEST_FILMS_DIR,
        toAssetUrl: testToAssetUrl,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancelError);

    expect(ffmpegMock.execFfmpegConcat).toHaveBeenCalledWith(
      [{ url: 'https://only.mp4' }],
      path.join(TEST_FILMS_DIR, 'job_1.mp4'),
      controller.signal,
    );
  });

  it('EXTRACT_FRAME calls extractLastFrame with the video URL + local out path, uploads', async () => {
    const job = makeJob({
      type: 'EXTRACT_FRAME',
      input: {
        videoUrl: 'https://v.mp4',
        atSec: 5,
        outputUploadUrl: 'https://upload/frame.jpg',
      },
    });

    const result = await executeJob(job, {
      ffmpeg: ffmpegMock,
      logger: noopLogger,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    expect(ffmpegMock.extractLastFrame).toHaveBeenCalledTimes(1);
    expect(ffmpegMock.extractLastFrame).toHaveBeenCalledWith(
      'https://v.mp4',
      expect.any(String),
    );
    const localOut = ffmpegMock.extractLastFrame.mock.calls[0][1] as string;
    expect(localOut).toMatch(/sf-render-.*\.jpg$/);
    expect(uploadArtifact).toHaveBeenCalledWith(localOut, 'https://upload/frame.jpg');
    expect(result).toEqual({ outputUrl: 'https://upload/frame.jpg' });
  });

  it('SPLIT_BY_DURATION calls splitVideoByDuration and returns outputs', async () => {
    const job = makeJob({
      type: 'SPLIT_BY_DURATION',
      input: {
        videoUrl: 'https://v.mp4',
        durationSec: 3,
        outputPrefix: 'seg-',
      },
    });

    const result = await executeJob(job, {
      ffmpeg: ffmpegMock,
      logger: noopLogger,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    expect(ffmpegMock.splitVideoByDuration).toHaveBeenCalledTimes(1);
    expect(ffmpegMock.splitVideoByDuration).toHaveBeenCalledWith(
      'https://v.mp4',
      3,
      expect.any(String),
    );
    // No upload URL in the SPLIT contract — nothing to upload.
    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(result.outputs).toEqual(['/tmp/seg-000.mp4']);
    expect(result.meta).toMatchObject({ outputPrefix: 'seg-' });
  });

  it('SPLIT_EVENLY calls splitVideoEvenly and returns outputs', async () => {
    const job = makeJob({
      type: 'SPLIT_EVENLY',
      input: {
        videoUrl: 'https://v.mp4',
        segments: 2,
        outputPrefix: 'seg-',
      },
    });

    const result = await executeJob(job, {
      ffmpeg: ffmpegMock,
      logger: noopLogger,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
    });

    expect(ffmpegMock.splitVideoEvenly).toHaveBeenCalledWith(
      'https://v.mp4',
      2,
      expect.any(String),
    );
    expect(result.outputs).toEqual(['/tmp/seg-000.mp4', '/tmp/seg-001.mp4']);
    expect(uploadArtifact).not.toHaveBeenCalled();
  });

  it('CHAIN_COMPILE with no orchestrator throws "orchestrator not configured for CHAIN_COMPILE"', async () => {
    const job = makeJob({
      type: 'CHAIN_COMPILE',
      input: {
        groupResults: [{ url: 'https://g.mp4' }],
        outputUploadUrl: 'https://upload/c.mp4',
      },
    });

    await expect(
      executeJob(job, {
        ffmpeg: ffmpegMock,
        logger: noopLogger,
        filmsDir: TEST_FILMS_DIR,
        toAssetUrl: testToAssetUrl,
      }),
    ).rejects.toThrow('orchestrator not configured for CHAIN_COMPILE');
    expect(uploadArtifact).not.toHaveBeenCalled();
  });

  it('CHAIN_COMPILE with an orchestrator delegates to it and returns its result', async () => {
    const controller = new AbortController();
    const chainCompile = vi
      .fn()
      .mockResolvedValue({ outputUrl: 'https://upload/c.mp4', meta: { groups: 1 } });
    const job = makeJob({
      type: 'CHAIN_COMPILE',
      input: {
        groupResults: [{ url: 'https://g.mp4' }],
        outputUploadUrl: 'https://upload/c.mp4',
      },
    });

    const result = await executeJob(job, {
      ffmpeg: ffmpegMock,
      logger: noopLogger,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
      orchestrators: { chainCompile },
      signal: controller.signal,
    });

    expect(chainCompile).toHaveBeenCalledTimes(1);
    const [inputArg, ctxArg] = chainCompile.mock.calls[0];
    expect(inputArg).toEqual({
      groupResults: [{ url: 'https://g.mp4' }],
      outputUploadUrl: 'https://upload/c.mp4',
    });
    // The orchestrator receives ffmpeg + logger in its ctx.
    expect(ctxArg.ffmpeg).toBe(ffmpegMock);
    expect(ctxArg.logger).toBe(noopLogger);
    // 组合任务必须收到与 FFmpeg 任务相同的取消信号，才能打断云端 fetch。
    expect(ctxArg.signal).toBe(controller.signal);
    expect(result).toEqual({ outputUrl: 'https://upload/c.mp4', meta: { groups: 1 } });
    // The executor itself does not upload for CHAIN_COMPILE — the orchestrator owns that.
    expect(uploadArtifact).not.toHaveBeenCalled();
  });

  it('LONG_VIDEO_REWRITE with no orchestrator throws', async () => {
    const job = makeJob({
      type: 'LONG_VIDEO_REWRITE',
      input: {
        videoUrl: 'https://v.mp4',
        segments: 3,
        projectId: 'project-lvr',
        totalDurationSec: 1_800,
        totalBytes: 120 * 1024 * 1024,
        outputUploadUrl: 'https://upload/lvr.mp4',
      },
    });

    await expect(
      executeJob(job, {
        ffmpeg: ffmpegMock,
        logger: noopLogger,
        filmsDir: TEST_FILMS_DIR,
        toAssetUrl: testToAssetUrl,
      }),
    ).rejects.toThrow('orchestrator not configured for LONG_VIDEO_REWRITE');
  });

  it('LONG_VIDEO_REWRITE with an orchestrator delegates to it', async () => {
    const longVideoRewrite = vi
      .fn()
      .mockResolvedValue({ outputUrl: 'https://upload/lvr.mp4' });
    const job = makeJob({
      type: 'LONG_VIDEO_REWRITE',
      input: {
        videoUrl: 'https://v.mp4',
        segments: 3,
        projectId: 'project-lvr',
        totalDurationSec: 1_800,
        totalBytes: 120 * 1024 * 1024,
        outputUploadUrl: 'https://upload/lvr.mp4',
      },
    });

    const result = await executeJob(job, {
      ffmpeg: ffmpegMock,
      logger: noopLogger,
      filmsDir: TEST_FILMS_DIR,
      toAssetUrl: testToAssetUrl,
      orchestrators: { longVideoRewrite },
    });

    expect(longVideoRewrite).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outputUrl: 'https://upload/lvr.mp4' });
  });
});
