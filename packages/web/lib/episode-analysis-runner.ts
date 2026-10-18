// ============================================================
// web/lib/episode-analysis-runner — 编剧分析后台 runner（B2 inline-task + B1 扣费后移）
// ============================================================
//
// 文件职责：
//   runEpisodeAnalysis(input) — 由 analyze 路由 fire-and-forget 调起，在 web 进程
//   长驻 Node 里跑完 callAI 重试循环 + 校验 + 持久化，全程经 reportInlineAiTaskProgress
//   推 SSE 实时进度。成功 → completeInlineAiTask + 扣费 + 落库；失败 → failInlineAiTask
//   + stageStatus 复位 + 不扣费。
//
// 来源：抽自 analyze/route.ts:127-278（同步阻塞版本）。关键改造（spec B1+B2）：
//   1. 扣费移到 validateAnalysisConsistency 通过 + 即将持久化前（原在循环内每次
//      callAI 后扣，空内容也扣 → 资损）。
//   2. callAI 外包 callAIWithTimeout(6min)；挂死即抛 AiCallTimeoutError 走失败路径。
//   3. 各阶段 reportInlineAiTaskProgress（5/15/30/70/90/100），callAI 期间 8s 心跳
//      保 SSE 活 + 防任务卡进度条。
//   4. 失败（空/parse空/不一致/超时/gateway）→ failInlineAiTask + resetAnalyzingToInput
//      + 不扣费。
//   5. try/finally：finally 确保 stageStatus 终态化（成功→assets 由 update 推进；
//      失败→input 由 resetAnalyzingToInput），绝不留 analyzing。
//
// 注意：失败复位用 episodeRepo.resetAnalyzingToInput（裸 SQL），不能用 update
// ({stageStatus:'input'})——update 的单调推进守卫会把 analyzing→input 回退静默忽略
// （那是「卡死 analyzing」的隐藏根因）。
//
// web 禁止 import 任何 ffmpeg 模块；本模块只做文本/DB/SSE。
// ============================================================

import {
  callAI,
  GatewayError,
  episodeRepo,
  listAssets,
  buildScriptAnalysisPrompt,
  parseScriptResult,
  validateAnalysisConsistency,
  detectLanguage,
  reportInlineAiTaskProgress,
  completeInlineAiTask,
  failInlineAiTask,
  type GatewayResult,
  type LocalizationProfile,
} from '@dramaforge/server';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { callAIWithTimeout, AiCallTimeoutError } from './ai-call-timeout';
import { buildEpisodeAnalysisContext } from './episode-analysis-context';
import { parseModel } from './model-parser';
import { createHash } from 'crypto';

/** 文本类 AI 调用超时（>单次 DeepSeek 典型时长 + 余量）。 */
const ANALYSIS_CALL_TIMEOUT_MS = 6 * 60 * 1000;
/** callAI 期间心跳间隔（保 SSE 活 + 防 task-heal-sweep 误判卡死）。 */
const HEARTBEAT_INTERVAL_MS = 8_000;
/** 与原 analyze route 一致：空/不一致时带 cache-busting nonce 重试几次。 */
const MAX_ANALYSIS_ATTEMPTS = 2;

export interface RunEpisodeAnalysisInput {
  taskId: string;
  userId: string;
  projectId: string;
  episodeId: string;
  /** provider/model-id（由路由 parseModel 校验过格式）。 */
  model: string;
  /** 路由已 resolveAnalysisGuidance 的增强提示词（undefined 表示无）。 */
  enhancementPrompt?: string;
  /** 路由已 readLocalizationProfile 的本地化档案（undefined 表示无）。 */
  localizationProfile?: LocalizationProfile;
}

/** 启动周期心跳，重复上报当前进度，避免进度条长时间冻结。返回 stop 函数。 */
function startHeartbeat(
  report: () => Promise<void>,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void report().catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

/** 把任意错误转成对用户安全的失败文案（不泄露上游响应/凭证）。 */
function safeFailureMessage(err: unknown): string {
  if (err instanceof AiCallTimeoutError) return 'AI 调用超时，请重试';
  if (err instanceof GatewayError) {
    return `AI 服务暂时不可用 [${err.provider}]，请稍后重试`;
  }
  return '分析失败，请重试';
}

/**
 * 后台跑完编剧分析并终态化 task。绝不抛出（所有失败内部消化为 failInlineAiTask），
 * 调用方（路由）可用 .catch() 仅作日志兜底。
 */
export async function runEpisodeAnalysis(
  input: RunEpisodeAnalysisInput,
): Promise<void> {
  const { taskId, userId, projectId, episodeId } = input;
  let succeeded = false;
  let failMsg: string | null = null;

  try {
    await reportInlineAiTaskProgress(taskId, userId, 5, '准备分析', 0);

    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      failMsg = '分集不存在或已变更，请刷新后重试';
      return;
    }

    const novelText = (
      episode.novelText ?? episode.content ?? episode.videoScriptDraft ?? ''
    ).trim();
    if (novelText.length < 10) {
      failMsg = '该集剧本文本为空，请先在输入阶段保存剧本';
      return;
    }

    let parsed: { provider: string; model: string };
    try {
      parsed = parseModel(input.model);
    } catch {
      failMsg = 'model 格式错，请重新选择';
      return;
    }

    const language = detectLanguage(novelText);
    const novelTextHash = createHash('sha256')
      .update(novelText)
      .digest('hex')
      .slice(0, 16);
    const existingScriptData =
      episode.scriptData &&
      typeof episode.scriptData === 'object' &&
      !Array.isArray(episode.scriptData)
        ? (episode.scriptData as Record<string, unknown>)
        : {};

    await reportInlineAiTaskProgress(taskId, userId, 15, '构造分析提示词', 0);

    const [allEpisodes, projectAssets] = await Promise.all([
      episodeRepo.listByProject(projectId),
      listAssets(projectId),
    ]);
    const continuity = buildEpisodeAnalysisContext(
      episode,
      allEpisodes,
      projectAssets,
      language,
    );
    const { system, user } = buildScriptAnalysisPrompt(
      novelText,
      input.enhancementPrompt,
      {
        episodeNumber: episode.episodeNumber,
        localizationProfile: input.localizationProfile,
        previousEpisodes: continuity.previousEpisodes,
        existingAssets: continuity.existingAssets,
      },
      language,
    );
    const contextualUser = continuity.previousScriptsPrefix + user;

    await reportInlineAiTaskProgress(taskId, userId, 30, 'AI 生成中', 0);

    let parsedScript: ReturnType<typeof parseScriptResult> | null = null;
    let aiContent = '';
    let lastFailReason = 'AI 未能从该集剧本中提取场景';
    /** 命中接受分支的那次 callAI 结果（仅供成功后扣费用，不在重试内扣）。 */
    let acceptedResult: GatewayResult | null = null;

    // 心跳：callAI 期间持续推进子进度，让进度条不静止。
    let stageProgress = 0;
    const stopHeartbeat = startHeartbeat(async () => {
      stageProgress = Math.min(95, stageProgress + 3);
      await reportInlineAiTaskProgress(
        taskId,
        userId,
        30,
        'AI 生成中',
        stageProgress,
      );
    });

    try {
      for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt++) {
        // attempt 2+ 在 user 消息前置 nonce，破 DeepSeek prompt 缓存（防污染缓存命中）。
        const nonceUser =
          attempt === 1
            ? contextualUser
            : `[分析请求#${attempt}·${userId.slice(0, 6)}]\n${contextualUser}`;

        const result = await callAIWithTimeout({
          call: () =>
            callAI(parsed.provider, parsed.model, {
              capability: 'text_generation',
              input: {
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: nonceUser },
                ],
                temperature: 0.7,
                // 剧本输出可能较长，拉满 maxTokens 确保不被截断（对齐 app1）。
                maxTokens: 393216,
              },
              userId,
            }),
          timeoutMs: ANALYSIS_CALL_TIMEOUT_MS,
        });

        const meta = (result.meta ?? {}) as Record<string, unknown>;
        const content = typeof meta.content === 'string' ? meta.content : '';
        if (!content) {
          lastFailReason = 'AI 编剧分析返回内容为空';
          continue;
        }
        const candidate = parseScriptResult(content);
        if (!candidate.scenes || candidate.scenes.length === 0) {
          lastFailReason = 'AI 未能从该集剧本中提取场景';
          continue;
        }
        const consistency = validateAnalysisConsistency(candidate, novelText);
        if (!consistency.ok) {
          if (consistency.kind === 'characters') {
            // 局部瑕疵：只过滤编造的角色名，不整体重跑（保留好的场景/台词/造型）。
            const bad = new Set(consistency.hallucinated);
            candidate.characters = candidate.characters.filter(
              (c) => !bad.has(c),
            );
            parsedScript = candidate;
            aiContent = content;
            acceptedResult = result;
            break;
          }
          // total：整个分析不可信（语种错/过半角色编造），才重试。
          lastFailReason = consistency.reason;
          continue;
        }
        parsedScript = candidate;
        aiContent = content;
        acceptedResult = result;
        break;
      }
    } finally {
      stopHeartbeat();
    }

    if (!parsedScript || !acceptedResult) {
      // 重试耗尽：不复位 task RUNNING 状态由 finally 统一处理；这里只记原因。
      failMsg = `重试 ${MAX_ANALYSIS_ATTEMPTS} 次仍未取得与原文一致的分析：${lastFailReason}`;
      return;
    }

    await reportInlineAiTaskProgress(taskId, userId, 70, '校验一致性', 90);

    // === B1 资损止血：扣费只在 validateAnalysisConsistency 通过 + 即将持久化前 ===
    await billDirectGeneration({
      userId,
      result: acceptedResult,
      description: '编剧分析',
      taskType: 'story_analyze',
    });

    await reportInlineAiTaskProgress(taskId, userId, 90, '落库中', 95);

    const scriptData = {
      ...existingScriptData,
      rawAnalysis: aiContent,
      scenes: parsedScript.scenes,
      infoPoints: parsedScript.infoPoints,
      sceneMeta: parsedScript.sceneMeta,
      costumeMap: parsedScript.costumeMap,
      characters: parsedScript.characters,
      ...(input.localizationProfile
        ? { localizationProfile: input.localizationProfile }
        : {}),
      ...(input.enhancementPrompt
        ? { analysisGuidance: input.enhancementPrompt }
        : {}),
      modelUsed: input.model,
      analyzedAt: new Date().toISOString(),
      novelTextHash,
      novelLanguage: language,
    };

    const scenes = parsedScript.scenes.map((s, idx) => ({
      id: s.id,
      scene_id: `${s.id}-${idx}`,
      location: s.location,
      time: s.time,
      intExt: s.intExt,
      characters: parsedScript!.characters.filter((c) =>
        s.content?.includes(c),
      ),
      content: s.content,
    }));

    await episodeRepo.update(episodeId, {
      scriptData,
      scenes,
      status: 'COMPLETED',
      stageStatus: 'assets',
      emotionArc: '平静 → 紧张 → 冲突 → 高潮',
    });

    await completeInlineAiTask(taskId, userId, {
      episodeId,
      sceneCount: scenes.length,
    });
    succeeded = true;
  } catch (err) {
    failMsg = safeFailureMessage(err);
  } finally {
    if (!succeeded) {
      // 统一失败出口：failInlineAiTask 的 WHERE status='RUNNING' CAS 与
      // resetAnalyzingToInput 的 WHERE stageStatus='analyzing' 守卫保证幂等，
      // 即便成功路径竞态先推进到 assets，这里也不会误覆盖。
      // resetAnalyzingToInput 用裸 SQL 绕过 update() 的单调推进守卫（否则
      // analyzing→input 回退会被静默忽略 = 卡死 analyzing 的根因）。
      await failInlineAiTask(taskId, userId, failMsg ?? '分析失败，请重试').catch(
        () => {},
      );
      await episodeRepo.resetAnalyzingToInput(episodeId).catch(() => {});
    }
  }
}
