// ============================================================
// ② server/gateway/providers — OpenAI（文本 + 图像）
// ============================================================
//
// 移植自 app1 src/core/gateway/providers.ts callOpenAI。
// 端点：
//   - 文本：POST {baseUrl}/chat/completions  Bearer
//   - 图像：POST {baseUrl}/images/generations Bearer
// ============================================================

import { fetchJson } from '../http';
import type { GatewayPayload, GatewayResult, ProviderCredential } from '../types';
import { callOpenAICompatibleTextGen, extractModelId } from './_shared';

export async function callOpenAI(
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
): Promise<GatewayResult> {
  const modelId = extractModelId(model);
  const baseUrl = cred.baseUrl || 'https://api.openai.com/v1';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.apiKey}`,
  };

  if (payload.capability === 'text_generation') {
    return callOpenAICompatibleTextGen(
      modelId,
      { ...cred, baseUrl },
      headers,
      payload.input,
    );
  }

  if (payload.capability === 'image_generation') {
    const input = payload.input;
    const width = (input.width as number | undefined) ?? 1024;
    const height = (input.height as number | undefined) ?? 1024;
    const size = input.width && input.height ? `${width}x${height}` : '1024x1024';
    const body: Record<string, unknown> = {
      model: modelId,
      prompt: input.prompt,
      n: input.count ?? 1,
      size,
    };

    const data = await fetchJson(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const items = (data.data as Array<{ url?: string }>) ?? [];
    const images = items.map((item) => ({ url: item.url ?? '', width, height }));
    return { url: images[0]?.url ?? '', meta: { images } };
  }

  throw new Error(`OpenAI 不支持的能力: ${payload.capability}`);
}
