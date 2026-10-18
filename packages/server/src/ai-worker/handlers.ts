// ============================================================
// ⑥ server/ai-worker/handlers — 产品范围内的纯 AI 任务处理器
// ============================================================
//
// 文件职责：
//   handleTask(taskType, input, userId, taskId) — 按 taskType 分派到对应 handler，
//   每个 handler 调用 ② callAI(provider, model, payload)，返回 HandlerResult。
//
// 处理器分类（与 app1 4 个 worker 的 process() 对齐，剥离 ffmpeg）：
//   TEXT（8 种）：STORY_ANALYZE / SCRIPT_CONVERT / EPISODE_SPLIT / CHARACTER_PROFILE /
//     SHOT_AI / STORY_EXPAND / LLM_CHAT / LLM_STREAM —— 统一走 text_generation
//   IMAGE（2 种）：IMAGE_GENERATE 持久化到服务端；ASSET_IMAGE_GENERATE 由客户端落盘
//   VIDEO（1 种）：VIDEO_GENERATE —— video_generation + TOS URL 持久化 + shot 回写
//   VOICE（1 种）：VOICE_GENERATE(TTS) —— tts
//
// 与 app1 的差异（已知 gap，见报告）：
//   - EPISODE_SPLIT：app1 调 executeEpisodeSplitTask + extractWholeScriptAssets（复杂编排），
//     这两个服务不在已迁移模块 ②③④⑦ 中，本实现退化为 text_generation 透传
//     （API 路由层构建 prompt，handler 透传给 gateway）。
//   - IMAGE：app1 的 negativePrompt 用 getStyleNegativePrompt/getDeliveryComplianceNegativePrompt
//     增强，本实现用 DEFAULT_NEGATIVE_PROMPT 兜底（@core/ai/asset-prompt 未迁移）。
//   - IMAGE：app1 的 costume 变体写回（FOR UPDATE 行锁 costumes JSONB）未迁移，
//     ASSET_IMAGE_GENERATE 只产出临时 provider URL；客户端按 costumeKey 下载并提交 revision。
//   - VIDEO：app1 的铅笔彩绘转换预处理（ComfyUI z_image_turbo）未迁移，
//     VIDEO_GENERATE 直接用原参考图调 gateway。
//   - cost：② callAI 返回 { url, meta? } 不含 cost，所有 handler 的 cost 恒为 0；
//     扣费走 ③ chargeCredits(userId, 0) no-op 账本，待定价模型补入。
//
// 服务器禁止 import ffmpeg；本模块仅调用 ② callAI + ③ storage/asset，零 ffmpeg 依赖。
// ============================================================

import { callAI } from '@server/gateway';
import { getStorage } from '@server/domain';
import {
  markAssetImageRevisionGenerated,
  markAssetImageRevisionFailed,
} from '@server/domain';
import { genId } from '@shared/utils';
import type { GatewayResult } from '@server/gateway';
import type { AiTaskType, HandlerResult } from './types';
import {
  parseModel,
  tryExtractProvider,
  computeAspectRatio,
  DEFAULT_NEGATIVE_PROMPT,
} from './model-util';
import { updateShotMaterial, markShotsVideoStatus } from './task-repo';
import {
  splitScriptIntoEpisodes,
  styleAndSplitOriginalSeries,
} from '@server/domain/episode';
import { extractWholeScriptAssets } from '@server/domain/asset';
import {
  updateCharacterMappingRoleIdentityByAliasMap,
} from '@server/domain/project';
import {
  buildLocalizationProfile,
  readLocalizationProfile,
} from '@server/domain/prompt';

// ============================================================
// 主分派入口
// ============================================================

/**
 * 按 taskType 分派到对应 handler。
 *
 * @param taskType - 任务类型（来自 BullMQ job.name）
 * @param input - 任务输入（来自 BullMQ job.data.input）
 * @param userId - 用户 ID
 * @param taskId - 任务 ID
 * @returns HandlerResult（output + 模型信息）
 * @throws Error 不支持的任务类型 / callAI 失败 / 存储/DB 失败
 */
export async function handleTask(
  taskType: AiTaskType,
  input: Record<string, unknown>,
  userId: string,
  taskId: string,
  reportProgress?: (progress: number, stage: string, stageProgress?: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<HandlerResult> {
  switch (taskType) {
    // TEXT 队列（8 种统一走 text_generation）
    case 'LLM_CHAT':
    case 'LLM_STREAM':
    case 'STORY_ANALYZE':
    case 'SCRIPT_CONVERT':
    case 'CHARACTER_PROFILE':
    case 'SHOT_AI':
    case 'STORY_EXPAND':
      return handleTextTask(taskType, input, userId, signal);
    case 'EPISODE_SPLIT':
      // EPISODE_SPLIT 透传 signal 到 domain 层 splitScriptIntoEpisodes/extractWholeScriptAssets
      // 侵入大，本次 defer：靠 CAS 丢弃 + 30min handler 超时兜底。
      // reportProgress 透传：在转风格/拆集/资产提取/角色映射各真实阶段上报，前端 ProgressBar 据此显示。
      return handleEpisodeSplit(input, userId, reportProgress);

    // IMAGE 队列
    case 'IMAGE_GENERATE':
      return handleImageGenerate(input, userId, signal);
    case 'ASSET_IMAGE_GENERATE':
      return handleAssetImageGenerate(input, userId, reportProgress, signal);

    // VIDEO 队列（仅单镜）
    case 'VIDEO_GENERATE':
      return handleVideoGenerate(input, userId, taskId, signal);

    // VOICE 队列
    case 'VOICE_GENERATE':
      return handleVoiceGenerate(input, userId, signal);
    default: {
      const exhaustive: never = taskType;
      throw new Error(`不支持的 AI 任务类型: ${String(exhaustive)}`);
    }
  }
}

/**
 * 长操作期间定期上报「心跳进度」，避免进度条长时间冻结让用户以为假死。
 *
 * DeepSeek 拆集 / 整剧资产提取各最长 ~15min，期间无阶段切换、reportProgress 不调用 →
 * 进度条卡在上一个阶段值（如 12%）一动不动 → 用户以为任务死了（生产 19d0ca7c 等
 * 假死投诉的体验根因之一）。本函数在 start 与 end（不含）之间随时间缓慢推进、封顶
 * end-1；真完成时调用方 reportProgress(end) 直接跳到真值，心跳只负责让进度条「活着」。
 * 副作用：定期 updateTaskProgress 刷新 tasks.updatedAt，task-heal-sweep 也不会误判卡死。
 *
 * @returns stop 函数，操作完成或异常时必须调用以清定时器（防泄漏）。
 */
export function startProgressHeartbeat(
  report: ((progress: number, stage: string, stageProgress?: number) => Promise<void>) | undefined,
  start: number,
  end: number,
  stage: string,
  intervalMs = 20_000,
  step = 2,
): () => void {
  if (!report) return () => {};
  const cap = Math.max(start + 1, end - 1); // 不触及 end，给真完成留跳变空间
  let current = start;
  const timer = setInterval(() => {
    if (current >= cap) return;
    current = Math.min(cap, current + step);
    void report(Math.round(current), stage, 0).catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * 调用原创整剧的项目级编排。
 *
 * OVERSEAS 由一次 AI 通读同时完成动态分集与整剧转风格；DOMESTIC 直接拆原文。
 * 核心剧本与分集在短事务中原子提交，随后再 best-effort 提取共享资产与更新角色映射。
 */
async function handleEpisodeSplit(
  input: Record<string, unknown>,
  userId: string,
  reportProgress?: (progress: number, stage: string, stageProgress?: number) => Promise<void>,
): Promise<HandlerResult> {
  await reportProgress?.(5, '任务已接收', 0);
  const projectId = typeof input.projectId === 'string' ? input.projectId : '';
  const novelText = typeof input.novelText === 'string' ? input.novelText : '';
  const sourceScriptHash = typeof input.sourceScriptHash === 'string'
    ? input.sourceScriptHash.trim()
    : undefined;
  if (!projectId || novelText.trim().length < 50) throw new Error('AI 分集任务缺少有效的项目或剧本文本');
  const modelId = typeof input.modelId === 'string' ? input.modelId : undefined;
  const category = typeof input.category === 'string' ? input.category : 'DOMESTIC';
  const stylePrompt = typeof input.stylePrompt === 'string' ? input.stylePrompt.trim() : '';
  let finalNovelText = novelText;
  let localizationProfile = readLocalizationProfile(input.localizationProfile);
  let wholeSeriesStyled = false;
  let characterAliasMap: Map<string, string> | undefined;
  let split: Awaited<ReturnType<typeof splitScriptIntoEpisodes>>;

  if (category.toUpperCase() === 'OVERSEAS') {
    if (!stylePrompt) throw new Error('海外转绘整剧任务缺少目标语言或文化风格');
    await reportProgress?.(12, '整剧通读：目标语言转风格与动态拆集中', 0);
    localizationProfile = buildLocalizationProfile(stylePrompt);
    // 心跳：整剧通读 + 转风格 + 动态拆集是单次长 DeepSeek 流式调用，最长 ~15min。
    const stopStyleHeartbeat = startProgressHeartbeat(
      reportProgress,
      12,
      60,
      '整剧通读：目标语言转风格与动态拆集中',
    );
    let styledSplit: Awaited<ReturnType<typeof styleAndSplitOriginalSeries>>;
    try {
      styledSplit = await styleAndSplitOriginalSeries({
        projectId,
        sourceScriptText: novelText,
        sourceScriptHash,
        stylePrompt,
        userId,
        modelId,
        localizationProfile,
        projectCommit: {
          scriptData: {
            localizationProfile,
            wholeSeriesStyle: {
              completed: true,
              stylePrompt: localizationProfile.stylePrompt,
            },
          },
        },
      });
    } finally {
      stopStyleHeartbeat();
    }
    await reportProgress?.(60, '转风格完成，提取整剧资产中', 0);
    finalNovelText = styledSplit.styledNovelText;
    characterAliasMap = styledSplit.characterAliasMap;
    split = {
      episodeIds: styledSplit.episodeIds,
      episodeCount: styledSplit.episodeCount,
      coverage: styledSplit.coverage,
      splitMode: styledSplit.splitMode,
      cost: styledSplit.cost,
    };
    wholeSeriesStyled = true;
  } else {
    await reportProgress?.(12, 'AI 拆分整剧中', 0);
    // 心跳：splitScriptIntoEpisodes 的 DeepSeek 流式调用最长 ~15min，期间无阶段切换，
    // 不加心跳进度条会卡在 12% 让用户以为假死。完成时下方 reportProgress(60) 跳真值。
    const stopSplitHeartbeat = startProgressHeartbeat(reportProgress, 12, 60, 'AI 拆分整剧中');
    try {
      split = await splitScriptIntoEpisodes({
        projectId,
        novelText: finalNovelText,
        userId,
        modelId,
        localizationProfile,
        sourceScriptHash,
        sourceScriptText: novelText,
      });
    } finally {
      stopSplitHeartbeat();
    }
    await reportProgress?.(60, '拆集完成，提取整剧资产中', 0);
  }

  const warnings: Array<{ code: string; message: string }> = [];
  let assets: Awaited<ReturnType<typeof extractWholeScriptAssets>> | null = null;
  // 心跳：资产提取也是长 DeepSeek 调用，期间进度条会卡在 60%。
  const stopExtractHeartbeat = startProgressHeartbeat(reportProgress, 60, 85, '提取整剧资产中');
  try {
    assets = await extractWholeScriptAssets(projectId, finalNovelText, userId, category, undefined, localizationProfile);
  } catch (error) {
    console.error('[ai-worker] post-split asset extraction failed', { projectId, error });
    warnings.push({
      code: 'ASSET_EXTRACTION_FAILED',
      message: '整剧与分集已保存，但自动资产提取暂未完成，请稍后重试资产提取。',
    });
  } finally {
    stopExtractHeartbeat();
  }
  if (characterAliasMap && characterAliasMap.size > 0) {
    await reportProgress?.(85, '更新角色身份映射', 0);
    try {
      await updateCharacterMappingRoleIdentityByAliasMap(projectId, characterAliasMap);
    } catch (error) {
      console.error('[ai-worker] post-split character alias update failed', { projectId, error });
      warnings.push({
        code: 'CHARACTER_ALIAS_UPDATE_FAILED',
        message: '整剧与分集已保存，但角色身份映射暂未更新，请稍后重试。',
      });
    }
  }
  await reportProgress?.(95, '收尾落库', 0);
  await reportProgress?.(100, '完成', 100);
  const slash = (modelId || 'deepseek/deepseek-v4-flash').indexOf('/');
  return {
    output: {
      ...split,
      wholeSeriesStyled,
      ...(wholeSeriesStyled ? { sourceStructureEpisodeCount: split.episodeCount } : {}),
      assetExtraction: assets,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    modelProvider: slash > 0 ? (modelId || '').slice(0, slash) : 'deepseek',
    modelName: slash > 0 ? (modelId || '').slice(slash + 1) : (modelId || 'deepseek-v4-flash'),
    cost: Math.max(0, Number(split.cost) || 0)
      + Math.max(0, Number(assets?.cost) || 0),
    billingDescription: wholeSeriesStyled
      ? '原创整剧转风格、资产提取与 AI 拆集'
      : '原创整剧资产提取与 AI 拆集',
  };
}

// ============================================================
// TEXT 处理器（8 种统一走 text_generation）
// ============================================================

/**
 * 文本任务统一处理器。
 *
 * 复刻 app1 TextWorker.callTextGeneration：
 *   1. 从 input.model 拆分 provider
 *   2. 规范化 input：确保有 messages 或 prompt（兜底从 text/content/script 提取）
 *   3. callAI({ capability: 'text_generation', input, userId })
 *   4. 返回 { output: { content, tokensUsed }, modelProvider, modelName }
 *
 * EPISODE_SPLIT 在 app1 中调 executeEpisodeSplitTask + extractWholeScriptAssets
 * 做复杂编排，本实现退化为透传（gap，见模块头注释）。
 */
async function handleTextTask(
  _taskType: AiTaskType,
  input: Record<string, unknown>,
  userId: string,
  signal?: AbortSignal,
): Promise<HandlerResult> {
  const modelRaw = typeof input.model === 'string' ? input.model : '';
  if (!modelRaw) throw new Error('文本任务缺少 model');
  const { provider, model } = parseModel(modelRaw);

  // 规范化 input：确保有 messages 或 prompt
  const gatewayInput: Record<string, unknown> = { ...input };
  if (!gatewayInput.messages && !gatewayInput.prompt) {
    const fallback = input.text || input.content || input.script;
    if (typeof fallback === 'string' && fallback) {
      gatewayInput.prompt = fallback;
    }
  }

  const result = await callAI(provider, model, {
    capability: 'text_generation',
    input: gatewayInput,
    userId,
  }, signal ? { signal } : undefined);

  const meta = (result.meta ?? {}) as Record<string, unknown>;
  return {
    output: {
      content: meta.content ?? '',
      tokensUsed: meta.tokensUsed ?? null,
    },
    modelProvider: provider,
    modelName: model,
    cost: result.cost,
    billingDescription: getBillingDescription(_taskType),
  };
}

// ============================================================
// IMAGE 处理器
// ============================================================

/**
 * 通用图片生成。
 *
 * 复刻 app1 ImageWorker.handleImageGenerate：
 *   1. callAI({ capability: 'image_generation', input: { prompt, negativePrompt, width, height, ... } })
 *   2. 从 result.meta.images 提取图片 URL 列表
 *   3. 逐张下载（fetch URL 或解码 base64 data URL）→ 上传到 ③ storage
 *   4. 返回 { output: { imageUrls, projectId }, modelProvider, modelName }
 */
async function handleImageGenerate(
  input: Record<string, unknown>,
  userId: string,
  signal?: AbortSignal,
): Promise<HandlerResult> {
  const modelRaw = typeof input.model === 'string' ? input.model : '';
  if (!modelRaw) throw new Error('图片任务缺少 model');
  const { provider, model } = parseModel(modelRaw);

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt) throw new Error('图片任务缺少 prompt');

  const width = (input.width as number | undefined) ?? 1024;
  const height = (input.height as number | undefined) ?? 1024;
  const aspectRatio = computeAspectRatio(width, height);
  const style = typeof input.style === 'string' ? input.style : undefined;
  const negativePrompt =
    (typeof input.negativePrompt === 'string' ? input.negativePrompt : '') ||
    (style ? `${DEFAULT_NEGATIVE_PROMPT}, ${style}` : DEFAULT_NEGATIVE_PROMPT);
  const referenceImageUrl =
    typeof input.referenceImageUrl === 'string' ? input.referenceImageUrl : undefined;
  const count = (input.count as number | undefined) ?? 1;
  const projectId = (input.projectId as string | undefined) ?? 'global';

  const result = await callAI(provider, model, {
    capability: 'image_generation',
    input: {
      prompt,
      negativePrompt,
      width,
      height,
      style,
      aspect_ratio: aspectRatio,
      referenceImageUrl,
      count,
    },
    userId,
  }, signal ? { signal } : undefined);

  const images = extractImages(result);
  if (images.length === 0) throw new Error('AI 模型未返回图片');

  const savedUrls = await persistImages(images, projectId);
  if (savedUrls.length === 0) throw new Error('图片保存失败：所有图片均未能成功保存到存储');

  return {
    output: { imageUrls: savedUrls, projectId },
    modelProvider: provider,
    modelName: model,
    cost: result.cost,
    billingDescription: '图片生成',
  };
}

/**
 * 资产图片生成。
 *
 * 对齐 app1 ImageWorker.handleAssetImageGenerate 的生图语义，同时遵守 C/S 媒体边界：
 *   1. worker 调 AI，并把 revision 标为 GENERATED；
 *   2. 返回 provider 临时 URL、revisionId 与 costumeKey；
 *   3. 桌面客户端下载后通过 revision 两阶段提交，默认图写 assets.imageUrl，
 *      造型图在行锁内写入 costumes[costumeKey].imageUrl。
 */
async function handleAssetImageGenerate(
  input: Record<string, unknown>,
  userId: string,
  reportProgress?: (progress: number, stage: string, stageProgress?: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<HandlerResult> {
  const modelRaw = typeof input.model === 'string' ? input.model : '';
  if (!modelRaw) throw new Error('资产图片任务缺少 model');
  const { provider, model } = parseModel(modelRaw);

  const assetId = typeof input.assetId === 'string' ? input.assetId : '';
  if (!assetId) throw new Error('资产图片任务缺少 assetId');
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt) throw new Error('资产图片任务缺少 prompt');

  const width = (input.width as number | undefined) ?? 1024;
  const height = (input.height as number | undefined) ?? 1024;
  const aspectRatio = computeAspectRatio(width, height);
  const style = typeof input.style === 'string' ? input.style : undefined;
  const negativePrompt =
    (typeof input.negativePrompt === 'string' ? input.negativePrompt : '') ||
    (style ? `${DEFAULT_NEGATIVE_PROMPT}, ${style}` : DEFAULT_NEGATIVE_PROMPT);
  const referenceImageUrl =
    typeof input.referenceImageUrl === 'string' ? input.referenceImageUrl : undefined;
  const projectId = (input.projectId as string | undefined) ?? 'global';
  const costumeKey = typeof input.costumeKey === 'string' ? input.costumeKey : '';
  const revisionId = typeof input.revisionId === 'string' ? input.revisionId : '';

  try {
    await reportProgress?.(5, '任务已接收', 0);
    await reportProgress?.(15, '准备生成请求', 0);
    await reportProgress?.(25, 'AI生成图片中', 0);
    const result = await callAI(provider, model, {
      capability: 'image_generation',
      input: {
        prompt,
        negativePrompt,
        width,
        height,
        style,
        aspect_ratio: aspectRatio,
        referenceImageUrl,
      },
      userId,
    }, signal ? { signal } : undefined);

    await reportProgress?.(70, '处理生成结果', 0);
    const images = extractImages(result);
    if (images.length === 0) throw new Error('AI 模型未返回图片');

    // C/S 媒体边界：服务端只记录临时供应商地址，不下载、不上传、更不抢先切换当前图。
    // 桌面客户端拿到完成事件后下载为 sf-asset://，再通过 revision 事务提交当前版本。
    await reportProgress?.(95, '等待客户端保存', 0);
    if (revisionId) await markAssetImageRevisionGenerated(revisionId, images[0]);

    return {
      output: {
        assetId,
        imageUrl: images[0],
        imageUrls: images,
        imageCount: images.length,
        projectId,
        costumeKey: costumeKey || null,
        revisionId: revisionId || null,
      },
      modelProvider: provider,
      modelName: model,
      cost: result.cost,
      billingDescription: '资产图片生成',
    };
  } catch (error) {
    if (revisionId) {
      await markAssetImageRevisionFailed(
        revisionId,
        error instanceof Error ? error.message : '资产生图失败',
      ).catch(() => undefined);
    }
    throw error;
  }
}

// ============================================================
// VIDEO 处理器（仅单镜 VIDEO_GENERATE）
// ============================================================

/**
 * 单镜视频生成。
 *
 * 复刻 app1 VideoWorker.handleVideoGenerate（剥离铅笔彩绘/自动合集/chain）：
 *   1. 构造 gateway input（prompt/duration/aspectRatio/参考图/seed/...）
 *   2. callAI({ capability: 'video_generation', input, userId })
 *   3. 从 result.url 取视频 URL（ARK TOS 预签名，1h 过期）
 *   4. 下载并持久化到 ③ storage（避免 URL 过期；失败回退原 URL）
 *   5. 回写 shots."currentMaterialUrl" + "videoStatus"='COMPLETED'
 *   6. 返回 { output: { videoUrl, ... }, modelProvider, modelName }
 *
 * 失败时把相关 shot 的 videoStatus 置 FAILED。
 */
async function handleVideoGenerate(
  input: Record<string, unknown>,
  userId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<HandlerResult> {
  const modelRaw = typeof input.model === 'string' ? input.model : '';
  if (!modelRaw) throw new Error('视频任务缺少 model');
  const { provider, model } = parseModel(modelRaw);

  // motion 校准已由 combineGroupPrompts 末尾 append（镜头组拼装时）+ 链路层 LLM 重写后补 append
  // 双重保证；此处透传即可，不再重复追加（幂等冗余）。
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const duration = (input.duration as number | undefined) ?? 5;
  const aspectRatio = (input.aspectRatio as string | undefined) ?? '9:16';
  const shotId = typeof input.shotId === 'string' ? input.shotId : undefined;
  const groupShotIds = Array.isArray(input.groupShotIds)
    ? (input.groupShotIds as string[])
    : [];
  // chain 编排模式（客户端 chain-generate.ts 派发）：跳过服务端 persistVideo
  // （dramaforge-assets-client-local：媒体只存客户端本地，服务器零媒体字节）+ 跳过 shot
  // 回写（chain 的 shot 素材回写由 CHAIN_COMPILE render_job G3 体系负责，用客户端
  // concat 后的本地 sf-asset:// 组片；handler 这里拿 ark TOS URL 立即交客户端
  // downloadClips）。默认（单镜头生成）行为不变。
  const chainMode = input.chainMode === true;

  // 构造 gateway input（复刻 app1 callSeedanceGenerate）
  const gatewayInput: Record<string, unknown> = {
    prompt,
    duration,
    aspectRatio,
  };
  const charRefs = (input.characterReferenceImageUrls as string[] | undefined) ?? [];
  if (charRefs.length > 0) gatewayInput.characterReferenceImageUrls = charRefs;
  // 透传客户端"人物参考图已叠加 app1 稀疏网格"标志 → ark.ts:97 门禁据此放行。
  // 白名单漏透传时，有人物参考图的请求即使客户端已叠加网格（tasks input 里
  // characterReferencesGridApplied=true）也会被 ark 门禁误判"未处理真人图"直接拦截，
  // 导致整条 chain 的镜头视频生成全军覆没（4928 22 镜头 ~20 个被此门禁拦）。
  if (input.characterReferencesGridApplied === true) gatewayInput.characterReferencesGridApplied = true;
  const refImages = (input.referenceImageUrls as string[] | undefined) ?? [];
  if (refImages.length > 0) gatewayInput.referenceImageUrls = refImages;
  const refAudio = (input.referenceAudioUrls as string[] | undefined) ?? [];
  if (refAudio.length > 0) gatewayInput.referenceAudioUrls = refAudio;
  const refVideo = (input.referenceVideoUrls as string[] | undefined) ?? [];
  if (refVideo.length > 0) gatewayInput.referenceVideoUrls = refVideo;
  if (input.seed !== undefined) gatewayInput.seed = input.seed;
  if (input.generateAudio !== undefined) gatewayInput.generateAudio = input.generateAudio;
  if (input.resolution !== undefined) gatewayInput.resolution = input.resolution;
  if (input.watermark !== undefined) gatewayInput.watermark = input.watermark;
  if (input.returnLastFrame !== undefined) gatewayInput.returnLastFrame = input.returnLastFrame;

  const allShotIds = groupShotIds.length > 0 ? groupShotIds : shotId ? [shotId] : [];

  try {
    const result = await callAI(provider, model, {
      capability: 'video_generation',
      input: gatewayInput,
      userId,
    }, signal ? { signal } : undefined);

    const videoUrl = result.url;
    if (!videoUrl) throw new Error('API 未返回视频 URL，生成失败');

    // chain 模式跳过服务端持久化（dramaforge-assets-client-local）：直接用 ark TOS URL，
    // 客户端 chain-generate.ts 拿到后立即 downloadClips 落盘本地（1h 内完成）。
    // 默认（单镜头）仍持久化到项目存储避免 URL 过期。
    const persistLabel = (allShotIds[0] ?? taskId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
    const persistedUrl = chainMode ? videoUrl : await persistVideo(videoUrl, persistLabel);

    // 回写 shots."currentMaterialUrl" + "videoStatus"='COMPLETED'
    // chain 模式跳过：shot 素材回写由 CHAIN_COMPILE render_job G3 体系负责（用客户端
    // concat 后的本地组片 sf-asset://，非此处的 ark TOS URL）。
    if (!chainMode) {
      for (const id of allShotIds) {
        try {
          await updateShotMaterial(id, persistedUrl, 'COMPLETED');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[ai-worker] 更新 shot 素材失败 (shotId=${id}): ${msg}`);
        }
      }
    }

    const meta = (result.meta ?? {}) as Record<string, unknown>;
    return {
      output: {
        videoUrl: persistedUrl,
        originalUrl: videoUrl,
        taskId: meta.taskId ?? meta.requestId ?? null,
        duration: meta.duration ?? duration,
      },
      modelProvider: provider,
      modelName: model,
      cost: result.cost,
      billingDescription:
        groupShotIds.length > 0 ? '分镜组视频生成' : '镜头视频生成',
    };
  } catch (err) {
    // 失败时把相关 shot 的 videoStatus 置 FAILED（复刻 app1 failShots）
    // chain 模式跳过：FAILED 由 CHAIN_COMPILE render_job markFailed(G3-1) 统一处理。
    if (!chainMode && allShotIds.length > 0) {
      try {
        await markShotsVideoStatus(allShotIds, 'FAILED');
      } catch {
        // 回滚失败不掩盖原始错误
      }
    }
    throw err;
  }
}

// ============================================================
// VOICE 处理器
// ============================================================

/**
 * 文本转语音（TTS）。
 *
 * 复刻 app1 VoiceWorker.handleVoiceGenerate：
 *   callAI({ capability: 'tts', input: { text, voiceId, speed, emotion }, userId })
 *   返回 { output: { audioUrl, meta }, modelProvider, modelName }
 *
 * TTS 的 provider 从 input.model 前缀取；无前缀时回退 input.provider 或 'ark'。
 */
async function handleVoiceGenerate(
  input: Record<string, unknown>,
  userId: string,
  signal?: AbortSignal,
): Promise<HandlerResult> {
  const modelRaw = typeof input.model === 'string' ? input.model : '';
  const providerFromInput = typeof input.provider === 'string' ? input.provider : null;
  const provider =
    tryExtractProvider(modelRaw) ?? providerFromInput ?? 'ark';
  // model 保留原值（含前缀）；无前缀时拼接默认
  const model = modelRaw || `${provider}/tts-default`;

  const text = typeof input.text === 'string' ? input.text : '';
  if (!text) throw new Error('语音任务缺少 text');

  const ttsInput: Record<string, unknown> = { text };
  if (typeof input.voiceId === 'string') ttsInput.voiceId = input.voiceId;
  if (typeof input.provider === 'string') ttsInput.provider = input.provider;
  if (input.speed !== undefined) ttsInput.speed = input.speed;
  if (typeof input.emotion === 'string') ttsInput.emotion = input.emotion;

  const result = await callAI(provider, model, {
    capability: 'tts',
    input: ttsInput,
    userId,
  }, signal ? { signal } : undefined);

  return {
    output: { audioUrl: result.url, meta: result.meta ?? null },
    modelProvider: provider,
    modelName: model,
    cost: result.cost,
    billingDescription: '语音生成',
  };
}

// ============================================================
// 内部辅助
// ============================================================

/** 从 GatewayResult 提取图片 URL 列表（复刻 app1 extractImageSource 的 URL 分支） */
function extractImages(result: GatewayResult): string[] {
  const meta = (result.meta ?? {}) as Record<string, unknown>;
  const images = Array.isArray(meta.images) ? meta.images : [];
  const urls: string[] = [];
  for (const img of images) {
    if (typeof img === 'string') {
      if (img.startsWith('http') || img.startsWith('data:')) urls.push(img);
    } else if (img && typeof img === 'object') {
      const obj = img as Record<string, unknown>;
      if (typeof obj.url === 'string' && obj.url) {
        urls.push(obj.url);
      } else if (typeof obj.b64_json === 'string' && obj.b64_json) {
        urls.push(`data:image/png;base64,${obj.b64_json}`);
      }
    }
  }
  // 也兜底 result.url（部分 provider 只返回顶层 url）
  if (urls.length === 0 && result.url) {
    urls.push(result.url);
  }
  return urls;
}

/**
 * 下载/解码图片并上传到 ③ storage。
 *
 * 支持 http(s) URL（fetch 下载）和 data:base64 URL（直接解码）。
 * 返回上传后的可访问 URL 列表。
 */
async function persistImages(
  imageUrls: string[],
  projectId: string,
  assetId?: string,
): Promise<string[]> {
  const storage = getStorage();
  const savedUrls: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    try {
      let buf: Buffer;
      let contentType = 'image/png';

      if (url.startsWith('data:')) {
        const matches = url.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) continue;
        contentType = matches[1];
        buf = Buffer.from(matches[2], 'base64');
      } else {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) {
          console.warn(`[ai-worker] 下载图片失败: HTTP ${res.status}`);
          continue;
        }
        buf = Buffer.from(await res.arrayBuffer());
        const ct = res.headers.get('content-type');
        if (ct) contentType = ct;
      }

      const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';
      const dir = assetId
        ? `assets/${projectId}/${assetId}`
        : `generated/${projectId}`;
      const key = `${dir}/${Date.now()}_${i}.${ext}`;
      const uploadResult = await storage.upload(key, buf, contentType);
      savedUrls.push(uploadResult.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ai-worker] 保存第 ${i} 张图片失败: ${msg}`);
    }
  }

  return savedUrls;
}

/**
 * 下载视频并持久化到 ③ storage（避免 ARK TOS 预签名 URL 1h 过期）。
 *
 * 复刻 app1 VideoWorker.persistVideoUrl（简化：3 次重试改 1 次尝试 + 回退原 URL）。
 * 下载或上传失败时回退到原始 URL（短期内仍可访问）。
 */
async function persistVideo(videoUrl: string, label: string): Promise<string> {
  try {
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) {
      console.warn(`[ai-worker] 下载视频失败: HTTP ${res.status}，回退原 URL`);
      return videoUrl;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const storage = getStorage();
    const storageKey = `videos/${label}-${Date.now()}-${genId().slice(0, 8)}.mp4`;
    const uploadResult = await storage.upload(storageKey, buf, 'video/mp4');
    return uploadResult.url;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ai-worker] 持久化视频失败，回退原 URL（约 1h 后过期）: ${msg}`);
    return videoUrl;
  }
}

/** 按任务类型生成扣费描述（复刻 app1 BaseWorker.getBillingDescription） */
function getBillingDescription(taskType: AiTaskType): string {
  switch (taskType) {
    case 'STORY_ANALYZE':
      return '小说分析';
    case 'SCRIPT_CONVERT':
      return '剧本转换';
    case 'EPISODE_SPLIT':
      return '分集拆分';
    case 'CHARACTER_PROFILE':
      return '角色档案生成';
    case 'SHOT_AI':
      return 'AI 分镜';
    case 'STORY_EXPAND':
      return '故事扩写';
    case 'LLM_CHAT':
      return 'LLM 对话';
    case 'LLM_STREAM':
      return 'LLM 流式对话';
    case 'IMAGE_GENERATE':
      return '图片生成';
    case 'ASSET_IMAGE_GENERATE':
      return '资产图片生成';
    case 'VIDEO_GENERATE':
      return '镜头视频生成';
    case 'VOICE_GENERATE':
      return '语音生成';
    default:
      return '任务扣费';
  }
}
