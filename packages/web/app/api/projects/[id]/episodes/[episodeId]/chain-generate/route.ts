// ============================================================
// POST /api/projects/[id]/episodes/[episodeId]/chain-generate — 一键串生成（P7.5）
// ============================================================
//
// 把单集分镜（shots）组装成 CHAIN_COMPILE render_job：每 shot 一组，params 携带
// cloud-AI 视频生成参数。客户端 render-worker 拉取该 job → chainCompile orchestrator
// 逐组 POST /api/generate/video（服务器云端 key 调 AI）→ 本机 ffmpeg 合片 → 成品落
// 客户端本地（sf-asset://，服务器不存媒体字节，契合 dramaforge-assets-client-local）。
//
// 与 app1 的差异：app1 创建 BullMQ CHAIN_GENERATE task 由 server worker 异步处理；
// dramaforge 是 C/S：创建 CHAIN_COMPILE render_job 由客户端 render-worker 处理（AI 仍在云端）。
//
// 每组按分镜 groupIndex、模型时长和参考图上限自动拆分；params 含
// model/prompt/duration/aspectRatio + 可选 resolution/seed/watermark/
// returnLastFrame + 固定 generateAudio:true。
//
// 批8 增量（R6 + R7）：
//   - R6 input.filmMeta 透传 projectId/episodeId/episodeNumber/episodeTitle/
//     projectTitle/shotCount/totalDuration —— films GET route 从 input JSONB
//     提取做项目过滤 + 卡片展示。客户端 orchestrator 不读 filmMeta（行为零影响）。
//   - R7 任务复用：按 episodeId + 镜头范围在 PostgreSQL 事务锁内原子
//     create-or-reuse，防止并发点击穿透“先查后插”；复用响应同时返回 taskId，
//     让前端可以恢复 SSE/轮询生命周期。
//
// C/S 参考图接缝：服务器只编排 sf-asset:// 标识，客户端读取本地字节、叠加角色网格
// 后以本次请求数据提交云端；服务器不持久化媒体。force、严格/并行执行和计费均由
// render_job + 客户端 orchestrator + 直连生成路由完成。
//
// 批8 P7.6（网格叠加端到端激活）：CHARACTER 资产若 gridOverlayEnabled===true 且有
//   imageUrl，则其图作为 characterReferenceImageUrls 注入对应组的 params，并置
//   gridEnabled:true。客户端 ⑩ chain-generate orchestrator 的
//   applyCharacterAssetGridOverlay 读到这两字段后，本地 ffmpeg 叠稀疏九宫格 → base64
//   data URL → 提交云端 AI（服务器零 ffmpeg、零媒体字节，仅透传 sf-asset:// 给客户端）。
//   镜头→资产映射靠 shot.referencedAssets.characters（名字数组）+ listAssets('CHARACTER')
//   按名归一化匹配（镜像 shot-asset-reference.ts 的 normalizeName）。无任何
//   gridOverlayEnabled 资产时这俩字段不出现，默认路径完全不变。
//
// 鉴权：session REQUIRED。响应：
//   200 { success:true, data: { renderJobId, taskId, groupCount } }
//   202 { success:true, data: { reused:true, renderJobId, taskId } }（复用活跃 job）
//   400 NO_SHOTS / 401 / 404 / 502
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  dispatchChainGenerateOnce,
  episodeRepo,
  projectRepo,
  getShot,
  getStorage,
  listShots,
  listAssets,
  hasLockedTargetLanguage,
  readLocalizationProfile,
  PENCIL_PAINTING_RESTORATION_PROMPT,
  query,
  updateShot,
  callAI,
  type LocalizationProfile,
} from '@dramaforge/server';
import { genId, REFERENCE_VIDEO_PRESIGN_TTL_SEC, type ReferenceVideoMeta } from '@dramaforge/shared';
import type { K3Shot } from '../../../reference-video/k3-analyze/route';
import { alignSceneIdsToClips, dominantSceneId, sceneIdSequence } from '@web/lib/reference-video-align';
import { requireUser, AuthError } from '@web/lib/auth';
import { rewriteGroupPromptForModeration } from '@web/lib/seedance-narrative-rewrite';
import { appendSeedanceMotionCalibration, maxDurationForVideoModel } from '@server/domain/prompt/seedance-helpers';
import { sanitizePromptForModeration, sanitizeOverseasCulturalProps } from '@server/domain/prompt/asset-helpers';
import { isDegenerateVisualPrompt, sanitizeDegenerateVisualPrompt } from '@server/domain/storyboard/degenerate';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { parseModel } from '@web/lib/model-parser';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import {
  groupShotsForPreparedPrompts,
  groupPromptMetadata,
  mergeCostumeMaps,
  prepareGroupPromptSnapshot,
  readStoredGroupPrompt,
  resolveGroupExecutablePrompt,
  buildSceneSpatialLayoutMap,
  buildSceneTimeOfDayMap,
  buildSceneBlockingImageMap,
  shouldReuseGroupVideo,
} from '@web/lib/group-prompt-snapshot';

/** 默认视频模型；调用方仍可选择目录中的其他视频模型。 */
const DEFAULT_VIDEO_MODEL = 'ark/doubao-seedance-2-0-260128';
const DEFAULT_VIDEO_RESOLUTION = '720p';
const MAX_GROUP_DURATION_SECONDS = 15;
// 角色参考上限 6（2026-08-12 用户解除 4 限制：多角色对峙场面的分镜引用不再被静默
// 截断；总参考图仍受 MAX_TOTAL_REFERENCES=9 约束）。
const MAX_CHARACTER_REFERENCES = 6;
const MAX_TOTAL_REFERENCES = 9;

/**
 * 确定性 seed：从字符串（如首镜 ID）哈希出稳定的 32 位整数。
 * 用于每镜组自动固定 seed —— 同一镜组重生 = 同一 seed = 可复现的视觉结果。
 * body.seed 优先（用户显式指定时覆盖）。
 */
function deterministicSeed(source: string): number {
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * 角色名归一化：小写 + 去常见分隔符。镜像 shot-asset-reference.ts:66 的 normalizeName，
 * 让镜头引用名与资产名匹配规则在 web 层保持一致（同一项目里两种匹配路径不会因归一化
 * 差异而错配）。
 */
function normalizeCharName(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[\s\-_·.,'"()（）]/g, '')
    : '';
}

interface ReferenceAsset {
  name: string;
  url: string;
  kind: string;
  gridEnabled: boolean;
  voiceFile?: string;
}

/**
 * 场景 ID 读取：分镜落库时 sceneId 只在 metadata.sceneId / storyboardTable.sceneId
 * （AI 输出的场景标识），shots.sceneId 列可能为空（生成路由未回填）。REFERENCE_VIDEO
 * 对齐必须兼容这两种形态，否则切片映射恒为空、参考视频静默丢失。
 */
function effectiveSceneId(shot: {
  sceneId?: string | null;
  metadata?: Record<string, unknown> | null;
}): string | null {
  if (typeof shot.sceneId === 'string' && shot.sceneId.trim()) return shot.sceneId.trim();
  const metadata = shot.metadata ?? {};
  if (typeof metadata.sceneId === 'string' && metadata.sceneId.trim()) return metadata.sceneId.trim();
  const storyboard = metadata.storyboardTable as Record<string, unknown> | null | undefined;
  if (storyboard && typeof storyboard.sceneId === 'string' && storyboard.sceneId.trim()) {
    return storyboard.sceneId.trim();
  }
  return null;
}

/**
 * C/S 参考图索引：服务器只传 sf-asset:// 标识，客户端在真正调用云端模型前读取本地字节。
 * 彩铅开关优先选择已缓存派生图；没有缓存时保留原图并由提示词约束风格，避免重复付费转换。
 */
function buildReferenceAssetIndex(assets: Awaited<ReturnType<typeof listAssets>>): Map<string, ReferenceAsset> {
  const index = new Map<string, ReferenceAsset>();
  for (const asset of assets) {
    const key = `${asset.kind}:${normalizeCharName(asset.name)}`;
    if (!key || index.has(key)) continue;
    const metadata = asset.metadata ?? {};
    const cachedPencil = asset.pencilImageUrl
      ?? (typeof metadata.pencilPaintingUrl === 'string' ? metadata.pencilPaintingUrl : null);
    const url = asset.pencilPaintEnabled === true && cachedPencil
      ? cachedPencil
      : asset.imageUrl;
    const voiceFile = asset.kind === 'CHARACTER' || asset.kind === 'ENTITY'
      ? (() => {
          const confirmed = metadata.confirmed_voice;
          if (confirmed && typeof confirmed === 'object' && !Array.isArray(confirmed)) {
            const file = (confirmed as Record<string, unknown>).file;
            if (typeof file === 'string' && file.trim()) return file.trim();
          }
          return typeof asset.voiceId === 'string' && asset.voiceId.trim()
            ? asset.voiceId.trim()
            : undefined;
        })()
      : undefined;
    // app1 的 ENTITY 可只有音色、没有人物参考图；仍需进入音色索引。
    if (!url && !voiceFile) continue;
    index.set(key, {
      name: asset.name,
      url: url ?? '',
      kind: asset.kind,
      // CHARACTER 对齐 app1：只要进入人物参考通道就必须叠网格，不允许资产级关闭。
      gridEnabled: asset.kind === 'CHARACTER' || asset.gridOverlayEnabled === true,
      ...(voiceFile ? { voiceFile } : {}),
    });
  }
  return index;
}

function collectReferenceAssetsForShot(
  shot: {
    referencedAssets?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  },
  index: Map<string, ReferenceAsset>,
): { characters: ReferenceAsset[]; scenes: ReferenceAsset[] } {
  const refs = shot.referencedAssets ?? {};
  const metadata = shot.metadata ?? {};
  const storyboard = metadata.storyboardTable && typeof metadata.storyboardTable === 'object'
    ? metadata.storyboardTable as Record<string, unknown>
    : {};
  const collect = (field: string, expectedKind?: string): ReferenceAsset[] => {
    const rawValues = [refs[field], storyboard[field]];
    const values = rawValues.flatMap((value) => Array.isArray(value) ? value : []);
    if (!Array.isArray(values)) return [];
    const seen = new Set<string>();
    const result: ReferenceAsset[] = [];
    for (const value of values) {
      const asset = expectedKind
        ? index.get(`${expectedKind}:${normalizeCharName(value)}`)
        : ['LOCATION', 'PROP', 'CHARACTER']
            .map((kind) => index.get(`${kind}:${normalizeCharName(value)}`))
            .find(Boolean);
      if (!asset || !asset.url || (expectedKind && asset.kind !== expectedKind) || seen.has(asset.url)) continue;
      seen.add(asset.url);
      result.push(asset);
    }
    return result;
  };
  return {
    characters: collect('characters', 'CHARACTER'),
    scenes: [...collect('environments', 'LOCATION'), ...collect('items', 'PROP')]
      .filter((asset, position, all) => all.findIndex((item) => item.url === asset.url) === position),
  };
}

function readReferencedNames(
  shot: { referencedAssets?: Record<string, unknown> | null; metadata?: Record<string, unknown> | null },
  field: string,
): string[] {
  const refs = shot.referencedAssets ?? {};
  const metadata = shot.metadata ?? {};
  const storyboard = metadata.storyboardTable && typeof metadata.storyboardTable === 'object'
    ? metadata.storyboardTable as Record<string, unknown>
    : {};
  return [refs[field], storyboard[field]]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function readGroupIndex(shot: { metadata?: Record<string, unknown> | null }): number | null {
  const metadata = shot.metadata ?? {};
  const storyboard = metadata.storyboardTable && typeof metadata.storyboardTable === 'object'
    ? metadata.storyboardTable as Record<string, unknown>
    : {};
  const value = storyboard.groupIndex ?? metadata.groupIndex;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 2026-08-03 修复（Ep24/25 403）：只有"可持久复用"的素材 URL 才能让客户端跳过生成。
 * persistVideo 转存失败时会回退 ARK 原始签名 URL 落库（handlers.ts 注释：约 1h 过期），
 * 若 chain 重跑把它当"已完成"复用，客户端 downloadClips 必吃 403（Ep24/25 重置两次复现）。
 * - sf-asset://                  → 客户端本地成片，永不过期，可复用
 * - 自家 minio 持久 URL（upload() 返回 publicBaseUrl/bucket/key）→ 可复用
 * - ARK/TOS 临时签名桶（tos-*.volces.com / ark-*）→ 一律不可复用，强制重新生成
 */
function isReusableMaterialUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('sf-asset://')) return true;
  if (/tos-[\w-]*\.volces\.com|volces\.com\/doubao-seedance|^https?:\/\/ark-/i.test(url)) {
    return false;
  }
  return true;
}

/** 按 app1 的 groupIndex 聚合，并保证单组不超过 15 秒。 */
function groupShotsForGeneration<T extends { durationSeconds?: number | null; metadata?: Record<string, unknown> | null }>(
  shots: readonly T[],
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentKey: number | null = null;
  let duration = 0;
  for (const shot of shots) {
    const key = readGroupIndex(shot);
    const shotDuration = Math.max(0.1, shot.durationSeconds ?? 2);
    const groupChanged = current.length > 0 && key !== null && currentKey !== null && key !== currentKey;
    if (current.length > 0 && (groupChanged || duration + shotDuration > MAX_GROUP_DURATION_SECONDS + 1e-9)) {
      groups.push(current);
      current = [];
      duration = 0;
    }
    current.push(shot);
    currentKey = key;
    duration += shotDuration;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * 在不改变镜头顺序的前提下按模型参考图上限拆组。
 *
 * 一个镜头自己的引用若已经超限，不能再安全拆镜，原样保留；多个镜头合并才超限时
 * 自动另起一组。对齐 app1 group-service.ts：拆不动（单镜头自身超限）时不硬阻断，
 * 交由 provider 截断兜底，避免复杂场景整批失败。
 */
function splitGroupByReferenceLimit<T extends {
  referencedAssets?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}>(group: readonly T[], index: Map<string, ReferenceAsset>): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentCharacters = new Set<string>();
  let currentScenes = new Set<string>();

  for (const shot of group) {
    const references = collectReferenceAssetsForShot(shot, index);
    const shotCharacters = new Set(references.characters.map((asset) => asset.url));
    const shotScenes = new Set(references.scenes.map((asset) => asset.url));
    const nextCharacters = new Set([...currentCharacters, ...shotCharacters]);
    const nextScenes = new Set([...currentScenes, ...shotScenes]);
    const exceedsLimit =
      nextCharacters.size > MAX_CHARACTER_REFERENCES ||
      nextCharacters.size + nextScenes.size > MAX_TOTAL_REFERENCES;

    if (current.length > 0 && exceedsLimit) {
      groups.push(current);
      current = [];
      currentCharacters = new Set<string>();
      currentScenes = new Set<string>();
    }
    current.push(shot);
    for (const url of shotCharacters) currentCharacters.add(url);
    for (const url of shotScenes) currentScenes.add(url);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, episodeId } = await params;

    // ownership
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const sceneSpatialLayoutMap = buildSceneSpatialLayoutMap(episode.scriptData);
    const sceneTimeOfDayMap = buildSceneTimeOfDayMap(episode.scriptData);
    const sceneBlockingImageMap = buildSceneBlockingImageMap(episode.scriptData, sceneSpatialLayoutMap);

    // 余额前置预检（对齐 app1 precheckBalance）：0 积分挡在昂贵 AI 调用之前。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    // 先解析请求范围与生成参数。shotIds 缺省表示整集；显式提供则只能是非空、
    // 无重复的字符串数组。并行模式在客户端执行，服务器只负责校验和固化执行策略。
    let body: Record<string, unknown>;
    try {
      const raw = (await req.json()) as unknown;
      body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    } catch {
      body = {};
    }

    const force = body.force === true;
    const parallelMode = body.parallelMode === undefined ? 'strict' : body.parallelMode;
    if (parallelMode !== 'strict' && parallelMode !== 'fast') {
      return apiFail(
        {
          error: 'parallelMode 必须为 strict 或 fast',
          code: 'INVALID_PARALLEL_MODE',
        },
        400,
      );
    }
    const parallelConcurrency = body.parallelConcurrency === undefined
      ? 3
      : body.parallelConcurrency;
    if (!Number.isInteger(parallelConcurrency) || Number(parallelConcurrency) < 1 || Number(parallelConcurrency) > 12) {
      return apiFail(
        { error: 'parallelConcurrency 必须是 1-12 的整数', code: 'INVALID_PARALLEL_CONCURRENCY' },
        400,
      );
    }
    const pencilPaintingMode = body.pencilPaintingMode === true;
    if (pencilPaintingMode) {
      return apiFail({
        error: '彩铅参考图转换与缓存协议尚未部署，已拒绝用普通参考图伪装彩铅生成',
        code: 'PENCIL_PIPELINE_UNAVAILABLE',
        suggestion: '请关闭彩铅模式后生成；已有彩铅缓存的资产仍可按资产开关只读使用',
      }, 409);
    }
    const enhancementPrompt = typeof body.enhancementPrompt === 'string'
      ? body.enhancementPrompt.trim().slice(0, 4000)
      : '';
    const gridEnabledOverride = typeof body.gridEnabled === 'boolean' ? body.gridEnabled : undefined;
    const gridCells = body.gridCells === undefined ? 100 : Number(body.gridCells);
    const gridOpacity = body.gridOpacity === undefined ? 0.6 : Number(body.gridOpacity);
    const gridStrokeWidth = body.gridStrokeWidth === undefined ? 1 : Number(body.gridStrokeWidth);
    if (!Number.isInteger(gridCells) || gridCells < 4 || gridCells > 400) {
      return apiFail({ error: 'gridCells 必须是 4-400 的整数', code: 'INVALID_GRID_CELLS' }, 400);
    }
    if (!Number.isFinite(gridOpacity) || gridOpacity < 0 || gridOpacity > 1) {
      return apiFail({ error: 'gridOpacity 必须在 0-1 之间', code: 'INVALID_GRID_OPACITY' }, 400);
    }
    if (!Number.isFinite(gridStrokeWidth) || gridStrokeWidth < 0.1 || gridStrokeWidth > 10) {
      return apiFail({ error: 'gridStrokeWidth 必须在 0.1-10 之间', code: 'INVALID_GRID_STROKE' }, 400);
    }
    const transition = typeof body.transition === 'string' && body.transition.trim()
      ? body.transition.trim().slice(0, 500)
      : undefined;

    let requestedShotIds: string[] | undefined;
    if (Object.prototype.hasOwnProperty.call(body, 'shotIds')) {
      if (
        !Array.isArray(body.shotIds)
        || body.shotIds.length === 0
        || body.shotIds.some((value) => typeof value !== 'string' || !value.trim())
      ) {
        return apiFail(
          { error: 'shotIds 必须是非空镜头 ID 数组', code: 'INVALID_SHOT_IDS' },
          400,
        );
      }
      requestedShotIds = body.shotIds as string[];
      if (new Set(requestedShotIds).size !== requestedShotIds.length) {
        return apiFail(
          { error: 'shotIds 不允许重复', code: 'INVALID_SHOT_IDS' },
          400,
        );
      }
    }

    // 先取该集镜头，再做范围校验；因此其他项目/分集的 ID 与不存在 ID 一律被拒绝，
    // 不会泄露镜头是否存在。服务端顺序是最终权威顺序，避免客户端乱序破坏串联关系。
    const allShots = await listShots(projectId, episodeId);
    if (allShots.length === 0) {
      return apiFail(
        { error: '该集尚无分镜，请先生成分镜', code: 'NO_SHOTS' },
        400,
      );
    }
    const requestedSet = requestedShotIds ? new Set(requestedShotIds) : null;
    const shots = requestedSet
      ? allShots.filter((shot) => requestedSet.has(shot.id))
      : allShots;
    if (requestedShotIds && shots.length !== requestedShotIds.length) {
      return apiFail(
        {
          error: '部分镜头不存在、无权访问或不属于当前分集',
          code: 'INVALID_SHOT_IDS',
        },
        400,
      );
    }
    const scopedShotIds = requestedShotIds
      ? shots.map((shot) => shot.id)
      : undefined;

    // Prompt 预览、准备和真实生成共享同一份项目资产与造型解析，避免 UI 显示
    // 礼服变体而 provider 实际仍收到默认角色图。
    let assets: Awaited<ReturnType<typeof listAssets>>;
    try {
      assets = await listAssets(projectId);
    } catch (error) {
      // A declared character may only be rendered when its identity image can be
      // resolved.  Treat an unavailable asset index exactly like an unresolved
      // character instead of dispatching a video job with no identity lock.
      const declaredCharacters = Array.from(new Set(
        shots.flatMap((shot) => readReferencedNames(shot, 'characters')),
      ));
      if (declaredCharacters.length > 0) {
        return apiFail({
          error: `人物镜头暂时无法读取角色资产图，未开始生成：${declaredCharacters.join('、')}`,
          code: 'CHARACTER_GRID_REFERENCE_REQUIRED',
        }, 400);
      }
      throw error;
    }
    const cachedPencilReferenceUrls = new Set(
      assets.flatMap((asset) => {
        if (asset.pencilPaintEnabled !== true) return [];
        const metadata = asset.metadata ?? {};
        const cachedPencil = asset.pencilImageUrl
          ?? (typeof metadata.pencilPaintingUrl === 'string' ? metadata.pencilPaintingUrl : null);
        return cachedPencil ? [cachedPencil] : [];
      }),
    );

    // 以下参数透传到每个目标镜头组，由客户端 orchestrator 原样 POST 云端视频 API。
   const modelId = (
     typeof body.model === 'string' && body.model.includes('/')
       ? body.model
       : DEFAULT_VIDEO_MODEL
   ).split(':')[0]; // 剥 UI 区分后缀（:15 仅换模型条目），还原真实模型 id
   // 组划分上限跟随请求携带的 maxDuration（UI 选中模型条目语义：2.5 双条目
   // 「30秒·合并组」传 30、「仅换模型」传 15），并钳制到模型能力上限。
   const bodyMaxDuration =
     typeof body.maxDuration === 'number' && body.maxDuration > 0
       ? body.maxDuration
       : 15;
   const maxDuration = Math.min(bodyMaxDuration, maxDurationForVideoModel(modelId));
    // resolution / aspectRatio：字符串透传（UI 的 select 值：480p/720p/1080p/4k
    // + 16:9/9:16/1:1/4:3/3:4/21:9）。云端按 provider 校验/拒绝。
    const resolution = typeof body.resolution === 'string' && body.resolution.length > 0
      ? body.resolution
      : DEFAULT_VIDEO_RESOLUTION;
    const aspectRatioOverride =
      typeof body.aspectRatio === 'string' && body.aspectRatio.length > 0
        ? body.aspectRatio
        : undefined;
    // seed：app1 截断为整数（Math.trunc），undefined 表示由云端随机。
    const seed =
      typeof body.seed === 'number' && Number.isFinite(body.seed)
        ? Math.trunc(body.seed)
        : undefined;
    const watermark = typeof body.watermark === 'boolean' ? body.watermark : undefined;
    const returnLastFrame =
      typeof body.returnLastFrame === 'boolean' ? body.returnLastFrame : undefined;
    const localizationProfile = readLocalizationProfile(episode.scriptData)
      ?? readLocalizationProfile(project.scriptData);
    if (!hasLockedTargetLanguage(project.category, localizationProfile)) {
      return apiFail(
        { error: '海外项目尚未锁定目标语言，请先完成文本转风格', code: 'TARGET_LANGUAGE_REQUIRED' },
        400,
      );
    }
    const costumeMap = mergeCostumeMaps(project.scriptData, episode.scriptData);

    // 组装 CHAIN_COMPILE input：按 app1 的镜头组生成结构化时间码提示词，而不是
    // 把单镜 visualPrompt 直接发给 Seedance。
    // groupResults 在 shared 契约是 {url}[]，⑩ orchestrator 本地扩展可选 params（passthrough）。
    // url 留空串——orchestrator 见 params 即走 cloud 生成；film 由 OP1 本地写
    // （sf-asset://，server 零媒体字节）。generateAudio 固定 true 镜像 app1
    // （原生音频始终开，不接受客户端关闭）。
    //
    // P7.6 网格叠加：每组按镜头引用的 CHARACTER 资产查 gridCharIndex，命中即注入
    // characterReferenceImageUrls + gridEnabled:true。⑩ orchestrator 见两字段后本地
    // 叠稀疏九宫格 → base64 data URL → 云端 AI。无命中时不出现这两字段，默认路径不变。
    // taskId 在组装 params 前生成：已安装的 1.1.6 客户端会原样转发这些参数，
    // 服务端即可在不升级客户端的情况下把同一整片的多组调用累计取整一次。
    const taskId = genId();
    // REFERENCE_VIDEO 转绘：按切片边界对齐分组。
    // 把 shot 的 groupIndex 设为其 sourceClip.index，让 groupShotsForPreparedPrompts
    // 自然按切片分组，避免跨切片拆组导致时长膨胀。
    const isReferenceVideoMode = ((project.scriptData as Record<string, unknown> | null)?.sourceMode) === 'REFERENCE_VIDEO';
    if (isReferenceVideoMode) {
      for (const shot of shots) {
        const clipIdx = (shot.metadata as Record<string, unknown> | null)?.sourceClip as
          | { index?: number }
          | undefined;
        if (clipIdx?.index !== undefined && shot.metadata) {
          (shot.metadata as Record<string, unknown>).groupIndex = clipIdx.index;
        }
      }
    }
    const groupedShotsRaw = groupShotsForPreparedPrompts(shots, assets, costumeMap, maxDuration);
    // REFERENCE_VIDEO: merge sub-groups sharing the same sourceClip.index back
    // into one group. splitShotsByAssetLimit may split a 15s clip into multiple
    // sub-groups, but each clip must be ONE Seedance call (duration = clip duration),
    // otherwise total output duration inflates (e.g. 15+4=19s instead of 15s).
    const groupedShots = isReferenceVideoMode
      ? (() => {
          const merged: typeof groupedShotsRaw = [];
          for (const grp of groupedShotsRaw) {
            const last = merged[merged.length - 1];
            const getClipIdx = (g: typeof grp) =>
              (g[0]?.metadata as Record<string, unknown> | null)?.sourceClip as
                | { index?: number }
                | undefined;
            const lastIdx = last ? getClipIdx(last)?.index : undefined;
            const curIdx = getClipIdx(grp)?.index;
            if (last !== undefined && lastIdx !== undefined && lastIdx === curIdx) {
              merged[merged.length - 1] = [...last, ...grp];
            } else {
              merged.push(grp);
            }
          }
          return merged;
        })()
      : groupedShotsRaw;

    // REFERENCE_VIDEO 转绘：项目级参考视频切片（scriptData.referenceVideo，
    // 客户端切割后经 POST reference-video/clips 落库，零字节元数据）。
    // 场景序列 → 切片映射一次性构建；组循环内按 dominantSceneId 取自己的切片，
    // 组跨场景时取组内主导场景的切片。URL 由服务端从白名单 key 签发，
    // 客户端 body 不接受任何 referenceVideo URL 入参（越权防御）。
    const refVideo = (project.scriptData as Record<string, unknown> | null)?.referenceVideo as
      | ReferenceVideoMeta
      | undefined;
    // K3 结构化镜头表（reference-video/k3-analyze route 存入）：
    // REFERENCE_VIDEO 模式下逐镜头 JSON 数据，DeepSeek 仅做格式整理成 Seedance 提示词。
    const referenceVideoShots = (project.scriptData as Record<string, unknown> | null)
      ?.referenceVideoShots as K3Shot[] | undefined;
    // 分镜落库时 sceneId 只在 metadata.sceneId / storyboardTable.sceneId
    // （AI 输出的场景标识），shots.sceneId 列可能为空（生成路由未回填）。
    // 先统一归一化，否则 REFERENCE_VIDEO 对齐恒空、参考视频静默丢失。
    const shotsWithSceneId = shots.map((shot) => ({
      ...shot,
      sceneId: effectiveSceneId(shot),
    }));
    const alignMap = refVideo?.clips?.length
      ? alignSceneIdsToClips(
          sceneIdSequence(shotsWithSceneId),
          refVideo.clips,
          refVideo.sourceDurationSec,
        )
      : new Map<string, ReferenceVideoMeta['clips'][number]>();
    // 角色资产索引：独立判断「声明角色是否有可用图」，不依赖被槽位截断的 assetRefs，
    // 避免动态上限截断后被截但有图的角色被误判 missing（CHARACTER_GRID_REFERENCE_REQUIRED）。
    const referenceAssetIndex = buildReferenceAssetIndex(assets);
    const groupResults: Array<{
      url: string;
      /** 服务器权威分组范围，供客户端组片完成后安全回写镜头状态。 */
      shotIds: string[];
      params?: Record<string, unknown>;
    }> = [];
    const firstTargetOrder = Math.min(...shots.map((shot) => shot.sortOrder));
    const hasPreviousContext = allShots.some((shot) => shot.sortOrder < firstTargetOrder);
    for (let groupIndex = 0; groupIndex < groupedShots.length; groupIndex += 1) {
      const group = groupedShots[groupIndex];
      // 客户端不能自行重算分组；必须沿用服务器当前用于提示词、计费和参考图的同一范围。
      const groupShotIds = group.map((shot) => shot.id);
      // REFERENCE_VIDEO：组内主导场景 → 对齐切片（无 sceneId / 映射空时 undefined）。
      const dominant = dominantSceneId(group.map((shot) => ({
        sceneId: effectiveSceneId(shot),
      })));
      const referenceVideoClip = dominant ? alignMap.get(dominant) : undefined;
      const prepared = prepareGroupPromptSnapshot({
        shots: group,
        assets,
        costumeMap,
        localizationProfile,
        projectArtStyle: project.artStyle,
        aspectRatio: aspectRatioOverride,
       prevLastFrameHint: parallelMode === 'strict' && (hasPreviousContext || groupIndex > 0),
       sceneSpatialLayoutMap,
       maxDuration,
        sceneTimeOfDayMap,
        sceneBlockingImageMap,
      });
      // REFERENCE_VIDEO + K3: DeepSeek 把 K3 结构化镜头 JSON + 资产描述格式整理成 Seedance 提示词。
      // 严格只做格式调整——禁止扩写、优化、补充内容。
      let mergedK3 = '';
      if (isReferenceVideoMode && referenceVideoShots && referenceVideoShots.length > 0) {
        const groupStartSec = group[0]?.metadata
          ? Number((group[0].metadata as Record<string, unknown>).startTimeSec ?? 0)
          : 0;
        const groupEndSec = group[group.length - 1]?.metadata
          ? Number((group[group.length - 1].metadata as Record<string, unknown>).endTimeSec ?? 999)
          : 999;
        // 取该组时间范围内的 K3 镜头
        const groupShots = referenceVideoShots.filter(
          (s) => s.startTime >= groupStartSec - 0.5 && s.startTime < groupEndSec,
        );
        if (groupShots.length > 0) {
          mergedK3 = await formatSeedancePromptFromK3(
            groupShots,
            assets.filter((a) => a.kind === 'CHARACTER'),
            auth.userId,
          );
        }
      }
      if (mergedK3.length > 50) {
        prepared.prompt = mergedK3;
      }
      const declaredCharacters = Array.from(new Set(group.flatMap((shot) => readReferencedNames(shot, 'characters'))));
      // 独立判断：声明角色是否存在 CHARACTER 资产且有可用图（不再对比被截断的 assetRefs）。
      // 被动态上限截断但有图的角色不算 missing；仅真无图的角色才阻断生成。
      const missingCharacterImages = declaredCharacters.filter((name) => {
        const asset = referenceAssetIndex.get(`CHARACTER:${normalizeCharName(name)}`);
        return !asset || !asset.url;
      });
      if (missingCharacterImages.length > 0) {
        return apiFail(
          {
            error: `人物镜头缺少可用角色资产图，无法生成稀疏网格：${missingCharacterImages.join('、')}`,
            code: 'CHARACTER_GRID_REFERENCE_REQUIRED',
          },
          400,
        );
      }
      const characters = prepared.references.characterImageUrls;
      const scenes = prepared.references.imageUrls;
      const audioReferences = prepared.references.audioUrls;
      const usesCachedPencilReference = [...characters, ...scenes]
        .some((url) => cachedPencilReferenceUrls.has(url));

      // 只有整组已经对应同一个现成素材时才安全复用；否则按组重新生成。
      const completedUrls = group
        .filter(
          (shot) =>
            shot.videoStatus === 'COMPLETED'
            && shot.currentMaterialUrl
            && isReusableMaterialUrl(shot.currentMaterialUrl),
        )
        .map((shot) => shot.currentMaterialUrl as string);
      // 复用门（staleness-aware）：readStoredGroupPrompt 纯读（无 await/副作用），前移到门前；
      // READY（资产图/运镜/座位布局都没改）+ 整组 COMPLETED 同 URL 才复用旧视频，
      // STALE/MISSING（资产/运镜/位置变了）落到下方按组重生成拿新角色/运镜/位置。
      const storedPrompt = readStoredGroupPrompt(group[0].metadata, prepared);
      if (
        shouldReuseGroupVideo(
          force,
          storedPrompt.status,
          completedUrls,
          group.length,
          storedPrompt.versionMatches,
        ) && storedPrompt.referenceHashMatches
      ) {
        groupResults.push({ url: completedUrls[0], shotIds: groupShotIds });
        continue;
      }
      // 生产门禁解除（2026-07-23 指令）：过期（含用户手改来源）的组提示词不再以 409 阻断生成，
      // 与 auto 来源一致地在下方确定性重生成。鉴权/计费门禁不受影响。
      // 层2：READY 还须 seedanceGroupPromptRewritten===true 才算「已过 LLM 审核重写」可复用；
      //   prepare 路由写回的是未重写 prompt（rewritten 缺省 false），此处判为需重写，避免漏过 LLM。
      const groupMeta = (group[0].metadata ?? {}) as Record<string, unknown>;
      const storedRewritten = groupMeta.seedanceGroupPromptRewritten === true;
      // 决策抽出纯函数 resolveGroupExecutablePrompt（可单测）。优先级：用户手改（source='user'）
      //   / 认可锁定（approved）/ READY&&rewritten 缓存 → 用 stored.prompt、不重写；其余用现算
      //   prepared.prompt，MISSING/STALE 需 LLM 重写。
      // 关键修复：source='user' 短路——用户在生成弹窗手改的提示词必须原样送生成，绝不被 LLM
      //   重写偷偷覆盖（兑现 UI「修改后生成将优先使用您的版本」；否则弹窗所见 ≠ 实际所用）。
      // 违禁词 / 退化画面 / 海外文化等机械替换在下方无条件执行，不受本决策影响。
      let executablePrompt: string;
      let needsRewrite: boolean;
      // REFERENCE_VIDEO: K3 merged prompt always wins (bypass stored prompt cache).
      if (isReferenceVideoMode && mergedK3 && mergedK3.length > 50) {
        executablePrompt = mergedK3;
        needsRewrite = false;
      } else {
        const promptDecision = resolveGroupExecutablePrompt({
          storedPrompt,
          storedRewritten,
          preparedPrompt: prepared.prompt,
        });
        executablePrompt = promptDecision.executablePrompt;
        needsRewrite = promptDecision.needsRewrite;
      }
      // Missing/auto-stale prompts are deterministically prepared and persisted
      // before any render job is created. Thus even direct API callers cannot
      // start video generation with an unwritten/transient prompt.
      if (needsRewrite) {
        // 层2：LLM 审核友好重写（创作语境声明规则进 system prompt，重写后 prompt
        //   自然内化；覆盖 sanitize 管不到的年龄词/语义级敏感）。READY 命中跳过（缓存
        //   的已是重写结果）。任一异常降级原 prompt，不阻断主链路。
        let persistedPrompt = prepared.prompt;
        try {
          persistedPrompt = await rewriteGroupPromptForModeration(prepared.prompt, {
            userId: auth.userId,
            assetRefs: prepared.references.assetRefs,
            billingTaskId: taskId,
            groupIndex,
          });
        } catch (error) {
          console.warn(`[chain-generate] 组 ${groupIndex} 提示词 LLM 重写降级，用原 prompt：`, error);
          persistedPrompt = prepared.prompt;
        }
        // 重写（或降级）后确定性补 motion 校准：LLM 可能删掉，统一保证末尾在场。
        persistedPrompt = appendSeedanceMotionCalibration(persistedPrompt);
        // 重写窗口守卫：LLM 重写耗时（秒~数十秒）内用户保存了手改版 → 跳过落库，
        // 保留用户版本（生成仍用重写后文本，但下次生成 resolveGroupExecutablePrompt
        // 分支 1 会原样用用户版——避免重写结果覆盖窗口内保存的手改）。
        const freshFirst = await getShot(group[0].id);
        const freshMeta = (freshFirst?.metadata ?? {}) as Record<string, unknown>;
        const userSavedDuringRewrite = freshMeta.seedanceGroupPromptSource === 'user'
          && typeof freshMeta.seedanceGroupPrompt === 'string'
          && freshMeta.seedanceGroupPrompt.trim();
        if (!userSavedDuringRewrite) {
          await updateShot(group[0].id, {
            metadata: groupPromptMetadata(group[0].metadata, prepared, persistedPrompt, 'auto', true),
          });
        }
        executablePrompt = persistedPrompt;
      }
      // 违禁词最终硬替换：堵 LLM 重写 / 历史 approved 缓存把「帝国」等违禁词写回来的缺口（idempotent，覆盖全分支）
      executablePrompt = sanitizePromptForModeration(executablePrompt).sanitized;
      // 退化画面兜底：黑屏/无主体/无场景等"无意义画面"会让 Seedance 400 或只出静图——
      // 命中即机械改写成"极暗剪影/可见主体"等可生成措辞（覆盖已落库旧坏数据；守卫防误改"纯黑西装"等合法词）。
      if (isDegenerateVisualPrompt(executablePrompt)) {
        executablePrompt = sanitizeDegenerateVisualPrompt(executablePrompt);
      }
      // 海外文化本地化：源片中国短剧的筷子/包子/汉服等会穿帮，海外项目替换为目标文化等价物（覆盖已落库旧分镜）。
      if (String(project.category).toUpperCase() === 'OVERSEAS') {
        executablePrompt = sanitizeOverseasCulturalProps(executablePrompt).sanitized;
      }
      const useGrid = characters.length > 0 || gridEnabledOverride === true;
      groupResults.push({
        url: '',
        shotIds: groupShotIds,
        params: {
          model: modelId,
          prompt: [
            executablePrompt,
            usesCachedPencilReference ? PENCIL_PAINTING_RESTORATION_PROMPT : '',
            enhancementPrompt ? `用户增强要求：${enhancementPrompt}` : '',
          ].filter(Boolean).join('\n\n').trim(),
          duration: (() => {
            if (referenceVideoClip) {
              const clipDur = referenceVideoClip.endSec - referenceVideoClip.startSec;
              const valid = [15, 10, 8, 6, 5, 4];
              const snapped = valid.find((d) => clipDur >= d - 0.5) ?? 4;
              return snapped;
            }
            return prepared.validDuration;
          })(),
          aspectRatio: aspectRatioOverride ?? group[0]?.aspectRatio ?? '9:16',
          resolution,
          // seed 固定:body.seed 优先;否则每镜组从首镜 ID 哈希出确定性 seed(同镜组重生=同 seed=可复现)
          ...(seed !== undefined
            ? { seed }
            : { seed: deterministicSeed(group[0]?.id ?? String(groupIndex)) }),
          ...(watermark !== undefined ? { watermark } : {}),
          ...(returnLastFrame !== undefined ? { returnLastFrame } : {}),
          ...(transition ? { transition } : {}),
          pencilPaintingMode: false,
          generateAudio: true,
          billingTaskId: taskId,
          billingUnitId: String(groupIndex),
          ...(useGrid
            ? {
                ...(characters.length > 0 ? { characterReferenceImageUrls: characters } : {}),
                gridEnabled: useGrid,
                gridCells,
                gridOpacity,
                gridStrokeWidth,
              }
            : {}),
          ...(scenes.length > 0 ? { referenceImageUrls: scenes } : {}),
          ...(audioReferences.length > 0
            ? { referenceAudioFiles: audioReferences }
            : {}),
          // REFERENCE_VIDEO：组内主导场景对齐到的切片 → Seedance reference_video
          // （video-to-video 转绘：原片运动/结构 + 海外资产图替换外观）。
          // 对齐失败（无 sceneId / 映射空）时不注入，降级为现有纯图生视频。
          // REFERENCE_VIDEO 转绘：发送切片元数据（sf-asset:// key + 时间边界），
          // 客户端 applyReferenceVideoClip 本地下载 → 深度图生成 → relay 中转 → ARK。
          // 绝不直接发送 presigned 原始切片 URL（原始人脸会被 ARK PrivacyInformation 拦截）。
          ...(referenceVideoClip
            ? {
                referenceVideoClip: {
                  key: `clip-${referenceVideoClip.index}.mp4`,
                  startSec: referenceVideoClip.startSec,
                  endSec: referenceVideoClip.endSec,
                  index: referenceVideoClip.index,
                },
                referenceVideoClipIndex: referenceVideoClip.index,
              }
            : {}),
        },
      });
    }

    // R6 filmMeta：films GET route 从 input JSONB 提取做项目过滤 + 卡片展示。
    // 子集任务额外记录规范化后的 shotIds，既用于活跃任务精确复用，也让计费/审计
    // 能确认本次真正派发的镜头范围；整集任务不写该字段，保持旧数据契约。
    const totalDuration = shots.reduce(
      (sum, s) => sum + (s.durationSeconds ?? 0),
      0,
    );
    const filmMeta = {
      projectId,
      episodeId,
      episodeNumber: episode.episodeNumber ?? null,
      episodeTitle: episode.title ?? null,
      projectTitle: project.title ?? null,
      shotCount: shots.length,
      totalDuration,
      ...(scopedShotIds ? { shotIds: scopedShotIds } : {}),
    };

    // G3-2（对齐 app1 group-service.ts ~405/500/606/648）：dispatch 前把本次 chain
    // 涉及、且仍可生成的 shot 批量标 GENERATING——让用户切走再回来能看见 per-shot
    // 生成中状态，而不是只有 chain 级进度条。只动 PENDING/FAILED：COMPLETED 不在
    // IN 列表，复用组天然不动（见上文 ~518-524 skip 逻辑）；regen 组里孤立的
    // COMPLETED 也保留原状，由完成回调覆盖。shotIds 取自 groupResults（scoped 子集
    // 与整集两种模式都覆盖），用文件同款 @dramaforge/server 的 query 原语单条 UPDATE。
    const chainShotIds = groupResults.flatMap((group) => group.shotIds);
    if (chainShotIds.length > 0) {
      await query(
        `UPDATE shots
            SET "videoStatus"='GENERATING', "updatedAt"=NOW()
          WHERE id = ANY($1::text[])
            AND "videoStatus" IN ('PENDING','FAILED')`,
        [chainShotIds],
      );
    }

    // 最终的活跃任务检查与 INSERT 必须在一个数据库事务锁内完成；这里不能再拆成
    // route 级 SELECT + dispatch 两步，否则两个并发请求仍会各自创建一条作业。
    const dispatched = await dispatchChainGenerateOnce(taskId, auth.userId, {
      groupResults,
      filmMeta,
      execution: {
        mode: parallelMode === 'fast' ? 'parallel' : 'strict',
        concurrency: Number(parallelConcurrency),
      },
    });

    if (dispatched.reused) {
      return apiSuccess({
        reused: true,
        renderJobId: dispatched.job.id,
        taskId: dispatched.job.taskId,
        groupCount: (dispatched.job.input as { groupResults?: unknown[] }).groupResults?.length ?? 0,
      }, 202);
    }

    return apiSuccess({
      renderJobId: dispatched.job.id,
      taskId: dispatched.job.taskId,
      groupCount: groupResults.length,
    });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/episodes/[episodeId]/chain-generate');
  }
}

/**
 * DeepSeek 把 K3 结构化镜头 JSON + 角色资产描述格式整理成 Seedance 提示词。
 * 严格只做格式转换——禁止扩写、优化、补充、改写。
 * DeepSeek 看不到视频，只把 K3 已有的镜头数据按 Seedance 模板排版。
 */
async function formatSeedancePromptFromK3(
  shots: K3Shot[],
  characterAssets: ReadonlyArray<{ name: string; description?: string | null }>,
  userId: string,
): Promise<string> {
  const { provider, model } = parseModel('deepseek/deepseek-v4-flash');

  // 资产描述（供 DeepSeek 了解角色外貌）
  const assetContext = characterAssets.length > 0
    ? '角色资产描述（用于提示词中的外貌部分）：\n' + characterAssets.map((a) =>
        `- ${a.name}: ${a.description || '无描述'}`
      ).join('\n')
    : '';

  const result = await callAI(provider, model, {
    capability: 'text_generation' as const,
    input: {
      messages: [
        {
          role: 'system',
          content: [
            '你是格式转换器。把结构化 JSON 镜头数据整理成 Seedance video-to-video 提示词文本。',
            '严格规则：',
            '1. 只做格式转换，禁止扩写、优化、补充、改写、重述任何内容',
            '2. 每个 JSON 镜头 → 一段提示词文本，包含该镜头的全部信息',
            '3. 格式模板（每段）：',
            '   Shot N [start-ends]: shotType, cameraAngle.',
            '   Action: <action字段原样>',
            '   Emotion: <emotion字段原样>',
            '   Characters: <characters字段> with <对应资产描述>',
            '   Setting: <setting>, <location>',
            '   Dialogue: <dialogue原样>',
            '4. 所有内容必须来自 JSON 数据，不得添加 JSON 中没有的信息',
            '5. 保持无字幕、无水印、无 Logo',
            '   Photorealistic, natural daylight, 35mm film aesthetic.',
            '',
            assetContext,
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(shots, null, 2),
        },
      ],
      temperature: 0.1,
      maxTokens: 8192,
      thinking: 'disabled',
    },
    userId,
  });

  const meta = (result.meta ?? {}) as Record<string, unknown>;
  return typeof meta.content === 'string' ? meta.content : '';
}
