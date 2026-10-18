// ============================================================
// ② server/gateway/providers — Grok / xAI（视频，Grok Imagine Video）
// ============================================================
//
// 移植自 app1 callGrok。
// 协议：
//   1. POST {baseUrl}/videos/generations  提交 → request_id
//   2. GET  {baseUrl}/videos/{request_id} 轮询 → done + video.url
// 鉴权：Authorization: Bearer {apiKey}
// prompt 截断到 1500 字符（xAI token 上限 4096，中文 ~2-3 token/字）
// ============================================================

import { fetchJson, pollAsync } from '../http';
import type { GatewayPayload, GatewayResult, ProviderCredential } from '../types';
import { ensureAccessibleUrl, extractModelId } from './_shared';

const GROK_MAX_PROMPT = 1500;

export async function callGrok(
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
): Promise<GatewayResult> {
  const modelId = extractModelId(model);
  const baseUrl = cred.baseUrl || 'https://api.x.ai/v1';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.apiKey}`,
  };

  if (payload.capability !== 'video_generation') {
    throw new Error(`Grok 不支持的能力: ${payload.capability}`);
  }

  const input = payload.input;
  const rawPrompt = (input.prompt as string | undefined) || 'Cinematic video, high quality';
  if (!rawPrompt.trim()) throw new Error('Grok 视频生成需要 prompt');
  const prompt =
    rawPrompt.length > GROK_MAX_PROMPT ? rawPrompt.slice(0, GROK_MAX_PROMPT) : rawPrompt;

  const mapResolution = (r?: string): string => {
    if (!r) return '720p';
    if (r.toLowerCase() === '480p') return '480p';
    return '720p';
  };

  const aspectRatio = (input.aspectRatio as string | undefined) || '9:16';
  const duration = Math.min(Math.max((input.duration as number | undefined) ?? 5, 1), 15);

  const body: Record<string, unknown> = {
    model: modelId,
    prompt,
    resolution: mapResolution(input.resolution as string | undefined),
    aspect_ratio: aspectRatio,
    duration,
  };
  if (input.seed !== undefined) body.seed = input.seed;

  let imageUrl = input.imageUrl as string | undefined;
  if (!imageUrl) {
    const charRefs = (input.characterReferenceImageUrls as string[] | undefined) ?? [];
    const sceneRefs = (input.referenceImageUrls as string[] | undefined) ?? [];
    const allRefs = [...charRefs, ...sceneRefs];
    if (allRefs.length > 0) imageUrl = allRefs[0];
  }
  if (imageUrl) {
    body.image_url = ensureAccessibleUrl(imageUrl);
  }

  const submitData = await fetchJson(
    `${baseUrl}/videos/generations`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    30_000,
  );
  const requestId = (submitData.request_id as string | undefined) || (submitData.id as string | undefined);
  if (!requestId) {
    throw new Error('Grok 未返回 request_id');
  }

  // 注意：xAI 查询 URL 是 /v1/videos/{request_id}（不带 /generations）
  const pollUrl = `${baseUrl}/videos/${requestId}`;

  const videoUrl = await pollAsync<string>(
    async (signal) => {
      const data = await fetchJson(pollUrl, { headers, signal }, 20_000);
      const status = ((data.status as string | undefined) ?? '').toLowerCase();
      if (status === 'done' || status === 'completed' || status === 'succeeded' || status === 'success') {
        const video = (data.video as { url?: string } | undefined) ?? {};
        const output = (data.output as { video?: { url?: string }; url?: string } | undefined) ?? {};
        const url =
          video.url
          || output.video?.url
          || output.url
          || (data.video_url as string | undefined)
          || (data.url as string | undefined)
          || '';
        if (!url) {
          return { completed: true, failed: true, error: 'Grok 成功但未返回视频 URL' };
        }
        return { completed: true, failed: false, result: url };
      }
      if (status === 'failed' || status === 'error' || status === 'cancelled') {
        const errObj = (data.error as { message?: string; code?: string } | undefined) ?? {};
        const outputErr = (data.output as { error?: { message?: string } } | undefined) ?? {};
        const errMsg =
          errObj.message || errObj.code || outputErr.error?.message
          || (data.message as string | undefined) || 'Grok 视频生成失败';
        return { completed: true, failed: true, error: `Grok Imagine Video 生成失败: ${errMsg}` };
      }
      return { completed: false, failed: false };
    },
    { label: 'Grok Imagine Video (xAI)', timeoutMs: 600_000 },
  );

  const actualDuration = ((submitData.video as { duration?: number } | undefined)?.duration) ?? duration;
  return { url: videoUrl, meta: { duration: actualDuration, requestId } };
}
