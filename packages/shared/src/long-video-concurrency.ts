// 来源：F:\app1\src\core\video\long-video-concurrency.ts（整文件 verbatim 移植）。
// 转绘 X3.1 纯函数迁移，零依赖（无 DB/Prisma/redis/ffmpeg/node:*）。

const KIMI_TIER_CONCURRENCY_LIMITS = [1, 50, 100, 200, 400, 1000] as const;
const DEFAULT_KIMI_UPLOAD_CONCURRENCY = 4;

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

/**
 * Resolve Kimi segment concurrency from the official account-tier limits.
 * Tier1 is the production default because the video workflow requires a paid
 * account; an explicit override is useful for custom capacity arrangements.
 */
export function resolveKimiSegmentConcurrency(
  segmentCount: number,
  options: { tier?: unknown; override?: unknown } = {},
): number {
  const count = Math.max(1, Math.floor(segmentCount));
  const override = positiveInteger(options.override);
  if (override) return Math.min(count, override);

  const rawTier = nonNegativeInteger(options.tier);
  const tier = rawTier === null ? 1 : Math.min(5, Math.max(0, rawTier));
  return Math.min(count, KIMI_TIER_CONCURRENCY_LIMITS[tier]);
}

/**
 * The Files API has a much lower practical concurrency ceiling than model
 * inference. Keep multipart uploads on their own small pool so a Tier1 model
 * allowance of 50 does not become 50 simultaneous 50-100 MB uploads.
 */
export function resolveKimiUploadConcurrency(
  segmentCount: number,
  override?: unknown,
): number {
  const count = Math.max(1, Math.floor(segmentCount));
  return Math.min(count, positiveInteger(override) ?? DEFAULT_KIMI_UPLOAD_CONCURRENCY);
}

/** DeepSeek V4 Pro's published account-level concurrency limit is 500. */
export function resolveDeepSeekReduceConcurrency(
  chunkCount: number,
  override?: unknown,
): number {
  const count = Math.max(1, Math.floor(chunkCount));
  return Math.min(count, positiveInteger(override) ?? 500);
}
