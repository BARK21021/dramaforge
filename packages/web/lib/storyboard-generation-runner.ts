// ============================================================
// web/lib/storyboard-generation-runner — 分镜生成后台 runner（B2 inline-task + B1 扣费后移）
// ============================================================
//
// 文件职责：
//   runStoryboardGeneration(input) — 由 generate-storyboard 路由 fire-and-forget 调起，
//   在 web 长驻进程里跑完 callAI + 解析 + 后处理 + 落库，全程经 reportInlineAiTaskProgress
//   推 SSE 实时进度。成功 → completeInlineAiTask + 扣费 + replaceEpisodeShots；失败 →
//   failInlineAiTask + 不扣费（不动 episode.stageStatus，保留分析成果可重试）。
//
// 来源：抽自 generate-storyboard/route.ts:178-444（同步阻塞版）。关键改造（spec B1+B2）：
//   1. 扣费移到 parseStoryboardShots 非空 + 即将 replaceEpisodeShots 前（原在 callAI 后、
//      解析前扣，空/解析失败也扣 → 资损）。
//   2. callAI 外包 callAIWithTimeout(6min)；挂死即抛 AiCallTimeoutError 走失败路径。
//   3. 各阶段 reportInlineAiTaskProgress（5/15/30/70/90/100），callAI 期间 8s 心跳保活。
//   4. 失败（AI_EMPTY/AI_NO_SHOTS/超时/gateway）→ failInlineAiTask + 不扣费 + 不动 stageStatus。
//
// 与 analyze runner 的差异：分镜失败不回退 stageStatus（分析成果要保留，用户在分镜阶段重试），
// 故无 resetAnalyzingToInput；失败只 failInlineAiTask。
//
// web 禁止 import ffmpeg。
// ============================================================

import {
  callAI,
  GatewayError,
  episodeRepo,
  projectRepo,
  listAssets,
  listShots,
  replaceEpisodeShots,
  buildStoryboardPrompt,
  parseStoryboardShots,
  postprocessStoryboardShots,
  hasLockedTargetLanguage,
  buildLocalizedDurationBudget,
  buildExplicitDurationBudget,
  resolveExplicitStoryboardTarget,
  reportInlineAiTaskProgress,
  completeInlineAiTask,
  failInlineAiTask,
  type ShotCreateInput,
  type ShotRecord,
  type StoryboardScene,
  type StoryboardAssetRef,
  type LocalizationProfile,
  type GatewayResult,
} from '@dramaforge/server';
import { getProjectArtStylePreset } from '@dramaforge/shared';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { callAIWithTimeout, AiCallTimeoutError } from './ai-call-timeout';
import { parseModel } from './model-parser';

const STORYBOARD_CALL_TIMEOUT_MS = 12 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 8_000;
/** 与 analyze runner 一致：空/解析空时带 cache-busting nonce 重试几次。 */
const MAX_STORYBOARD_ATTEMPTS = 2;

export interface RunStoryboardGenerationInput {
  taskId: string;
  userId: string;
  projectId: string;
  episodeId: string;
  /** provider/model-id（路由 parseModel 校验过格式）。 */
  model: string;
  /** 用户弹窗选择的整集目标时长（秒）；undefined 走本地化兜底。 */
  totalDurationSeconds?: number;
}

function startHeartbeat(report: () => Promise<void>, intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => { void report().catch(() => {}); }, intervalMs);
  return () => clearInterval(timer);
}

function safeFailureMessage(err: unknown): string {
  if (err instanceof AiCallTimeoutError) return 'AI 调用超时，请重试';
  if (err instanceof GatewayError) return `AI 服务暂时不可用 [${err.provider}]，请稍后重试`;
  return '分镜生成失败，请重试';
}

/** 读取资产 sourceNames（与原 route readAssetSourceNames 一致）。 */
function readAssetSourceNames(metadata: Record<string, unknown> | null): string[] {
  if (!metadata || !Array.isArray(metadata.sourceNames)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of metadata.sourceNames) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

interface ScriptDataShape {
  scenes?: Array<{
    id?: string; location?: string; time?: string; intExt?: string;
    characters?: string[]; content?: string;
  }>;
  localizationProfile?: LocalizationProfile;
  novelTextHash?: string;
}

/** 后台跑完分镜生成并终态化 task。绝不抛出（所有失败内部消化为 failInlineAiTask）。 */
export async function runStoryboardGeneration(input: RunStoryboardGenerationInput): Promise<void> {
  const { taskId, userId, projectId, episodeId } = input;
  let succeeded = false;
  let failMsg: string | null = null;

  try {
    await reportInlineAiTaskProgress(taskId, userId, 5, '准备分镜生成', 0);

    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== userId) { failMsg = '项目不存在或无权访问'; return; }
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) { failMsg = '分集不存在或已变更'; return; }

    // === REFERENCE_VIDEO 分支：K3 镜头表直接转 shot，不调 AI、不计费 ===
    if (((project.scriptData as Record<string, unknown> | null)?.sourceMode) === 'REFERENCE_VIDEO') {
      const projectSd = (project.scriptData ?? {}) as Record<string, unknown>;
      const episodeSd = (episode.scriptData ?? {}) as Record<string, unknown>;
      const k3Shots = (episodeSd.referenceVideoShots ?? projectSd.referenceVideoShots) as
        | Array<{
          index: number; startTime: number; endTime: number; shotType: string;
          cameraAngle: string; characters: string[]; action: string; emotion: string;
          dialogue: string; setting: string; location: string;
        }>
        | undefined;
      if (!k3Shots || k3Shots.length === 0) { failMsg = 'K3 镜头表为空，请先完成 K3 分析'; return; }

      await reportInlineAiTaskProgress(taskId, userId, 50, '写入 K3 镜头', 50);
      const shotInputs: ShotCreateInput[] = k3Shots.map((s) => {
        const clipIdx = Math.floor(s.startTime / 15);
        const promptParts = [s.shotType, s.cameraAngle, s.action, s.emotion].filter(Boolean);
        const visualPrompt = promptParts.join(', ');
        return {
          projectId, episodeId,
          shotSeq: `S${s.index}`, shotIndex: s.index,
          durationSeconds: Math.max(1, Math.round(s.endTime - s.startTime)),
          visualPrompt,
          stylePrompt: s.location, aspectRatio: '9:16',
          referencedAssets: { characters: s.characters } as Record<string, unknown>,
          metadata: {
            k3Shot: s,
            sceneId: `clip-${clipIdx}`,
            groupIndex: 0,
            sourceClip: { index: clipIdx },
            startTimeSec: s.startTime, endTimeSec: s.endTime,
            ...(s.dialogue ? { dialogue: s.dialogue } : {}),
          },
          sortOrder: s.index, audioType: s.dialogue ? 'dialogue' : 'ambient',
        };
      });
      await replaceEpisodeShots(episodeId, shotInputs);
      await episodeRepo.update(episodeId, { stageStatus: 'storyboard' });
      const shots = await listShots(projectId, episodeId);
      await completeInlineAiTask(taskId, userId, { episodeId, shotCount: shots.length, mode: 'reference_video' });
      succeeded = true;
      return;
    }

    // === 常规 DeepSeek 分镜分支 ===
    const sd = (episode.scriptData ?? null) as ScriptDataShape | null;
    const projectScriptData = project.scriptData as ScriptDataShape | null;
    const localizationProfile = sd?.localizationProfile ?? projectScriptData?.localizationProfile;
    if (!hasLockedTargetLanguage(project.category, localizationProfile)) {
      failMsg = '海外项目尚未锁定目标语言，请先完成文本转风格'; return;
    }
    const rawScenes = Array.isArray(sd?.scenes) ? sd!.scenes : [];
    if (rawScenes.length === 0) { failMsg = '该集尚无场景结构，请先进行编剧分析'; return; }

    const analyzedHash = typeof sd?.novelTextHash === 'string' ? sd!.novelTextHash : null;
    if (analyzedHash) {
      // 陈旧分析检测交由路由层 409；runner 到这里默认分析可用。
    }

    await reportInlineAiTaskProgress(taskId, userId, 15, '装配资产清单', 0);

    const scenes: StoryboardScene[] = rawScenes.map((s, i) => ({
      id: s.id || `S${i + 1}`,
      location: s.location ?? null, time: s.time ?? null, intExt: s.intExt ?? null,
      characters: Array.isArray(s.characters) ? s.characters : null,
      content: s.content ?? '',
    }));

    const allAssets = await listAssets(projectId);
    const buildEpisodeVariants = (
      costumes: unknown, episodeNumber: number,
    ): Array<{ key: string; label: string; description?: string | null }> => {
      const list = Array.isArray(costumes) ? (costumes as Record<string, unknown>[]) : [];
      const active = list.filter((c) => {
        const eps = c.coverageEpisodes ?? c.coverage_episodes;
        if (!Array.isArray(eps) || eps.length === 0) return true;
        return eps.some((n) => Number(n) === episodeNumber);
      });
      return active
        .filter((c) => typeof c.key === 'string' && c.key.trim())
        .map((c) => ({
          key: String(c.key).trim(),
          label: typeof c.label === 'string' ? c.label : '',
          description: typeof c.description === 'string' ? c.description : null,
        }));
    };
    const assets: StoryboardAssetRef[] = allAssets
      .filter((a) => ['CHARACTER', 'PROP', 'LOCATION', 'ENTITY'].includes(a.kind))
      .map((a) => {
        const base = {
          kind: a.kind, name: a.name, description: a.description,
          sourceNames: readAssetSourceNames(a.metadata),
        };
        if (!['PROP', 'LOCATION', 'CHARACTER'].includes(a.kind)) return base;
        const variants = buildEpisodeVariants(a.costumes, episode.episodeNumber);
        return variants.length > 1 ? { ...base, variants } : base;
      });

    let parsed: { provider: string; model: string };
    try { parsed = parseModel(input.model); }
    catch { failMsg = 'model 格式错，请重新选择'; return; }

    const episodeScriptData =
      episode.scriptData && typeof episode.scriptData === 'object'
        ? (episode.scriptData as Record<string, unknown>) : {};
    const sourceDurationSeconds =
      typeof (episodeScriptData as Record<string, unknown>).sourceVideoDurationSeconds === 'number'
        ? (episodeScriptData as Record<string, unknown>).sourceVideoDurationSeconds as number
        : undefined;
    const explicitTarget = resolveExplicitStoryboardTarget(sourceDurationSeconds, input.totalDurationSeconds);
    const durationBudget = explicitTarget
      ? buildExplicitDurationBudget(explicitTarget, localizationProfile)
      : buildLocalizedDurationBudget(localizationProfile, sourceDurationSeconds);
    const { system, user } = buildStoryboardPrompt(scenes, assets, {
      episodeNumber: episode.episodeNumber,
      localizationProfile,
      visualStylePrompt: getProjectArtStylePreset(project.artStyle)?.promptZh,
      durationBudget,
      category: project.category,
    });

    await reportInlineAiTaskProgress(taskId, userId, 30, 'AI 生成中', 0);

    let acceptedResult: GatewayResult | null = null;
    let aiContent = '';
    let parsedShots: ReturnType<typeof parseStoryboardShots> = [];
    let lastFailReason = 'AI 分镜生成返回内容为空';
    let stageProgress = 0;
    const stopHeartbeat = startHeartbeat(async () => {
      stageProgress = Math.min(95, stageProgress + 3);
      await reportInlineAiTaskProgress(taskId, userId, 30, 'AI 生成中', stageProgress);
    });
    try {
      for (let attempt = 1; attempt <= MAX_STORYBOARD_ATTEMPTS; attempt++) {
        // attempt 2+ 前置 nonce 破 DeepSeek prompt 缓存（防污染缓存命中吐空内容）。
        const nonceUser = attempt === 1 ? user : `[分镜请求#${attempt}·${userId.slice(0, 6)}]\n${user}`;
        const result = await callAIWithTimeout({
          call: () => callAI(parsed.provider, parsed.model, {
            capability: 'text_generation',
            input: {
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: nonceUser },
              ],
              temperature: 0.7,
              maxTokens: 131072,
            },
            userId,
          }),
          timeoutMs: STORYBOARD_CALL_TIMEOUT_MS,
        });
        const meta = (result.meta ?? {}) as Record<string, unknown>;
        const content = typeof meta.content === 'string' ? meta.content : '';
        if (!content) { lastFailReason = 'AI 分镜生成返回内容为空'; continue; }
        const candidate = parseStoryboardShots(content);
        if (candidate.length === 0) { lastFailReason = 'AI 未能从场景中拆分出镜头'; continue; }
        acceptedResult = result;
        aiContent = content;
        parsedShots = candidate;
        break;
      }
    } finally {
      stopHeartbeat();
    }

    if (!acceptedResult || parsedShots.length === 0) {
      failMsg = lastFailReason; return;
    }

    await reportInlineAiTaskProgress(taskId, userId, 70, '后处理镜头', 90);

    // === B1 资损止血：扣费只在解析出非空镜头 + 即将落库前 ===
    await billDirectGeneration({
      userId,
      result: acceptedResult,
      description: '分镜生成',
      taskType: 'storyboard_generate',
    });

    await reportInlineAiTaskProgress(taskId, userId, 90, '落库中', 95);

    const targetLanguageCode = localizationProfile?.targetLanguage?.code
      ?? (project.category === 'DOMESTIC' ? 'zh' : undefined);
    const processed = postprocessStoryboardShots(parsedShots, scenes, assets, targetLanguageCode, episode.novelText ?? undefined);
    const coverageByScene = new Map(processed.dialogueCoverage.map((item) => [item.sceneId, item]));
    const replacements = processed.shots.map((sh, index) => {
      const globalIndex = index + 1;
      const groupIndex = sh.groupIndex ?? 0;
      const groupLabel = sh.groupLabel ?? `组 ${groupIndex + 1}`;
      return {
        projectId, episodeId,
        shotIndex: globalIndex,
        shotSeq: sh.sceneId ? `${sh.sceneId}-${sh.shotIndex}` : `SHOT-${globalIndex}`,
        durationSeconds: sh.durationSeconds,
        visualPrompt: sh.visualPrompt,
        purposeTag: sh.purposeTag,
        emotionArcPosition: sh.emotionArcPosition,
        audioType: sh.audioType,
        referencedAssets: {
          characters: sh.characters,
          speakingCharacters: sh.speakingCharacters,
          environments: sh.environments,
          items: sh.items,
          ...(sh.characterCostumes && sh.characterCostumes.length > 0 ? { characterCostumes: sh.characterCostumes } : {}),
          ...(sh.itemCostumes && sh.itemCostumes.length > 0 ? { itemCostumes: sh.itemCostumes } : {}),
          ...(sh.environmentCostumes && sh.environmentCostumes.length > 0 ? { environmentCostumes: sh.environmentCostumes } : {}),
        },
        metadata: {
          sceneId: sh.sceneId || null,
          dialogue: sh.dialogue || null,
          action: sh.action || null,
          shotSize: sh.shotSize || null,
          cameraAngle: sh.cameraAngle || null,
          cameraMovement: sh.cameraMovement || null,
          soundCue: sh.soundCue || null,
          groupIndex, groupLabel,
          dialogueCoverage: coverageByScene.get(sh.sceneId) ?? null,
          storyboardTable: {
            sceneId: sh.sceneId || null, groupIndex, groupLabel,
            shotSize: sh.shotSize || null, cameraAngle: sh.cameraAngle || null,
            cameraMovement: sh.cameraMovement || null, action: sh.action || null,
            soundCue: sh.soundCue || null,
          },
          structuredPrompt: {
            scene: sh.sceneContext || null,
            sceneDesign: sh.sceneDesign || null,
            visualInfo: sh.visualInfo || null,
          },
          source: 'ai',
        },
        sortOrder: globalIndex,
      };
    });
    await replaceEpisodeShots(episodeId, replacements);

    await episodeRepo.update(episodeId, {
      scriptData: { ...episodeScriptData, storyboardWarnings: processed.warnings ?? [] },
    });
    await projectRepo.update(projectId, { status: 'STORYBOARD' });

    const shots: ShotRecord[] = await listShots(projectId, episodeId);
    await completeInlineAiTask(taskId, userId, {
      episodeId, shotCount: shots.length,
      dialogueCoverage: processed.dialogueCoverage,
      warnings: processed.warnings,
    });
    succeeded = true;
  } catch (err) {
    failMsg = safeFailureMessage(err);
  } finally {
    if (!succeeded) {
      await failInlineAiTask(taskId, userId, failMsg ?? '分镜生成失败，请重试').catch(() => {});
    }
  }
}
