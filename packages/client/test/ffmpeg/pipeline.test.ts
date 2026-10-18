// Integration tests for ⑧ client/ffmpeg pipeline.
//
// Generates a tiny 3s test video with ffmpeg (lavfi testsrc) in os.tmpdir(),
// then exercises getVideoDuration / splitVideoEvenly / extractLastFrame /
// execFfmpegConcat against it.
//
// Skip guard: @ffmpeg-installer/ffmpeg throws at load-time if the platform
// binary is missing, so we use a top-level dynamic import in try/catch and
// register it.skip (with a reason in the name) when the binary is unavailable.
// All temp files are cleaned up in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

type FfmpegApi = typeof import('../../src/ffmpeg');

// Top-level dynamic import: if the ffmpeg binary is missing, the import throws
// and we fall back to skipping all tests.
let api: FfmpegApi | null = null;
try {
  const mod = await import('../../src/ffmpeg');
  if (existsSync(mod.getFfmpegPath())) {
    api = mod;
  }
} catch {
  api = null;
}

const ffmpegAvailable = api !== null;

// Register with `it` when the binary is available, else `it.skip` with a
// reason appended to the name (so the skip reason is visible in output).
function guardIt(name: string, fn: () => Promise<void> | void): void {
  if (ffmpegAvailable) {
    it(name, fn);
  } else {
    it.skip(`${name} (skipped: ffmpeg binary unavailable)`, fn);
  }
}

let tmpDir = '';
let testMp4 = '';
let testWav = '';

beforeAll(async () => {
  if (!ffmpegAvailable || api === null) return;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-ffmpeg-test-'));
  testMp4 = path.join(tmpDir, 'test.mp4');
  // 3s, 320x240, 15fps test pattern video.
  await execFileAsync(
    api.getFfmpegPath(),
    ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-y', testMp4],
    { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
  );
  // 8s 440Hz sine wav — 用于 trimAudio 测试（dur > 5 触发裁剪）。
  testWav = path.join(tmpDir, 'test.wav');
  await execFileAsync(
    api.getFfmpegPath(),
    ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-y', testWav],
    { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
  );
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe('client/ffmpeg pipeline', () => {
  guardIt('getVideoDuration returns ~3 (±0.5) for a 3s video', async () => {
    const d = await api!.getVideoDuration(testMp4);
    expect(d).toBeGreaterThan(2.5);
    expect(d).toBeLessThan(3.5);
  });

  guardIt('trimAudio keeps the first maxSec seconds of an 8s wav (≤5.x, non-empty)', async () => {
    const out = path.join(tmpDir, 'trimmed.wav');
    await api!.trimAudio(testWav, 5, out);
    // 产出存在且非空。
    expect(existsSync(out)).toBe(true);
    const size = (await fs.stat(out)).size;
    expect(size).toBeGreaterThan(0);
    // PCM wav 下 -c copy 采样级精确：裁后时长应 ≤5.x（允许 ffmpeg 时长取整误差）。
    const d = await api!.getVideoDuration(out);
    expect(d).toBeLessThanOrEqual(5.5);
    expect(d).toBeGreaterThan(0);
  });

  guardIt('trimAudio throws when the input path does not exist', async () => {
    const out = path.join(tmpDir, 'nope.wav');
    await expect(api!.trimAudio(path.join(tmpDir, 'missing.wav'), 5, out)).rejects.toThrow();
  });

  guardIt('splitVideoEvenly(testMp4, 2, prefix) produces 2 files', async () => {
    const prefix = path.join(tmpDir, 'even-seg');
    const segs = await api!.splitVideoEvenly(testMp4, 2, prefix);
    expect(segs).toHaveLength(2);
    for (const s of segs) {
      expect(existsSync(s)).toBe(true);
    }
  });

  guardIt('splitVideoForKimi(testMp4, 2, 1.5, dir) stream-copy 出 2 段带 timing', async () => {
    const dir = path.join(tmpDir, 'kimi-seg');
    const segs = await api!.splitVideoForKimi(testMp4, 2, 1.5, dir);
    expect(segs).toHaveLength(2);
    expect(segs[0].index).toBe(0);
    expect(segs[0].startSec).toBe(0);
    expect(segs[0].endSec).toBeCloseTo(1.5);
    expect(segs[1].index).toBe(1);
    expect(segs[1].startSec).toBeCloseTo(1.5);
    expect(segs[1].endSec).toBeCloseTo(3);
    for (const s of segs) {
      expect(existsSync(s.path)).toBe(true);
      const stat = await fs.stat(s.path);
      expect(stat.size).toBeGreaterThan(0);
      // 每段远低于 95 MiB 安全上限
      expect(stat.size).toBeLessThan(95 * 1024 * 1024);
    }
  });

  guardIt('splitVideoForKimi 非法参数抛错', async () => {
    const dir = path.join(tmpDir, 'kimi-bad');
    await expect(api!.splitVideoForKimi(testMp4, 0, 1.5, dir)).rejects.toThrow();
    await expect(api!.splitVideoForKimi(testMp4, 2, 0, dir)).rejects.toThrow();
  });

  guardIt('extractLastFrame(testMp4, outPng) produces a frame file', async () => {
    const outPng = path.join(tmpDir, 'last-frame.png');
    await api!.extractLastFrame(testMp4, outPng);
    expect(existsSync(outPng)).toBe(true);
    const stat = await fs.stat(outPng);
    expect(stat.size).toBeGreaterThan(0);
  });

  guardIt('execFfmpegConcat([testMp4, testMp4], outMp4) produces a ~6s video', async () => {
    const outMp4 = path.join(tmpDir, 'concat.mp4');
    await api!.execFfmpegConcat([{ url: testMp4 }, { url: testMp4 }], outMp4);
    expect(existsSync(outMp4)).toBe(true);
    const d = await api!.getVideoDuration(outMp4);
    expect(d).toBeGreaterThan(5.5);
    expect(d).toBeLessThan(6.5);
  });

  // resolveStorageUrl is a pure no-op, but it lives in the same module that
  // fails to load without the ffmpeg binary, so we guard with guardIt too.
  guardIt('resolveStorageUrl is a no-op pass-through (server storage-factory stripped)', () => {
    const remote = 'https://minio.example.com/bucket/clip.mp4';
    expect(api!.resolveStorageUrl(remote)).toBe(remote);
    const local = '/uploads/videos/xxx.mp4';
    expect(api!.resolveStorageUrl(local)).toBe(local);
  });

  guardIt('probeVideoHeight 解析 320x240 fixture 返回 240', async () => {
    expect(await api!.probeVideoHeight(testMp4)).toBe(240);
  });

  guardIt('probeVideoHeight 文件不存在时优雅返回 0（stderr 无 Video 行）', async () => {
    expect(await api!.probeVideoHeight(path.join(tmpDir, 'no-such.mp4'))).toBe(0);
  });

  guardIt('downscaleVideoToHeight 把 720p 降到 480p（输出高度=480，文件非空）', async () => {
    // 生成 1280x720 源（>480 才触发降采样意义）。
    const src = path.join(tmpDir, 'hd.mp4');
    await execFileAsync(
      api!.getFfmpegPath(),
      ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=1280x720:rate=15', '-y', src],
      { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
    );
    expect(await api!.probeVideoHeight(src)).toBe(720);

    const out = path.join(tmpDir, 'downscaled.mp4');
    await api!.downscaleVideoToHeight(src, out, 480);
    expect(existsSync(out)).toBe(true);
    expect((await fs.stat(out)).size).toBeGreaterThan(0);
    // scale=-2:480 锁高 480、宽自适应偶数 → 输出高度恰好 480。
    expect(await api!.probeVideoHeight(out)).toBe(480);
  });

  // ============================================================
  // Reference-video scene detection + cutting（国外转绘 REFERENCE_VIDEO）
  // ============================================================

  guardIt('detectSceneBoundaries: static testsrc has no scene cuts (empty boundaries)', async () => {
    const { boundaries, sourceDurationSec } = await api!.detectSceneBoundaries(testMp4, {
      threshold: 0.3,
      minSceneSec: 1,
    });
    expect(boundaries).toEqual([]);
    expect(sourceDurationSec).toBeGreaterThan(2.5);
    expect(sourceDurationSec).toBeLessThan(4);
  });

  guardIt(
    'detectSceneBoundaries: -f null - 成功退出码 0 时仍能从 stderr 解析出场景切换点（历史回归）',
    async () => {
      // 前 2s testsrc + 后 2s testsrc2 拼接：切换点画面突变 → scene 分接近 1。
      const sceneVideo = path.join(tmpDir, 'two-scenes.mp4');
      const partA = path.join(tmpDir, 'part-a.mp4');
      const partB = path.join(tmpDir, 'part-b.mp4');
      await execFileAsync(
        api!.getFfmpegPath(),
        ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15', '-y', partA],
        { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
      );
      await execFileAsync(
        api!.getFfmpegPath(),
        ['-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=15', '-y', partB],
        { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
      );
      const listFile = path.join(tmpDir, 'two-scenes.txt');
      await fs.writeFile(listFile, `file '${partA.replaceAll('\\', '/')}'\nfile '${partB.replaceAll('\\', '/')}'\n`);
      await execFileAsync(
        api!.getFfmpegPath(),
        ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', sceneVideo],
        { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
      );

      const { boundaries, sourceDurationSec } = await api!.detectSceneBoundaries(sceneVideo, {
        // -c copy 拼接会让拼接点 scene 分被帧类型差异压低（实测 <0.3），
        // 这里显式低阈值验证"spawn+stderr 解析"机制本身；真实镜头切换默认 0.3。
        threshold: 0.05,
        minSceneSec: 1,
      });

      // 切换点应落在 ~2s 附近（±0.5s 容差；-c copy 拼接时间戳基本无损）。
      expect(sourceDurationSec).toBeGreaterThan(3.5);
      expect(boundaries.length).toBeGreaterThanOrEqual(1);
      expect(Math.abs(boundaries[0] - 2)).toBeLessThan(0.6);
    },
  );

  guardIt('cutReferenceVideo: cuts scene windows into ≤15s 720p-capped clips', async () => {
    const sceneVideo = path.join(tmpDir, 'two-scenes.mp4');
    if (!existsSync(sceneVideo)) {
      // 前一个 guardIt 被 skip（无二进制）时这里也会被 skip，正常。
      throw new Error('scene video not prepared (binary unavailable?)');
    }
    const outDir = path.join(tmpDir, 'ref-clips');
    const { clips, sourceDurationSec } = await api!.cutReferenceVideo(sceneVideo, outDir, {
      threshold: 0.05, // 同回归测试：-c copy 拼接场景分被压低
      maxHeight: 720,
      maxClipSec: 15,
    });

    expect(sourceDurationSec).toBeGreaterThan(3.5);
    expect(clips.length).toBeGreaterThanOrEqual(1);
    for (const clip of clips) {
      expect(clip.durationSec).toBeGreaterThan(0);
      expect(clip.durationSec).toBeLessThanOrEqual(15.5);
      expect(clip.height).toBeLessThanOrEqual(720);
      expect(existsSync(clip.path)).toBe(true);
    }
    // 切片时间窗连续覆盖整段。
    expect(clips[0].startSec).toBeCloseTo(0, 1);
    const total = clips.reduce((sum, c) => sum + c.durationSec, 0);
    expect(total).toBeGreaterThan(3);
    expect(total).toBeLessThan(5);
  });
});
