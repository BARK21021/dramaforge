// ============================================================
// reference-video-align — 分镜镜头组 ↔ 参考视频切片对齐（纯函数）
// ============================================================
//
// REFERENCE_VIDEO 转绘：原视频在客户端被切成 N 个切片，分镜生成时 AI 按
// sceneId 收敛成组（server/domain/storyboard/postprocess.ts）。本模块把
// 「剧本场景序列」映射到「切片序列」，供 chain-generate 每组取自己的参考切片。
//
// 对齐策略（启发式，无绝对时间戳）：
//   - 切片数 K == 场景数 N → 按序一一映射（最理想：切点即场景切点）。
//   - K ≠ N → 按时间比例映射：场景 i 占 `[i/N·D, (i+1)/N·D]` 窗（D=源时长），
//     取与该窗重叠时长最大的切片。素材若剪接重排会错位——冒烟用真实短剧比对，
//     错位时降级为纯图生视频（不注入 referenceVideoUrls）。
// ============================================================

import type { ReferenceVideoClipMeta } from '@dramaforge/shared';

/** 组内镜头取主导（众数）场景 id；无 sceneId 时返回 null。 */
export function dominantSceneId(shots: Array<{ sceneId?: string | null }>): string | null {
  const counts = new Map<string, number>();
  for (const shot of shots) {
    const id = shot.sceneId;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/** 按数组序去重提取场景序列（分镜 sortOrder 即时间序）。 */
export function sceneIdSequence(shots: Array<{ sceneId?: string | null }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const shot of shots) {
    const id = shot.sceneId;
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 场景序列 → 切片映射。
 *
 * @param sceneIds 按时间序的场景 id 列表（非空）
 * @param clips    按 index 升序的切片列表（非空）
 * @param sourceDurationSec 原视频时长（秒；<=0 时退化为按序映射）
 * @returns sceneId → 切片 的映射；无合理对齐时返回空 Map
 */
export function alignSceneIdsToClips(
  sceneIds: string[],
  clips: ReferenceVideoClipMeta[],
  sourceDurationSec: number,
): Map<string, ReferenceVideoClipMeta> {
  const map = new Map<string, ReferenceVideoClipMeta>();
  if (sceneIds.length === 0 || clips.length === 0) return map;

  // K == N：按序一一映射。
  if (sceneIds.length === clips.length) {
    for (let i = 0; i < sceneIds.length; i += 1) {
      map.set(sceneIds[i], clips[i]);
    }
    return map;
  }

  // K ≠ N：时间比例映射（源时长未知时退化为均分映射）。
  const total = sourceDurationSec > 0 ? sourceDurationSec : clips.reduce((s, c) => s + c.durationSec, 0);
  const D = total / sceneIds.length;
  for (let i = 0; i < sceneIds.length; i += 1) {
    const winStart = i * D;
    const winEnd = (i + 1) * D;
    let bestClip: ReferenceVideoClipMeta | null = null;
    let bestOverlap = -1;
    for (const clip of clips) {
      const overlap = Math.max(
        0,
        Math.min(winEnd, clip.endSec) - Math.max(winStart, clip.startSec),
      );
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestClip = clip;
      }
    }
    if (bestClip && bestOverlap > 0) {
      map.set(sceneIds[i], bestClip);
    }
  }
  // Fallback: if no alignment was achieved (AI sceneIds don't match clips),
  // assign clips round-robin by scene order — better than silent no-op (which
  // silently degrades to image-only generation without the reference video).
  if (map.size === 0 && sceneIds.length > 0 && clips.length > 0) {
    for (let i = 0; i < sceneIds.length; i += 1) {
      map.set(sceneIds[i], clips[i % clips.length]);
    }
  }
  return map;
}
