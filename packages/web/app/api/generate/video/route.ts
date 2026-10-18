// ============================================================
// POST /api/generate/video — 同步云端视频生成（⑩ orchestrator 契约）
// ============================================================
//
// ⑩ client/orchestrators/chain-generate.ts 每个 group POST 此端点，期望同步
// 返回成功 envelope { success: true, data: { url, meta? } }。web 从 body.model
// 拆出 provider（"provider/model-id" 格式，同 ⑥ parseModel），调用
// ② callAI(provider, model, payload)，把 GatewayResult 透传给客户端。⑩ 对非 2xx
// 用 withRetry 重试 3 次。
//
// 鉴权：session REQUIRED（Cookie）。⑩ chain-generate 的 jsonHeaders 带 Cookie。
// userId 从 session 读取，传入 payload 供 ② 按用户级 api_configs 取 key。
//
// 请求体：JSON 对象（group 生成参数），必须含 `model` 字段（"provider/model-id"）。
//   可选字段：prompt / imageUrl / duration / aspectRatio / referenceImageUrls /
//   referenceImageBase64 / ...（各 provider 按需读取，web 透传不校验）。
// 响应（UI-facing envelope，GC-4）：
//   200 { success:true, data: { url, meta? } }    — 生成成功
//   400 { success:false, error, code }              — 缺 model / model 格式错 / body 非 JSON
//   401 { success:false, error, code:'UNAUTHORIZED'} — 未登录
//   422 { success:false, code:'PROVIDER_CONTENT_REJECTED', retryable:false }
//                                                   — 内容安全等确定性拒绝
//   429/5xx { success:false, category:'provider', retryable:true }
//                                                   — 限流或临时上游故障
//   500 { success:false, error, code:'INTERNAL_ERROR'} — 其他异常
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import { callAI, GatewayError, type GatewayPayload } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { runDedupedVideoGeneration } from '@web/lib/video-generation-dedup';

/**
 * 从 model ID 拆分 provider 前缀。
 * "ark/doubao-seedance-2-0" → { provider: 'ark', model: 'ark/doubao-seedance-2-0' }
 *
 * 与 ⑥ ai-worker/model-util.ts 的 parseModel 同逻辑；web 不 import ai-worker
 * （BullMQ worker 不应进 web bundle），故内联此纯函数。
 */
function parseModel(model: string): { provider: string; model: string } {
  const idx = model.indexOf('/');
  if (idx <= 0) {
    throw new Error(`model 缺少 provider 前缀（应为 "provider/model-id"）: ${model}`);
  }
  return { provider: model.slice(0, idx), model };
}

/**
 * 把模型网关错误映射成客户端可执行的重试语义。
 * 内容安全与普通 4xx 是确定性失败，重试只会重复调用；429/5xx 才允许退避重试。
 */
function mapGatewayError(err: GatewayError): {
  status: number;
  code: string;
  category: string;
  retryable: boolean;
} {
  const contentRejected =
    /Input(?:Image|Text)SensitiveContentDetected|PrivacyInformation|may contain real person|sensitive (?:content|information)/i.test(
      err.message,
    );

  if (contentRejected) {
    return {
      status: 422,
      code: 'PROVIDER_CONTENT_REJECTED',
      category: 'content_policy',
      retryable: false,
    };
  }
  // ark pollAsync 总超时（ark.ts:180, 20min）经 callAI toGatewayError 包成 GatewayError(status=null)，
  // 消息含「轮询超时」（http.ts:140）。重试只会再等 20min 放大 chain 假死，故判 non-retryable；
  // 失败进 video-generation-dedup FAILURE_TTL 缓存，同组并发/短期重试命中缓存不再调 ark。
  // 注意：fetchJson 瞬时网络超时用「请求超时」（http.ts:81），不在此列，保留 retryable=true。
  if (/轮询超时/.test(err.message)) {
    return {
      status: 504,
      code: 'AI_GATEWAY_TIMEOUT',
      category: 'provider',
      retryable: false,
    };
  }
  if (err.status === 429) {
    return {
      status: 429,
      code: 'PROVIDER_RATE_LIMIT',
      category: 'provider',
      retryable: true,
    };
  }
  if (err.status !== null && err.status >= 400 && err.status < 500) {
    return {
      status: err.status,
      code: 'PROVIDER_REQUEST_REJECTED',
      category: 'provider',
      retryable: false,
    };
  }
  return {
    status: err.status !== null && err.status >= 500 ? err.status : 502,
    code: 'AI_GATEWAY_ERROR',
    category: 'provider',
    retryable: true,
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    // 余额前置预检（对齐 app1 precheckBalance）：0 积分挡在昂贵 AI 调用之前。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    let body: Record<string, unknown>;
    try {
      const raw = (await req.json()) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return apiFail(
          { error: 'body 需为 JSON 对象', code: 'BAD_BODY' },
          400,
        );
      }
      body = raw as Record<string, unknown>;
    } catch {
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const modelRaw = body.model;
    if (typeof modelRaw !== 'string' || modelRaw.length === 0) {
      return apiFail(
        {
          error: 'body 缺少 model 字段（"provider/model-id"）',
          code: 'MISSING_MODEL',
        },
        400,
      );
    }

    let parsed: { provider: string; model: string };
    try {
      parsed = parseModel(modelRaw);
    } catch (err) {
      return apiFail(
        {
          error: err instanceof Error ? err.message : 'model 格式错',
          code: 'BAD_MODEL',
        },
        400,
      );
    }
    // 内部累计计费字段只供本路由使用，不透传给模型供应商。
    const providerInput = { ...body };
    delete providerInput.billingTaskId;
    delete providerInput.billingUnitId;
    // 构造 GatewayPayload：capability=video_generation，input 透传模型参数。
    const payload: GatewayPayload = {
      capability: 'video_generation',
      input: providerInput,
      userId: auth.userId,
    };

    try {
      const billingTaskId =
        typeof body.billingTaskId === 'string' ? body.billingTaskId : undefined;
      const billingUnitId =
        typeof body.billingUnitId === 'string' ? body.billingUnitId : undefined;
      const execute = () => callAI(parsed.provider, parsed.model, payload);
      const result = billingTaskId && billingUnitId
        ? await runDedupedVideoGeneration(
            `${auth.userId}:${billingTaskId}:${billingUnitId}:${parsed.model}`,
            execute,
            // 只有确定性的 4xx 值得缓存；429/5xx 释放后允许下一次重试。
            (error) =>
              error instanceof GatewayError
              && mapGatewayError(error).retryable === false,
          )
        : await execute();
      await billDirectGeneration({
        userId: auth.userId,
        result,
        description: '镜头视频生成',
        taskType: 'video_generate',
        billingTaskId,
        billingUnitId,
      });
      return apiSuccess({ url: result.url, meta: result.meta });
    } catch (err) {
      if (err instanceof GatewayError) {
        const mapped = mapGatewayError(err);
        // provider/status 合并进错误文本，避免向客户端泄漏 Key 等凭据。
        return apiFail(
          {
            error: `AI 生成失败 [provider=${err.provider}]: ${err.message}`,
            code: mapped.code,
            category: mapped.category,
            retryable: mapped.retryable,
          },
          mapped.status,
        );
      }
      throw err; // re-throw → outer catch → handleApiError → 500 INTERNAL_ERROR
    }
  } catch (err) {
    return handleApiError(err, 'POST /api/generate/video');
  }
}
