// Unit tests for ⑩ orchestrators/chain-generate.
//
// Mocks global `fetch` (cloud AI returns the GC-4 UI envelope
// {success:true, data:{url}}) + mocks @client/ffmpeg (vi.mock). The ffmpeg
// mocks for extractLastFrame / gridOverlay / downloadClips write real
// (fake-bytes) files at the paths they return, because the orchestrator
// reads the grid-overlay PNG back into base64 for the next group's AI
// request body, and the concat mock must leave chain-out.mp4 on disk so
// the batch 7 OP1 client-local copyFile has a source.
//
// Batch 7 OP1 (dramaforge-assets-client-local): the orchestrator writes the film
// to ctx.filmsDir/<jobId>.mp4 + returns sf-asset://<jobId>.mp4. There is NO
// uploadArtifact import any more; the test instead asserts the local write
// + sf-asset:// URL + meta.localKey.
//
// Covers:
//   - 2-group chain: AI called twice, extractLastFrame+gridOverlay called
//     between (once), execFfmpegConcat called at end with both group URLs,
//     local film written at filmsDir/<jobId>.mp4, sf-asset:// URL returned.
//   - Per-group retry: first group's AI fails twice then passes → withRetry
//     retries 3 total attempts and succeeds.
//   - Group failing 3x → throws (job fails; loop will POST /failed).
//   - Pass-through: entry with no `params` skips the AI and uses entry.url.
//   - Failure envelope {success:false, error, code} → orchestrator surfaces
//     THAT error (not the generic 'missing url').

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock @client/ffmpeg. The factory is self-contained (vi.mock is hoisted; no
// outer refs). extractLastFrame / gridOverlay / downloadClips write real fake
// files at their out-path so the orchestrator can fs.readFile them back.
// execFfmpegConcat writes the concat output (chain-out.mp4) as a real fake
// file so the orchestrator's copyFile to filmsDir has a source.
vi.mock('../../src/ffmpeg', () => ({
  execFfmpegConcat: vi.fn(async (_clips: unknown, outPath: string) => {
    await fs.writeFile(outPath, Buffer.from('fake-mp4'));
  }),
  extractLastFrame: vi.fn(async (_url: string, outPath: string) => {
    await fs.writeFile(outPath, Buffer.from('fake-jpg'));
  }),
  splitVideoByDuration: vi.fn().mockResolvedValue(['/tmp/seg-000.mp4']),
  splitVideoEvenly: vi.fn().mockResolvedValue(['/tmp/seg-000.mp4']),
  getVideoDuration: vi.fn().mockResolvedValue(10),
  downloadClips: vi.fn(async (urls: string[], dir: string) => {
    await fs.mkdir(dir, { recursive: true });
    // 用真实临时文件模拟下载结果，才能验证组片从 tmp 持久化到 clipsDir 的行为。
    const files = urls.map((_url, i) => path.join(dir, `clip-${i}.mp4`));
    await Promise.all(files.map((file, i) => fs.writeFile(file, Buffer.from(`fake-clip-${i}`))));
    return files;
  }),
  gridOverlay: vi.fn(async (_frames: string[], outPath: string) => {
    await fs.writeFile(outPath, Buffer.from('fake-png'));
  }),
  // 人物参考图管线（resize≤1280 + 网格 + JPEG 重编码）：返回固定 fake-jpeg，调用方转 data:image/jpeg。
  applyCharacterReferenceGrid: vi.fn(async (_imageBuf: Buffer, _opts?: unknown) => {
    return Buffer.from('fake-jpeg');
  }),
  getFfmpegPath: vi.fn().mockReturnValue('/usr/bin/ffmpeg'),
  resolveStorageUrl: vi.fn((s: string) => s),
}));

import { chainCompile } from '../../src/orchestrators/chain-generate';
import type { OrchestratorContext } from '../../src/render-worker';
import type { ChainCompileInput } from '@dramaforge/shared';
import * as ffmpeg from '../../src/ffmpeg';

const originalFetch = globalThis.fetch;

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const FIXED_JOB_ID = 'job-test-1';

async function makeCtx(voicesDir?: string): Promise<{ ctx: OrchestratorContext; filmsDir: string }> {
  const filmsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-chain-films-'));
  const ctx: OrchestratorContext = {
    ffmpeg,
    logger: noopLogger,
    apiBase: 'https://api.example.com',
    authCookie: 'sid=abc',
    machineId: 'm1',
    filmsDir,
    voicesDir,
    toAssetUrl: (key: string) => `sf-asset://${key}`,
    jobId: FIXED_JOB_ID,
  };
  return { ctx, filmsDir };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('chainCompile', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    vi.mocked(ffmpeg.execFfmpegConcat).mockClear();
    vi.mocked(ffmpeg.extractLastFrame).mockClear();
    vi.mocked(ffmpeg.gridOverlay).mockClear();
    vi.mocked(ffmpeg.applyCharacterReferenceGrid).mockClear();
    vi.mocked(ffmpeg.downloadClips).mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * 异步视频生成 mock：把「每组返回 videoUrl」语义封装成派发+轮询两阶段。
   * dispatchOutcomes[i] = 第 i 次 POST /api/generate/video-async 派发的任务，轮询该 taskId 的结果：
   *   string → COMPLETED + output.videoUrl=该 string
   *   Error  → FAILED + error=该 Error.message（模拟该组生成失败）
   */
  function mockAsyncVideoGeneration(
    fetchMock: ReturnType<typeof vi.fn>,
    dispatchOutcomes: (string | Error)[],
  ): void {
    let dispatchCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        const idx = dispatchCount++;
        return jsonResponse({ success: true, data: { taskId: `task-${idx}` } });
      }
      if (u.includes('/api/tasks/')) {
        const m = u.match(/\/api\/tasks\/([^/?]+)/);
        const idx = Number((m?.[1] ?? '').replace(/^task-/, ''));
        const outcome = dispatchOutcomes[idx];
        if (outcome instanceof Error) {
          return jsonResponse({ success: true, data: { status: 'FAILED', error: outcome.message } });
        }
        return jsonResponse({ success: true, data: { status: 'COMPLETED', output: { videoUrl: outcome } } });
      }
      // 其它 fetch（如末帧衔接的 http(s) 参考图）原样返回 200 空 envelope
      return jsonResponse({ success: true, data: {} });
    });
  }

  it('2-group chain: AI x2, extractLastFrame+gridOverlay x1 between, concat + local write at end (sf-asset://)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'group-0', model: 'seedance' } },
        { url: '', params: { prompt: 'group-1', model: 'seedance' } },
      ],
    };

    mockAsyncVideoGeneration(fetchMock, [
      'https://ai/group-0.mp4',
      'https://ai/group-1.mp4',
    ]);

    const { ctx, filmsDir } = await makeCtx();
    const result = await chainCompile(input, ctx);

    // AI dispatched twice (one per group) via the async endpoint.
    const aiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    );
    expect(aiCalls).toHaveLength(2);

    // extractLastFrame + gridOverlay called once each (between group 0 and 1).
    expect(ffmpeg.extractLastFrame).toHaveBeenCalledTimes(1);
    expect(ffmpeg.gridOverlay).toHaveBeenCalledTimes(1);

    // downloadClips called once with both AI-returned URLs.
    expect(ffmpeg.downloadClips).toHaveBeenCalledTimes(1);
    expect(ffmpeg.downloadClips).toHaveBeenCalledWith(
      ['https://ai/group-0.mp4', 'https://ai/group-1.mp4'],
      expect.any(String),
    );

    // execFfmpegConcat called once at the end with 2 clips (the local paths
    // returned by downloadClips).
    expect(ffmpeg.execFfmpegConcat).toHaveBeenCalledTimes(1);
    const [clipsArg, outArg] = ffmpeg.execFfmpegConcat.mock.calls[0] as [
      { url: string }[],
      string,
    ];
    expect(clipsArg).toHaveLength(2);
    expect(clipsArg[0].url).toMatch(/clip-0\.mp4$/);
    expect(clipsArg[1].url).toMatch(/clip-1\.mp4$/);
    expect(outArg).toMatch(/chain-out\.mp4$/);

    // Batch 7 OP1: the film is persisted at filmsDir/<jobId>.mp4 — NO MinIO
    // upload. The orchestrator returns an sf-asset:// URL + meta.localKey.
    const filmPath = path.join(filmsDir, `${FIXED_JOB_ID}.mp4`);
    const written = await fs.readFile(filmPath);
    expect(written).toEqual(Buffer.from('fake-mp4'));

    expect(result).toEqual({
      outputUrl: `sf-asset://${FIXED_JOB_ID}.mp4`,
      meta: {
        localKey: `${FIXED_JOB_ID}.mp4`,
        totalGroups: 2,
        reusedGroups: 0,
        generatedGroups: 2,
        failedGroups: 0,
        skippedGroups: 0,
      },
    });
  });

  it('88% concat reuses the locally-saved progressive clip for expiring ark/TOS URLs (Ep24/25 403 修复)', async () => {
    // ark/TOS 签名 URL ~1h 过期。渐进回传生成时（URL 新鲜）已把组视频落盘到
    // <jobId>-group-1.mp4。88% 拼接应优先用本地副本，不重拉过期 URL（否则 downloadClips
    // HTTP 403 → 整链 FAILED，Ep24/25 根因）。
    const arkUrl = 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance/grp.mp4?X-Amz-Expires=3600';
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', shotIds: ['shot-1'], params: { prompt: 'group-0', model: 'seedance' } },
      ],
    };
    mockAsyncVideoGeneration(fetchMock, [arkUrl]);
    const { ctx, filmsDir } = await makeCtx();

    await chainCompile(input, ctx);

    // 渐进回传已把组视频落盘为本地副本
    const progressivePath = path.join(filmsDir, `${FIXED_JOB_ID}-group-1.mp4`);
    await expect(fs.readFile(progressivePath)).resolves.toBeDefined();
    // 最后一次 downloadClips = 88% 拼接；应收到本地副本路径，而非过期的 ark/TOS URL。
    const lastDlCall = ffmpeg.downloadClips.mock.calls.at(-1) as [string[], string];
    expect(lastDlCall[0]).toEqual([progressivePath]);
  });

  it('persists generated group clips and reports their shot mappings for server-side refresh recovery', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', shotIds: ['shot-1', 'shot-2'], params: { prompt: 'group-0' } },
        { url: '', shotIds: ['shot-3'], params: { prompt: 'group-1' } },
      ],
    };
    mockAsyncVideoGeneration(fetchMock, [
      'https://ai/group-0.mp4',
      'https://ai/group-1.mp4',
    ]);
    const { ctx, filmsDir } = await makeCtx();

    const result = await chainCompile(input, ctx);

    // 每个镜头组必须有独立、稳定的客户端本地视频，不能只留下整集成片。
    await expect(fs.readFile(path.join(filmsDir, `${FIXED_JOB_ID}-group-1.mp4`)))
      .resolves.toEqual(Buffer.from('fake-clip-0'));
    await expect(fs.readFile(path.join(filmsDir, `${FIXED_JOB_ID}-group-2.mp4`)))
      .resolves.toEqual(Buffer.from('fake-clip-1'));
    expect(result.meta?.groupClips).toEqual([
      {
        shotIds: ['shot-1', 'shot-2'],
        videoUrl: `sf-asset://${FIXED_JOB_ID}-group-1.mp4`,
        localKey: `${FIXED_JOB_ID}-group-1.mp4`,
      },
      {
        shotIds: ['shot-3'],
        videoUrl: `sf-asset://${FIXED_JOB_ID}-group-2.mp4`,
        localKey: `${FIXED_JOB_ID}-group-2.mp4`,
      },
    ]);
  });

  it('渐进回传:每组完成即下载到本地 + 发 groupClip(reportProgress 带 shotIds + sf-asset url)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', shotIds: ['shot-1', 'shot-2'], params: { prompt: 'group-0' } },
        { url: '', shotIds: ['shot-3'], params: { prompt: 'group-1' } },
      ],
    };
    mockAsyncVideoGeneration(fetchMock, ['https://ai/group-0.mp4', 'https://ai/group-1.mp4']);
    const { ctx, filmsDir } = await makeCtx();
    const reportProgress = vi.fn<
      (progress: number, stage: string, groupClip?: { shotIds: string[]; videoUrl: string }) => void
    >();
    ctx.reportProgress = reportProgress;

    await chainCompile(input, ctx);

    // reportProgress 全程多次调用(准备/各组/下载/拼接/完成);带 groupClip 的是每组完成那次。
    const clipCalls = reportProgress.mock.calls
      .map((c) => c[2])
      .filter((c): c is { shotIds: string[]; videoUrl: string } => !!c);
    expect(clipCalls).toHaveLength(2);
    expect(clipCalls[0]).toEqual({
      shotIds: ['shot-1', 'shot-2'],
      videoUrl: `sf-asset://${FIXED_JOB_ID}-group-1.mp4`,
    });
    expect(clipCalls[1]).toEqual({
      shotIds: ['shot-3'],
      videoUrl: `sf-asset://${FIXED_JOB_ID}-group-2.mp4`,
    });
    // 组片确实在 in-loop 阶段就落本地了(渐进显示的前提,不必等末相 concat)。
    await expect(fs.readFile(path.join(filmsDir, `${FIXED_JOB_ID}-group-1.mp4`))).resolves
      .toBeDefined();
  });

  it('渐进回传:历史任务无 shotIds 时不发 groupClip(只走末相整批持久化,不回归)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' } },
        { url: '', params: { prompt: 'g1' } },
      ],
    };
    mockAsyncVideoGeneration(fetchMock, ['https://ai/g0.mp4', 'https://ai/g1.mp4']);
    const { ctx } = await makeCtx();
    const reportProgress = vi.fn<
      (progress: number, stage: string, groupClip?: { shotIds: string[]; videoUrl: string }) => void
    >();
    ctx.reportProgress = reportProgress;

    await chainCompile(input, ctx);

    const clipCalls = reportProgress.mock.calls.filter((c) => c[2]);
    expect(clipCalls).toHaveLength(0);
  });

  it('resolves confirmed local voice files to Seedance referenceAudioUrls', async () => {
    const voicesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-chain-voices-'));
    const voiceFile = 'female_test.wav';
    await fs.writeFile(path.join(voicesDir, 'manifest.json'), JSON.stringify([{
      file: voiceFile,
      gender: 'female',
      dur: 1,
      desc: 'test voice',
      text: 'hello',
      lang: 'en',
    }]));
    await fs.writeFile(path.join(voicesDir, voiceFile), Buffer.from('wav-bytes'));
    mockAsyncVideoGeneration(fetchMock, ['https://ai/voice-group.mp4']);
    const input: ChainCompileInput = {
      groupResults: [{
        url: '',
        params: { prompt: 'voice group', referenceAudioFiles: [voiceFile] },
      }],
    };
    const { ctx } = await makeCtx(voicesDir);

    await chainCompile(input, ctx);

    // The dispatch POST body carries referenceAudioUrls (data URLs), not raw files.
    const dispatchCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    ) as [string, RequestInit] | undefined;
    expect(dispatchCall).toBeDefined();
    const requestBody = JSON.parse(String(dispatchCall![1].body)) as Record<string, unknown>;
    expect(requestBody.referenceAudioFiles).toBeUndefined();
    expect(requestBody.referenceAudioUrls).toEqual([
      `data:audio/wav;base64,${Buffer.from('wav-bytes').toString('base64')}`,
    ]);
    await fs.rm(voicesDir, { recursive: true, force: true });
  });

  it('sends Cookie header and referenceImageBase64 on the second group AI call', async () => {
    // g0/g1 都带「首尾衔接」行（finalize 保存的提示词，非首组时会生成该行）
    const joinLine = '首尾衔接：本组首镜紧接上一镜头组的末帧（即本组参考图的最后一张，图片2），继承其场景状态。';
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: `g0\n${joinLine}` } },
        { url: '', params: { prompt: `g1\n${joinLine}` } },
      ],
    };

    // Two groups, each resolves with the same URL via async dispatch+poll.
    mockAsyncVideoGeneration(fetchMock, ['https://ai/x.mp4', 'https://ai/x.mp4']);

    const { ctx } = await makeCtx();
    await chainCompile(input, ctx);

    const aiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    );
    expect(aiCalls).toHaveLength(2);

    // Both AI dispatches carry the auth Cookie.
    for (const call of aiCalls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({ Cookie: 'sid=abc' });
    }

    // The second call's body carries referenceImageBase64 (the grid-overlaid
    // last frame of group 0).
    const secondBody = JSON.parse(aiCalls[1][1].body as string) as Record<string, unknown>;
    expect(secondBody.referenceImageBase64).toBeTypeOf('string');
    expect(secondBody.referenceImageBase64).toBe(Buffer.from('fake-png').toString('base64'));
    // 有末帧 → 衔接行原样保留（编号引用有效）
    expect(secondBody.prompt).toContain('首尾衔接：');
    // The first call's body has NO referenceImageBase64 (no previous group),
    // and its prompt has the 首尾衔接 line REMOVED (would reference a nonexistent image).
    const firstBody = JSON.parse(aiCalls[0][1].body as string) as Record<string, unknown>;
    expect(firstBody.referenceImageBase64).toBeUndefined();
    expect(firstBody.prompt).not.toContain('首尾衔接');
    expect(firstBody.prompt).toContain('g0');
    // Async dispatch body carries chainMode + dedupeKey (replaces the legacy
    // billingTaskId/billingUnitId — billing is now per-task in ai-worker).
    expect(firstBody).toMatchObject({ chainMode: true, dedupeKey: `${FIXED_JOB_ID}:0` });
    expect(secondBody).toMatchObject({ chainMode: true, dedupeKey: `${FIXED_JOB_ID}:1` });
  });

  it('per-group retry: first group AI fails twice then passes (3 attempts, succeeds)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' } },
        { url: '', params: { prompt: 'g1' } },
      ],
    };

    // First group: first 2 dispatch attempts fail (network error), 3rd succeeds.
    // Second group: first attempt succeeds. Dispatch is wrapped in withAbortableRetry
    // (3 tries), so transient errors retry; poll is NOT retried on terminal status.
    let dispatchFails = 0;
    let dispatchCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        if (dispatchFails < 2) {
          dispatchFails++;
          throw new Error('network down');
        }
        const idx = dispatchCount++;
        return jsonResponse({ success: true, data: { taskId: `task-${idx}` } });
      }
      if (u.includes('/api/tasks/')) {
        return jsonResponse({
          success: true,
          data: { status: 'COMPLETED', output: { videoUrl: 'https://ai/g.mp4' } },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    // withRetry uses real setTimeout for backoff (1s + 2s = 3s). Bump the
    // per-test timeout so the real sleeps fit.
    const { ctx } = await makeCtx();
    const result = await chainCompile(input, ctx);

    const aiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    );
    // 3 dispatch attempts for group 0 (2 fail + 1 pass) + 1 for group 1 = 4 total.
    expect(aiCalls).toHaveLength(4);

    // The job ultimately succeeded — local film written + sf-asset:// URL.
    expect(result.outputUrl).toMatch(/^sf-asset:\/\//);
  }, 15_000);

  it('per-group retry: group failing 3x throws (job fails)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' } },
        { url: '', params: { prompt: 'g1' } },
      ],
    };

    // Dispatch always throws a transient error → withAbortableRetry exhausts
    // 3 attempts per group → both groups skipped → R3 guard throws (its
    // message embeds the original cause, so toThrow substring still matches).
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        throw new Error('AI permanently down');
      }
      return jsonResponse({ success: true, data: {} });
    });

    // withRetry backoff: 1s + 2s = 3s of real sleeps before the 3rd attempt
    // throws. Bump the per-test timeout.
    const { ctx } = await makeCtx();
    await expect(chainCompile(input, ctx)).rejects.toThrow('AI permanently down');

    // B 止血后：单组失败跳过继续，两组各重试 3 次 = 6 次派发；全跳过 → R3 guard throw（job fails）。
    const aiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    );
    expect(aiCalls).toHaveLength(6);

    // No concat on failure.
    expect(ffmpeg.execFfmpegConcat).not.toHaveBeenCalled();
  }, 15_000);

  it('pass-through: entry with no params skips AI and uses entry.url directly', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: 'https://existing/g0.mp4' }, // no params → pass-through
        { url: '', params: { prompt: 'g1' } }, // AI call
      ],
    };

    mockAsyncVideoGeneration(fetchMock, ['https://ai/g1.mp4']);

    const { ctx } = await makeCtx();
    await chainCompile(input, ctx);

    // Only ONE dispatch (group 1) — group 0 was pass-through.
    const aiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    );
    expect(aiCalls).toHaveLength(1);

    // downloadClips called with [existing g0 URL, AI-returned g1 URL].
    expect(ffmpeg.downloadClips).toHaveBeenCalledWith(
      ['https://existing/g0.mp4', 'https://ai/g1.mp4'],
      expect.any(String),
    );
  });

  it('resolves a reused sf-asset group to its local file for chaining and concat', async () => {
    const { ctx, filmsDir } = await makeCtx();
    const existingPath = path.join(filmsDir, 'existing-group.mp4');
    await fs.writeFile(existingPath, Buffer.from('existing-group'));
    const input: ChainCompileInput = {
      groupResults: [
        { url: 'sf-asset://existing-group.mp4', shotIds: ['shot-1'] },
        { url: '', shotIds: ['shot-2'], params: { prompt: 'new-group' } },
      ],
    };
    mockAsyncVideoGeneration(fetchMock, ['https://ai/new-group.mp4']);

    await chainCompile(input, ctx);

    // Electron 私有协议只供渲染器播放；本地 ffmpeg 必须收到真实绝对路径。
    expect(ffmpeg.extractLastFrame).toHaveBeenCalledWith(
      existingPath,
      expect.any(String),
    );
    expect(ffmpeg.downloadClips).toHaveBeenCalledWith(
      [existingPath, 'https://ai/new-group.mp4'],
      expect.any(String),
    );
  });

  it('throws when groupResults is empty', async () => {
    const input: ChainCompileInput = {
      groupResults: [],
    };
    const { ctx } = await makeCtx();
    await expect(chainCompile(input, ctx)).rejects.toThrow(
      'groupResults is empty',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when filmsDir/toAssetUrl/jobId missing on ctx (batch 7 OP1 guard)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' } },
        { url: '', params: { prompt: 'g1' } },
      ],
    };
    const ctx: OrchestratorContext = {
      ffmpeg,
      logger: noopLogger,
      apiBase: 'https://api.example.com',
      authCookie: 'sid=abc',
      machineId: 'm1',
      // filmsDir / toAssetUrl / jobId intentionally absent
    };
    mockAsyncVideoGeneration(fetchMock, ['https://ai/g.mp4', 'https://ai/g.mp4']);
    await expect(chainCompile(input, ctx)).rejects.toThrow(
      /filmsDir\/toAssetUrl\/jobId required/,
    );
  }, 15_000);

  it('P7.6 grid overlay: overlays sparse grid on characterReferenceImageUrls when gridEnabled !== false', async () => {
    // Single group with characterReferenceImageUrls + gridEnabled:true.
    // The orchestrator should fetch each URL, grid-overlay it, and replace
    // the entry with a data:image/png;base64,... URL before POSTing.
    const charRef = 'https://chars.example.com/char1.png';
    const input: ChainCompileInput = {
      groupResults: [
        {
          url: '',
          params: {
            prompt: 'g0',
            model: 'seedance',
            characterReferenceImageUrls: [charRef],
            gridEnabled: true,
            gridCells: 200,
            gridOpacity: 0.5,
            gridStrokeWidth: 2,
          },
        },
      ],
    };

    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      // Async dispatch + poll for the single group.
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        return jsonResponse({ success: true, data: { taskId: 'task-0' } });
      }
      if (u.includes('/api/tasks/')) {
        return jsonResponse({
          success: true,
          data: { status: 'COMPLETED', output: { videoUrl: 'https://ai/g0.mp4' } },
        });
      }
      // Character ref fetch — return fake image bytes.
      if (u === charRef) {
        return new Response(Buffer.from('fake-png-bytes'), { status: 200 });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { ctx } = await makeCtx();
    await chainCompile(input, ctx);

    // 人物参考图走 applyCharacterReferenceGrid 缓冲管线（resize+网格+JPEG）；
    // gridOverlay 只用于串联末帧，本例单组无串联 → 不应被调。
    expect(ffmpeg.applyCharacterReferenceGrid).toHaveBeenCalledTimes(1);
    expect(ffmpeg.gridOverlay).not.toHaveBeenCalled();
    const [bufArg, optsArg] = ffmpeg.applyCharacterReferenceGrid.mock.calls[0] as [
      Buffer,
      { cells?: number; opacity?: number; strokeWidth?: number },
    ];
    // 入参是 fetch 回来的原始字节。
    expect(bufArg).toEqual(Buffer.from('fake-png-bytes'));
    // params.gridCells/gridOpacity/gridStrokeWidth 透传进 opts（对齐 app1）。
    expect(optsArg.cells).toBe(200);
    expect(optsArg.opacity).toBe(0.5);
    expect(optsArg.strokeWidth).toBe(2);

    // Body POSTed to /api/generate/video-async carries the char ref as a
    // data:image/jpeg URL（管线输出 JPEG，fake-jpeg 的 base64）。
    const aiCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    ) as [string, RequestInit] | undefined;
    expect(aiCall).toBeDefined();
    const body = JSON.parse(aiCall![1].body as string) as Record<string, unknown>;
    expect(Array.isArray(body.characterReferenceImageUrls)).toBe(true);
    const refs = body.characterReferenceImageUrls as string[];
    expect(refs).toHaveLength(1);
    const expectedB64 = Buffer.from('fake-jpeg').toString('base64');
    expect(refs[0]).toBe(`data:image/jpeg;base64,${expectedB64}`);
  });

  it('P7.6 grid overlay: rejects character generation when gridEnabled === false', async () => {
    const charRef = 'https://chars.example.com/char1.png';
    const input: ChainCompileInput = {
      groupResults: [
        {
          url: '',
          params: {
            prompt: 'g0',
            model: 'seedance',
            characterReferenceImageUrls: [charRef],
            gridEnabled: false,
          },
        },
      ],
    };

    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        return jsonResponse({ success: true, data: { taskId: 'task-0' } });
      }
      if (u.includes('/api/tasks/')) {
        return jsonResponse({
          success: true,
          data: { status: 'COMPLETED', output: { videoUrl: 'https://ai/g0.mp4' } },
        });
      }
      // If the orchestrator incorrectly fetches the char ref, the test will
      // see fetchMock called with charRef — assert below it was NOT.
      return jsonResponse({});
    });

    const { ctx } = await makeCtx();
    await expect(chainCompile(input, ctx)).rejects.toThrow('人物镜头必须启用稀疏网格');

    // gridOverlay NOT called (single group, no chaining; gridEnabled=false
    // skips the char ref overlay path).
    expect(ffmpeg.gridOverlay).not.toHaveBeenCalled();

    // The char ref URL was NOT fetched (no client-side overlay work).
    const charRefFetch = fetchMock.mock.calls.find(
      (c) => String(c[0]) === charRef,
    );
    expect(charRefFetch).toBeUndefined();

    const aiCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    );
    expect(aiCall).toBeUndefined();
  });

  it('P7.6 grid overlay: skips when no characterReferenceImageUrls (default path)', async () => {
    // Group params without characterReferenceImageUrls — most common case
    // today (chain-generate dispatcher route doesn't populate char refs yet).
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0', model: 'seedance' } },
      ],
    };

    mockAsyncVideoGeneration(fetchMock, ['https://ai/g0.mp4']);

    const { ctx } = await makeCtx();
    await chainCompile(input, ctx);

    // gridOverlay NOT called at all (single group, no chaining, no char refs).
    expect(ffmpeg.gridOverlay).not.toHaveBeenCalled();

    // Body has no characterReferenceImageUrls field.
    const aiCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    ) as [string, RequestInit] | undefined;
    expect(aiCall).toBeDefined();
    const body = JSON.parse(aiCall![1].body as string) as Record<string, unknown>;
    expect(body.characterReferenceImageUrls).toBeUndefined();
  });

  it('P7.6 grid overlay: sf-asset:// URL resolved against filmsDir (client-local)', async () => {
    // sf-asset:// URLs MUST be resolved locally — the cloud server can't
    // fetch this scheme. The orchestrator reads bytes from filmsDir and
    // submits them inline as data: URL.
    const { ctx, filmsDir } = await makeCtx();
    // Drop a fake asset file at filmsDir/abc123.png (matches CLIP_KEY_RE).
    const clipId = '11111111-2222-3333-4444-555555555555';
    const assetKey = `${clipId}.png`;
    const assetPath = path.join(filmsDir, assetKey);
    await fs.writeFile(assetPath, Buffer.from('local-asset-bytes'));

    const charRefUrl = `sf-asset://${assetKey}`;
    const input: ChainCompileInput = {
      groupResults: [
        {
          url: '',
          params: {
            prompt: 'g0',
            model: 'seedance',
            characterReferenceImageUrls: [charRefUrl],
            // gridEnabled omitted → defaults to apply (only explicit false skips)
          },
        },
      ],
    };

    mockAsyncVideoGeneration(fetchMock, ['https://ai/g0.mp4']);

    await chainCompile(input, ctx);

    // 人物参考图走 applyCharacterReferenceGrid 缓冲管线；gridOverlay 不用于人物图。
    expect(ffmpeg.applyCharacterReferenceGrid).toHaveBeenCalledTimes(1);
    expect(ffmpeg.gridOverlay).not.toHaveBeenCalled();
    const [bufArg] = ffmpeg.applyCharacterReferenceGrid.mock.calls[0] as [Buffer];
    // 入参是 sf-asset:// 本地落地的字节（不走 fetch）。
    expect(bufArg).toEqual(Buffer.from('local-asset-bytes'));

    // sf-asset:// was NOT passed to globalThis.fetch.
    const sfFetch = fetchMock.mock.calls.find((c) =>
      String(c[0]).startsWith('sf-asset://'),
    );
    expect(sfFetch).toBeUndefined();

    // Body carries the overlaid data:image/jpeg URL.
    const aiCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    ) as [string, RequestInit] | undefined;
    expect(aiCall).toBeDefined();
    const body = JSON.parse(aiCall![1].body as string) as Record<string, unknown>;
    const refs = body.characterReferenceImageUrls as string[];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(`data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`);
  });

  it('P7.6 grid overlay: malformed sf-asset:// character ref fails closed', async () => {
    const badUrl = 'sf-asset://../escape.png';
    const input: ChainCompileInput = {
      groupResults: [
        {
          url: '',
          params: {
            prompt: 'g0',
            model: 'seedance',
            characterReferenceImageUrls: [badUrl],
          },
        },
      ],
    };

    mockAsyncVideoGeneration(fetchMock, ['https://ai/g0.mp4']);

    const { ctx } = await makeCtx();
    let caught: unknown;
    try {
      await chainCompile(input, ctx);
    } catch (e) {
      caught = e;
    }
    const errMsg = caught instanceof Error ? caught.message : String(caught);
    // R1：malformed sf-asset:// 网格失败且回退原图也失败 → fatal（该位置无法填充，防图片N错位）。
    // 报错必须带「防图片N错位」语义 + 组号 + 字段索引 + 出问题的 url，否则服务端 render_jobs.error
    // 仍只是干巴巴一句，无法定位是哪条镜头的哪张图。
    expect(errMsg).toContain('防图片N错位');
    expect(errMsg).toContain('组#1');
    expect(errMsg).toContain('characterReferenceImageUrls[0/1]');
    expect(errMsg).toContain(badUrl);

    // gridOverlay NOT called (the bad URL couldn't be resolved to a local file).
    expect(ffmpeg.gridOverlay).not.toHaveBeenCalled();

    const aiCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    );
    expect(aiCall).toBeUndefined();
  });

  it('P7.6 grid overlay: a missing character ref fails closed (防图片N错位, R1)', async () => {
    // R1：一张人物图有效（落地）、一张缺失（ENOENT）。旧 drop 行为会让 characterReferenceImageUrls
    // 比原数组短 → 服务端 prompt 图片N 与 Seedance 实收错位 → 整条视频角色错位。新行为：原图也
    // 读不出 = 该位置无法填充 → 整任务失败（逼用户修缺图），绝不产出错位视频。
    const { ctx, filmsDir } = await makeCtx();
    const validKey = '11111111-2222-3333-4444-555555555555.png';
    const missingKey = '99999999-9999-4999-9999-999999999999.png'; // 故意不落地到 filmsDir
    await fs.writeFile(path.join(filmsDir, validKey), Buffer.from('local-asset-bytes'));

    const input: ChainCompileInput = {
      groupResults: [
        {
          url: '',
          params: {
            prompt: 'g0',
            model: 'seedance',
            characterReferenceImageUrls: [`sf-asset://${validKey}`, `sf-asset://${missingKey}`],
          },
        },
      ],
    };

    mockAsyncVideoGeneration(fetchMock, ['https://ai/g0.mp4']);

    let caught: unknown;
    try {
      await chainCompile(input, ctx);
    } catch (e) {
      caught = e;
    }
    const errMsg = caught instanceof Error ? caught.message : String(caught);
    expect(errMsg).toContain('防图片N错位');
    expect(errMsg).toContain('组#1');
    expect(errMsg).toContain('characterReferenceImageUrls[1/2]'); // 第 2 张(missing)触发
    expect(errMsg).toContain(`sf-asset://${missingKey}`);
  });

  it('P7.6 grid overlay: transient overlay failure falls back to raw base64 (保图片N对齐, R1)', async () => {
    // R1 happy path：fetch 成功但 applyCharacterReferenceGrid 抛错（sharp/resize 瞬态挂）。
    // 旧 drop 行为会让数组比原短 → 图片N错位。新行为：回退"原图 base64（去网格）"，保数组长度
    // =图片N，任务继续；该张失去网格保护（接受被真人检测拦的代价，远好于静默错位）。
    const { ctx, filmsDir } = await makeCtx();
    const validKey = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
    await fs.writeFile(path.join(filmsDir, validKey), Buffer.from('local-asset-bytes'));
    // 让 applyCharacterReferenceGrid 抛一次（模拟 sharp 瞬态失败）；fetchImageBytes 仍成功 → 回退原图 base64。
    vi.mocked(ffmpeg.applyCharacterReferenceGrid).mockRejectedValueOnce(new Error('sharp transient crash'));

    const input: ChainCompileInput = {
      groupResults: [
        {
          url: '',
          params: {
            prompt: 'g0',
            model: 'seedance',
            characterReferenceImageUrls: [`sf-asset://${validKey}`],
          },
        },
      ],
    };

    mockAsyncVideoGeneration(fetchMock, ['https://ai/g0.mp4']);

    await expect(chainCompile(input, ctx)).resolves.toMatchObject({
      outputUrl: expect.any(String),
    });

    // 关键：任务继续，且数组长度保持 1（回退原图 base64，不是 drop 成 0）。回退的是"原图（去网格）"
    // ——不是网格版 fake-jpeg，而是原文件字节经 mime 判定的 base64（local-asset-bytes 非 PNG/JPEG → webp）。
    const aiCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    ) as [string, RequestInit] | undefined;
    expect(aiCall).toBeDefined();
    const body = JSON.parse(aiCall![1].body as string) as Record<string, unknown>;
    const refs = body.characterReferenceImageUrls as string[];
    expect(refs).toHaveLength(1);
    const expectedB64 = Buffer.from('local-asset-bytes').toString('base64');
    expect(refs[0]).toBe(`data:image/webp;base64,${expectedB64}`);
  });

  it('parallel mode caps concurrency and preserves input order after out-of-order completion', async () => {
    const input: ChainCompileInput = {
      groupResults: [0, 1, 2, 3].map((index) => ({
        url: '',
        params: { prompt: `group-${index}`, model: 'seedance' },
      })),
      execution: { mode: 'parallel', concurrency: 2 },
    };
    let active = 0;
    let maxActive = 0;
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(_url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        const index = Number(body.prompt.split('-').pop());
        active++;
        maxActive = Math.max(maxActive, active);
        // Stagger completion: group 3 finishes first (5ms), group 0 last (20ms).
        // Concurrency cap (=2) is enforced despite out-of-order completion.
        await new Promise((resolve) => setTimeout(resolve, (4 - index) * 5));
        active--;
        return jsonResponse({ success: true, data: { taskId: `task-${index}` } });
      }
      if (u.includes('/api/tasks/')) {
        const m = u.match(/\/api\/tasks\/([^/?]+)/);
        const idx = Number((m?.[1] ?? '').replace(/^task-/, ''));
        return jsonResponse({
          success: true,
          data: { status: 'COMPLETED', output: { videoUrl: `https://ai/group-${idx}.mp4` } },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { ctx } = await makeCtx();
    await chainCompile(input, ctx);

    expect(maxActive).toBe(2);
    // fast 模式 extractTailFrame 对非最后组抽末帧(尽力衔接, A1)：4 组 → 组 0/1/2 共 3 次
    expect(ffmpeg.extractLastFrame).toHaveBeenCalledTimes(3);
    expect(ffmpeg.downloadClips).toHaveBeenCalledWith([
      'https://ai/group-0.mp4',
      'https://ai/group-1.mp4',
      'https://ai/group-2.mp4',
      'https://ai/group-3.mp4',
    ], expect.any(String));
  });

  it('non-2xx HTTP response preserves the provider error envelope for client logs', async () => {
    // After Task 1 the route returns the GC-4 envelope on failure too:
    //   { success:false, error, code, ... }  with HTTP status 4xx/5xx
    // (e.g. apiFail for AI_GATEWAY_ERROR → HTTP 502). The orchestrator's
    // Mock mirrors a real provider 502. The client must parse this body before
    // throwing; otherwise render_jobs.error only contains "502 Bad Gateway".
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' } },
        { url: '', params: { prompt: 'g1' } },
      ],
    };

    // Dispatch returns 502 with retryable=true → retried 3 times per group →
    // both groups skipped (strict) → R3 guard throws; its message embeds the
    // provider error text from the CloudVideoRequestError cause.
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        return jsonResponse(
          {
            success: false,
            error: 'AI 生成失败 [provider=ark]: rate limited',
            code: 'AI_GATEWAY_ERROR',
            category: 'provider',
            retryable: true,
          },
          502,
        );
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { ctx } = await makeCtx();
    let caught: unknown;
    try {
      await chainCompile(input, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /AI 生成失败 \[provider=ark\]: rate limited \[AI_GATEWAY_ERROR\] \(HTTP 502\)/,
    );
  }, 15_000);

  it('strict: 内容审核失败(retryable:false)不重试；单组拒→跳过→无成功组→R3 guard throw', async () => {
    const input: ChainCompileInput = {
      groupResults: [{ url: '', params: { prompt: 'g0' } }],
    };
    // Poll returns FAILED with the content-rejection error → CloudVideoRequest-
    // Error(retryable=false) → NOT retried → single dispatch per group.
    mockAsyncVideoGeneration(fetchMock, [
      new Error('参考图疑似包含真人或隐私信息 [PROVIDER_CONTENT_REJECTED]'),
    ]);

    const { ctx } = await makeCtx();
    // 单组审核拒 → ChainGroupSkippedError → 跳过 → groupResults 空 → R3 全跳过 guard
    await expect(chainCompile(input, ctx)).rejects.toThrow(/均失败|被跳过/);

    // 同一内容安全请求重复提交只会制造重复任务，不可能通过重试自愈。
    const aiCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/generate/video-async'));
    expect(aiCalls).toHaveLength(1);
  });

  it('strict: 第1组内容审核失败 → 跳过该组，第2组继续，出部分成片 (failedGroups=1)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' }, shotIds: ['s0'] },
        { url: '', params: { prompt: 'g1' }, shotIds: ['s1'] },
      ],
    };
    // Group 0 poll → FAILED (content rejection, retryable=false); group 1 → COMPLETED.
    mockAsyncVideoGeneration(fetchMock, [
      new Error('参考图疑似包含真人或隐私信息'),
      'https://ai/group-2.mp4',
    ]);

    const { ctx } = await makeCtx();
    const result = await chainCompile(input, ctx);
    expect(result.outputUrl).toMatch(/^sf-asset:\/\//);
    const meta = result.meta as { failedGroups?: number; groupClips?: Array<{ localKey: string; shotIds: string[] }> };
    expect(meta.failedGroups).toBe(1);
    // concat 只拼成功的第2组
    expect(ffmpeg.execFfmpegConcat).toHaveBeenCalledTimes(1);
    // groupClips 只含 group-2(原始 index 1 → group-2.mp4),shotIds 对齐
    expect(meta.groupClips).toHaveLength(1);
    expect(meta.groupClips![0].localKey).toBe(`${FIXED_JOB_ID}-group-2.mp4`);
    expect(meta.groupClips![0].shotIds).toEqual(['s1']);
  });

  it('strict: 末帧提取失败 → 不杀链，第2组无 referenceImageBase64 独立生成 (P0)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' } },
        { url: '', params: { prompt: 'g1' } },
      ],
    };
    let dispatchCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        const n = ++dispatchCount;
        if (n === 2) {
          // 第2组的 body 不应含 referenceImageBase64(末帧降级)
          const body = JSON.parse(String(init?.body)) as { referenceImageBase64?: string };
          expect(body.referenceImageBase64).toBeUndefined();
        }
        return jsonResponse({ success: true, data: { taskId: `task-${n - 1}` } });
      }
      if (u.includes('/api/tasks/')) {
        const m = u.match(/\/api\/tasks\/([^/?]+)/);
        const idx = Number((m?.[1] ?? '').replace(/^task-/, ''));
        return jsonResponse({
          success: true,
          data: { status: 'COMPLETED', output: { videoUrl: `https://ai/g${idx + 1}.mp4` } },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });
    // 第1组末帧提取抛错(P0 应吞掉,不杀链)
    vi.mocked(ffmpeg.extractLastFrame).mockRejectedValueOnce(new Error('ffmpeg extract boom'));

    const { ctx } = await makeCtx();
    const result = await chainCompile(input, ctx);
    expect(result.outputUrl).toMatch(/^sf-asset:\/\//);
    const meta = result.meta as { failedGroups?: number };
    expect(meta.failedGroups).toBe(0);
  });

  it('strict: [ok, skip, ok] 保序 → concat 2 段，localKey group-1/group-3', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' }, shotIds: ['s0'] },
        { url: '', params: { prompt: 'g1' }, shotIds: ['s1'] },
        { url: '', params: { prompt: 'g2' }, shotIds: ['s2'] },
      ],
    };
    // Group 0 → group-1.mp4; group 1 → FAILED (skip); group 2 → group-3.mp4.
    // URL strings only need to be distinct per group for downloadClips ordering.
    mockAsyncVideoGeneration(fetchMock, [
      'https://ai/g1.mp4',
      new Error('参考图疑似包含真人'),
      'https://ai/g3.mp4',
    ]);

    const { ctx } = await makeCtx();
    const result = await chainCompile(input, ctx);
    const meta = result.meta as { failedGroups?: number; groupClips?: Array<{ localKey: string }> };
    expect(meta.failedGroups).toBe(1);
    expect(meta.groupClips!.map((g) => g.localKey)).toEqual([
      `${FIXED_JOB_ID}-group-1.mp4`,
      `${FIXED_JOB_ID}-group-3.mp4`,
    ]);
  });

  it('fast: 单组失败 → allSettled 收敛 + 完整性门禁 throw (all-or-nothing,对齐 app1)', async () => {
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' } },
        { url: '', params: { prompt: 'g1' } },
      ],
      execution: { mode: 'parallel', concurrency: 2 },
    };
    // Both groups → poll FAILED → ChainGroupSkippedError; fast mode aggregates
    // via allSettled then 完整性门禁 throws (no partial film).
    mockAsyncVideoGeneration(fetchMock, [
      new Error('参考图疑似包含真人'),
      new Error('参考图疑似包含真人'),
    ]);

    const { ctx } = await makeCtx();
    // D fast = all-or-nothing：allSettled 等在飞组收敛 → 完整性门禁 throw，不出残缺片。
    await expect(chainCompile(input, ctx)).rejects.toThrow(/完整性校验失败/);
    expect(ffmpeg.execFfmpegConcat).not.toHaveBeenCalled();
  });

  it('summarizes an nginx HTML 502 response instead of persisting the page markup', async () => {
    const input: ChainCompileInput = {
      groupResults: [{ url: '', params: { prompt: 'g0' } }],
    };
    const html = '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><center>nginx/1.20.1</center><!-- a padding to disable MSIE and Chrome friendly error page --></body></html>';
    // Dispatch returns nginx HTML 502; withAbortableRetry retries 3 times (the
    // gateway HTML branch produces a generic retryable error), then skips →
    // R3 guard throws with the summarized message.
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        return new Response(html, {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { ctx } = await makeCtx();
    let caught: unknown;
    try {
      await chainCompile(input, ctx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('云端服务暂时不可用');
    expect((caught as Error).message).not.toContain('<html>');
    expect((caught as Error).message).not.toContain('padding');
  }, 15_000);

  it('surfaces the failure envelope error/code when route returns 2xx + success:false', async () => {
    // Belt-and-suspenders: if the route ever returns HTTP 200 with a failure
    // envelope (e.g. a misconfigured proxy flattens status codes), the
    // orchestrator must still surface `error`/`code` rather than 'missing url'.
    const input: ChainCompileInput = {
      groupResults: [
        { url: '', params: { prompt: 'g0' } },
        { url: '', params: { prompt: 'g1' } },
      ],
    };

    // Dispatch returns 2xx with success:false → CloudVideoRequestError(
    // retryable=true by default) → retried 3 times per group → both groups
    // skipped → R3 guard throws, embedding the dispatch error message.
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/generate/video-async') && method === 'POST') {
        return jsonResponse({
          success: false,
          error: 'rate limited',
          code: 'PROVIDER_RATE_LIMIT',
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { ctx } = await makeCtx();
    let caught: unknown;
    try {
      await chainCompile(input, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /chainCompile: 派发返回失败: rate limited \[PROVIDER_RATE_LIMIT\]/,
    );
    // Must NOT be swallowed as the generic 'missing url'.
    expect((caught as Error).message).not.toMatch(/missing url/);

    // B 止血后：两组 rate limited 各重试 3 次 = 6 次派发（跳过继续），全跳过 → R3 guard throw。
    const aiCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/generate/video-async'),
    );
    expect(aiCalls).toHaveLength(6);
    // No concat on failure.
    expect(ffmpeg.execFfmpegConcat).not.toHaveBeenCalled();
  }, 15_000);
});
