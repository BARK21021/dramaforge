// ============================================================
// ② server/gateway — AI 网关统一入口（13 provider）
// ============================================================
//
// 文件职责：
//   - callAI(provider, model, payload): 统一入口，读凭证 → 分发 → 归一化错误
//   - PROVIDERS: 支持的 provider 名单
//   - 透传 GatewayError / GatewayResult / GatewayPayload 等类型
//
// 安全约束：
//   - AI key 仅从管理员 api_configs 池读取，绝不返回给 client
//   - callAI 返回值 GatewayResult 只含 url + meta，无 key
//   - 服务器禁止 import ffmpeg（本模块零 ffmpeg 依赖）
//
// 产品未配置的平台不注册到网关，避免残留适配器被误调用。
// 当前保留 ark / ark_intl / openai / google / deepseek / kimi / minimax / grok / comfyui。
// ============================================================

import { getCredential } from './credentials';
import { getApiKeyPool, classifyKeyError } from './api-key-pool';
import { GatewayHttpError } from './http';
import type { GatewayPayload, GatewayResult, ProviderCredential } from './types';
import { GatewayError } from './types';
import { getCapabilityCostYuan } from './pricing';
import { callArk } from './providers/ark';
import { callOpenAI } from './providers/openai';
import { callGoogle } from './providers/google';
import { callDeepSeek } from './providers/deepseek';
import { callKimi } from './providers/kimi';
import { callMinimax } from './providers/minimax';
import { callGrok } from './providers/grok';
import { callComfyUI } from './providers/comfyui';

// License gate hook：cloud 默认 always-pass；本地模式由 callAI 首次调用懒加载注册。
let _licenseGate: () => boolean = () => true;
let _licInitialized = false;
export function setLicenseGate(fn: () => boolean): void {
  _licenseGate = fn;
}

/** provider 调用函数签名 */
type ProviderFn = (
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
  ctx?: { signal?: AbortSignal },
) => Promise<GatewayResult>;

/** provider → 调用函数。ark_intl 复用 callArk（baseUrl 由 credentials.ts 区分海外端点） */
const PROVIDER_HANDLERS: Record<string, ProviderFn> = {
  ark: callArk,
  ark_intl: callArk,
  openai: callOpenAI,
  google: callGoogle,
  deepseek: callDeepSeek,
  kimi: callKimi,
  minimax: callMinimax,
  grok: callGrok,
  comfyui: callComfyUI,
};

/** 支持的 provider 名单（13 个） */
export const PROVIDERS: readonly string[] = Object.freeze(Object.keys(PROVIDER_HANDLERS));

/**
 * AI 网关统一入口。
 *
 * 流程：
 *   1. 校验 provider 支持
 *   2. 归一化 payload 为 GatewayPayload
 *   3. 从管理员 api_configs 池读取凭证
 *   4. 分发到 provider 函数
 *   5. 错误归一化：GatewayHttpError → GatewayError(带 status/retryAfter)；
 *      其他 Error → GatewayError(无 status)；已是 GatewayError 原样抛出
 *
 * @param provider  provider 名（ark / openai / google / ...）
 * @param model     模型 ID（可带 provider 前缀，如 "ark/doubao-seedance-2-0"）
 * @param payload   未知载荷，内部归一化为 { capability, input, userId? }
 * @returns { url, meta? } url 为主产物 URL，text_generation 时为空串
 *
 * @throws GatewayError 任何失败都包成 GatewayError
 */
export async function callAI(
  provider: string,
  model: string,
  payload: unknown,
  opts?: { signal?: AbortSignal },
): Promise<GatewayResult> {
  const handler = PROVIDER_HANDLERS[provider];
  if (!handler) {
    throw new GatewayError(provider, `不支持的提供商: ${provider}`);
  }

  // 本地模式 license 门禁：首次 AI 调用时懒加载 license 并注册（云端默认 pass，零影响）。
  // 放在 instrumentation 之外：instrumentation 被 Next 编进 edge 变体（fs/minio 不兼容），
  // 而 callAI 只跑在 node API 路由，此处懒加载安全。
  if (process.env.DRAMAFORGE_LOCAL_MODE === '1' && !_licInitialized) {
    _licInitialized = true;
    try {
      const { checkLicenseGate, isLicenseActive } = await import('../license/gate');
      await checkLicenseGate(process.env.DRAMAFORGE_DATA_DIR || '', '1.0.0');
      setLicenseGate(isLicenseActive);
    } catch (e) {
      console.error('[gateway] local license init failed:', e);
    }
  }
  if (!_licenseGate()) {
    throw new GatewayError(provider, 'License not activated. 请先激活 DramaForge 本地版。');
  }

  const normalizedPayload = normalizePayload(payload, provider);

  let cred: ProviderCredential;
  try {
    // 粘性 key 锁：若 payload 带 input.fileId（复用已上传文件，如 Kimi 视频再分析），
    // 把 fileId 作为 pinnedFileId 传给 getCredential → 锁回上传该文件的原 key，防多 key 轮转 403。
    const pinnedFileId =
      typeof normalizedPayload.input.fileId === 'string'
        ? (normalizedPayload.input.fileId as string)
        : undefined;
    cred = await getCredential(
      provider,
      normalizedPayload.userId,
      pinnedFileId ? { pinnedFileId } : undefined,
    );
  } catch (err) {
    throw toGatewayError(provider, err);
  }

  try {
    // 峰谷价格按请求发起时刻锁定，避免长输出跨越价格边界后产生随机账单。
    const pricingStartedAt = new Date();
    const result = await handler(model, normalizedPayload, cred, opts?.signal ? { signal: opts.signal } : undefined);
    // 健康（仅池 key）：成功清零连续失败计数。fire-and-forget，不阻塞响应。
    if (cred.configId) void getApiKeyPool().recordSuccess(cred.configId);
    // 统一在网关归因平台成本；未知/外币模型返回 0，避免错误扣费。
    if (
      normalizedPayload.capability === 'text_generation'
      || normalizedPayload.capability === 'image_generation'
      || normalizedPayload.capability === 'video_generation'
      || normalizedPayload.capability === 'tts'
      || normalizedPayload.capability === 'video_understanding'
      || normalizedPayload.capability === 'video_to_script'
    ) {
      const cost = getCapabilityCostYuan(
        model,
        normalizedPayload.capability,
        normalizedPayload.input,
        result,
        pricingStartedAt,
      );
      if (cost > 0) result.cost = cost;
    }
    return result;
  } catch (err) {
    // 健康（仅池 key）：失败按错误类型 cooldown/熔断。fire-and-forget。
    if (cred.configId) {
      void getApiKeyPool().recordFailure(
        cred.configId,
        classifyKeyError(err),
        err instanceof Error ? err.message : String(err),
      );
    }
    throw toGatewayError(provider, err);
  } finally {
    // 释放在途名额（与 ApiKeyPool.pick 的预留配对；成败均释放。pickById 未预留则 no-op）
    if (cred.configId) getApiKeyPool().release(cred.configId);
  }
}

/** 把 unknown payload 归一化为 GatewayPayload */
function normalizePayload(payload: unknown, provider: string): GatewayPayload {
  if (payload && typeof payload === 'object' && 'capability' in payload) {
    const p = payload as GatewayPayload;
    if (!p.capability) {
      throw new GatewayError(provider, 'payload 缺少 capability 字段');
    }
    if (!p.input || typeof p.input !== 'object') {
      throw new GatewayError(provider, 'payload.input 必须为对象');
    }
    return p;
  }
  throw new GatewayError(provider, 'payload 必须为 { capability, input, userId? } 对象');
}

/** 把任意错误归一化为 GatewayError */
function toGatewayError(provider: string, err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  if (err instanceof GatewayHttpError) {
    return new GatewayError(provider, err.message, err.status, err.retryAfter);
  }
  if (err instanceof Error) {
    return new GatewayError(provider, err.message);
  }
  return new GatewayError(provider, String(err));
}

// 透传公共类型与工具
export { GatewayError } from './types';
export type {
  GatewayPayload,
  GatewayResult,
  ProviderCredential,
  ModelCapability,
} from './types';
export { getCredential } from './credentials';
export {
  getImageCostYuan,
  getCapabilityCostYuan,
  estimateSpeechDurationSeconds,
} from './pricing';
