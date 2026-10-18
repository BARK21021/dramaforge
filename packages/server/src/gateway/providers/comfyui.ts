// ============================================================
// ② server/gateway/providers — ComfyUI（z_image_turbo + IPAdapter 图像）
// ============================================================
//
// 移植自 app1 callComfyUI。
// 协议：
//   1. （可选）POST {baseUrl}/upload/image          上传参考图到 input 目录
//   2. POST {baseUrl}/prompt                         提交工作流 → prompt_id
//   3. GET  {baseUrl}/history/{prompt_id}            轮询直到 completed
//   4. GET  {baseUrl}/view?filename=...              下载产物为 base64 data URL
// 鉴权：COMFYUI_MODE=local 免鉴权；api 模式 Bearer（cred.apiKey）
// ============================================================

import { fetchJson, pollAsync } from '../http';
import type { GatewayPayload, GatewayResult, ProviderCredential } from '../types';
import { extractModelId } from './_shared';

interface ZImageWorkflowParams {
  positive: string;
  negative: string;
  width: number;
  height: number;
  refImageName?: string;
  seed: number;
}

/** 构建 z_image_turbo + IPAdapter API 格式工作流（移植自 app1 buildZImageWorkflow） */
function buildZImageWorkflow(p: ZImageWorkflowParams): Record<string, unknown> {
  const useRef = !!p.refImageName;
  const workflow: Record<string, unknown> = {
    '21': { class_type: 'UNETLoader', inputs: { unet_name: 'z-imge\\z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    '19': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen\\qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
    '20': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '16': { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'clip_vision_h.safetensors' } },
    '15': { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: 'ip-adapter-plus_sdxl_vit-h.safetensors' } },
    '22': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['21', 0], shift: 3 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['19', 0], text: p.positive } },
    '7': { class_type: 'CLIPTextEncode', inputs: { clip: ['19', 0], text: p.negative } },
    '23': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['20', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'comfyui_zimage' } },
  };

  if (useRef) {
    workflow['12'] = { class_type: 'LoadImage', inputs: { image: p.refImageName } };
    workflow['17'] = {
      class_type: 'PrepImageForClipVision',
      inputs: { image: ['12', 0], interpolation: 'LANCZOS', crop_position: 'top', sharpening: 0.5 },
    };
    workflow['14'] = {
      class_type: 'IPAdapterAdvanced',
      inputs: {
        model: ['22', 0], ipadapter: ['15', 0], image: ['17', 0], clip_vision: ['16', 0],
        weight: 0.55, weight_type: 'style transfer', combine_embeds: 'concat',
        start_at: 0, end_at: 1, embeds_scaling: 'V only',
      },
    };
    workflow['3'] = {
      class_type: 'KSampler',
      inputs: {
        model: ['14', 0], positive: ['6', 0], negative: ['23', 0], latent_image: ['5', 0],
        seed: p.seed, steps: 6, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
      },
    };
  } else {
    workflow['3'] = {
      class_type: 'KSampler',
      inputs: {
        model: ['22', 0], positive: ['6', 0], negative: ['23', 0], latent_image: ['5', 0],
        seed: p.seed, steps: 6, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
      },
    };
  }
  return workflow;
}

export async function callComfyUI(
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
): Promise<GatewayResult> {
  // model 参数保留以备未来按模型选择工作流；当前固定 z_image_turbo
  void extractModelId(model);
  const baseUrl = cred.baseUrl || 'http://127.0.0.1:8188';
  const mode = process.env.COMFYUI_MODE || 'local';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (mode === 'api' && cred.apiKey) {
    headers['Authorization'] = `Bearer ${cred.apiKey}`;
  }

  if (payload.capability !== 'image_generation') {
    throw new Error(`ComfyUI 暂不支持的能力: ${payload.capability}（当前仅 image_generation）`);
  }

  const input = payload.input;
  const width = (input.width as number | undefined) ?? 1280;
  const height = (input.height as number | undefined) ?? 720;

  // 1. 若提供参考图：下载 → 上传到 ComfyUI input 目录
  let refImageName: string | undefined;
  if (input.referenceImageUrl) {
    let refUrl = String(input.referenceImageUrl);
    if (refUrl.startsWith('/')) {
      const appBase = (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
      refUrl = appBase + refUrl;
    }
    const refRes = await fetch(refUrl, { signal: AbortSignal.timeout(60_000) });
    if (!refRes.ok) {
      throw new Error(`ComfyUI 下载参考图失败: HTTP ${refRes.status} (${refUrl})`);
    }
    const imgBytes = await refRes.arrayBuffer();
    const refFilename = `ref_${Date.now()}.png`;
    refImageName = await uploadToComfyUI(baseUrl, headers, imgBytes, refFilename);
  }

  // 2. 构建工作流
  const workflow = buildZImageWorkflow({
    positive: (input.prompt as string | undefined) ?? '',
    negative: (input.negativePrompt as string | undefined) || 'blurry, noisy, messy, lowres, jpeg artifacts, distorted, malformed',
    width,
    height,
    refImageName,
    seed: (input.seed as number | undefined) ?? Math.floor(Math.random() * 1e15),
  });

  // 3. POST /prompt 提交
  const submitData = await fetchJson(`${baseUrl}/prompt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: workflow }),
  });
  const promptId = submitData.prompt_id as string | undefined;
  if (!promptId) {
    throw new Error(`ComfyUI 未返回 prompt_id`);
  }

  // 4. 轮询 GET /history/{prompt_id}
  const historyUrl = `${baseUrl}/history/${encodeURIComponent(promptId)}`;
  const entry = await pollAsync<Record<string, unknown>>(
    async (signal) => {
      let h: Record<string, unknown>;
      try {
        const res = await fetch(historyUrl, { headers, signal });
        if (!res.ok) {
          return { completed: false, failed: false };
        }
        h = (await res.json()) as Record<string, unknown>;
      } catch {
        return { completed: false, failed: false };
      }
      if (!(promptId in h)) {
        return { completed: false, failed: false };
      }
      const e = h[promptId] as { status?: { status_str?: string; messages?: unknown[]; completed?: boolean }; outputs?: unknown };
      const st = e.status || {};
      if (st.status_str === 'error') {
        return { completed: true, failed: true, error: `ComfyUI 执行失败: ${JSON.stringify(st.messages || []).slice(0, 500)}` };
      }
      if (st.completed || e.outputs) {
        return { completed: true, failed: false, result: e };
      }
      return { completed: false, failed: false };
    },
    { label: 'ComfyUI', timeoutMs: 600_000, intervalMs: 2_000, maxIntervalMs: 5_000 },
  );

  // 5. 解析产物，GET /view 下载为 base64 data URL
  const images: Array<{ url: string; width: number; height: number }> = [];
  const outputs = (entry.outputs as Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }>) ?? {};
  for (const nodeOut of Object.values(outputs)) {
    for (const img of nodeOut.images ?? []) {
      const viewUrl =
        `${baseUrl}/view?filename=${encodeURIComponent(img.filename ?? '')}`
        + `&subfolder=${encodeURIComponent(img.subfolder || '')}`
        + `&type=${img.type || 'output'}`;
      const viewRes = await fetch(viewUrl, { headers, signal: AbortSignal.timeout(60_000) });
      if (!viewRes.ok) continue;
      const buf = await viewRes.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      images.push({ url: `data:image/png;base64,${b64}`, width, height });
    }
  }
  if (images.length === 0) {
    throw new Error('ComfyUI 未返回任何图片产物（检查工作流是否包含 SaveImage 节点）');
  }
  return { url: images[0].url, meta: { images } };
}

/** 上传图片字节到 ComfyUI input 目录，返回注册文件名 */
async function uploadToComfyUI(
  baseUrl: string,
  headers: Record<string, string>,
  imgBytes: ArrayBuffer,
  filename: string,
): Promise<string> {
  const boundary = `----comfyui_boundary_${Date.now()}`;
  const pre = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`
    + `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const post = Buffer.from(
    `\r\n--${boundary}\r\n`
    + `Content-Disposition: form-data; name="overwrite"\r\n\r\n`
    + `true\r\n`
    + `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="type"\r\n\r\n`
    + `input\r\n`
    + `--${boundary}--\r\n`,
  );
  const body = Buffer.concat([pre, Buffer.from(imgBytes), post]);
  const res = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`ComfyUI 上传图片失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { name?: string };
  return data.name || filename;
}
