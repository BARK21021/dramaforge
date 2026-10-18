// ffmpeg helpers for the e2e harness.
//
// Uses the SAME binary the client render-worker uses (@ffmpeg-installer/ffmpeg)
// to generate two tiny 2-second test clips via the lavfi `testsrc` source. The
// clips are encoded with libx264 + yuv420p so the concat demuxer's `-c copy`
// path produces a valid mp4 (matching codec/pixfmt/timebase on both clips).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const execFileAsync = promisify(execFile);

/** Path to the bundled ffmpeg binary (same one the client render-worker uses). */
export const FFMPEG_PATH: string = ffmpegInstaller.path;

export interface GeneratedClip {
  localPath: string;
  durationSec: number;
}

/**
 * Generate N tiny test clips (2s each, 320x240 @ 30fps, libx264 yuv420p).
 *
 * Each clip is written to a fresh temp dir under os.tmpdir(). Returns the
 * local paths in order.
 *
 * @param count - number of clips to generate
 * @param durationSec - per-clip duration (default 2)
 */
export async function generateTestClips(
  count: number,
  durationSec = 2,
): Promise<GeneratedClip[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`clip count must be a positive integer, received ${count}`);
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`clip duration must be positive, received ${durationSec}`);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-e2e-clips-'));

  try {
    const clips: GeneratedClip[] = [];
    for (let i = 0; i < count; i++) {
      const localPath = path.join(dir, `clip-${i + 1}.mp4`);
      // testsrc: test pattern generator. duration/size/rate are lavfi params.
      // -pix_fmt yuv420p: broad compatibility (concat demuxer -c copy friendly).
      const args = [
        '-f', 'lavfi',
        '-i', `testsrc=duration=${durationSec}:size=320x240:rate=30`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        localPath,
      ];
      try {
        await execFileAsync(FFMPEG_PATH, args, {
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
        });
      } catch (err) {
        const stderr = (err as { stderr?: string })?.stderr ?? '';
        throw new Error(`ffmpeg clip gen failed: ${stderr || (err as Error).message}`);
      }
      clips.push({ localPath, durationSec });
    }
    return clips;
  } catch (error) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(`${String(error)}; clip temp cleanup failed: ${String(cleanupError)}`);
    }
    throw error;
  }
}

/**
 * Probe a video URL/local-path duration using the same ffmpeg binary.
 * Mirrors @client/ffmpeg.getVideoDuration but standalone (no workspace dep).
 */
export async function probeDuration(url: string): Promise<number> {
  try {
    await execFileAsync(FFMPEG_PATH, ['-i', url], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const sec = parseFloat(m[3]);
      return h * 3600 + min * 60 + sec;
    }
  }
  return 0;
}
