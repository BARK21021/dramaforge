// ============================================================
// POST /api/projects/[id]/asset-extraction — 资产提取（P7.2-T2b）
// ============================================================
//
// 项目级：聚合所有已分析 episodes 的 scriptData.scenes → AI 提取角色/物品/环境 →
// 写 assets 表（项目级归属，无 episodeId 列，coverageScenes/costumes 跨集合并）。
// 移植自 app1 src/app/api/projects/[projectId]/asset/extraction/route.ts，并适配 C/S：
//
// 保留：
//   - ownership 校验（project 归属）
//   - 剧本聚合（episodes.scriptData.scenes → markdown，回退 novelText/content）
//   - canonicalCharacterNames（各集 scriptData.characters 聚合，供还原双语姓名）
//   - buildAssetExtractionPrompt → callAI(text_generation, temp 0.3, maxTokens 393216)
//   - parseAssetExtraction → reconcileExtractedAssetCharacterNames → 过滤 isAnonymousCharacterName
//   - replaceExtractedAssets 跨集复用 CHARACTER/PROP/LOCATION/ENTITY 富资产
//   - costumeMap、characterMapping、voiceManifest 与 localizationProfile 一并注入
//   - 不单独冻结预估额度；成功结果按网关真实 token 成本写账本
//
// 鉴权：session REQUIRED。响应（UI-facing envelope）：
//   200 { success:true, data: { counts, assets } }
//   400 EMPTY_SCRIPT（项目下所有分集剧本不足 50 字符）
//   401 UNAUTHORIZED / 404 NOT_FOUND
//   502 AI_GATEWAY_ERROR / AI_EMPTY / AI_NO_ASSETS
//
// web 禁止 import ffmpeg。零 ffmpeg 依赖。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  callAI,
  GatewayError,
  episodeRepo,
  projectRepo,
  listAssets,
  replaceExtractedAssets,
  supplementExtractedCostumes,
  buildAssetExtractionPrompt,
  parseAssetExtraction,
  reconcileExtractedAssetCharacterNames,
  validateSuggestedVoices,
  languageFromCategory,
  readLocalizationProfile,
  parseScriptResult,
  loadPresetVoiceManifest,
  type AssetRecord,
  type CostumeMapEntry,
} from '@dramaforge/server';
import { getProjectArtStylePreset } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** 默认资产提取模型（对齐 app1，低温度保证提取稳定）。 */
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/** 剧本聚合下限（字符）。app1 同值。 */
const MIN_SCRIPT_LEN = 50;

/**
 * 从 model ID 拆分 provider 前缀（与 analyze route 同逻辑）。
 * "deepseek/deepseek-v4-flash" → { provider: 'deepseek', model: 'deepseek/deepseek-v4-flash' }
 */
function parseModel(model: string): { provider: string; model: string } {
  const idx = model.indexOf('/');
  if (idx <= 0) {
    throw new Error(`model 缺少 provider 前缀（应为 "provider/model-id"）: ${model}`);
  }
  return { provider: model.slice(0, idx), model };
}

/** 单集 scriptData 的场景子集（聚合用）。 */
interface SceneShape {
  id?: string;
  location?: string;
  time?: string;
  intExt?: string;
  content?: string;
}

interface ScriptDataShape {
  scenes?: SceneShape[];
  characters?: string[];
  analysisGuidance?: string;
  localizationProfile?: unknown;
  costumeMap?: unknown;
  rawText?: string;
}

function readCostumeMap(value: unknown): CostumeMapEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const sceneId = typeof item.sceneId === 'string' ? item.sceneId.trim() : '';
    const character = typeof item.character === 'string' ? item.character.trim() : '';
    const costumeLabel = typeof item.costumeLabel === 'string' ? item.costumeLabel.trim() : '';
    if (!sceneId || !character || !costumeLabel) return [];
    return [{
      sceneId,
      character,
      costumeLabel,
      costumeDesc: typeof item.costumeDesc === 'string' ? item.costumeDesc.trim() : '',
      isNew: item.isNew === true,
    }];
  });
}

/** Merge duplicate scene/character/label rows while retaining the most specific description. */
function mergeCostumeMap(target: Map<string, CostumeMapEntry>, value: unknown): void {
  for (const entry of readCostumeMap(value)) {
    const key = `${entry.sceneId}\u0000${entry.character}\u0000${entry.costumeLabel}`;
    const previous = target.get(key);
    if (!previous) {
      target.set(key, entry);
      continue;
    }
    target.set(key, {
      ...previous,
      costumeDesc: entry.costumeDesc.length > previous.costumeDesc.length
        ? entry.costumeDesc
        : previous.costumeDesc,
      isNew: previous.isNew || entry.isNew,
    });
  }
}

/**
 * 把单集格式化为供 AI 提取的剧本文本。
 * 优先 scriptData.scenes（结构化，markdown 头标注场景元信息），回退 novelText / content。
 */
function episodeToScriptText(ep: {
  scriptData?: unknown;
  novelText?: string | null;
  content?: string | null;
}): string {
  const sd = (ep.scriptData ?? null) as ScriptDataShape | null;
  if (sd?.scenes && sd.scenes.length > 0) {
    return sd.scenes
      .map(
        (s) =>
          `## ${s.id ?? ''} [${[s.location, s.time, s.intExt].filter(Boolean).join(' · ')}]\n${s.content ?? ''}`,
      )
      .join('\n\n');
  }
  return (ep.novelText ?? ep.content ?? '').toString();
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;

    // 1. ownership：项目归属（统一 404 不泄露存在性）
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 余额前置预检（对齐 app1 precheckBalance）：0 积分挡在昂贵 AI 调用之前。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    // 2. 聚合所有分集剧本 + 规范角色名清单（跨集去重）
    const episodes = await episodeRepo.listByProject(projectId);
    const epTexts: string[] = [];
    const canonicalSet = new Set<string>();
    const costumeMapByIdentity = new Map<string, CostumeMapEntry>();
    let analysisGuidance = '';
    let localizationProfile = readLocalizationProfile(project.scriptData);
    const projectScriptData = (project.scriptData ?? null) as ScriptDataShape | null;
    mergeCostumeMap(costumeMapByIdentity, projectScriptData?.costumeMap);
    for (const ep of episodes) {
      const text = episodeToScriptText(ep);
      if (text.trim()) {
        epTexts.push(`=== EP${ep.episodeNumber} ${ep.title ?? ''} ===\n${text}`);
      }
      const sd = (ep.scriptData ?? null) as ScriptDataShape | null;
      mergeCostumeMap(costumeMapByIdentity, sd?.costumeMap);
      if (!localizationProfile) localizationProfile = readLocalizationProfile(sd);
      if (!analysisGuidance && typeof sd?.analysisGuidance === 'string') {
        analysisGuidance = sd.analysisGuidance.trim();
      }
      if (Array.isArray(sd?.characters)) {
        for (const c of sd.characters) {
          if (typeof c === 'string' && c.trim()) canonicalSet.add(c.trim());
        }
      }
    }
    // app1 compatibility for projects analyzed before costumeMap became a persisted field.
    if (costumeMapByIdentity.size === 0 && typeof projectScriptData?.rawText === 'string') {
      try {
        mergeCostumeMap(costumeMapByIdentity, parseScriptResult(projectScriptData.rawText).costumeMap);
      } catch {
        // A malformed legacy rawText must not block normal extraction.
      }
    }
    const costumeMap = Array.from(costumeMapByIdentity.values());
    for (const entry of costumeMap) canonicalSet.add(entry.character);
    const scriptText = epTexts.join('\n\n');

    if (scriptText.trim().length < MIN_SCRIPT_LEN) {
      return apiFail(
        {
          error: '项目下分集剧本内容不足，请先在分集阶段保存并分析至少一集剧本',
          code: 'EMPTY_SCRIPT',
        },
        400,
      );
    }

    // 3. 请求体：model（可选，默认）
    let body: { model?: unknown };
    try {
      const raw = (await req.json()) as unknown;
      body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { model?: unknown })
        : {};
    } catch {
      body = {};
    }
    const modelId =
      typeof body.model === 'string' && body.model.length > 0 ? body.model : DEFAULT_MODEL;

    let parsed: { provider: string; model: string };
    try {
      parsed = parseModel(modelId);
    } catch (err) {
      return apiFail(
        { error: err instanceof Error ? err.message : 'model 格式错', code: 'BAD_MODEL' },
        400,
      );
    }

    // 4. 构造提取 prompt（批6 音色库：喂 voiceManifest → AI 输出 suggested_voices）
    //    voiceManifest 是纯文本清单（200 条 {file,gender,dur,desc,text,lang}），不违反
    //    dramaforge-assets-client-local（那只禁媒体字节）；wav 字节仍只客户端持有。
    const canonicalCharacterNames = Array.from(canonicalSet);
    const language = languageFromCategory(project.category, scriptText);
    const voiceManifest = loadPresetVoiceManifest();
    const projectStyle = getProjectArtStylePreset(project.artStyle);
    const existingAssets = await listAssets(projectId);
    for (const asset of existingAssets) {
      if (asset.kind === 'CHARACTER' && asset.name.trim()) canonicalCharacterNames.push(asset.name.trim());
    }
    const mappingContainer = project.characterMapping && typeof project.characterMapping === 'object'
      ? project.characterMapping as Record<string, unknown>
      : null;
    const characterMapping = Array.isArray(mappingContainer?.entries)
      ? mappingContainer.entries.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const item = entry as Record<string, unknown>;
          if (typeof item.characterId !== 'string' || !item.characterId.trim()) return [];
          return [{
            characterId: item.characterId.trim(),
            roleIdentity: typeof item.roleIdentity === 'string' ? item.roleIdentity : '',
            name: typeof item.name === 'string' ? item.name : null,
            firstEpisode: typeof item.firstEpisode === 'number' ? item.firstEpisode : 1,
          }];
        })
      : [];
    const { system, user } = buildAssetExtractionPrompt(
      scriptText,
      voiceManifest,
      {
        canonicalCharacterNames,
        overseasAdaptation: project.category === 'OVERSEAS',
        localizationProfile,
        analysisGuidance,
        visualStylePrompt: language === 'en' ? projectStyle?.promptEn : projectStyle?.promptZh,
        existingCharacters: existingAssets
          .filter((asset) => asset.kind === 'CHARACTER')
          .map((asset) => ({
            name: asset.name,
            costumes: (asset.costumes ?? []).map((costume) => ({
              key: typeof costume.key === 'string' ? costume.key : 'default',
              label: typeof costume.label === 'string' ? costume.label : '默认',
            })),
          })),
        existingItems: existingAssets
          .filter((asset) => asset.kind === 'PROP')
          .map((asset) => ({ name: asset.name, description: asset.description ?? undefined })),
        existingEnvironments: existingAssets
          .filter((asset) => asset.kind === 'LOCATION')
          .map((asset) => ({
            name: asset.name,
            description: asset.description ?? undefined,
            int_ext: asset.intExt ?? undefined,
          })),
        characterMapping,
        costumeMap,
      },
      language,
    );

    // 5. AI 提取（低温度 0.3 保证稳定；maxTokens 拉满防 JSON 中途截断）
    let aiContent = '';
    try {
      const result = await callAI(parsed.provider, parsed.model, {
        capability: 'text_generation',
        input: {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.3,
          maxTokens: 393216,
        },
        userId: auth.userId,
      });
      await billDirectGeneration({
        userId: auth.userId,
        result,
        description: '项目资产提取',
        taskType: 'asset_extraction',
      });
      const meta = (result.meta ?? {}) as Record<string, unknown>;
      aiContent = typeof meta.content === 'string' ? meta.content : '';
    } catch (err) {
      if (err instanceof GatewayError) {
        return apiFail(
          {
            error: `AI 资产提取失败 [provider=${err.provider}]: ${err.message}`,
            code: 'AI_GATEWAY_ERROR',
            category: 'provider',
            retryable: true,
          },
          502,
        );
      }
      throw err;
    }

    if (!aiContent) {
      return apiFail(
        { error: 'AI 资产提取返回内容为空', code: 'AI_EMPTY', category: 'provider' },
        502,
      );
    }

    // 6. 解析 + 双语姓名还原 + 音色文件名三级匹配校正
    //    批6 音色库：validateSuggestedVoices 把 AI 返回的 suggested_voices 文件名
    //    校正到 manifest 内真实存在的文件（exact / prefix / desc 相似度三级匹配），
    //    避免下游 UI 选了不存在的 wav。空 manifest 时透传（本次不会发生，manifest 已加载）。
    //    路人/群演保留（用户需求：剧本所有背景角色都要保留，无名按「身份+天干」编号命名），
    //    不再过滤 isAnonymousCharacterName（与 app1 extraction/route.ts 相反）。
    const extracted = parseAssetExtraction(aiContent);
    const voiceFixed = validateSuggestedVoices(extracted, voiceManifest);
    const validated = reconcileExtractedAssetCharacterNames(voiceFixed, canonicalCharacterNames);
    supplementExtractedCostumes(validated, costumeMap);

    if (
      validated.characters.length === 0 &&
      validated.items.length === 0 &&
      validated.environments.length === 0
    ) {
      return apiFail(
        { error: 'AI 未能从剧本中提取资产，请检查剧本内容', code: 'AI_NO_ASSETS', category: 'provider' },
        502,
      );
    }

    // 7. 落库（清理未确认 + 插入；保留用户已确认/锁定/生图成果）
    const counts = await replaceExtractedAssets(projectId, validated);

    // 8. 返回最新资产清单（UI 直接渲染）
    const assets: AssetRecord[] = await listAssets(projectId);

    return apiSuccess({ counts, assets });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/asset-extraction');
  }
}
