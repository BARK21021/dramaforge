// POST /api/projects/[id]/episodes/split — 调用原创整剧的项目级异步编排
//
// 剧本文本只从目标项目创建时冻结的 ORIGINAL 快照读取。OVERSEAS 在任务内先对
// 全文转风格，随后自动提取整剧资产并拆集；DOMESTIC 直接整剧提取资产并拆集。

import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import {
  enqueueAiTask,
  episodeRepo,
  projectRepo,
  readLocalizationProfile,
} from '@dramaforge/server';
import {
  normalizeProjectScriptForHash,
  resolveProjectSourceScriptText,
} from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';
import { requireBalanceOrFail } from '@web/lib/balance-gate';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { id: projectId } = await params;
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '项目不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    if (project.category === 'ORIGINAL' || !project.sourceProjectId) {
      return apiFail({ error: '只有调用原创整剧的项目可以执行 AI 分集', code: 'BAD_SOURCE_MODE' }, 400);
    }
    // ORIGINAL_PROJECT 在创建目标项目时已复制整剧快照。拆集必须使用该快照，
    // 不能重新读取源项目，否则源稿后续编辑会静默改变既有目标项目的分集输入。
    const novelText = resolveProjectSourceScriptText(project) ?? '';
    if (novelText.length < 50) {
      return apiFail({ error: '关联原创整剧文本过短，请先完善剧本', code: 'SCRIPT_TOO_SHORT' }, 400);
    }

    const episodes = await episodeRepo.listByProject(projectId);
    if (episodes.some((episode) => episode.stageStatus === 'analyzing')) {
      return apiFail({ error: '有分集正在分析，请完成后再重新拆集', code: 'EPISODE_BUSY' }, 409);
    }

    // 余额前置预检（对齐 app1 precheckBalance）：0 积分挡在昂贵 AI 调用之前。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    const body = await request.json().catch(() => ({})) as {
      model?: unknown;
      stylePrompt?: unknown;
    };
    const modelId = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : 'deepseek/deepseek-v4-flash';
    const localizationProfile = readLocalizationProfile(project.scriptData);
    const stylePrompt = typeof body.stylePrompt === 'string' && body.stylePrompt.trim()
      ? body.stylePrompt.trim()
      : localizationProfile?.stylePrompt ?? '';
    if (project.category === 'OVERSEAS' && !stylePrompt) {
      return apiFail(
        { error: '请先选择整剧转绘的目标语言', code: 'TARGET_STYLE_REQUIRED' },
        400,
      );
    }
    const result = await enqueueAiTask({
      userId: auth.userId,
      projectId,
      type: 'EPISODE_SPLIT',
      queueName: 'text',
      timeoutMs: 60 * 60 * 1000,
      payload: {
        projectId,
        novelText,
        sourceScriptHash: createHash('sha256')
          .update(normalizeProjectScriptForHash(novelText), 'utf8')
          .digest('hex'),
        modelId,
        category: project.category,
        stylePrompt,
        localizationProfile,
        deleteExisting: true,
      },
    });
    return apiSuccess({
      taskId: result.task.id,
      status: result.task.status,
      reused: result.reused,
    }, 202);
  } catch (error) {
    return handleApiError(error, 'POST /api/projects/[id]/episodes/split');
  }
}
