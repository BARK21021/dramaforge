// ============================================================
// ② server/gateway/providers — MiniMax（视频，异步）
// ============================================================
//
// 移植自 app1 callMinimax。
// 协议：
//   1. POST {baseUrl}/video_generation              提交 → task_id
//   2. GET  {baseUrl}/query/video_generation?task_id=  轮询 → Success + file_id
//   3. GET  {baseUrl}/files/retrieve?file_id=          取下载链接
// 鉴权：Authorization: Bearer {apiKey}
// ============================================================

import { fetchJson, pollAsync } from '../http';
import type { GatewayPayload, GatewayResult, ProviderCredential } from '../types';
import { extractModelId } from './_shared';

export async function callMinimax(
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
): Promise<GatewayResult> {
  const modelId = extractModelId(model);
  const baseUrl = cred.baseUrl || 'https://api.minimaxi.com/v1';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.apiKey}`,
  };

  if (payload.capability === 'video_generation') {
    const input = payload.input;
    const body: Record<string, unknown> = {
      model: modelId,
      prompt: input.prompt || '',
      prompt_optimizer: true,
    };
    if (input.imageUrl) body.first_frame_image = input.imageUrl;
    if (input.duration) body.duration = input.duration;

    const submitData = await fetchJson(`${baseUrl}/video_generation`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const baseResp = (submitData.base_resp as { status_code?: number; status_msg?: string }) ?? {};
    if (baseResp.status_code !== 0) {
      throw new Error(`MiniMax 提交失败: ${baseResp.status_msg || '未知错误'}`);
    }
    const taskId = submitData.task_id as string | undefined;
    if (!taskId) throw new Error('MiniMax 未返回 task_id');

    const downloadUrl = await pollAsync<string>(
      async (signal) => {
        const data = await fetchJson(
          `${baseUrl}/query/video_generation?task_id=${taskId}`,
          { headers, signal },
        );
        const status = data.status as string;
        if (status === 'Success') {
          const fileId = data.file_id as string | undefined;
          if (!fileId) {
            return { completed: true, failed: true, error: 'MiniMax 未返回 file_id' };
          }
          const fileData = await fetchJson(
            `${baseUrl}/files/retrieve?file_id=${fileId}`,
            { headers, signal },
          );
          const file = (fileData.file as { download_url?: string } | undefined) ?? {};
          return { completed: true, failed: false, result: file.download_url ?? '' };
        }
        if (status === 'Failed') {
          const resp = (data.base_resp as { status_msg?: string }) ?? {};
          return { completed: true, failed: true, error: resp.status_msg || 'MiniMax 视频生成失败' };
        }
        return { completed: false, failed: false };
      },
      { label: 'MiniMax', timeoutMs: 300_000 },
    );

    return { url: downloadUrl, meta: { duration: input.duration ?? 0, taskId } };
  }

  throw new Error(`MiniMax 不支持的能力: ${payload.capability}`);
}
