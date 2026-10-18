/**
 * @file models.ts — 前端模型目录（对齐 app1 ModelSelector 白名单 + catalog.ts 价格）
 *
 * dramaforge 是 GC-1（key 云端，无 BYOK），不像 app1 需查用户 api-configs。
 * 故本目录是静态常量：列出平台已配 key 的 provider 的推荐模型。
 * 用户选模型 → 透传 model 到 API → 服务器用云端 key 调。
 *
 * 与 app1 对齐情况：
 *   - LANGUAGE / IMAGE / VIDEO 保留 app1 对应能力，但只展示当前平台已有 Key
 *     可真实调用的 DeepSeek / ARK 模型。
 *   - 产品只暴露现有 Kimi / DeepSeek / ARK Key 可支持的模型；无口型入口。
 *   - 价格字段从 app1 catalog.ts 镜像（平台成本价，未加毛利）。
 *   - rateLimit 字段从 app1 catalog.ts 镜像（rpm / concurrency）。
 *   - 积分换算用 estimateImageGenerationCredits() —— app1 同名公式
 *     `Math.ceil(perImage * 1.2 / 0.1)`，成本加价 20%（API_PRICE_MARKUP=1.2，
 *     1 积分 = 0.1 元），与 app1 yuanToCredits 一致。
 *
 * 字段含义：
 *   - id           全局唯一 "provider/model-name"
 *   - provider     服务商标识（用于 route 透传到 gateway）
 *   - name         UI 显示名
 *   - category     业务分类 language/image/video
 *   - capabilities 能力列表（与 ModelSelector 选择的业务能力对应）
 *   - inputs       模型支持的输入类型
 *   - pricing      平台成本价（无毛利）
 *   - rateLimit    速率限制（rpm / 并发数）
 *   - maxDuration  视频模型最大时长（秒）
 *   - supportedSizes 图像模型支持的输出尺寸
 *   - maxTokens    文本模型最大输出 token 数
 */

// ============================================================
// 类型定义
// ============================================================

export type ModelCapability =
  | "text_generation"
  | "image_generation"
  | "video_generation"
  | "tts";

export type ModelCategory = "language" | "image" | "video";

export type ModelInput = "text" | "image" | "video" | "audio";

/**
 * 速率限制（rpm = 每分钟请求数，concurrency = 并发数）。
 * 字段值照搬 app1 catalog.ts，用于前端节流提示与批量按钮积分预估。
 */
export interface ModelRateLimit {
  rpm: number;
  concurrency: number;
}

/**
 * 模型定价（平台成本价，未加毛利）。
 *
 * 至少一组单价字段有值，currency 必填。各字段语义：
 *   - inputPerToken / outputPerToken — 文本模型每 token 单价
 *   - perImage                       — 图像模型每张单价
 *   - perSecondVideo                 — 视频模型每秒单价
 *   - perSecondAudio                 — TTS 语音合成每秒单价
 *   - perRequest                     — 一次性请求计费（为兼容历史目录保留）
 *
 * 注：Seedance 2.0 系列官方按分辨率/token 计费（详见 app1 catalog.ts 的
 * seedanceTokenPricing），本前端目录简化为 perSecondVideo 头线价（取 720p
 * 不带视频输入档），UI 显示与积分换算用此值；精确计费在服务端 gateway 进行。
 */
export interface ModelPricing {
  inputPerToken?: number;
  outputPerToken?: number;
  perImage?: number;
  perSecondVideo?: number;
  perSecondAudio?: number;
  perRequest?: number;
  currency: "CNY" | "USD";
}

/**
 * 模型选项（dramaforge 扩展版，含 app1 ModelOption + catalog.ts 关键字段）
 */
export interface ModelOption {
  /** 模型 ID "provider/model-name" */
  id: string;
  /** 显示名 */
  name: string;
  /** 服务商 */
  provider: string;
  /** 业务分类 */
  category: ModelCategory;
  /** 能力列表 */
  capabilities: ModelCapability[];
  /** 支持的输入类型 */
  inputs: ModelInput[];
  /** 平台成本价（无毛利） */
  pricing?: ModelPricing;
  /** 速率限制（rpm / 并发数），照搬 app1 catalog.ts */
  rateLimit?: ModelRateLimit;
  /** 视频模型最大时长（秒） */
  maxDuration?: number;
  /** 图像模型支持的输出尺寸 */
  supportedSizes?: string[];
  /** 文本模型最大输出 token */
  maxTokens?: number;
}

// ============================================================
// 语言模型（剧本分析 / 分镜生成，text_generation）
// ============================================================
//
// 规定（与 app1 一致）：语言模型只准用 DeepSeek，其他 provider 不在前端使用。
// 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// V4 系列最大输出 384K tokens（character-mapping 已验证可用）。
//
export const LANGUAGE_MODELS: ModelOption[] = [
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash（快）",
    provider: "deepseek",
    category: "language",
    capabilities: ["text_generation"],
    inputs: ["text"],
    maxTokens: 393216, // 384K — 模型最大输出上限
    // 2026-08-17 起峰谷定价（谷=峰半价）：谷 0.05/1.5/4.5，峰 0.10/3.0/9.0（元/M）。
    // 展示价取峰值口径（宁可高估成本展示，服务端按真实峰谷精确计）。
    pricing: {
      inputPerToken: 0.000003,
      outputPerToken: 0.000009,
      currency: "CNY",
    },
    rateLimit: { rpm: 60, concurrency: 5 },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro（推荐）",
    provider: "deepseek",
    category: "language",
    capabilities: ["text_generation"],
    inputs: ["text"],
    maxTokens: 393216,
    // 2026-08-17 起峰谷定价：谷 0.15/4.5/13.5，峰 0.30/9.0/27.0（元/M）。展示取峰值。
    pricing: {
      inputPerToken: 0.000009,
      outputPerToken: 0.000027,
      currency: "CNY",
    },
    rateLimit: { rpm: 60, concurrency: 5 },
  },
];

// ============================================================
// 图像模型（资产生图，image_generation）
// ============================================================
//
// 当前产品只使用已有 ARK Key；未配置的百炼模型不进入选择器。
// 价格来源：火山方舟 https://www.volcengine.com/docs/82379/1544106
//          百炼    https://help.aliyun.com/zh/model-studio/
// pricing.perImage 为「平台成本价」，estimateImageGenerationCredits 会再乘 1.2 加价系数。
// ⚠ 价格随官方调整，上线前请到控制台核对。
//
export const IMAGE_MODELS: ModelOption[] = [
  // ---- ARK / 火山引擎 Seedream ----
  {
    id: "ark/doubao-seedream-5-0-pro-260628",
    name: "Seedream 5.0 Pro（火山·需开通）",
    provider: "ark",
    category: "image",
    capabilities: ["image_generation"],
    inputs: ["text", "image"],
    supportedSizes: ["1024x1024", "2048x2048", "3072x3072", "4096x4096"],
    pricing: { perImage: 0.4, currency: "CNY" },
    rateLimit: { rpm: 30, concurrency: 3 },
  },
  {
    id: "ark/doubao-seedream-5-0-260128",
    name: "Seedream 5.0 Lite（火山·推荐）",
    provider: "ark",
    category: "image",
    capabilities: ["image_generation"],
    inputs: ["text", "image"],
    supportedSizes: ["1024x1024", "2048x2048", "3072x3072"],
    pricing: { perImage: 0.22, currency: "CNY" },
    rateLimit: { rpm: 30, concurrency: 3 },
  },
  {
    id: "ark/doubao-seedream-4-5-251128",
    name: "Seedream 4.5（火山）",
    provider: "ark",
    category: "image",
    capabilities: ["image_generation"],
    inputs: ["text", "image"],
    supportedSizes: ["1024x1024", "2048x2048", "4096x4096"],
    pricing: { perImage: 0.25, currency: "CNY" },
    rateLimit: { rpm: 30, concurrency: 3 },
  },
  {
    id: "ark/doubao-seedream-4-0-250828",
    name: "Seedream 4.0（火山）",
    provider: "ark",
    category: "image",
    capabilities: ["image_generation"],
    inputs: ["text", "image"],
    supportedSizes: ["1024x1024", "2048x2048", "4096x4096"],
    pricing: { perImage: 0.2, currency: "CNY" },
    rateLimit: { rpm: 30, concurrency: 3 },
  },
];

// ============================================================
// 视频模型（串生成，video_generation）
// ============================================================
//
// 当前产品只使用已有 ARK Key，视频模型统一由火山方舟提供。
// 价格来源：火山方舟 https://www.volcengine.com/docs/82379/1520757
//          百炼    https://help.aliyun.com/zh/model-studio/happyhorse-api-reference/
//
// Seedance 2.0 系列（前 3 条）官方按分辨率计费，此处 perSecondVideo 取
// 「720p 不带视频输入」档作为头线价（与 app1 catalog.ts 字段一致），
// 精确计费在服务端进行。
//
export const VIDEO_MODELS: ModelOption[] = [
  // ---- ARK / 火山引擎 Seedance ----
  {
    id: "ark/doubao-seedance-2-0-260128",
    name: "Seedance 2.0（推荐）",
    provider: "ark",
    category: "video",
    capabilities: ["video_generation"],
    inputs: ["text", "image", "video", "audio"],
    maxDuration: 15,
    pricing: { perSecondVideo: 0.046, currency: "CNY" },
    rateLimit: { rpm: 10, concurrency: 2 },
  },
  {
    id: "ark/doubao-seedance-2-0-mini-260615",
    name: "Seedance 2.0 Mini（快）",
    provider: "ark",
    category: "video",
    capabilities: ["video_generation"],
    inputs: ["text", "image", "video", "audio"],
    maxDuration: 15,
    pricing: { perSecondVideo: 0.023, currency: "CNY" },
    rateLimit: { rpm: 10, concurrency: 2 },
  },
  {
    id: "ark/doubao-seedance-2-0-fast-260128",
    name: "Seedance 2.0 Fast",
    provider: "ark",
    category: "video",
    capabilities: ["video_generation"],
    inputs: ["text", "image", "video", "audio"],
    maxDuration: 15,
    pricing: { perSecondVideo: 0.037, currency: "CNY" },
    rateLimit: { rpm: 10, concurrency: 2 },
  },
 {
   // 2026-08-12 用户要求移除：1.0 Pro 不需要，生产只保留 2.0 系列 + 2.5 双模式。
   id: "ark/doubao-seedance-2-5-260628",
   name: "Seedance 2.5（30秒·合并组）",
   provider: "ark",
   category: "video",
   capabilities: ["video_generation"],
   inputs: ["text", "image", "video", "audio"],
   // 30s 上限：组划分按 30s 合并镜头组（2026-08-12 用户要求保留此模式）。
   maxDuration: 30,
   // 头线价 = 720p 无视频输入官方价（¥70/百万token → ¥1.51/s，官方示例 5s=¥7.56 验证）。
   // 精确计费（分辨率/视频输入/折扣窗口）在服务端 seedance-pricing.ts。
   pricing: { perSecondVideo: 1.51, currency: "CNY" },
   rateLimit: { rpm: 10, concurrency: 2 },
 },
 {
   // 后缀 :15 是 UI 区分标识（仅换模型），提交时剥掉还原真实模型 id。
   id: "ark/doubao-seedance-2-5-260628:15",
   name: "Seedance 2.5（仅换模型）",
   provider: "ark",
   category: "video",
   capabilities: ["video_generation"],
   inputs: ["text", "image", "video", "audio"],
   // 仅换模型：组划分保持 15s 上限（不合并镜头组），生成时仍用 2.5 模型。
   maxDuration: 15,
   pricing: { perSecondVideo: 1.51, currency: "CNY" },
   rateLimit: { rpm: 10, concurrency: 2 },
 },
];

// ============================================================
// TTS 语音合成模型（tts）
// ============================================================
//
// 规定（与 app1 一致）：TTS 走平台云端 key，模型 ID 与 app1 catalog.ts 对齐。
// 当前只保留 ARK 音频模型，避免 UI 展示没有平台 Key 的供应商。
//
export const TTS_MODELS: ModelOption[] = [
  // ---- ARK / 火山引擎 CosyVoice ----
  {
    id: "ark/cosyvoice",
    name: "CosyVoice（火山）",
    provider: "ark",
    category: "language",
    capabilities: ["tts"],
    inputs: ["text"],
    pricing: { perSecondAudio: 0.01, currency: "CNY" },
    rateLimit: { rpm: 30, concurrency: 3 },
  },
];

// ============================================================
// 默认模型 ID（保持不变，与历史版本一致）
// ============================================================

export const DEFAULT_SCRIPT_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_IMAGE_MODEL = "ark/doubao-seedream-5-0-260128";
export const DEFAULT_VIDEO_MODEL = "ark/doubao-seedance-2-0-260128";

// ============================================================
// 视频转剧本模型（Kimi 视频理解，video_to_script 能力）
// ============================================================
//
// 与 LANGUAGE/IMAGE/VIDEO 目录分开：video_to_script 是 Kimi-only 的视频理解
// 能力，不属于 text/image/video_generation 三类，故用独立轻量结构（不复用
// ModelOption，避免给 ModelSelector 喂错能力语义）。
//
// id 用「provider/model-name」带前缀形式：
//   - callKimi 的 extractModelId 会去前缀给 Moonshot API（_shared.ts）
//   - 计费表 pricing.ts 的 key 也带前缀 → 命中计费，不再 0 扣
// model id 来源：Kimi 官方文档 platform.kimi.ai（K2.6 / K2.7 Code / K3）。
//
export interface VideoToScriptModel {
  /** 带前缀 model id（"kimi/kimi-k2.6"）；透传到 route ?model=，再进 callAI */
  id: string;
  /** UI 显示名（不含 hint） */
  name: string;
  /** 极短卖点提示（稳 / 快 / 旗舰），下拉选项后缀 */
  hint: string;
}

export const VIDEO_TO_SCRIPT_MODELS: VideoToScriptModel[] = [
  { id: "kimi/kimi-k2.6", name: "Kimi K2.6", hint: "稳·默认" },
  { id: "kimi/kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code", hint: "快" },
  { id: "kimi/kimi-k3", name: "Kimi K3", hint: "旗舰·1M上下文" },
];

export const DEFAULT_VIDEO_TO_SCRIPT_MODEL = "kimi/kimi-k2.6";

// ============================================================
// 积分换算（对齐 app1：相对成本加价 20% + 1 积分 = 0.1 元）
// ============================================================

/**
 * 把图像模型「平台成本价 perImage（元）」换算为用户应扣积分。
 *
 * 公式（与 app1 yuanToCredits 一致）：
 *   credits = Math.ceil(perImage * API_PRICE_MARKUP / PRICE_PER_CREDIT)
 *          = Math.ceil(perImage * 1.2 / 0.1)
 *
 * 即平台成本 × 1.2（成本加价 20%，销售额口径毛利率约 16.67%）后除以 0.1（1 积分 = 0.1 元），
 * 向上取整确保平台不亏。
 *
 * @param perImage - 平台成本单价（元/张），见 IMAGE_MODELS[].pricing.perImage
 * @returns 用户应扣积分（>=0 的整数）
 *
 * @example
 *   estimateImageGenerationCredits(0.22) // = Math.ceil(2.64) = 3 积分
 */
export function estimateImageGenerationCredits(perImage: number): number {
  if (!Number.isFinite(perImage) || perImage <= 0) return 0;
  return Math.ceil((perImage * 1.2) / 0.1);
}
