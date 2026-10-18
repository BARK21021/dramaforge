// ============================================================
// ② server/gateway/providers — ARK / 火山引擎（文本 + 图像 + 视频 + TTS）
// ============================================================
//
// 移植自 app1 src/core/gateway/providers.ts callArk。
// 同时服务 ark（北京端点）与 ark_intl（海外端点），
// 由 cred.baseUrl 区分（credentials.ts 已按 provider 给出默认 baseUrl）。
//
// 端点：
//   - 文本：POST {baseUrl}/chat/completions                  Bearer
//   - 图像：POST {baseUrl}/images/generations                Bearer
//   - 视频：POST {baseUrl}/contents/generations/tasks        Bearer
//           GET  {baseUrl}/contents/generations/tasks/{id}   轮询
//   - TTS： POST {baseUrl}/audio/speech                      Bearer
//
// 视频生成的网格叠加 / 本地图转 base64 等预处理在重构后由 worker 层处理
// （资产走 MinIO presigned URL，远程 API 可直达），此处仅保留请求构造与轮询。
// ============================================================

import { fetchJson, GatewayHttpError, pollAsync } from '../http';
import type { GatewayPayload, GatewayResult, ProviderCredential } from '../types';
import { callOpenAICompatibleTextGen, ensureAccessibleUrl, extractModelId } from './_shared';

export async function callArk(
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
  ctx?: { signal?: AbortSignal },
): Promise<GatewayResult> {
  const modelId = extractModelId(model);
  const baseUrl = cred.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.apiKey}`,
  };

  if (payload.capability === 'text_generation') {
    return callOpenAICompatibleTextGen(modelId, { ...cred, baseUrl }, headers, payload.input);
  }

  if (payload.capability === 'image_generation') {
    const input = payload.input;
    // ARK Seedream 最小像素约束，低于则对齐到标准比例
    const ARK_MIN_PIXELS = 3686400;
    let width = (input.width as number | undefined) ?? 1024;
    let height = (input.height as number | undefined) ?? 1024;
    if (width * height < ARK_MIN_PIXELS) {
      const ratio = width / height;
      if (ratio > 2.2) { width = 2560; height = 1080; }
      else if (ratio > 1.7) { width = 2560; height = 1440; }
      else if (ratio < 0.45) { width = 1080; height = 2560; }
      else if (ratio < 0.6) { width = 1440; height = 2560; }
      else if (ratio > 1.3) { width = 2352; height = 1568; }
      else if (ratio > 0.7) { width = 1920; height = 1920; }
      else { width = 1568; height = 2352; }
    }
    const size = `${width}x${height}`;
    const prompt = [
      typeof input.prompt === 'string' ? input.prompt : '',
      typeof input.negativePrompt === 'string' && input.negativePrompt.trim()
        ? `Negative constraints: ${input.negativePrompt.trim()}`
        : '',
    ].filter(Boolean).join('\n');
    const arkBody: Record<string, unknown> = {
      model: modelId,
      prompt,
      size,
      response_format: 'url',
      watermark: false,
    };
    if (input.referenceImageUrl) {
      // ARK Seedream 官方参数名为 image（支持 URL 或 data URL）
      arkBody.image = ensureAccessibleUrl(String(input.referenceImageUrl));
    }

    const data = await fetchJson(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(arkBody),
    });
    const items = (data.data as Array<{ url?: string }>) ?? [];
    const images = items.map((item) => ({ url: item.url ?? '', width, height }));
    return { url: images[0]?.url ?? '', meta: { images } };
  }

  if (payload.capability === 'video_generation') {
    const input = payload.input;

    // Seedance 2.0 全能参考模式：合并人物 + 场景参考图
    const charRefs = (input.characterReferenceImageUrls as string[] | undefined) ?? [];
    const sceneRefs = (input.referenceImageUrls as string[] | undefined) ?? [];
    const imageUrls = (input.imageUrl ? [input.imageUrl as string] : []);
    const lastFrameUrls = (input.lastFrameImageUrl ? [input.lastFrameImageUrl as string] : []);
    const chainedFrameUrls = typeof input.referenceImageBase64 === 'string' && input.referenceImageBase64
      ? [`data:image/png;base64,${input.referenceImageBase64}`]
      : [];

    if (charRefs.length > 0 && input.characterReferencesGridApplied !== true) {
      throw new Error('人物参考图必须先叠加 app1 稀疏网格，已阻止未处理的真人图提交 Seedance');
    }

    // 对齐 app1 providers.ts：人物优先、场景/道具其次、首末帧最后，最终防御性截断到 9 张。
    // 正常路径由分组器预先拆组；单镜脏数据仍不会把超限请求送给 ARK。
    const allReferenceImageUrls = [
      ...charRefs,
      ...sceneRefs,
      ...imageUrls,
      ...lastFrameUrls,
      ...chainedFrameUrls,
    ].slice(0, 9);

    const content: Array<Record<string, unknown>> = [];
    // 2026-08-12 实测：ARK 把「高潮组」判为涉黄敏感词组（InputTextSensitiveContentDetected，
    // 二分验证：'# 高潮组'+皮肤主句 400 / '# 剧情高潮段落' 200）。已保存的旧提示词快照
    // 可能仍含该词——提交层统一替换兜底（与 GROUP_LABELS 源头改名双保险）。
    const prompt = String(input.prompt ?? '').replaceAll('高潮组', '高潮段落');
    if (prompt) {
      content.push({ type: 'text', text: prompt });
    }
    // Seedance 2.0 参考视频（video-to-video 转绘）：content 里 video_url + role
    // reference_video。上限 3 条（ARK 文档），每条 2-15s（上游切割器已封顶）。
    // ⚠ 顺序铁律（真实验证 2026-08-02）：**reference_video 必须在 reference_image
    // 之前**——放在图片/音频之后 ARK 返 400 "Invalid video_url"（mini r2v 实测）。
    // 与 first_frame/last_frame role 互斥；reference_image（末帧）可共存。
    const refVideoUrls = (input.referenceVideoUrls as string[] | undefined) ?? [];
    if (refVideoUrls.length > 3) {
      throw new Error('参考视频最多 3 个');
    }
    for (const url of refVideoUrls) {
      content.push({
        type: 'video_url',
        video_url: { url: ensureAccessibleUrl(url) },
        role: 'reference_video',
      });
    }
    for (const url of allReferenceImageUrls) {
      content.push({
        type: 'image_url',
        image_url: { url: ensureAccessibleUrl(url) },
        role: 'reference_image',
      });
    }
    const audioRefs = (input.referenceAudioUrls as string[] | undefined) ?? [];
    for (const url of audioRefs.slice(0, 3)) {
      content.push({
        type: 'audio_url',
        audio_url: { url: ensureAccessibleUrl(url) },
        role: 'reference_audio',
      });
    }

    const taskBody: Record<string, unknown> = { model: modelId, content };
    if (input.duration !== undefined) taskBody.duration = input.duration;
    if (input.aspectRatio !== undefined) taskBody.ratio = input.aspectRatio;
    if (input.generateAudio !== undefined) taskBody.generate_audio = input.generateAudio;
    if (input.seed !== undefined) taskBody.seed = input.seed;
    if (input.resolution !== undefined) taskBody.resolution = input.resolution;
    if (input.watermark !== undefined) taskBody.watermark = input.watermark;
    if (input.returnLastFrame !== undefined) taskBody.return_last_frame = input.returnLastFrame;

    const taskData = await fetchJson(`${baseUrl}/contents/generations/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify(taskBody),
    });
    const taskId = taskData.id as string | undefined;
    if (!taskId) throw new Error('ARK 未返回 task id');

    const videoUrl = await pollAsync<string>(
      async (signal) => {
        const data = await fetchJson(
          `${baseUrl}/contents/generations/tasks/${taskId}`,
          { headers, signal },
        );
        const status = data.status as string;
        if (status === 'succeeded') {
          const url = (data.content as { video_url?: string } | undefined)?.video_url
            || (data.content as Array<{ video_url?: string }> | undefined)?.[0]?.video_url
            || '';
          return { completed: true, failed: false, result: url };
        }
        if (status === 'failed') {
          // ARK 返回 HTTP 200 但 task 业务失败（内容审核拒绝 InputText /
          // ImageSensitiveContentDetected、参数错误等）。这是客户端输入问题——
          // 换 key 同样判审核/同样参数错，绝不能归为 server_error 烧 key（P0-C 根因）。
          // 直接抛 GatewayHttpError(400) 透过 pollAsync 上抛 → classifyKeyError 命中
          // 4xx client_error 分支 → recordFailure 只记 lastErrorMessage，不累加
          // consecutiveFailures、不进 cooldown。对齐 app1 providers.ts 的 errorCategory:'api'
          // 语义（app1 BYOK 无 key 池故无此烧 key 问题）。
          // 注意：真正的 5xx 由上面 fetchJson 抛 GatewayHttpError(5xx) 仍是 server_error；
          // pollAsync 总超时仍抛带「超时」字样的 plain Error → classifyKeyError 命中 timeout。
          const errObj = data.error as { message?: string; code?: string } | undefined;
          throw new GatewayHttpError(
            400,
            `Seedance 生成失败: ${errObj?.message || errObj?.code || 'ARK 视频生成失败'}`,
          );
        }
        return { completed: false, failed: false };
      },
      { label: 'Seedance (ARK)', timeoutMs: 1_200_000 },
      ctx?.signal,
    );

    return { url: videoUrl, meta: { duration: input.duration ?? 0, taskId } };
  }

  if (payload.capability === 'tts') {
    const input = payload.input;
    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        input: input.text,
        voice: input.voiceId || 'default',
        speed: input.speed ?? 1.0,
      }),
      signal: ctx?.signal
        ? AbortSignal.any([AbortSignal.timeout(120_000), ctx.signal])
        : AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 抛带 status 的 GatewayHttpError：4xx→client_error（用户输入问题，不烧 key），
      // 5xx→server_error（真服务器问题，烧 key 合理）。旧实现 throw plain Error 把 status 塞进
      // 字符串 → classifyKeyError 读不到 err.status → 落 server_error → TTS 4xx 误烧 key
      // （与 Seedance status=failed 同一反模式，P0-C agent 发现的连带 bug）。
      throw new GatewayHttpError(res.status, `ARK TTS 失败: ${res.status} ${text.slice(0, 200)}`);
    }
    const audioBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(audioBuffer).toString('base64');
    return { url: `data:audio/mpeg;base64,${base64}`, meta: { duration: 0 } };
  }

  throw new Error(`ARK 不支持的能力: ${payload.capability}`);
}
