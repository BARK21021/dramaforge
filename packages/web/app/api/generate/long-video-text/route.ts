// ============================================================
// POST /api/generate/long-video-text — 长视频 DeepSeek 文本生成（转绘 X3.3）
// ============================================================
//
// client/orchestrators/long-video-rewrite.ts（X3.4）整剧重写主链的 DeepSeek
// 阶段（reduce 大纲 / outline 大纲 / 3 段 rewrite 续写）都走此端点：
// orchestrator 按 long-video-prompt.ts 构造 messages，POST 到这里，server 持
// DeepSeek key 调 text_generation，返回 content + finishReason（orchestrator
// 用 finishReason==='length' 判定是否需要续写 append）。
//
// 余额熔断回退 kimi：DeepSeek 配额/限流/5xx 时（retryable 退避 2 次仍败）自动
// 回退到 Kimi 文本模型（kimi 同样支持 text_generation，走 callOpenAICompatible
// TextGen）。两个 provider 都败才抛 GatewayError（route 映射为 retryable envelope）。
//
// C/S 铁律：
//   - GC-1：DeepSeek/Kimi key 只在 server（callAI cred 直传），绝不下发 client
//   - 本端点纯文本（messages 进 / content 出），不碰任何媒体字节
//
// Body: { messages:[{role,content}], temperature?, maxTokens?, contextWindow?,
//         model?, fallbackModel?, machineId? }
//   默认 model='deepseek/deepseek-v4-flash'，fallbackModel='kimi-k2'
// 响应: 200 { success:true, data:{ content, finishReason, provider, tokensUsed } }
//       400 缺 messages / 401 / 429|5xx provider 暂时失败(retryable) / 500
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import { callAI, GatewayError } from '@dramaforge/server';
import { requireUser } from '@web/lib/auth';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** DeepSeek 暂时性失败的重试策略（指数退避，仅重试 retryable）。 */
const DEEPSEEK_RETRY = { tries: 2, backoffMs: 2_000 } as const;

interface ChatMessage {
  role: string;
  content: string;
}

interface TextGenOutcome {
  content: string;
  finishReason: string;
  tokensUsed: { input: number; output: number };
  provider: 'deepseek' | 'kimi';
  result: Awaited<ReturnType<typeof callAI>>;
}

/**
 * 调单个 provider 的 text_generation，抽取 content/finishReason/tokensUsed。
 * 抛 GatewayError 交调用方决定回退还是映射。
 */
async function callTextProvider(
  provider: 'deepseek' | 'kimi',
  model: string,
  userId: string,
  input: {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    contextWindow?: number;
  },
): Promise<TextGenOutcome> {
  const result = await callAI(provider, model, {
    capability: 'text_generation',
    userId,
    input,
  });
  const meta = (result.meta ?? {}) as Record<string, unknown>;
  return {
    content: typeof meta.content === 'string' ? meta.content : '',
    finishReason: typeof meta.finishReason === 'string' ? meta.finishReason : '',
    tokensUsed: (meta.tokensUsed as { input: number; output: number }) ?? {
      input: 0,
      output: 0,
    },
    provider,
    result,
  };
}

/** GatewayError 是否值得重试/回退（retryable：限流 429、服务端 5xx、带 retryAfter）。 */
function isRetryable(err: unknown): boolean {
  if (err instanceof GatewayError) {
    const status = err.status ?? 502;
    return err.retryAfter !== null || status === 429 || status >= 500;
  }
  return false;
}

/** 带 backoff 的重试（仅重试 retryable；非 retryable 立即抛，避免无谓等待）。 */
async function retryRetryable<T>(
  fn: () => Promise<T>,
  tries: number,
  backoffMs: number,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < tries && isRetryable(err)) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) return apiFail({ error: '未登录或登录已过期', code: 'UNAUTHORIZED' }, 401);

    // 余额前置预检（对齐 app1 precheckBalance）：0 积分挡在昂贵 AI 调用之前。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return apiFail({ error: '请求体必须是 JSON 对象' }, 400);
    }
    const b = body as Record<string, unknown>;

    const rawMessages = b.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return apiFail({ error: '缺少 messages', code: 'VALIDATION_ERROR' }, 400);
    }
    const messages: ChatMessage[] = [];
    for (const m of rawMessages) {
      if (
        m &&
        typeof m === 'object' &&
        typeof (m as { role?: unknown }).role === 'string' &&
        typeof (m as { content?: unknown }).content === 'string'
      ) {
        messages.push({
          role: (m as { role: string }).role,
          content: (m as { content: string }).content,
        });
      }
    }
    if (messages.length === 0) {
      return apiFail({ error: 'messages 必须是非空 {role,content} 数组', code: 'VALIDATION_ERROR' }, 400);
    }

    const input = {
      messages,
      temperature: typeof b.temperature === 'number' ? b.temperature : undefined,
      maxTokens: typeof b.maxTokens === 'number' ? b.maxTokens : undefined,
      contextWindow: typeof b.contextWindow === 'number' ? b.contextWindow : undefined,
    };
    const model =
      typeof b.model === 'string' && b.model.length > 0
        ? b.model
        : 'deepseek/deepseek-v4-flash';
    const fallbackModel =
      typeof b.fallbackModel === 'string' && b.fallbackModel.length > 0
        ? b.fallbackModel
        : 'kimi/kimi-k2.6';

    // 主路径：DeepSeek（retryable 退避 2 次）。
    let outcome: TextGenOutcome;
    try {
      outcome = await retryRetryable(
        () => callTextProvider('deepseek', model, auth.userId, input),
        DEEPSEEK_RETRY.tries,
        DEEPSEEK_RETRY.backoffMs,
      );
    } catch (deepseekErr) {
      // 余额熔断 / 配额 / 持续失败 → 回退 Kimi（Kimi gateway 自带 withKimiRetry 覆盖瞬时）。
      outcome = await callTextProvider('kimi', fallbackModel, auth.userId, input);
    }

    await billDirectGeneration({
      userId: auth.userId,
      result: outcome.result,
      description: '整剧重写文本生成',
      taskType: 'long_video_text',
    });

    return apiSuccess({
      content: outcome.content,
      finishReason: outcome.finishReason,
      provider: outcome.provider,
      tokensUsed: outcome.tokensUsed,
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      const status = err.status ?? 502;
      const retryable = err.retryAfter !== null || status === 429 || status >= 500;
      return apiFail(
        {
          error: err.message,
          code: 'PROVIDER_ERROR',
          category: 'provider',
          retryable,
        },
        status,
      );
    }
    return handleApiError(err, 'POST /api/generate/long-video-text');
  }
}
