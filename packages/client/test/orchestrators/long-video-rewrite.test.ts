// Unit tests for ⑩ orchestrators/long-video-rewrite (转绘 X3.4 整剧重写主链).
//
// Mocks:
//   - global `fetch` (4 routes: /api/generate/text multipart, /api/generate/
//     long-video-text JSON, /progress PUT, /result POST)
//   - @client/ffmpeg (vi.mock; splitVideoForKimi writes real fake-bytes files
//     at returned VideoSegment.path so callKimiSegment can fs.readFile them
//     back into the multipart/form-data body)
//   - @client/render-worker/uploader (uploadArtifact spy, legacy path only)
//
// Covers (X3.4 contract):
//   - Happy path: 2 segments → split → Kimi x2 → duration-derived outline →
//     3 sequential range rewrites → 2 段间导演板 → result POST.
//   - sourceScriptOverride reuse: skip split + Kimi, go straight to outline.
//   - Progress PUT calls cover all 5 stages (splitting/transcribing/outlining/
//     scripting/completed).
//   - Failure case: Kimi segment 0 fails 3x → throws; no result POST.
//   - Invalid input throws before any HTTP/ffmpeg call.
//   - Legacy outputUploadUrl: rewrite text is uploadArtifact-ed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

// Mock @client/ffmpeg. splitVideoForKimi writes real fake-bytes files at the
// returned VideoSegment.path so callKimiSegment can fs.readFile them for the
// multipart body. Other ffmpeg fns are unused stubs.
vi.mock('../../src/ffmpeg', () => ({
  execFfmpegConcat: vi.fn().mockResolvedValue(undefined),
  extractLastFrame: vi.fn().mockResolvedValue(undefined),
  splitVideoByDuration: vi.fn().mockResolvedValue(['/tmp/seg-000.mp4']),
  splitVideoEvenly: vi.fn().mockResolvedValue(['/tmp/seg-000.mp4']),
  splitVideoForKimi: vi.fn(
    async (_url: string, n: number, dur: number, outDir: string) => {
      await fs.mkdir(outDir, { recursive: true });
      const segs: Array<{
        path: string;
        startSec: number;
        endSec: number;
        index: number;
      }> = [];
      for (let i = 0; i < n; i++) {
        const p = path.join(outDir, `segment-${String(i).padStart(3, '0')}.mp4`);
        await fs.writeFile(p, Buffer.from(`fake-segment-${i}-bytes`));
        segs.push({ path: p, startSec: i * dur, endSec: (i + 1) * dur, index: i });
      }
      return segs;
    },
  ),
  getVideoDuration: vi.fn().mockResolvedValue(10),
  downloadClips: vi.fn().mockResolvedValue([]),
  gridOverlay: vi.fn().mockResolvedValue(undefined),
  getFfmpegPath: vi.fn().mockReturnValue('/usr/bin/ffmpeg'),
  resolveStorageUrl: vi.fn((s: string) => s),
}));

vi.mock('../../src/render-worker/uploader', () => ({
  uploadArtifact: vi.fn().mockResolvedValue(undefined),
}));

import {
  buildRegenerationCheckpoint,
  longVideoRewrite,
} from '../../src/orchestrators/long-video-rewrite';
import type { OrchestratorContext } from '../../src/render-worker';
import type { LongVideoRewriteInput } from '@dramaforge/shared';
import { uploadArtifact } from '../../src/render-worker/uploader';
import * as ffmpeg from '../../src/ffmpeg';

const originalFetch = globalThis.fetch;

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeCtx(): OrchestratorContext {
  return {
    ffmpeg,
    logger: noopLogger,
    apiBase: 'https://api.example.com',
    authCookie: 'sid=abc',
    machineId: 'm1',
    // render-worker executor 透传 job.id（=== dispatch 的 taskId）。设上以验证
    // progress PUT 每次 body.taskId 粘住它（UI 刷新后靠 progress.taskId 还原轮询）。
    jobId: 'job-123',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---- Mock content builders (structure-gate-safe) ----

/**
 * Build a single episode block that passes inspectScriptRangeStructure AND
 * inspectScriptSemanticDuplicates (each line includes `ep` so episodes differ):
 *   - exactly 1 `第NNN集` heading
 *   - block length > 500 chars
 *   - 1+ scene marker `[ep-N scene ...]`
 *   - no `人物：同上`, no `内/外` mixed, no `第X集` in body
 *   - every dialogue/action line is unique per (ep, j) → no cross-episode dupes
 */
function buildEpisodeBlock(ep: number): string {
  const lines = [
    `第${String(ep).padStart(3, '0')}集：第${ep}集测试标题`,
    '',
    `本集钩子：线索${ep}测试钩子。`,
    `本集爽点：线索${ep}测试爽点。`,
    `本集结尾：线索${ep}测试结尾。`,
    '',
    `[${ep}-1 线索${ep}场景 日 外 人物：甲、乙]`,
    '',
  ];
  for (let j = 0; j < 25; j++) {
    lines.push(`▲ 线索${ep}动作${j}：甲走向乙，停下并检查${ep}-${j}号证物。`);
  }
  for (let j = 0; j < 25; j++) {
    lines.push(`甲：线索${ep}对白${j}，${ep}-${j}号证物改变了我们的下一步。`);
  }
  for (let j = 0; j < 25; j++) {
    lines.push(`乙：线索${ep}回应${j}，我会按${ep}-${j}号新计划继续行动。`);
  }
  return lines.join('\n');
}

/** Build a rewrite response for an episode range with the completion marker. */
function buildRewriteResponse(start: number, end: number): string {
  const blocks: string[] = [];
  for (let ep = start; ep <= end; ep++) {
    blocks.push(buildEpisodeBlock(ep));
  }
  return `《测试剧》第${start}-${end}集正式剧本\n\n${blocks.join('\n\n')}\n\n[[RANGE_COMPLETE:${start}-${end}]]`;
}

/** Build an outline response with N episode headings + completion marker. */
function buildOutlineResponse(episodeCount = 50): string {
  const headings: string[] = [];
  for (let i = 1; i <= episodeCount; i++) {
    headings.push(`第${String(i).padStart(3, '0')}集：第${i}集大纲标题`);
  }
  return `### 1. 故事概要\n概要内容\n\n### 5. 剧情结构（按集拆分）\n${headings.join('\n')}\n\n[[GLOBAL_OUTLINE_COMPLETE]]`;
}

/** Default /api/generate/long-video-text dispatcher (by prompt content). */
function longVideoTextDispatch(body: unknown, options: {
  outlineEpisodeCount?: number;
  outlineMetaLine?: string;
  rewriteMetaLine?: string;
} = {}): Response {
  const b = body as { messages: Array<{ role: string; content: string }> };
  const userMsg = b.messages.find((m) => m.role === 'user')?.content ?? '';
  const systemMsg = b.messages.find((m) => m.role === 'system')?.content ?? '';

  // 1) Outline (initial): user has GLOBAL_OUTLINE_COMPLETE marker requirement
  if (
    userMsg.includes('[[GLOBAL_OUTLINE_COMPLETE]]')
    && !userMsg.includes('RANGE_COMPLETE')
  ) {
    const requestedTarget = Number(userMsg.match(/全剧目标为\s*(\d+)\s*集/)?.[1]);
    const count = options.outlineEpisodeCount
      ?? (Number.isInteger(requestedTarget) ? requestedTarget : 50);
    const content = [options.outlineMetaLine, buildOutlineResponse(count)]
      .filter(Boolean)
      .join('\n');
    return jsonResponse({ success: true, data: { content, finishReason: 'stop' } });
  }
  // 2) Range rewrite: user has RANGE_COMPLETE marker requirement
  const rangeMatch = userMsg.match(/\[\[RANGE_COMPLETE:(\d+)-(\d+)\]\]/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    return jsonResponse({
      success: true,
      data: {
        content: [options.rewriteMetaLine, buildRewriteResponse(start, end)]
          .filter(Boolean)
          .join('\n'),
        finishReason: 'stop',
      },
    });
  }
  // 3) Director board / stage director board (no markers; system has 场记总监)
  if (systemMsg.includes('场记总监')) {
    return jsonResponse({
      success: true,
      data: {
        content:
          '## 导演连续性板\n| 角色 | 别名 | 关系 |\n| --- | --- | --- |\n| **甲** | 甲哥 | 主角 |\n| **乙** | 乙妹 | 配角 |',
        finishReason: 'stop',
      },
    });
  }
  // 4) Default fallback (unrecognized call) — surface in test failures
  return jsonResponse({
    success: false,
    error: 'long-video-text mock: unrecognized prompt shape',
  }, 500);
}

/**
 * Build a fetch dispatcher covering all 4 routes. Tracks all calls per-route
 * so tests can assert stage transitions + HTTP contract.
 */
function makeFetchDispatcher(options: {
  outlineEpisodeCount?: number;
  outlineMetaLine?: string;
  rewriteMetaLine?: string;
} = {}) {
  const calls = {
    kimi: [] as Array<{ url: string; init: RequestInit }>,
    deepseek: [] as Array<{ url: string; init: RequestInit }>,
    progress: [] as Array<{ url: string; init: RequestInit }>,
    result: [] as Array<{ url: string; init: RequestInit }>,
  };
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.includes('/api/generate/text') && method === 'POST') {
      calls.kimi.push({ url: u, init: init! });
      return jsonResponse({ success: true, data: { content: 'KIMI_SEGMENT_TEXT' } });
    }
    if (u.includes('/api/generate/long-video-text') && method === 'POST') {
      calls.deepseek.push({ url: u, init: init! });
      const body = JSON.parse(String(init?.body));
      return longVideoTextDispatch(body, options);
    }
    if (u.includes('/long-video-rewrite/progress') && method === 'PUT') {
      calls.progress.push({ url: u, init: init! });
      return jsonResponse({ success: true });
    }
    if (u.includes('/long-video-rewrite/result') && method === 'POST') {
      calls.result.push({ url: u, init: init! });
      return jsonResponse({ success: true, data: { projectId: 'p1' } });
    }
    return jsonResponse({ success: false, error: `unmocked ${method} ${u}` }, 500);
  });
  return { fn, calls };
}

function readJsonBody(init: RequestInit): unknown {
  return JSON.parse(String(init.body));
}

describe('buildRegenerationCheckpoint', () => {
  const previousScript = Array.from(
    { length: 60 },
    (_, index) => `第${index + 1}集\n场景：第${index + 1}集正文`,
  ).join('\n\n');
  const saved = {
    analysisFingerprint: 'same-fingerprint',
    initialOutline: '第1集 大纲\n第60集 终局',
    outline: '完整大纲',
    directorBoard: '角色与事件连续性板',
    targetEpisodeCount: 60,
    stageDirectorBoards: ['阶段一板', '阶段二板'],
  };

  it('preserves only complete ranges before the requested episode', () => {
    const checkpoint = buildRegenerationCheckpoint({
      fingerprint: 'same-fingerprint',
      regenerateFromEpisode: 41,
      previousScript,
      saved,
      reuseTargetStageDraft: true,
      now: '2026-07-21T00:00:00.000Z',
    });

    expect(checkpoint.rewriteStageContents).toHaveLength(2);
    expect(checkpoint.rewriteStageContents?.[0]).toContain('第1集');
    expect(checkpoint.rewriteStageContents?.[1]).toContain('第40集');
    expect(checkpoint.rewriteRepairDrafts?.[2]).toContain('第41集');
    expect(checkpoint.stageDirectorBoards).toEqual(['阶段一板', '阶段二板']);
  });

  it('rejects recovery when a different source video fingerprint is selected', () => {
    expect(() => buildRegenerationCheckpoint({
      fingerprint: 'different-video',
      regenerateFromEpisode: 21,
      previousScript,
      saved,
    })).toThrow(/源视频指纹/);
  });
});

describe('longVideoRewrite (X3.4 整剧重写 orchestrator)', () => {
  let dispatcher: ReturnType<typeof makeFetchDispatcher>;

  beforeEach(() => {
    dispatcher = makeFetchDispatcher();
    globalThis.fetch = dispatcher.fn as unknown as typeof globalThis.fetch;
    vi.mocked(ffmpeg.splitVideoForKimi).mockClear();
    vi.mocked(ffmpeg.splitVideoEvenly).mockClear();
    vi.mocked(uploadArtifact).mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ------------------------------------------------------------
  // Happy path: 2 segments → split → Kimi x2 → outline → 3 rewrites → result
  // ------------------------------------------------------------
  it('happy path: exercises all 5 stages, POSTs result, reports progress per stage', async () => {
    const input: LongVideoRewriteInput = {
      videoUrl: '/userData/source.mp4',
      segments: 2,
      projectId: `happy-${Date.now()}`,
      userId: 'u1',
      totalDurationSec: 3000, // 3000 / 90 ≈ 33 集
      totalBytes: 200 * 1024 * 1024,
    };

    const result = await longVideoRewrite(input, makeCtx());

    // ---- Stage 1: splitVideoForKimi called once with the right args ----
    expect(ffmpeg.splitVideoForKimi).toHaveBeenCalledTimes(1);
    const splitCall = ffmpeg.splitVideoForKimi.mock.calls[0] as [
      string,
      number,
      number,
      string,
    ];
    expect(splitCall[0]).toBe('/userData/source.mp4');
    expect(splitCall[1]).toBe(2);
    expect(splitCall[2]).toBe(1500);
    expect(splitCall[3]).toMatch(/dramaforge-long-video-checkpoints[\\/]/);

    // ---- Stage 2: Kimi multipart POST x2 (one per segment) ----
    // mapWithConcurrency(concurrency=4) 可以乱序完成，calls.kimi 落入「完成顺序」
    // 而非「段索引顺序」；按 segmentIndex 排序后再断言，消除调度抖动导致的 flake。
    expect(dispatcher.calls.kimi).toHaveLength(2);
    const kimiByIndex = dispatcher.calls.kimi
      .map((call) => ({
        call,
        idx: Number((call.init.body as FormData).get('segmentIndex')),
      }))
      .sort((a, b) => a.idx - b.idx);
    for (let i = 0; i < kimiByIndex.length; i += 1) {
      const { call } = kimiByIndex[i];
      const form = call.init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      const video = form.get('video');
      expect(video).toBeInstanceOf(File);
      expect((video as File).name).toBe(`segment-${String(i).padStart(3, '0')}.mp4`);
      expect(form.get('segmentIndex')).toBe(String(i));
      expect(form.get('segmentCount')).toBe('2');
      expect(form.get('model')).toBe('kimi-k2.6');
      expect(form.get('machineId')).toBe('m1');
      // Cookie header set on multipart too
      expect(call.init.headers).toMatchObject({ Cookie: 'sid=abc' });
    }

    // ---- Stage 3+4: DeepSeek calls (outline + director board + 3 rewrites + 2 stage boards = 7) ----
    // 1 outline + 1 canonical director board + 3 range rewrites + 2 stage director boards
    expect(dispatcher.calls.deepseek).toHaveLength(7);

    // ---- Progress PUT covers all 5 stages + 每次 body 粘住 taskId（防 UI 刷新丢轮询）----
    const stagesSeen = new Set<string>();
    for (const call of dispatcher.calls.progress) {
      const body = readJsonBody(call.init) as { stage: string; taskId?: string };
      expect(call.url).toBe(
        `https://api.example.com/api/projects/${input.projectId}/long-video-rewrite/progress`,
      );
      expect(call.init.method).toBe('PUT');
      // taskId 必须每次 PUT 都在（progress route 整列覆盖，漏带会冲掉 dispatch 写入的 taskId）
      expect(body.taskId).toBe('job-123');
      stagesSeen.add(body.stage);
    }
    expect(stagesSeen.has('splitting')).toBe(true);
    expect(stagesSeen.has('transcribing')).toBe(true);
    expect(stagesSeen.has('outlining')).toBe(true);
    expect(stagesSeen.has('scripting')).toBe(true);
    expect(stagesSeen.has('completed')).toBe(true);

    // ---- Result POST has the expected payload ----
    expect(dispatcher.calls.result).toHaveLength(1);
    expect(dispatcher.calls.result[0].url).toBe(
      `https://api.example.com/api/projects/${input.projectId}/long-video-rewrite/result`,
    );
    expect(dispatcher.calls.result[0].init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'sid=abc',
      },
    });
    const resultBody = readJsonBody(dispatcher.calls.result[0].init) as {
      novelText: string;
      videoScriptDraft: string;
      longVideoRewrite: { targetEpisodeCount: number; sourceScript: string };
      targetStatus: string;
      completedAt: string;
    };
    expect(resultBody.targetStatus).toBe('SCREENWRITING');
    expect(resultBody.novelText).toContain('第001集');
    expect(resultBody.novelText).toContain('第033集');
    expect(resultBody.videoScriptDraft).toContain('KIMI_SEGMENT_TEXT');
    expect(resultBody.longVideoRewrite.targetEpisodeCount).toBe(33);
    expect(resultBody.longVideoRewrite.sourceScript).toContain('KIMI_SEGMENT_TEXT');
    expect(resultBody.completedAt).toBeTruthy();

    // ---- Output shape ----
    expect(result.outputUrl).toBeUndefined(); // no outputUploadUrl → no upload
    expect(result.meta).toMatchObject({
      segmentCount: 2,
      targetEpisodeCount: 33,
    });
    const outlineCall = dispatcher.calls.deepseek
      .map((call) => readJsonBody(call.init) as { messages?: Array<{ role: string; content: string }> })
      .find((body) => body.messages?.some((message) => message.content.includes('[[GLOBAL_OUTLINE_COMPLETE]]')));
    const outlineUser = outlineCall?.messages?.find((message) => message.role === 'user')?.content ?? '';
    expect(outlineUser).toContain('全剧目标为 33 集');
    expect(outlineUser).not.toContain('50~70');
    expect(uploadArtifact).not.toHaveBeenCalled(); // no legacy URL
  }, 30_000);

  // ------------------------------------------------------------
  // sourceScriptOverride: skip split + Kimi, reuse script, still 3 rewrites
  // ------------------------------------------------------------
  it('sourceScriptOverride: skips split + Kimi, reuses script, runs outline + rewrites', async () => {
    const input: LongVideoRewriteInput = {
      videoUrl: '/userData/source.mp4',
      segments: 2,
      projectId: `reuse-${Date.now()}`,
      userId: 'u1',
      totalDurationSec: 3000,
      totalBytes: 200 * 1024 * 1024,
      sourceScriptOverride: '已有 Kimi 分析稿内容（短，不触发 Reduce）',
    };

    const result = await longVideoRewrite(input, makeCtx());

    // split + Kimi skipped entirely
    expect(ffmpeg.splitVideoForKimi).not.toHaveBeenCalled();
    expect(dispatcher.calls.kimi).toHaveLength(0);

    // Outline + rewrites still ran (1 outline + 1 board + 3 rewrites + 2 stage boards = 7)
    expect(dispatcher.calls.deepseek).toHaveLength(7);

    // Result POST happened
    expect(dispatcher.calls.result).toHaveLength(1);
    const resultBody = readJsonBody(dispatcher.calls.result[0].init) as {
      videoScriptDraft: string;
    };
    expect(resultBody.videoScriptDraft).toBe(
      '已有 Kimi 分析稿内容（短，不触发 Reduce）',
    );

    expect(result.meta?.targetEpisodeCount).toBe(33);
  }, 30_000);

  it('uses the duration-derived target as the outline structure gate', async () => {
    dispatcher = makeFetchDispatcher({ outlineEpisodeCount: 9 });
    globalThis.fetch = dispatcher.fn as unknown as typeof globalThis.fetch;

    await expect(longVideoRewrite({
      videoUrl: '/userData/source.mp4',
      segments: 1,
      projectId: `dynamic-gate-${Date.now()}`,
      userId: 'u1',
      totalDurationSec: 15 * 60, // 10 集 target
      totalBytes: 10 * 1024 * 1024,
      sourceScriptOverride: '已有分析稿',
    }, makeCtx())).rejects.toThrow(/动态目标为 10 集/);

    expect(dispatcher.calls.result).toHaveLength(0);
  });

  it('removes leaked AI planning lines before outline and screenplay persistence', async () => {
    dispatcher = makeFetchDispatcher({
      outlineMetaLine: 'AI思考：先规划批次，再输出大纲。',
      rewriteMetaLine: '本次只生成当前批次，接下来我会续写。',
    });
    globalThis.fetch = dispatcher.fn as unknown as typeof globalThis.fetch;

    await longVideoRewrite({
      videoUrl: '/userData/source.mp4',
      segments: 1,
      projectId: `meta-filter-${Date.now()}`,
      userId: 'u1',
      totalDurationSec: 5 * 60, // 3 集
      totalBytes: 10 * 1024 * 1024,
      sourceScriptOverride: '已有分析稿',
    }, makeCtx());

    const body = readJsonBody(dispatcher.calls.result[0].init) as {
      novelText: string;
      longVideoRewrite: { initialOutline: string };
    };
    expect(body.novelText).not.toMatch(/本次只生成|接下来我会续写/);
    expect(body.longVideoRewrite.initialOutline).not.toContain('AI思考');
    expect(body.novelText).toContain('第003集');
  });

  // ------------------------------------------------------------
  // Legacy outputUploadUrl: rewrite text is uploaded via uploadArtifact
  // ------------------------------------------------------------
  it('legacy outputUploadUrl: uploadArtifact called with rewritten text', async () => {
    const input: LongVideoRewriteInput = {
      videoUrl: '/userData/source.mp4',
      segments: 2,
      projectId: `legacy-${Date.now()}`,
      userId: 'u1',
      totalDurationSec: 3000,
      totalBytes: 200 * 1024 * 1024,
      sourceScriptOverride: '已有分析稿',
      outputUploadUrl: 'https://upload.example/out.txt',
    };

    const result = await longVideoRewrite(input, makeCtx());

    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    const [localOut, uploadUrl] = uploadArtifact.mock.calls[0] as [string, string];
    expect(localOut).toMatch(/long-video-rewrite\.txt$/);
    expect(uploadUrl).toBe('https://upload.example/out.txt');
    expect(result.outputUrl).toBe('https://upload.example/out.txt');
  }, 30_000);

  // ------------------------------------------------------------
  // Failure case: Kimi segment 0 fails 3x → throws, no result POST
  // ------------------------------------------------------------
  it('Kimi segment 0 fails 3x → throws after retries, no result POST', async () => {
    const input: LongVideoRewriteInput = {
      videoUrl: '/userData/source.mp4',
      segments: 1,
      projectId: `fail-${Date.now()}`,
      userId: 'u1',
      totalDurationSec: 3000,
      totalBytes: 200 * 1024 * 1024,
    };

    // Kimi endpoint always throws → withRetry exhausts 3 tries (1s + 2s sleeps).
    // We track fetch invocations via dispatcher.fn.mock.calls (vi.fn's built-in
    // call log) because mockImplementation overrides the body that pushes to
    // calls.kimi, so calls.kimi would stay empty.
    dispatcher.fn.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/generate/text')) {
        throw new Error('Kimi 永久不可用');
      }
      if (String(url).includes('/progress')) {
        return jsonResponse({ success: true });
      }
      return jsonResponse({});
    });

    await expect(longVideoRewrite(input, makeCtx())).rejects.toThrow('Kimi 永久不可用');

    // The only segment is attempted exactly three times by the Kimi retry policy.
    const kimiCalls = dispatcher.fn.mock.calls.filter(([u]) =>
      String(u).includes('/api/generate/text'),
    );
    expect(kimiCalls).toHaveLength(3);
    for (const [, init] of kimiCalls) {
      const form = init?.body as FormData;
      expect(form.get('segmentIndex')).toBe('0');
      expect(form.get('segmentCount')).toBe('1');
    }
    // No result POST (failed before completion).
    expect(
      dispatcher.fn.mock.calls.filter(([u]) =>
        String(u).includes('/long-video-rewrite/result'),
      ),
    ).toHaveLength(0);
    // Progress PUT did report failed stage.
    const failedPut = dispatcher.fn.mock.calls.find(([u, init]) => {
      if (!String(u).includes('/long-video-rewrite/progress')) return false;
      const body = readJsonBody(init!) as { stage: string };
      return body.stage === 'failed';
    });
    expect(failedPut).toBeTruthy();
  }, 15_000);

  // ------------------------------------------------------------
  // Input validation: invalid segment count / missing projectId throws early
  // ------------------------------------------------------------
  it('throws on invalid segment count (zero or non-integer)', async () => {
    const ctx = makeCtx();
    await expect(
      longVideoRewrite(
        {
          videoUrl: '/x.mp4',
          segments: 0,
          projectId: 'p1',
          totalDurationSec: 3000,
          totalBytes: 200,
        },
        ctx,
      ),
    ).rejects.toThrow('invalid segment count');
    await expect(
      longVideoRewrite(
        {
          videoUrl: '/x.mp4',
          segments: 1.5,
          projectId: 'p1',
          totalDurationSec: 3000,
          totalBytes: 200,
        },
        ctx,
      ),
    ).rejects.toThrow('invalid segment count');
    expect(ffmpeg.splitVideoForKimi).not.toHaveBeenCalled();
    expect(dispatcher.calls.kimi).toHaveLength(0);
  });

  it('throws on missing projectId / totalDurationSec / totalBytes', async () => {
    await expect(
      longVideoRewrite(
        {
          videoUrl: '/x.mp4',
          segments: 1,
          totalDurationSec: 3000,
          totalBytes: 200,
        } as LongVideoRewriteInput,
        makeCtx(),
      ),
    ).rejects.toThrow('missing input.projectId');
    await expect(
      longVideoRewrite(
        {
          videoUrl: '/x.mp4',
          segments: 1,
          projectId: 'p1',
          totalBytes: 200,
        } as LongVideoRewriteInput,
        makeCtx(),
      ),
    ).rejects.toThrow('invalid totalDurationSec');
    await expect(
      longVideoRewrite(
        {
          videoUrl: '/x.mp4',
          segments: 1,
          projectId: 'p1',
          totalDurationSec: 3000,
        } as LongVideoRewriteInput,
        makeCtx(),
      ),
    ).rejects.toThrow('invalid totalBytes');
  });

  // ------------------------------------------------------------
  // Progress PUT body carries stage + currentStep + totalSteps (contract check)
  // ------------------------------------------------------------
  it('progress PUTs carry stage + totalSteps + currentStep describing each phase', async () => {
    const input: LongVideoRewriteInput = {
      videoUrl: '/userData/source.mp4',
      segments: 2,
      projectId: `progress-${Date.now()}`,
      userId: 'u1',
      totalDurationSec: 3000,
      totalBytes: 200 * 1024 * 1024,
    };

    await longVideoRewrite(input, makeCtx());

    // totalSteps = segmentCount + 3 = 5 (matches app1's "split/kimi/outline/script/result")
    const splittingPut = dispatcher.calls.progress.find((c) => {
      const b = readJsonBody(c.init) as { stage: string };
      return b.stage === 'splitting';
    });
    expect(splittingPut).toBeTruthy();
    const splittingBody = readJsonBody(splittingPut!.init) as {
      stage: string;
      progress: number;
      currentStep: string;
      totalSteps: number;
      updatedAt: string;
    };
    expect(splittingBody.progress).toBeGreaterThanOrEqual(0);
    expect(splittingBody.progress).toBeLessThanOrEqual(8);
    expect(splittingBody.totalSteps).toBe(5);
    expect(splittingBody.currentStep).toMatch(/拆分|segment/i);
    expect(splittingBody.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // completed stage carries progress=100
    const completedPut = dispatcher.calls.progress.find((c) => {
      const b = readJsonBody(c.init) as { stage: string };
      return b.stage === 'completed';
    });
    expect(completedPut).toBeTruthy();
    const completedBody = readJsonBody(completedPut!.init) as { progress: number };
    expect(completedBody.progress).toBe(100);

    // transcribing stage carries a Kimi concurrency description
    const transcribingPut = dispatcher.calls.progress.find((c) => {
      const b = readJsonBody(c.init) as { stage: string; currentStep?: string };
      return b.stage === 'transcribing' && typeof b.currentStep === 'string' && b.currentStep.includes('Kimi');
    });
    expect(transcribingPut).toBeTruthy();
  }, 30_000);
});
