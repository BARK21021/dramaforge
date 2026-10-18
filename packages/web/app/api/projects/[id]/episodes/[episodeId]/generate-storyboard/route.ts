// ============================================================
// POST /api/projects/[id]/episodes/[episodeId]/generate-storyboard — 分镜生成（B2 inline-task 异步版）
// ============================================================
//
// 路由变薄：预检 → 去重 → startInlineAiTask → fire-and-forget runStoryboardGeneration
// → 返 202 { taskId }。业务逻辑（callAI / 解析 / 后处理 / replaceEpisodeShots / 落库）
// 在 @web/lib/storyboard-generation-runner，SSE 实时进度经 task:events。
//
// 对比旧同步阻塞版（callAI 在 web 同步等 → requestTimeout 风险；扣费在 callAI 后、
// 解析前 → AI_EMPTY/AI_NO_SHOTS 也扣 = 资损；前端二态进度条 + 刷新丢 in-flight）：
//   - 立即返 202 → 绕开 requestTimeout；后台 runner 跑完经 SSE 推进度。
//   - 扣费移到 parseStoryboardShots 非空后（B1）→ 空内容/拆不出镜头不扣。
//   - 前端 GenerationProgress 绑 taskId → 实时百分比 + 刷新经 localStorage 不丢。
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
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { parseModel } from '@web/lib/model-parser';
import { runStoryboardGeneration } from '@web/lib/storyboard-generation-runner';
import { createHash } from 'crypto';

/** 默认分镜生成模型（对齐 app1：deepseek flash，快）。 */
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

interface ScriptDataShape {
  scenes?: unknown;
  novelTextHash?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, episodeId } = await params;

    // 1. ownership
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 余额前置预检（昂贵 AI 调用前挡 0 积分；真扣费在 runner 解析成功后）
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    // 2. body：model + totalDurationSeconds
    let body: { model?: unknown; totalDurationSeconds?: unknown };
    try {
      const raw = (await req.json()) as unknown;
      body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { model?: unknown; totalDurationSeconds?: unknown })
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
    const bodyTotalDuration =
      typeof body.totalDurationSeconds === 'number'
        && Number.isFinite(body.totalDurationSeconds)
        && body.totalDurationSeconds > 0
        ? body.totalDurationSeconds
        : undefined;

    // 3. 陈旧分析检测（原文分析后被改 → 409 提示重新分析；runner 默认分析可用）。
    //    仅当分析产物带 novelTextHash（新链路）才校验；历史无 hash 不阻断。
    const sd = (episode.scriptData ?? null) as ScriptDataShape | null;
    const analyzedHash = typeof sd?.novelTextHash === 'string' ? sd.novelTextHash : null;
    if (analyzedHash) {
      const currentNt = (episode.novelText ?? episode.content ?? episode.videoScriptDraft ?? '').trim();
      const currentHash = createHash('sha256').update(currentNt).digest('hex').slice(0, 16);
      if (currentHash !== analyzedHash) {
        return apiFail(
          { error: '该集原文在编剧分析后被修改，分析已陈旧，请重新进行编剧分析后再生成分镜', code: 'ANALYSIS_STALE' },
          409,
        );
      }
    }

    // 4. 去重：同 episode 已有 active SHOT_AI task → 返回其 taskId（防双击双扣）
    const active = await listActiveInlineTasks(auth.userId, projectId, 'SHOT_AI');
    const mine = active.find((t) => {
      const ep = (t as { input?: { episodeId?: string } }).input?.episodeId;
      return ep === episodeId;
    });
    if (mine) return apiSuccess({ taskId: mine.id }, 202);

    // 5. 建 inline task + fire-and-forget runner（不 await）
    const taskId = randomUUID();
    await startInlineAiTask({
      id: taskId,
      userId: auth.userId,
      projectId,
      type: 'SHOT_AI',
      progress: 5,
      stage: '分镜生成',
      storedInput: { episodeId, projectId },
    });

    void runStoryboardGeneration({
      taskId,
      userId: auth.userId,
      projectId,
      episodeId,
      model: modelId,
      totalDurationSeconds: bodyTotalDuration,
    }).catch((err) => {
      // runner 内已有 try/finally 终态化（failInlineAiTask）；此 catch 仅防 rejection 泄漏。
      console.error('[generate-storyboard] runner 未捕获异常', err);
    });

    return apiSuccess({ taskId }, 202);
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/episodes/[episodeId]/generate-storyboard');
  }
}
