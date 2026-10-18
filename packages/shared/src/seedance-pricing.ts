// ============================================================
// Seedance 2.0 精确计费（与 app1 seedance-pricing.ts 同一公式）
// ============================================================

export type SeedanceResolution = '480p' | '720p' | '1080p' | '4k';

interface SeedanceModelPricing {
  withVideoInput: Partial<Record<SeedanceResolution, number>>;
  withoutVideoInput: Partial<Record<SeedanceResolution, number>>;
  defaultResolution: SeedanceResolution;
  supportedResolutions: SeedanceResolution[];
}

const FPS = 24;

/** 官方 token 公式使用的标准输出像素面积；横竖屏只交换宽高，不改变面积。 */
const RESOLUTION_AREAS: Record<SeedanceResolution, number> = {
  '480p': 896 * 480,
  '720p': 1280 * 720,
  '1080p': 1920 * 1080,
  '4k': 3840 * 2160,
};

/**
 * 每千 token 人民币成本，严格同步 app1 的分辨率和视频输入分档。
 * 官方价格入口：https://www.volcengine.com/product/ark
 */
export const SEEDANCE_PRICING_TABLE: Record<string, SeedanceModelPricing> = {
  'ark/doubao-seedance-2-0-260128': {
    withVideoInput: { '480p': 0.028, '720p': 0.028, '1080p': 0.031, '4k': 0.016 },
    withoutVideoInput: { '480p': 0.046, '720p': 0.046, '1080p': 0.051, '4k': 0.026 },
    defaultResolution: '720p',
    supportedResolutions: ['480p', '720p', '1080p', '4k'],
  },
  'ark/doubao-seedance-2-0-fast-260128': {
    withVideoInput: { '480p': 0.022, '720p': 0.022 },
    withoutVideoInput: { '480p': 0.037, '720p': 0.037 },
    defaultResolution: '720p',
    supportedResolutions: ['480p', '720p'],
  },
  'ark/doubao-seedance-2-0-mini-260615': {
    withVideoInput: { '480p': 0.014, '720p': 0.014 },
    withoutVideoInput: { '480p': 0.023, '720p': 0.023 },
    defaultResolution: '720p',
    supportedResolutions: ['480p', '720p'],
  },
  // Seedance 2.5（30s 上限，模型 ID doubao-seedance-2-5-260628，2026-06-28 上线）
  // ⚠ 定价为保守估算（基于 2.0 头线价 +10% 溢价），正式上线后须校准火山控制台最新价格。
  'ark/doubao-seedance-2-5-260628': {
    withVideoInput: { '480p': 0.031, '720p': 0.031, '1080p': 0.034, '4k': 0.018 },
    withoutVideoInput: { '480p': 0.051, '720p': 0.051, '1080p': 0.056, '4k': 0.029 },
    defaultResolution: '720p',
    supportedResolutions: ['480p', '720p', '1080p', '4k'],
  },
};

export interface SeedanceBillingBreakdown {
  modelId: string;
  resolution: SeedanceResolution;
  durationSeconds: number;
  fps: number;
  hasVideoInput: boolean;
  tokenUsage: number;
  ratePerKTokens: number;
  cost: number;
}

export function isSeedanceModel(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SEEDANCE_PRICING_TABLE, modelId);
}

export function normalizeSeedanceResolution(
  modelId: string,
  resolution?: string | null,
): SeedanceResolution {
  const pricing = SEEDANCE_PRICING_TABLE[modelId];
  if (!pricing) return '720p';
  const normalized = String(resolution || '').trim().toLowerCase() as SeedanceResolution;
  return pricing.supportedResolutions.includes(normalized) ? normalized : pricing.defaultResolution;
}

/** 视频输入包含 videoUrl 或至少一个有效 referenceVideoUrls。 */
export function hasSeedanceVideoInput(input: unknown): boolean {
  const value = (input || {}) as { videoUrl?: unknown; referenceVideoUrls?: unknown };
  if (typeof value.videoUrl === 'string' && value.videoUrl.trim()) return true;
  return Array.isArray(value.referenceVideoUrls)
    && value.referenceVideoUrls.some((url) => typeof url === 'string' && url.trim());
}

/** 按像素面积 × 24fps × 秒数换 token，再套所选模型/分辨率/输入类型的官方费率。 */
export function estimateSeedanceBilling(
  modelId: string,
  input: {
    duration?: number | null;
    resolution?: string | null;
    referenceVideoUrls?: string[];
    videoUrl?: string;
  },
  actualDurationSeconds?: number | null,
): SeedanceBillingBreakdown | null {
  const pricing = SEEDANCE_PRICING_TABLE[modelId];
  if (!pricing) return null;
  const durationSeconds = Number(actualDurationSeconds ?? input.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const resolution = normalizeSeedanceResolution(modelId, input.resolution);
  const hasVideoInput = hasSeedanceVideoInput(input);
  const ratePerKTokens = (hasVideoInput ? pricing.withVideoInput : pricing.withoutVideoInput)[resolution];
  if (!Number.isFinite(ratePerKTokens)) return null;
  const tokenUsage = Math.round((RESOLUTION_AREAS[resolution] * FPS * durationSeconds) / 1024);
  const cost = (tokenUsage / 1000) * (ratePerKTokens as number);
  return { modelId, resolution, durationSeconds, fps: FPS, hasVideoInput, tokenUsage, ratePerKTokens: ratePerKTokens as number, cost };
}
