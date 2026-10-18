// ============================================================
// ② server/gateway/providers — Google Gemini / Veo（文本 + 图像 + 视频）
// ============================================================
//
// 移植自 app1 src/core/gateway/providers.ts callGoogle。
// 鉴权：URL query ?key={apiKey}（非 Authorization 头）
// 端点：
//   - 文本：POST {baseUrl}/models/{model}:generateContent?key=
//   - 图像：POST {baseUrl}/models/{model}:predict?key=
//   - 视频：POST {baseUrl}/models/{model}:predictLongRunning?key=  → 轮询 GET {baseUrl}/{operation}?key=
// ============================================================

import { fetchJson, pollAsync } from '../http';
import type { GatewayPayload, GatewayResult, ProviderCredential } from '../types';
import { extractModelId } from './_shared';

export async function callGoogle(
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
): Promise<GatewayResult> {
  const modelId = extractModelId(model);
  const baseUrl = cred.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const apiKey = cred.apiKey;

  if (payload.capability === 'text_generation') {
    const input = payload.input;
    const messages = (input.messages as Array<{ role?: string; content?: string }> | undefined) ?? [
      { role: 'user', content: JSON.stringify(input) },
    ];
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content ?? '' }],
      }));
    const body: Record<string, unknown> = {
      contents,
      ...(systemParts.length > 0
        ? { systemInstruction: { parts: [{ text: systemParts.join('\n') }] } }
        : {}),
    };
    if (input.maxTokens) {
      body.generationConfig = { maxOutputTokens: input.maxTokens };
    }

    const data = await fetchJson(
      `${baseUrl}/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      180_000,
    );

    const candidates = (data.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }>) ?? [];
    const content = candidates[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const usageMeta = (data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number }) ?? {};
    return {
      url: '',
      meta: {
        content,
        tokensUsed: {
          input: usageMeta.promptTokenCount ?? 0,
          output: usageMeta.candidatesTokenCount ?? 0,
        },
      },
    };
  }

  if (payload.capability === 'image_generation') {
    const input = payload.input;
    const data = await fetchJson(
      `${baseUrl}/models/${modelId}:predict?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: input.prompt }],
          parameters: { sampleCount: input.count ?? 1 },
        }),
      },
    );
    const predictions = (data.predictions as Array<{ bytesBase64Encoded?: string }>) ?? [];
    const images = predictions.map((pred) => ({
      url: `data:image/png;base64,${pred.bytesBase64Encoded ?? ''}`,
      width: (input.width as number | undefined) ?? 1024,
      height: (input.height as number | undefined) ?? 1024,
    }));
    return { url: images[0]?.url ?? '', meta: { images } };
  }

  if (payload.capability === 'video_generation') {
    const input = payload.input;
    const submitData = await fetchJson(
      `${baseUrl}/models/${modelId}:predictLongRunning?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [
            {
              prompt: input.prompt,
              ...(input.imageUrl ? { image: { bytesBase64Encoded: input.imageUrl } } : {}),
            },
          ],
          parameters: { durationSeconds: input.duration ?? 5 },
        }),
      },
    );
    const operationName = submitData.name as string | undefined;
    if (!operationName) throw new Error('Google Veo 未返回 operation name');

    const result = await pollAsync<string>(
      async (signal) => {
        const data = await fetchJson(`${baseUrl}/${operationName}?key=${apiKey}`, {
          headers: { 'Content-Type': 'application/json' },
          signal,
        });
        if (data.done) {
          const errObj = data.error as { message?: string } | undefined;
          if (errObj) {
            return { completed: true, failed: true, error: errObj.message || 'Veo 生成失败' };
          }
          const response = (data.response as
            | { generatedSamples?: Array<{ video?: { uri?: string } }>; videos?: Array<{ uri?: string }> }
            | undefined) ?? undefined;
          const videoUri =
            response?.generatedSamples?.[0]?.video?.uri
            || response?.videos?.[0]?.uri
            || '';
          return { completed: true, failed: false, result: videoUri };
        }
        return { completed: false, failed: false };
      },
      { label: 'Google Veo', timeoutMs: 300_000 },
    );

    const videoUrl = result.includes('?') ? result : `${result}&key=${apiKey}`;
    return { url: videoUrl, meta: { duration: input.duration ?? 0, operation: operationName } };
  }

  throw new Error(`Google 不支持的能力: ${payload.capability}`);
}
