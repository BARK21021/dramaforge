// Integration tests for ⑧ client/ffmpeg gridOverlay (sharp-based).
//
// Generates a single 320x240 frame via ffmpeg, overlays a sparse grid on it,
// and verifies the output is a valid non-empty image. Also checks the
// empty-frames guard.
//
// Skip guard: same top-level dynamic import pattern as pipeline.test.ts — if
// the ffmpeg binary is missing, all tests are registered as it.skip.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

type FfmpegApi = typeof import('../../src/ffmpeg');

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

function guardIt(name: string, fn: () => Promise<void> | void): void {
  if (ffmpegAvailable) {
    it(name, fn);
  } else {
    it.skip(`${name} (skipped: ffmpeg binary unavailable)`, fn);
  }
}

let tmpDir = '';
let framePng = '';

beforeAll(async () => {
  if (!ffmpegAvailable || api === null) return;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-grid-test-'));
  framePng = path.join(tmpDir, 'frame.png');
  // Generate a single 320x240 frame via ffmpeg (testsrc → 1 frame PNG).
  await execFileAsync(
    api.getFfmpegPath(),
    ['-f', 'lavfi', '-i', 'testsrc=duration=0.1:size=320x240:rate=1', '-frames:v', '1', '-y', framePng],
    { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
  );
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe('client/ffmpeg gridOverlay', () => {
  guardIt('overlays a grid on a frame and writes a valid PNG', async () => {
    const outPng = path.join(tmpDir, 'grid-out.png');
    await api!.gridOverlay([framePng], outPng);
    expect(existsSync(outPng)).toBe(true);
    const stat = await fs.stat(outPng);
    expect(stat.size).toBeGreaterThan(0);
    // Verify it's a valid image with the original dimensions.
    const meta = await sharp(outPng).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
  });

  guardIt('throws on empty frames array', async () => {
    await expect(api!.gridOverlay([], path.join(tmpDir, 'nope.png'))).rejects.toThrow(/empty/);
  });
});
