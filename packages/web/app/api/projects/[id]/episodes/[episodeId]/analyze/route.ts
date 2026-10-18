// ============================================================
// POST /api/projects/[id]/episodes/[episodeId]/analyze — 编剧分析（B2 inline-task 异步版）
// ============================================================
//
// 路由变薄：预检 → 去重 → startInlineAiTask → 置 ANALYZING → fire-and-forget
// runEpisodeAnalysis → 返 202 { taskId }。业务逻辑（callAI 重试 / 校验 / 扣费 / 落库）
// 在 @web/lib/episode-analysis-runner，SSE 实时进度经 task:events。
//
// 对比旧同步阻塞版（callAI 在 web 进程同步等 → 踩 ~5min requestTimeout → 卡死
// analyzing；扣费在 callAI 后、校验前 → 空响应也扣 = 资损）：
//   - 立即返 202 → 请求秒级结束 → 绕开 requestTimeout → 不再卡死 analyzing。
//   - 扣费移到 runner 内 validateAnalysisConsistency 通过后（B1）→ 失败不扣。
//   - 进度经 reportInlineAiTaskProgress 实时推 SSE → 前端 GenerationProgress 实时显示。
//
// 详见 docs/superpowers/specs/2026-08-07-episode-lifecycle-realtime-design.md §B2。
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import {
  episodeRepo,
  projectRepo,
  startInlineAiTask,
  listActiveInlineTasks,
  readLocalizationProfile,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { resolveAnalysisGuidance } from '@web/lib/analysis-guidance';
import { parseModel } from '@web/lib/model-parser';
import { runEpisodeAnalysis } from '@web/lib/episode-analysis-runner';

/** 默认编剧分析模型（对齐 app1）。 */
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, episodeId } = await params;

    // 1. ownership（项目归属 + 分集属于项目，统一 404 不泄露存在性）
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 余额前置预检（昂贵 AI 调用前挡 0 积分；真实扣费在 runner 成功后）
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    // novelText ≥10（runner 也会再校验；这里早退省一次 task 创建）
    const novelText = (episode.novelText ?? episode.content ?? episode.videoScriptDraft ?? '').trim();
    if (novelText.length < 10) {
      return apiFail(
        { error: '该集剧本文本为空，请先在输入阶段保存剧本', code: 'EMPTY_SCRIPT' },
        400,
      );
    }

    // 2. body：model + enhancementPrompt + localizationProfile
    let body: { model?: unknown; enhancementPrompt?: unknown; localizationProfile?: unknown };
    try {
      const raw = (await req.json()) as unknown;
      body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { model?: unknown; enhancementPrompt?: unknown; localizationProfile?: unknown })
        : {};
    } catch {
      body = {};
    }
    const modelId =
      typeof body.model === 'string' && body.model.length > 0 ? body.model : DEFAULT_MODEL;
    try {
      parseModel(modelId);
    } catch (err) {
      return apiFail(
        { error: err instanceof Error ? err.message : 'model 格式错', code: 'BAD_MODEL' },
        400,
      );
    }

    const existingScriptData =
      episode.scriptData && typeof episode.scriptData === 'object' && !Array.isArray(episode.scriptData)
        ? (episode.scriptData as Record<string, unknown>)
        : {};
    const enhancementPrompt = resolveAnalysisGuidance(
      body.enhancementPrompt,
      existingScriptData,
      project.scriptData,
    );
    const localizationProfile =
      readLocalizationProfile(body.localizationProfile) ??
      readLocalizationProfile(existingScriptData) ??
      readLocalizationProfile(project.scriptData);

    // 3. 去重：同 episode 已有 active STORY_ANALYZE task → 返回其 taskId（防双击双扣）
    const active = await listActiveInlineTasks(auth.userId, projectId, 'STORY_ANALYZE');
    const mine = active.find((t) => {
      const ep = (t as { input?: { episodeId?: string } }).input?.episodeId;
      return ep === episodeId;
    });
    if (mine) return apiSuccess({ taskId: mine.id }, 202);

    // 4. 建 inline task + 置 ANALYZING + fire-and-forget runner（不 await）
    const taskId = randomUUID();
    await startInlineAiTask({
      id: taskId,
      userId: auth.userId,
      projectId,
      type: 'STORY_ANALYZE',
      progress: 5,
      stage: '编剧分析',
      storedInput: { episodeId, projectId },
    });
    await episodeRepo.update(episodeId, { status: 'ANALYZING', stageStatus: 'analyzing' });

    void runEpisodeAnalysis({
      taskId,
      userId: auth.userId,
      projectId,
      episodeId,
      model: modelId,
      enhancementPrompt: enhancementPrompt || undefined,
      localizationProfile: localizationProfile ?? undefined,
    }).catch((err) => {
      // runner 内已有 try/finally 终态化（failInlineAiTask + resetAnalyzingToInput）；
      // 此 catch 仅防 promise rejection 泄漏到 unhandledRejection + 留日志。
      console.error('[analyze] runner 未捕获异常', err);
    });

    return apiSuccess({ taskId }, 202);
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/episodes/[episodeId]/analyze');
  }
}
