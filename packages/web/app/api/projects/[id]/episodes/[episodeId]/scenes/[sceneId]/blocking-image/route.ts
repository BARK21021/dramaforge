// ============================================================
// POST  /api/projects/[id]/episodes/[episodeId]/scenes/[sceneId]/blocking-image
// PUT   /api/projects/[id]/episodes/[episodeId]/scenes/[sceneId]/blocking-image
// — 每场景站位图（blocking image）生成 + 落地提交
// ============================================================
//
// 跨镜头组空间锁定·视觉版：每个含座位布局的场景生成一张写实定场站位图
// （无脸人形占位 + 烘焙道具），作为场景定调参考图喂给该场景所有镜头组。
// 镜像资产生图模式：服务端 ARK doubao-seedream 生图 → 返回临时 provider URL →
// 客户端 downloadAsset 下回本地 sf-asset:// → PUT 提交写回 scriptData。
//
// 存储：scriptData.sceneBlockingImages[baseSceneId]（顶层兄弟 map，被 analyze 的
// ...existingScriptData spread 保留——不能挂 SceneInfo，re-analyze 会整体替换 scenes）。
//
// 鉴权：session REQUIRED。响应：
//   POST 201 { providerUrl, prompt, sceneId, version } / 400 NO_SPATIAL_LAYOUT / 402 余额 / 502 AI_GATEWAY_ERROR
//   PUT  200 { sceneId, url, version } / 404 NO_GENERATING_RECORD
//
// web 禁止 import ffmpeg。零 ffmpeg 依赖。媒体只落客户端。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  episodeRepo,
  listShots,
  projectRepo,
  callAI,
  getResolutionByKey,
  sanitizePromptForModeration,
  buildBlockingImagePrompt,
} from '@dramaforge/server';
import { getProjectArtStylePreset } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { readBodyWithLimit } from '@web/lib/sms-security';

/** 默认出图模型（对齐资产生图：ARK Doubao Seedream）。 */
const DEFAULT_MODEL = 'ark/doubao-seedream-5-0-260128';
/** 负面提示词只保留水印/logo（用户需求）。 */
const DEFAULT_NEGATIVE_PROMPT = '水印, logo';
const BODY_LIMIT_BYTES = 64 * 1024;

/** S3-1 → S3；与 group-preview extractBaseSceneId 同义。 */
function extractBaseSceneId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/^(S\d+)/i);
  return match ? match[1].toUpperCase() : value.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readTextList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
    : [];
}

/** 归一化网关图片结果，兼容 meta.images 的对象/字符串形态（镜像 generate-image）。 */
function extractProviderImages(result: { url?: string; meta?: Record<string, unknown> }): string[] {
  const raw = Array.isArray(result.meta?.images) ? result.meta.images : [];
  const images = raw
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') {
        return String((item as { url: string }).url);
      }
      return '';
    })
    .filter(Boolean);
  if (images.length === 0 && result.url) images.push(result.url);
  return images;
}

/** 从 episode.scriptData.scenes 解析指定场景（按 baseSceneId 归一化匹配）。 */
function findScene(
  scriptData: unknown,
  sceneId: string,
): { scene: { location?: string; time?: string; intExt?: string; spatialLayout?: string }; index: number } | null {
  const scenes = asRecord(scriptData).scenes;
  if (!Array.isArray(scenes)) return null;
  const target = extractBaseSceneId(sceneId);
  if (!target) return null;
  for (let index = 0; index < scenes.length; index += 1) {
    const rec = asRecord(scenes[index]);
    if (extractBaseSceneId(rec.id) === target) {
      return {
        scene: {
          location: typeof rec.location === 'string' ? rec.location : undefined,
          time: typeof rec.time === 'string' ? rec.time : undefined,
          intExt: typeof rec.intExt === 'string' ? rec.intExt : undefined,
          spatialLayout: typeof rec.spatialLayout === 'string' ? rec.spatialLayout : undefined,
        },
        index,
      };
    }
  }
  return null;
}

/** 读 scriptData.sceneBlockingImages（顶层兄弟 map）。 */
function readBlockingRecords(scriptData: unknown): Record<string, Record<string, unknown>> {
  const raw = asRecord(scriptData).sceneBlockingImages;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, Record<string, unknown>>;
}

/** 该场景可见道具名（去重）：从本集该场景镜头的 referencedAssets.items + storyboard.items。 */
function collectScenePropNames(
  shots: ReadonlyArray<{ referencedAssets?: unknown; metadata?: unknown; sceneId?: unknown }>,
  sceneId: string,
): string[] {
  const target = extractBaseSceneId(sceneId);
  if (!target) return [];
  const acc: string[] = [];
  for (const shot of shots) {
    const meta = asRecord(shot.metadata);
    const storyboard = asRecord(meta.storyboardTable);
    const shotScene = readText(meta.sceneId)
      ?? readText((shot as { sceneId?: unknown }).sceneId)
      ?? readText(storyboard.sceneId);
    if (extractBaseSceneId(shotScene) !== target) continue;
    const references = asRecord(shot.referencedAssets);
    acc.push(...readTextList(references.items), ...readTextList(storyboard.items));
  }
  return Array.from(new Set(acc));
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function loadEpisodeOwned(projectId: string, episodeId: string, userId: string) {
  const project = await projectRepo.getById(projectId);
  if (!project || project.userId !== userId) return { error: 'NOT_FOUND' as const };
  const episode = await episodeRepo.getById(episodeId);
  if (!episode || episode.projectId !== projectId) return { error: 'NOT_FOUND' as const };
  return { project, episode };
}

// ----------------------------------------------------------------------
// POST — 生成站位图（同步调 ARK，返回临时 provider URL；写 GENERATING 记录）
// ----------------------------------------------------------------------
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string; sceneId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { id: projectId, episodeId, sceneId } = await params;

    const owned = await loadEpisodeOwned(projectId, episodeId, auth.userId);
    if ('error' in owned) return apiFail({ error: '不存在或无权访问', code: owned.error }, 404);
    const { project, episode } = owned;

    const found = findScene(episode.scriptData, sceneId);
    if (!found) return apiFail({ error: '场景不存在', code: 'NOT_FOUND' }, 404);
    const spatialLayout = (found.scene.spatialLayout ?? '').trim();
    if (!spatialLayout) {
      return apiFail(
        { error: '该场景无座位布局，无需生成站位图（请先重新分析该集）', code: 'NO_SPATIAL_LAYOUT' },
        400,
      );
    }

    // 余额前置预检（对齐 app1 precheckBalance）：0 积分挡在昂贵 AI 调用之前。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    // 构造出图 prompt：项目五维风格锁置顶 + 场景站位图 body + 敏感词委婉化。
    const lockedStyle = project.artStyle ? getProjectArtStylePreset(project.artStyle) : null;
    const styleLock = lockedStyle ? lockedStyle.lockContentZh : '';
    const shots = await listShots(projectId, episodeId);
    const propNames = collectScenePropNames(shots, sceneId);
    const rawPrompt = buildBlockingImagePrompt(
      found.scene,
      spatialLayout,
      propNames,
      { styleLock },
    );
    const prompt = sanitizePromptForModeration(rawPrompt).sanitized;
    const resolved = getResolutionByKey('2K'); // 16:9 定场全景（1920×1080）

    // 写 GENERATING 记录（version 自增；存 prompt/sourceSpatialLayout 供 PUT 提交）。
    const baseSceneId = extractBaseSceneId(sceneId);
    const scriptData = asRecord(episode.scriptData);
    const existingRecords = readBlockingRecords(scriptData);
    const existing = asRecord(existingRecords[baseSceneId]);
    const version = (typeof existing.version === 'number' ? existing.version : 0) + 1;
    const generatingScriptData = {
      ...scriptData,
      sceneBlockingImages: {
        ...existingRecords,
        [baseSceneId]: {
          version,
          sourceSpatialLayout: spatialLayout,
          prompt,
          status: 'GENERATING',
          createdAt: new Date().toISOString(),
        },
      },
    };
    await episodeRepo.update(episodeId, { scriptData: generatingScriptData });

    const provider = DEFAULT_MODEL.slice(0, DEFAULT_MODEL.indexOf('/'));
    let providerUrl: string;
    try {
      const result = await callAI(provider, DEFAULT_MODEL, {
        capability: 'image_generation',
        input: {
          prompt,
          negativePrompt: DEFAULT_NEGATIVE_PROMPT,
          width: resolved.width,
          height: resolved.height,
        },
        userId: auth.userId,
      });
      const images = extractProviderImages(result);
      if (images.length === 0) throw new Error('AI 模型未返回图片');
      providerUrl = images[0];
      await billDirectGeneration({
        userId: auth.userId,
        result,
        description: '场景站位图生成',
        taskType: 'ASSET_IMAGE_GENERATE_STREAM',
      });
    } catch (error) {
      // 标记 FAILED（刷新后能看到失败，而非永久 GENERATING 转圈）。
      const failedScriptData = {
        ...generatingScriptData,
        sceneBlockingImages: {
          ...generatingScriptData.sceneBlockingImages,
          [baseSceneId]: {
            ...generatingScriptData.sceneBlockingImages[baseSceneId],
            status: 'FAILED',
            error: error instanceof Error ? error.message.slice(0, 500) : '站位图生成失败',
          },
        },
      };
      await episodeRepo.update(episodeId, { scriptData: failedScriptData }).catch(() => undefined);
      throw error;
    }

    return apiSuccess(
      { providerUrl, prompt, sceneId: baseSceneId, version },
      201,
    );
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/episodes/[episodeId]/scenes/[sceneId]/blocking-image');
  }
}

// ----------------------------------------------------------------------
// PUT — 客户端下回本地后提交 sf-asset:// key，翻 GENERATING → COMMITTED
// ----------------------------------------------------------------------
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string; sceneId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { id: projectId, episodeId, sceneId } = await params;

    const owned = await loadEpisodeOwned(projectId, episodeId, auth.userId);
    if ('error' in owned) return apiFail({ error: '不存在或无权访问', code: owned.error }, 404);
    const { episode } = owned;

    const bodyResult = await readBodyWithLimit<{ key?: unknown; url?: unknown }>(req, BODY_LIMIT_BYTES);
    if (!bodyResult.ok) return apiFail(bodyResult.payload, bodyResult.status);
    const body = bodyResult.body && typeof bodyResult.body === 'object' && !Array.isArray(bodyResult.body)
      ? (bodyResult.body as { key?: unknown; url?: unknown })
      : {};
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!/^sf-asset:\/\//.test(url) || !key) {
      return apiFail({ error: '缺少有效的本地资产 key/url', code: 'BAD_COMMIT' }, 400);
    }

    const baseSceneId = extractBaseSceneId(sceneId);
    const scriptData = asRecord(episode.scriptData);
    const records = readBlockingRecords(scriptData);
    const record = asRecord(records[baseSceneId]);
    if (record.status !== 'GENERATING') {
      return apiFail(
        { error: '无进行中的站位图生成记录，请重新生成', code: 'NO_GENERATING_RECORD' },
        404,
      );
    }

    const committedScriptData = {
      ...scriptData,
      sceneBlockingImages: {
        ...records,
        [baseSceneId]: {
          ...record,
          key,
          url,
          status: 'COMMITTED',
          committedAt: new Date().toISOString(),
        },
      },
    };
    await episodeRepo.update(episodeId, { scriptData: committedScriptData });

    return apiSuccess({
      sceneId: baseSceneId,
      url,
      version: typeof record.version === 'number' ? record.version : 1,
    });
  } catch (err) {
    return handleApiError(err, 'PUT /api/projects/[id]/episodes/[episodeId]/scenes/[sceneId]/blocking-image');
  }
}
