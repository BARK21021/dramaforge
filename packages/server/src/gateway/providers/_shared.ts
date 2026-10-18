// ============================================================
// ② server/gateway/providers — provider 共享工具
// ============================================================
//
// 文件职责：
//   - extractModelId：从 "provider/model-id" 中剥离 provider 前缀
//   - callOpenAICompatibleTextGen：OpenAI / ARK / Kimi 共用的非流式文本生成
//   - callOpenAICompatibleTextGenStream：DeepSeek 长输出使用的 SSE 流式文本生成
//   - ensureAccessibleUrl：远程资源 URL 校验（MinIO presigned URL 已公网可达）
//
// 与 app1 的差异：
//   - 普通文本默认非流式；DeepSeek 资产提取等长输出在 gateway 内持续消费 SSE，
//     上层仍收到完整文本，兼顾超时稳定性与现有解析契约
//   - ensureAccessibleUrl 不再做 /uploads/ → base64 转换（重构后资产走
//     MinIO presigned URL，远程 API 可直接访问）
// ============================================================

import { fetchJson, GatewayHttpError } from '../http';
import type { GatewayResult, ProviderCredential } from '../types';

/**
 * 从 model ID 中剥离 provider 前缀。
 * "ark/doubao-seedance-2-0" → "doubao-seedance-2-0"
 * "doubao-seedance-2-0"     → "doubao-seedance-2-0"
 */
export function extractModelId(model: string): string {
  const idx = model.indexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/**
 * 远程资源 URL 校验：http(s) URL 直接返回。
 *
 * 重构后资产存储走 MinIO presigned URL，对远程 AI API 公网可达，
 * 无需 app1 的 /uploads/ → base64 转换逻辑。
 */
export function ensureAccessibleUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
    return url;
  }
  // 相对路径（理论上重构后不应出现）：原样返回让上游 API 报错暴露问题
  return url;
}

/**
 * OpenAI 兼容的文本生成（非流式）。
 *
 * 适用于 openai / ark / ark_intl / deepseek / kimi。
 * 端点：POST {baseUrl}/chat/completions
 * 鉴权：Authorization: Bearer {apiKey}
 *
 * @param modelId   剥离前缀的模型 ID
 * @param cred      凭证（含 baseUrl + apiKey）
 * @param headers   复用 provider 构造的 headers（含 Authorization）
 * @param input     原始入参（messages / prompt / temperature / maxTokens / contextWindow）
 * @param opts      defaultTemp 默认温度
 */
export async function callOpenAICompatibleTextGen(
  modelId: string,
  cred: ProviderCredential,
  headers: Record<string, string>,
  input: Record<string, unknown>,
  opts?: { defaultTemp?: number; timeoutMs?: number },
): Promise<GatewayResult> {
  const baseUrl = cred.baseUrl;
  if (!baseUrl) throw new Error('OpenAI 兼容文本生成缺 baseUrl');

  const messages = (input.messages as unknown[] | undefined) ?? [
    { role: 'user', content: input.prompt ?? JSON.stringify(input) },
  ];

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    temperature: input.temperature ?? opts?.defaultTemp ?? 0.7,
    stream: false,
  };

  const requestedMax = Number(input.maxTokens);
  const contextWindow = Number(input.contextWindow);
  if (Number.isFinite(requestedMax) && requestedMax > 0) {
    const serializedInput = JSON.stringify(messages);
    const estimatedInputTokens = Math.ceil(serializedInput.length / 2) + 1024;
    const safeMax =
      Number.isFinite(contextWindow) && contextWindow > 0
        ? Math.max(1, Math.floor(Math.min(requestedMax, contextWindow - estimatedInputTokens)))
        : requestedMax;
    // Kimi 已弃用 max_tokens，使用 max_completion_tokens
    if (baseUrl.includes('moonshot.cn') || modelId.startsWith('kimi-')) {
      body.max_completion_tokens = safeMax;
    } else {
      body.max_tokens = safeMax;
    }
  }

  const data = await fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, opts?.timeoutMs);

  const choices = (data.choices as Array<{ message?: { content?: string }; finish_reason?: string }>) ?? [];
  const content = choices[0]?.message?.content ?? '';
  // 转绘 X3.3：暴露 finish_reason（'stop' | 'length' | 'tool_calls' | …）。
  // 长视频 orchestrator（X3.4）用 finishReason==='length' 判定模型因 max_tokens
  // 截断（未自然结束），据此触发续写 append；缺此信号则只能靠完成标记猜测。
  const finishReason = typeof choices[0]?.finish_reason === 'string' ? choices[0].finish_reason : '';
  const usage = (data.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  }) ?? {};

  return {
    url: '',
    meta: {
      content,
      finishReason,
      tokensUsed: {
        input: usage.prompt_tokens ?? 0,
        output: usage.completion_tokens ?? 0,
        // 只有供应商真的返回缓存明细时才扩展通用契约，避免普通 OpenAI 响应凭空多出零值字段。
        ...(typeof usage.prompt_cache_hit_tokens === 'number'
          ? { cacheHit: usage.prompt_cache_hit_tokens }
          : {}),
        ...(typeof usage.prompt_cache_miss_tokens === 'number'
          ? { cacheMiss: usage.prompt_cache_miss_tokens }
          : {}),
      },
    },
  };
}

/** DeepSeek 整剧 JSON 流总时限；45+ 集完整正文实测会超过 9 分钟。 */
const STREAM_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
/** 连续无任何 SSE 数据才判定卡死；DeepSeek keep-alive 注释也会重置此计时。 */
const STREAM_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * OpenAI 兼容 SSE 文本生成。
 *
 * 主要用于 DeepSeek 大型 JSON（资产提取等）：边到边消费 token，避免非流式请求在
 * 固定 180 秒处被 abort。函数仍聚合完整 content 再交给现有解析器，因此不改变上层
 * route/计费契约；stream_options.include_usage 保留真实 token 账单。
 */
export async function callOpenAICompatibleTextGenStream(
  modelId: string,
  cred: ProviderCredential,
  headers: Record<string, string>,
  input: Record<string, unknown>,
  opts?: { defaultTemp?: number; thinking?: 'enabled' | 'disabled'; thinkingBudget?: number },
): Promise<GatewayResult> {
  const baseUrl = cred.baseUrl;
  if (!baseUrl) throw new Error('OpenAI 兼容文本生成缺 baseUrl');

  const messages = (input.messages as unknown[] | undefined) ?? [
    { role: 'user', content: input.prompt ?? JSON.stringify(input) },
  ];
  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    temperature: input.temperature ?? opts?.defaultTemp ?? 0.7,
    stream: true,
    stream_options: { include_usage: true },
  };
  const requestedMax = Number(input.maxTokens);
  const contextWindow = Number(input.contextWindow);
  if (Number.isFinite(requestedMax) && requestedMax > 0) {
    const estimatedInputTokens = Math.ceil(JSON.stringify(messages).length / 2) + 1024;
    const safeMax =
      Number.isFinite(contextWindow) && contextWindow > 0
        ? Math.max(1, Math.floor(Math.min(requestedMax, contextWindow - estimatedInputTokens)))
        : requestedMax;
    // Kimi 已弃用 max_tokens，必须用 max_completion_tokens（与非流式分支对齐）。
    if (baseUrl.includes('moonshot.cn') || modelId.startsWith('kimi-')) {
      body.max_completion_tokens = safeMax;
    } else {
      body.max_tokens = safeMax;
    }
  }
  // DeepSeek 思考模式（V3.1+）：thinking.type=enabled 开启链式推理。
  // 推理过程经 delta.reasoning_content 返回，本函数只聚合 delta.content，
  // 故推理被丢弃、仅保留最终答案（不污染下游 JSON 解析）。
  // ⚠ 注意：推理 token 计入 max_tokens 总额，长 JSON 输出可能被截断（见 deepseek.ts 注释）。
  if (opts?.thinking) {
    // thinkingBudget（DeepSeek-V3.1+）显式上限推理 token，防止推理吃掉输出预算导致
    // 长 JSON 被 max_tokens 截断（finish_reason=length → 上游续写重试，拖慢链路）。
    body.thinking = typeof opts.thinkingBudget === 'number' && opts.thinkingBudget > 0
      ? { type: opts.thinking, budget_tokens: opts.thinkingBudget }
      : { type: opts.thinking };
  }

  const controller = new AbortController();
  // 对象属性可被定时器闭包更新，同时避免 TypeScript 把局部字面量错误收窄为 total。
  const timeoutState: { kind: 'total' | 'idle' } = { kind: 'total' };
  const totalTimer = setTimeout(() => {
    timeoutState.kind = 'total';
    controller.abort();
  }, STREAM_TOTAL_TIMEOUT_MS);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutState.kind = 'idle';
      controller.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  try {
    resetIdleTimer();
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new GatewayHttpError(response.status, errorText, response.headers.get('retry-after'));
    }
    if (!response.body) throw new Error('DeepSeek 流式接口未返回响应体');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheHitTokens = 0;
    let cacheMissTokens = 0;
    let hasCacheHitTokens = false;
    let hasCacheMissTokens = false;

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      // 官方会发送 `: keep-alive`；它已经在读到 chunk 时重置 idle timer，无需解析。
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
          } | null;
        };
        const choice = chunk.choices?.[0];
        if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          if (typeof chunk.usage.prompt_cache_hit_tokens === 'number') {
            cacheHitTokens = chunk.usage.prompt_cache_hit_tokens;
            hasCacheHitTokens = true;
          }
          if (typeof chunk.usage.prompt_cache_miss_tokens === 'number') {
            cacheMissTokens = chunk.usage.prompt_cache_miss_tokens;
            hasCacheMissTokens = true;
          }
        }
      } catch {
        // 单个坏 SSE 行不应丢掉此前已接收的完整内容；最终解析器仍会验证 JSON。
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);

    return {
      url: '',
      meta: {
        content,
        finishReason,
        tokensUsed: {
          input: inputTokens,
          output: outputTokens,
          // 流式响应也仅在供应商提供明细时返回，保持所有 OpenAI 兼容 provider 的旧契约。
          ...(hasCacheHitTokens ? { cacheHit: cacheHitTokens } : {}),
          ...(hasCacheMissTokens ? { cacheMiss: cacheMissTokens } : {}),
        },
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const seconds = Math.round(
        (timeoutState.kind === 'idle' ? STREAM_IDLE_TIMEOUT_MS : STREAM_TOTAL_TIMEOUT_MS) / 1000,
      );
      throw new Error(
        timeoutState.kind === 'idle'
          ? `DeepSeek 流式响应连续 ${seconds}s 无数据，已中止`
          : `DeepSeek 流式请求超过 ${seconds}s，已中止`,
      );
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
  }
}
