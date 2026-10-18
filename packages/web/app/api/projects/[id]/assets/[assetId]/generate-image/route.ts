// ============================================================
// POST /api/projects/[id]/assets/[assetId]/generate-image — 资产生图（P7.3）
// ============================================================
//
// 对齐 app1：请求只负责构造提示词、创建图片版本并投递 ASSET_IMAGE_GENERATE；
// worker 分阶段执行、持久化图片并回写资产，前端通过 SSE + /api/tasks 恢复生命周期。
//
// 支持 regenLocked、造型 costumeKey、客户端本地参考图 i2i、项目锁定画风、增强词、
// 版本并发保护和真实计费。含人脸道具的角色参考图由客户端读取后传入，服务器不读取
// sf-asset://，从而保持媒体只落客户端。
//
// 鉴权：session REQUIRED。响应（UI-facing envelope）：
//   201 { success:true, data: { taskId, status, revisionId } }
//   400 BAD_MODEL / 402 INSUFFICIENT_BALANCE（余额≤0）/ 423 ASSET_LOCKED（regenLocked）/
//   401 / 404 / 502 AI_GATEWAY_ERROR|AI_NO_IMAGE
//
// web 禁止 import ffmpeg。零 ffmpeg 依赖。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  updateAssetCostumesPreservingImages,
  getAsset,
  projectRepo,
  buildAssetImagePrompt,
  getResolutionByKey,
  beginAssetImageRevision,
  markAssetImageRevisionGenerated,
  markAssetImageRevisionFailed,
  enqueueAiTask,
  callAI,
  readLocalizationProfile,
  assetImageLanguageFromCategory,
  sanitizePromptForModeration,
  assignCostumeCodes,
} from '@dramaforge/server';
import { getProjectArtStylePreset } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { registerMediaRelay, releaseMediaRelay } from '@web/lib/media-relay';

/** 默认出图模型（对齐 app1：ARK Doubao Seedream）。 */
const DEFAULT_MODEL = 'ark/doubao-seedream-5-0-260128';

/** 用户需求：负面提示词只保留水印/logo，其余全部移除。 */
const DEFAULT_NEGATIVE_PROMPT = '水印, logo';

/** 参考图原始字节上限；数据通过背压流接力，不进入 JSON、PG、Redis 或磁盘。 */
const MAX_REFERENCE_STREAM_BYTES = 9 * 1024 * 1024;
/** 兼容旧 Electron 的最后回退；编码后 6MiB，且只允许同步直调，绝不进入队列。 */
const MAX_BASE64_FALLBACK_LENGTH = 6 * 1024 * 1024;

/** 归一化网关图片结果，兼容 meta.images 的对象/字符串形态。 */
function extractProviderImages(result: { url: string; meta?: Record<string, unknown> }): string[] {
  const raw = Array.isArray(result.meta?.images) ? result.meta.images : [];
  const images = raw.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') {
      return String((item as { url: string }).url);
    }
    return '';
  }).filter(Boolean);
  if (images.length === 0 && result.url) images.push(result.url);
  return images;
}

/** Resolve the provider-visible web origin when Next runs behind nginx. */
function resolvePublicOrigin(req: NextRequest): string {
  const configured = process.env.NEXTAUTH_URL?.replace(/\/+$/, '');
  if (configured && /^https?:\/\//i.test(configured)) return configured;
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const protocol = req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '');
  return host ? `${protocol}://${host}` : req.nextUrl.origin;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, assetId } = await params;

    // 1. ownership：项目归属 + 资产属于项目（统一 404）
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const asset = await getAsset(assetId);
    if (!asset || asset.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 2. regenLocked 锁（对齐 app1，已锁定禁止重生成）
    if (asset.regenLocked) {
      return apiFail(
        { error: '该资产已锁定（regenLocked），禁止重新生图', code: 'ASSET_LOCKED' },
        423,
      );
    }

    // 3. 请求体：model / resolution（默认 2K，对齐 app1）/ 可选 width/height 覆盖
    //    app1: 客户端发 resolution key（1K/2K/4K/21:9），route 用 getResolutionByKey
    //    映射成 {width,height}。dramaforge 之前 IGNORES resolution → 写死 1024×1024 方图（bug）。
    let body: {
      model?: unknown;
      resolution?: unknown;
      width?: unknown;
      height?: unknown;
      referenceImageBase64?: unknown;
      referenceImageUrl?: unknown;
      allowBase64Fallback?: unknown;
      style?: unknown;
      enhancementPrompt?: unknown;
      costumeKey?: unknown;
    };
    const isReferenceStream = req.headers.get('x-sf-reference-stream') === '1';
    if (isReferenceStream) {
      // 流式参考图把轻量生成参数放查询串，正文从客户端文件直接接力给供应商。
      body = Object.fromEntries(req.nextUrl.searchParams.entries());
    } else {
      try {
        const raw = (await req.json()) as unknown;
        body = raw && typeof raw === 'object' && !Array.isArray(raw)
          ? raw as typeof body
          : {};
      } catch {
        body = {};
      }
    }
    const base64Fallback = typeof body.referenceImageBase64 === 'string'
      && body.allowBase64Fallback === true
      ? body.referenceImageBase64
      : undefined;
    if (typeof body.referenceImageBase64 === 'string' && body.referenceImageBase64 && !base64Fallback) {
      return apiFail(
        { error: 'base64 仅允许作为旧客户端的受控回退', code: 'BASE64_MEDIA_DISABLED' },
        400,
      );
    }
    if (base64Fallback && (
      base64Fallback.length > MAX_BASE64_FALLBACK_LENGTH
      || !/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\r\n]+$/i.test(base64Fallback)
    )) {
      return apiFail(
        { error: 'base64 回退图片过大或格式无效', code: 'BAD_BASE64_FALLBACK' },
        base64Fallback.length > MAX_BASE64_FALLBACK_LENGTH ? 413 : 400,
      );
    }
    const contentType = req.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    const contentLength = Number(req.headers.get('content-length') ?? 0);
    if (isReferenceStream && (!req.body || !/^image\/(?:png|jpeg|webp)$/.test(contentType))) {
      return apiFail(
        { error: '参考图片流格式无效，仅支持 PNG/JPEG/WebP', code: 'BAD_REFERENCE_IMAGE_STREAM' },
        400,
      );
    }
    if (isReferenceStream && contentLength > MAX_REFERENCE_STREAM_BYTES) {
      return apiFail(
        { error: '参考图片过大，请压缩到 9MB 以内后重试', code: 'REFERENCE_IMAGE_TOO_LARGE' },
        413,
      );
    }
    const referenceImageUrl = typeof body.referenceImageUrl === 'string'
      && /^https?:\/\//i.test(body.referenceImageUrl)
      ? body.referenceImageUrl
      : undefined;
    const isFaceProp = asset.kind === 'PROP'
      && asset.metadata?.requiresCharacterRef === true;
    const style = typeof body.style === 'string' ? body.style.trim() : '';
    const enhancementPrompt = typeof body.enhancementPrompt === 'string'
      ? body.enhancementPrompt.trim()
      : '';
    const costumeKey = typeof body.costumeKey === 'string' ? body.costumeKey.trim() : '';
    const modelId =
      typeof body.model === 'string' && body.model.length > 0 ? body.model : DEFAULT_MODEL;
    const resolutionKey =
      typeof body.resolution === 'string' && body.resolution.length > 0
        ? body.resolution
        : '2K'; // 对齐 app1 默认 2K（1920×1080，ARK 会再 snap 到 2560×1440）
    const resolved = getResolutionByKey(resolutionKey);
    // 显式 width/height 优先（逃生口，向后兼容）；否则用 resolution 映射值
    const width = typeof body.width === 'number' && body.width > 0 ? body.width : resolved.width;
    const height =
      typeof body.height === 'number' && body.height > 0 ? body.height : resolved.height;

    if (!modelId.includes('/') || modelId.startsWith('/')) {
      return apiFail(
        { error: `model 缺少 provider 前缀（应为 "provider/model-id"）: ${modelId}`, code: 'BAD_MODEL' },
        400,
      );
    }

    const costumes = Array.isArray(asset.costumes)
      ? (asset.costumes as Array<Record<string, unknown>>)
      : [];
    const requestedCostumeKey = costumeKey || 'default';
    const matchedCostume = costumes.find((costume) => costume.key === requestedCostumeKey);
    // 变体编号（code）落库：资产生成时确保每个变体带全局稳定编号（如 Leo-03），
    // 后续引用/审计/提示词标注一律按 code 对齐（不再靠名称匹配）。缺 code 的按
    // assignCostumeCodes 规则补编并回写；回写失败不阻塞生图（下次生成再补）。
    if (costumes.some((costume) => typeof costume.code !== 'string' || !costume.code.trim())) {
      try {
        const coded = assignCostumeCodes(costumes, asset.name);
        await updateAssetCostumesPreservingImages(asset.id, asset.projectId, coded);
      } catch (error) {
        console.error(`assignCostumeCodes 回写失败 (asset=${asset.id}):`, error);
      }
    }
    // 显式请求不存在的变体必须在余额预检、版本创建和供应商调用之前失败。
    // 否则一次拼写错误会被当成默认造型出图并照常扣费，最终还写错 costumeKey。
    if (costumeKey && costumeKey !== 'default' && !matchedCostume) {
      return apiFail(
        { error: `造型变体不存在：${costumeKey}`, code: 'COSTUME_NOT_FOUND' },
        400,
      );
    }
    if (isFaceProp && !isReferenceStream && !base64Fallback && !referenceImageUrl) {
      return apiFail(
        {
          error: '该道具包含角色人脸，请先生成相关角色参考图后再生成本道具',
          code: 'FACE_PROP_REFERENCE_REQUIRED',
        },
        400,
      );
    }

    // 3.5 余额预检（对齐 app1 precheckBalance）：0 积分挡在昂贵生图之前（ADMIN unlimited 放行）。
    //     非精确预检——不冻结、不预扣；实际扣费在生图成功后（billDirectGeneration），
    //     余额不足以覆盖真实成本时由该处重抛 402、不交付结果（"不够扣就不让用"）。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    // 4. 构造出图 prompt（角色身份锁、环境氛围、道具意义、造型与项目锁定画风）。
    const localizationProfile = readLocalizationProfile(project.scriptData);
    const promptLanguage = assetImageLanguageFromCategory(
      project.category,
      [
        asset.name,
        asset.description ?? '',
        matchedCostume?.label ?? '',
        matchedCostume?.description ?? '',
      ].join('\n'),
    );
    const lockedStyle = getProjectArtStylePreset(project.artStyle);
    const effectiveStyle = lockedStyle?.assetImageKey || style || undefined;
    // 变体生图：命中 costumeKey 时把该变体的服装描述/身份锁注入 prompt（对齐 app1 worker 注入）。
    // 否则 i2i 只会原样保留默认服装（服饰不变 bug）。buildAssetImagePrompt 的 extra.costume 会指导
    // 模型按变体 description 换装，同时强约束保留默认五官/身材。
    const costumeOverride = matchedCostume
      ? {
          description: String(matchedCostume.description ?? ''),
          label: String(matchedCostume.label ?? requestedCostumeKey),
          isDefault: requestedCostumeKey === 'default',
          ...(matchedCostume.variantType === 'period'
            ? { variantType: 'period' as const }
            : {}),
          ...(Array.isArray(matchedCostume.identityLock)
            ? {
                identityLock: (matchedCostume.identityLock as unknown[]).filter(
                  (v): v is string => typeof v === 'string',
                ),
              }
            : {}),
        }
      : undefined;
    const basePrompt = buildAssetImagePrompt(asset.kind, asset.name, asset.description ?? '', {
      identityLock: asset.identityLock ?? undefined,
      intExt: asset.intExt ?? undefined,
      mood: asset.mood ?? undefined,
      significance: asset.significance ?? undefined,
      baseAmbience: asset.baseAmbience ?? undefined,
      style: effectiveStyle,
      language: promptLanguage,
      overseasAdaptation: project.category === 'OVERSEAS',
      localizationProfile,
      allowHumanFigure: isFaceProp,
      ...(costumeOverride ? { costume: costumeOverride } : {}),
    });
    // UI 的风格、增强词和造型键必须进入真实模型 prompt；此前这些参数被 route 静默丢弃。
    // 项目风格锁（五维：画风/人物/光影/材质/调色）前置为最高优先级，对齐 app1
    // generate-image/route.ts:243 的 `${styleLockSection}\n\n${promptBase}` 拼法。
    const styleLock = lockedStyle
      ? (promptLanguage === 'en' ? lockedStyle.lockContentEn : lockedStyle.lockContentZh)
      : '';
    const consistencyPrompt = isFaceProp
      ? '【图生图一致性要求】参考图为相关角色形象；道具画面中出现的人脸必须保持相同五官、脸型和身份特征，只按道具描述改变载体、版式与场景。'
      : ((isReferenceStream || base64Fallback || referenceImageUrl) && asset.kind === 'CHARACTER' && costumeOverride
          ? '【图生图一致性要求】参考图为该角色基准造型；必须保持相同人脸、五官、脸型、身材和体型，仅按当前造型要求更换服装、发型、配饰或妆容。'
          : '');
    const rawPrompt = [
      styleLock,
      basePrompt,
      consistencyPrompt,
      !lockedStyle && style ? `视觉风格：${style}` : '',
      enhancementPrompt ? `用户补充要求：${enhancementPrompt}` : '',
    ].filter(Boolean).join('\n\n');
    const prompt = sanitizePromptForModeration(rawPrompt).sanitized;
    // 用户需求：除水印/logo 外不保留任何负面提示词；画风互斥词已移除（画风由正向 lockContent 约束）。
    const lockedStyleNegative = '';

    // 先记录尝试再调用供应商：页面刷新后仍能看到 GENERATING/FAILED，而不是永久转圈。
    const revision = await beginAssetImageRevision({
      assetId,
      projectId,
      modelName: modelId,
      prompt,
      costumeKey: requestedCostumeKey,
    });

    if ((isReferenceStream && req.body) || base64Fallback) {
      const token = isReferenceStream && req.body
        ? registerMediaRelay({
            stream: req.body,
            contentType,
            maxBytes: MAX_REFERENCE_STREAM_BYTES,
          })
        : null;
      try {
        // ARK 只接受可访问 URL；一次性 relay 让供应商直接读取客户端上传流，服务器不落盘。
        // 旧客户端回退时只在本次同步调用栈内短暂持有 data URL，不写入任何持久层。
        const directReferenceUrl = token
          ? new URL(`/api/media-relay/${token}`, resolvePublicOrigin(req)).toString()
          : base64Fallback!;
        const provider = modelId.slice(0, modelId.indexOf('/'));
        const result = await callAI(provider, modelId, {
          capability: 'image_generation',
          input: {
            prompt,
            negativePrompt: [DEFAULT_NEGATIVE_PROMPT, lockedStyleNegative].filter(Boolean).join(', '),
            width,
            height,
            style: effectiveStyle,
            referenceImageUrl: directReferenceUrl,
          },
          userId: auth.userId,
        });
        const images = extractProviderImages(result);
        if (images.length === 0) throw new Error('AI 模型未返回图片');
        await markAssetImageRevisionGenerated(revision.id, images[0]);
        await billDirectGeneration({
          userId: auth.userId,
          result,
          description: '资产参考图生成',
          taskType: 'ASSET_IMAGE_GENERATE_STREAM',
        });
        return apiSuccess({
          assetId,
          imageUrl: images[0],
          imageUrls: images,
          revisionId: revision.id,
          costumeKey: costumeKey || null,
          status: 'COMPLETED',
        });
      } catch (error) {
        await markAssetImageRevisionFailed(
          revision.id,
          error instanceof Error ? error.message : '参考图生成失败',
        ).catch(() => undefined);
        throw error;
      } finally {
        if (token) releaseMediaRelay(token);
      }
    }

    // 对齐 app1：写 tasks → BullMQ image 队列 → worker RUNNING/COMPLETED/FAILED
    // → SSE + /api/tasks 轮询恢复。刷新页面不会丢失生成生命周期。
    let queued;
    try {
      queued = await enqueueAiTask({
        userId: auth.userId,
        projectId,
        type: 'ASSET_IMAGE_GENERATE',
        queueName: 'image',
        // 每次生成对应独立 revision；不同资产/连续重生绝不能复用同一活跃任务。
        dedupeKey: revision.id,
        payload: {
          assetId,
          projectId,
          prompt,
          model: modelId,
          style: effectiveStyle,
          negativePrompt: [DEFAULT_NEGATIVE_PROMPT, lockedStyleNegative].filter(Boolean).join(', '),
          width,
          height,
          revisionId: revision.id,
          ...(referenceImageUrl ? { referenceImageUrl } : {}),
          ...(costumeKey ? { costumeKey } : {}),
        },
        // 持久化输入只含文本和公开 URL；本地图片字节永不进入 PG/Redis。
        storedPayload: {
          assetId,
          projectId,
          prompt,
          model: modelId,
          style: effectiveStyle,
          negativePrompt: [DEFAULT_NEGATIVE_PROMPT, lockedStyleNegative].filter(Boolean).join(', '),
          width,
          height,
          revisionId: revision.id,
          hasReferenceImage: Boolean(referenceImageUrl),
          ...(costumeKey ? { costumeKey } : {}),
        },
      });
    } catch (error) {
      await markAssetImageRevisionFailed(
        revision.id,
        error instanceof Error ? error.message : '图片生成任务提交失败',
      ).catch(() => undefined);
      throw error;
    }

    return apiSuccess({
      taskId: queued.task.id,
      assetId,
      status: queued.task.status,
      prompt,
      model: modelId,
      resolution: resolutionKey,
      style: effectiveStyle,
      revisionId: revision.id,
      reused: queued.reused,
    }, 201);
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/assets/[assetId]/generate-image');
  }
}
