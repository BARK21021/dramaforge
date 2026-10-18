// ============================================================

import { estimateSeedanceBilling } from '@dramaforge/shared';
// ② server/gateway/pricing — 模型定价（成本归因）
// ============================================================
//
// 文件职责：
//   提供文本、图像、视频、TTS 模型的统一成本归因。定价单位为人民币元；
//   callAI 只计算平台成本，worker 再统一换算为用户积分。
//
//   定价数据移植自 app1 src/core/gateway/catalog.ts。只自动归因人民币条目；
//   美元条目在没有实时汇率快照前返回 0，避免把美元数值当成人民币扣费。
//
//   app1 的成本计算在 gateway 路由层（router.ts calculateBilling），不在
//   provider 内；dramaforge 同样在 callAI（gateway 层）归因，provider 只返 {url,meta}。
//
// 定价对齐火山方舟官方计费；perImage 为「平台成本价」，yuanToCredits 会再
// 乘 API_PRICE_MARKUP(1.2)，故用户实付 = perImage × 1.2 / 0.1 积分。
// 这是相对成本 20% 加价；不计积分取整和运营成本时，销售额口径毛利率为 1/6≈16.67%。
// ⚠️ 价格随官方调整，上线前以火山方舟控制台「模型价格」页为准。
// 纯数据 + 纯函数，零 I/O，零 ffmpeg。
// ============================================================

/**
 * image_generation 模型 → 元/张（平台成本价）。
 * 未列入目录的模型按 0 计（不扣费，宁可漏扣不误扣）。
 */
const IMAGE_PER_IMAGE_YUAN: Record<string, number> = {
  // ---- Ark (Doubao Seedream) ----
  'ark/doubao-seedream-5-0-pro-260628': 0.4,
  'ark/doubao-seedream-5-0-260128': 0.22, // 默认模型
  'ark/doubao-seedream-4-5-251128': 0.25,
  'ark/doubao-seedream-4-0-250828': 0.2,
};

/** 普通文本模型成本（元/token）；DeepSeek 因缓存和峰谷价另走精确规则。 */
const TEXT_PER_TOKEN_YUAN: Record<string, { input: number; output: number }> = {
  'kimi/kimi-k2.6': { input: 0.0000084, output: 0.0000084 },
  // Kimi 视频转剧本可选模型：官方文档「Vision 用与 moonshot-v1 同一计费方式」，token 单价 ¥8.4/M = 0.0000084。
  // K2.7 Code / K3 暂沿用同价（比现状 0 扣严格更优）；上线前到 Moonshot 控制台核对 K3 真实价后可上调。
  'kimi/kimi-k2.7-code-highspeed': { input: 0.0000084, output: 0.0000084 },
  'kimi/kimi-k3': { input: 0.0000084, output: 0.0000084 },
  'kimi/moonshot-v1-128k': { input: 0.0000084, output: 0.0000084 },
  'ark/doubao-seed-1-6-251015': { input: 0.000003, output: 0.000006 },
};

interface DeepSeekRate {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/**
 * DeepSeek 2026-07 官方人民币基准价（元/token）。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 缓存字段：https://api-docs.deepseek.com/zh-cn/guides/kv_cache/
 * 官网以百万 token 展示：Flash=0.02/1/2，Pro=0.025/3/6（命中/未命中/输出）。
 */
const DEEPSEEK_BASE_RATE: Record<string, DeepSeekRate> = {
  'deepseek/deepseek-v4-flash': { cacheHit: 0.02e-6, cacheMiss: 1e-6, output: 2e-6 },
  'deepseek/deepseek-v4-pro': { cacheHit: 0.025e-6, cacheMiss: 3e-6, output: 6e-6 },
};

/**
 * DeepSeek 峰价按北京时间每天 09:00–12:00、14:00–18:00 生效。
 * 该规则来自 DeepSeek 平台调价通知；公开价格页只展示基准价，因此独立保留为时段规则。
 */
export function isDeepSeekPeakTime(at: Date): boolean {
  if (!Number.isFinite(at.getTime())) return false;
  // 中国不使用夏令时，UTC+8 的整数偏移比依赖服务器本地时区更稳定。
  const minuteOfDay = ((at.getUTCHours() + 8) % 24) * 60 + at.getUTCMinutes();
  return (minuteOfDay >= 9 * 60 && minuteOfDay < 12 * 60)
    || (minuteOfDay >= 14 * 60 && minuteOfDay < 18 * 60);
}

/** 非 Seedance 视频模型成本（元/秒）；Seedance 2.0 使用上方共享的精确 token 公式。 */
const VIDEO_PER_SECOND_YUAN: Record<string, number> = {
  'ark/seedance-1-0-pro': 0.4,
};

/** TTS 成本（元/秒）。provider 未返回音频时长时使用文本节奏估算。 */
const AUDIO_PER_SECOND_YUAN: Record<string, number> = {
  'ark/cosyvoice': 0.01,
};

/**
 * 按 model id + 图片数算 image_generation 成本（元）。
 *
 * - 未列入目录的模型返回 0（不扣费）。
 * - imageCount 非正整数按 1 张处理（ARK 单次默认 1 张）。
 * - 结果保留 3 位小数，避免浮点噪声污染账本。
 */
export function getImageCostYuan(model: string, imageCount: number): number {
  const perImage = IMAGE_PER_IMAGE_YUAN[model];
  if (!perImage || !Number.isFinite(perImage) || perImage <= 0) return 0;
  const n = Number.isInteger(imageCount) && imageCount > 0 ? imageCount : 1;
  return Math.round(perImage * n * 1000) / 1000;
}

function roundYuan(value: number): number {
  // Token costs are often below one厘; six decimals keeps the call billable without float noise.
  return Math.round(value * 1_000_000) / 1_000_000;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
}

function readTokenUsage(result: { meta?: Record<string, unknown> }): TokenUsage {
  const value = result.meta?.tokensUsed;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
  }
  const usage = value as Record<string, unknown>;
  const reportedInput = Math.max(0, Number(usage.input) || 0);
  const reportedHit = Math.max(0, Number(usage.cacheHit) || 0);
  const reportedMiss = Math.max(0, Number(usage.cacheMiss) || 0);
  const input = Math.max(reportedInput, reportedHit + reportedMiss);
  const cacheHit = Math.min(input, reportedHit);
  return {
    input,
    output: Math.max(0, Number(usage.output) || 0),
    cacheHit,
    // 未提供缓存拆分时按未命中计，防止因供应商省略字段而低扣平台成本。
    cacheMiss: Math.max(0, input - cacheHit),
  };
}

/**
 * 根据文本估算 TTS 音频时长：中文约 4 字/秒，非中文约 2.5 词/秒。
 * 仅在 provider 未返回有效 duration 时启用，最少按 1 秒计费。
 */
export function estimateSpeechDurationSeconds(text: unknown): number {
  if (typeof text !== 'string' || !text.trim()) return 0;
  const normalized = text.trim();
  const cjkCount = (normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latinWords = normalized
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, cjkCount / 4 + latinWords / 2.5);
}

/**
 * 按 token 用量计算文本/视频理解能力的平台成本（元）。
 *
 * text_generation、video_understanding、video_to_script 都是 token 计费的 chat
 * completion（Kimi Files API 上传免费，仅 chat 按 token 收费），共用 TEXT_PER_TOKEN_YUAN
 * 单价表——K2.6 文本与多模态 input 同价（官方定价页确认）。DeepSeek 峰谷逻辑仅对
 * DEEPSEEK_BASE_RATE 命中的模型生效，Kimi 模型自然走纯文本费率。未知模型返回 0。
 */
function computeTokenCostYuan(
  model: string,
  result: { meta?: Record<string, unknown> },
  pricedAt: Date,
): number {
  const usage = readTokenUsage(result);
  const deepSeekRate = DEEPSEEK_BASE_RATE[model];
  if (deepSeekRate) {
    const multiplier = isDeepSeekPeakTime(pricedAt) ? 2 : 1;
    return roundYuan(multiplier * (
      deepSeekRate.cacheHit * usage.cacheHit
      + deepSeekRate.cacheMiss * usage.cacheMiss
      + deepSeekRate.output * usage.output
    ));
  }
  const rate = TEXT_PER_TOKEN_YUAN[model];
  if (!rate) return 0;
  return roundYuan(rate.input * usage.input + rate.output * usage.output);
}

/**
 * 统一计算各能力的平台成本（元）；未知模型返回 0，宁可漏扣不误扣。
 *
 * video_understanding（转绘 X1 长视频分段分析）/ video_to_script（转绘 X2/X4.1 单集
 * 视频转剧本）原未列入归因 → Kimi 转绘链路长期免费烧钱（P0-3）。两者均为 Kimi
 * token 计费，与 text_generation 共用 computeTokenCostYuan，provider 必须把真实 token
 * 用量写进 result.meta.tokensUsed（见 kimi.ts kimiStreamChat）。
 */
export function getCapabilityCostYuan(
  model: string,
  capability:
    | 'text_generation'
    | 'image_generation'
    | 'video_generation'
    | 'tts'
    | 'video_understanding'
    | 'video_to_script',
  input: Record<string, unknown>,
  result: { meta?: Record<string, unknown> },
  pricedAt: Date = new Date(),
): number {
  if (
    capability === 'text_generation'
    || capability === 'video_understanding'
    || capability === 'video_to_script'
  ) {
    return computeTokenCostYuan(model, result, pricedAt);
  }
  if (capability === 'image_generation') {
    const images = Array.isArray(result.meta?.images) ? result.meta.images : [];
    return getImageCostYuan(model, images.length || Number(input.count) || 1);
  }
  if (capability === 'video_generation') {
    const providerDuration = Number(result.meta?.duration);
    const requestedDuration = Number(input.duration);
    const seedance = estimateSeedanceBilling(
      model,
      input,
      // Seedance 按提交给模型的目标时长计费；只有旧调用没传 duration 才退回响应时长。
      requestedDuration > 0 ? requestedDuration : providerDuration,
    );
    if (seedance) return roundYuan(seedance.cost);
    const rate = VIDEO_PER_SECOND_YUAN[model];
    const duration = requestedDuration > 0 ? requestedDuration : providerDuration;
    return rate && duration > 0 ? roundYuan(rate * duration) : 0;
  }
  if (capability === 'tts') {
    const rate = AUDIO_PER_SECOND_YUAN[model];
    const providerDuration = Number(result.meta?.duration);
    const duration = providerDuration > 0
      ? providerDuration
      : estimateSpeechDurationSeconds(input.text);
    return rate && duration > 0 ? roundYuan(rate * duration) : 0;
  }
  return 0;
}
