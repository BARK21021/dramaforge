// ============================================================
// ② server/gateway/providers — DeepSeek（文本，OpenAI 兼容）
// ============================================================
// 移植自 app1 callDeepSeek。POST {baseUrl}/chat/completions  Bearer
// ============================================================

import type { GatewayPayload, GatewayResult, ProviderCredential } from '../types';
import { callOpenAICompatibleTextGenStream, extractModelId } from './_shared';

export async function callDeepSeek(
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
): Promise<GatewayResult> {
  const modelId = extractModelId(model);
  const baseUrl = cred.baseUrl || 'https://api.deepseek.com/v1';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.apiKey}`,
  };

  if (payload.capability === 'text_generation') {
    // DeepSeek 长 JSON 经常超过非流式客户端的 180 秒上限；持续消费 SSE token，
    // 同时保留最终完整文本和 usage，供现有资产解析与计费逻辑无缝使用。
    // thinking 默认开启（DeepSeek-V3.1+ 链式推理，reasoning_content 自动丢弃）。
    // ⚠ 推理 token 计入 max_tokens 总额——长 JSON（资产提取/整剧重写）可能因推理
    //   占用而被截断，必要时需上游调大 maxTokens 或传 thinkingBudget。
    // 上游可在 payload.input.thinking 传 'disabled' 关闭推理——用于近似确定的轻量
    // 调用（镜头组审核重写 rewriteGroupPromptForModeration、变体去重），否则这些调用
    // 串行累计会拖慢链路（曾导致 chain-generate 同步重写循环超过网关 504）。
    const inputOpts = payload.input as {
      thinking?: 'enabled' | 'disabled';
      thinkingBudget?: number;
      maxTokens?: number;
      contextWindow?: number;
    };
    const thinking = inputOpts.thinking ?? 'enabled';
    // 默认拉满：1M 上下文 + 384K 最大输出（DeepSeek V4 上限）。
    // 仅在调用方未显式指定时兜底；显式传值（如 costume-dedup 的 8192）优先生效。
    const inputWithDefaults = {
      ...payload.input,
      maxTokens:
        Number.isFinite(Number(inputOpts.maxTokens)) && Number(inputOpts.maxTokens) > 0
          ? inputOpts.maxTokens
          : 393216,
      contextWindow:
        Number.isFinite(Number(inputOpts.contextWindow)) && Number(inputOpts.contextWindow) > 0
          ? inputOpts.contextWindow
          : 1_048_576,
    };
    return callOpenAICompatibleTextGenStream(modelId, { ...cred, baseUrl }, headers, inputWithDefaults, {
      thinking,
      ...(typeof inputOpts.thinkingBudget === 'number' && inputOpts.thinkingBudget > 0
        ? { thinkingBudget: inputOpts.thinkingBudget }
        : {}),
    });
  }

  throw new Error(`DeepSeek 不支持的能力: ${payload.capability}`);
}
