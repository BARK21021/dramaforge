// ============================================================
// reference-video-align — 场景↔切片对齐纯函数单测
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  dominantSceneId,
  sceneIdSequence,
  alignSceneIdsToClips,
} from '../lib/reference-video-align';
import type { ReferenceVideoClipMeta } from '@dramaforge/shared';

function clip(index: number, startSec: number, endSec: number): ReferenceVideoClipMeta {
  return {
    index,
    startSec,
    endSec,
    durationSec: endSec - startSec,
    fileKey: `uploads/user-1/reference-video/p/clip-${index}.mp4`,
    height: 720,
  };
}

describe('dominantSceneId', () => {
  it('returns the modal sceneId of a group', () => {
    expect(
      dominantSceneId([
        { sceneId: 's1' },
        { sceneId: 's2' },
        { sceneId: 's1' },
      ]),
    ).toBe('s1');
  });

  it('returns null when no shot has a sceneId', () => {
    expect(dominantSceneId([{ sceneId: null }, { sceneId: undefined }])).toBeNull();
    expect(dominantSceneId([])).toBeNull();
  });
});

describe('sceneIdSequence', () => {
  it('dedupes consecutive sceneIds preserving order', () => {
    expect(
      sceneIdSequence([
        { sceneId: 's1' },
        { sceneId: 's1' },
        { sceneId: 's2' },
        { sceneId: 's1' }, // 场景回归（分镜乱序）仍保留第一次出现的序号
        { sceneId: 's3' },
      ]),
    ).toEqual(['s1', 's2', 's3']);
  });
});

describe('alignSceneIdsToClips', () => {
  it('maps 1:1 when clip count equals scene count (K == N)', () => {
    const clips = [clip(0, 0, 10), clip(1, 10, 20), clip(2, 20, 30)];
    const map = alignSceneIdsToClips(['s1', 's2', 's3'], clips, 30);
    expect(map.get('s1')).toBe(clips[0]);
    expect(map.get('s2')).toBe(clips[1]);
    expect(map.get('s3')).toBe(clips[2]);
  });

  it('maps by time-window overlap when K != N', () => {
    // 2 个场景、4 个切片（源 40s）：场景 s1 窗 [0,20) 应取 0-10s 切片
    // （s2 窗 [20,40) 取 20-30s 切片）。
    const clips = [clip(0, 0, 10), clip(1, 10, 20), clip(2, 20, 30), clip(3, 30, 40)];
    const map = alignSceneIdsToClips(['s1', 's2'], clips, 40);
    expect(map.get('s1')).toBe(clips[0]);
    expect(map.get('s2')).toBe(clips[2]);
  });

  it('returns empty map for empty inputs', () => {
    expect(alignSceneIdsToClips([], [clip(0, 0, 10)], 10).size).toBe(0);
    expect(alignSceneIdsToClips(['s1'], [], 10).size).toBe(0);
  });
});
