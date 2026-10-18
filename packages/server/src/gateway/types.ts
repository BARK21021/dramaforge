// ============================================================
// ② server/gateway — 类型定义
// ============================================================
//
// 文件职责：
//   定义 AI 网关的统一契约：payload、result、error、credential。
//   所有 13 个 provider 的调用函数都遵循同一签名，便于 callAI 统一分发。
//
// 安全约束：
//   ProviderCredential 含 apiKey，仅限 server 内部使用，
//   不得出现在任何跨向 client 的类型中。callAI 的返回值 GatewayResult
//   只含 url + meta，绝不包含 key。
// ============================================================

/**
 * 模型能力枚举（与 app1 src/core/types/gateway.ts 对齐）。
 * video_understanding 为 dramaforge 转绘 X1 新增（app1 走 kimi-client 直调不经网关能力枚举）：
 * Kimi Files API 上传视频 + SSE chat 长视频分段分析（连续性锚点剧情事实稿）。
 * video_to_script 为转绘 X2 新增：单集视频转剧本（extractVideoContext + generateScriptFromVideo，
 * Kimi-only 砍 Whisper/OCR）。
 */
export type ModelCapability =
  | 'text_generation'
  | 'image_generation'
  | 'video_generation'
  | 'audio_generation'
  | 'tts'
  | 'video_understanding'
  | 'video_to_script';

/**
 * 网关请求载荷。
 *
 * - capability：模型能力，决定 provider 内部分支
 * - input：原始入参，各 provider 按需读取（prompt / imageUrl / duration 等）
 * - userId（可选）：保留业务归属信息，但凭证统一从管理员平台池读取
 *
 * payload 在 callAI 入口为 unknown，内部归一化为 GatewayPayload。
 */
export interface GatewayPayload {
  capability: ModelCapability;
  input: Record<string, unknown>;
  userId?: string;
}

/**
 * 网关返回值。
 *
 * - url：主产物 URL（图片/视频/音频）；text_generation 无 URL 时为空串
 * - meta：附加信息（content / tokensUsed / images / duration / width / height 等）
 * - cost：本次调用平台成本（元）。由 callAI 在 provider 返回后按 catalog 定价归因
 *   （文本 token、图片张数、视频/音频秒数或单次请求）。上层据此 chargeCredits。
 *   未列入人民币定价目录的模型保持 undefined，避免错误币种扣费。
 */
export interface GatewayResult {
  url: string;
  meta?: Record<string, unknown>;
  cost?: number;
}

/**
 * AI 服务商凭证（server 内部类型，禁跨向 client）。
 *
 * - apiKey：鉴权密钥
 * - baseUrl：可选自定义端点；缺省时各 provider 使用默认地址
 */
export interface ProviderCredential {
  apiKey: string;
  baseUrl?: string;
  /**
   * 来源管理员 api_configs 池的行 id，用于健康回写与粘性锁。
   * 用于：① 健康回写（recordSuccess / recordFailure 按 configId 定位行）；
   *       ② 粘性 key 锁（上传资源归属此 config，后续访问锁回它，防多 key 轮转 403）。
   */
  configId?: string;
}

/**
 * 网关统一错误类型。
 *
 * 包装各 provider 的原始错误，携带 provider 名、HTTP 状态码、Retry-After，
 * 供上层（任务重试 / 熔断 / 用户提示）决策。callAI 把所有非 GatewayError
 * 的抛出都包成 GatewayError，确保上层只需 instanceof 一次。
 */
export class GatewayError extends Error {
  readonly provider: string;
  readonly status: number | null;
  /** 从 Retry-After 头解析的等待毫秒数；无该头为 null */
  readonly retryAfter: number | null;

  constructor(
    provider: string,
    message: string,
    status: number | null = null,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'GatewayError';
    this.provider = provider;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
