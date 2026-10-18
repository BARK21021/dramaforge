// ============================================================
// POST /api/projects/[id]/outline-to-script — 剧本原创 · 根据大纲写剧本
// ============================================================
//
// ORIGINAL 项目的第三种 sourceMode（OUTLINE_TO_SCRIPT）：用户直接输入故事大纲，
// 服务端用 DeepSeek 把大纲扩写成竖屏微短剧完整剧本（buildScriptFromOutlinePrompt，
// 融入短剧行业标准）。纯文本流程，无需 ffmpeg/视频，因此跑在 server 端（区别于
// VIDEO_REWRITE 走 client orchestrator）。
//
// 链路：requireUser + ownership → 余额预检 → buildScriptFromOutlinePrompt 构造
// messages → callAI deepseek text_generation（触顶自动续写，最多 MAX_CONTINUATIONS
// 轮）→ projectRepo.update 写回（videoScriptDraft=剧本，novelText=大纲，
// scriptData 浅合并，status=SCREENWRITING）。
//
// C/S 铁律：GC-1 DeepSeek key 只在 server；本端点纯文本，不碰媒体字节。
//
// Body: { outline, targetEpisodeCount?, language?:'zh'|'en', feedback?, model? }
//   默认 model='deepseek/deepseek-v4-flash'
// 响应: 200 { success:true, data:{ projectId, script, status } }
//       400 校验 / 401 / 402 余额不足 / 404 / 429|5xx provider(retryable)
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { callAI, GatewayError, projectRepo } from '@dramaforge/server';
import {
  buildScriptFromOutlinePrompt,
  type ScriptLanguage,
} from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

const bodySchema = z.object({
  outline: z.string().trim().min(50, '大纲至少 50 字'),
  targetEpisodeCount: z.number().int().min(1).max(120).optional(),
  language: z.enum(['zh', 'en']).optional(),
  feedback: z.string().max(2000).optional(),
  model: z.string().optional(),
});

const MAX_CONTINUATIONS = 8;
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

interface ChatMessage {
  role: string;
  content: string;
}

/** 单次 DeepSeek text_generation，抽取 content/finishReason。 */
async function callDeepSeek(
  userId: string,
  messages: ChatMessage[],
  model: string,
) {
  const result = await callAI('deepseek', model, {
    capability: 'text_generation',
    userId,
    input: { messages },
  });
  const meta = (result.meta ?? {}) as Record<string, unknown>;
  return {
    content: typeof meta.content === 'string' ? meta.content : '',
    finishReason: typeof meta.finishReason === 'string' ? meta.finishReason : '',
    result,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    let parsed: z.infer<typeof bodySchema>;
    try {
      const raw = (await req.json().catch(() => null)) as unknown;
      parsed = bodySchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    const prompt = buildScriptFromOutlinePrompt(parsed.outline, {
      targetEpisodeCount: parsed.targetEpisodeCount,
      language: parsed.language as ScriptLanguage | undefined,
      feedback: parsed.feedback,
    });
    const model =
      parsed.model && parsed.model.length > 0 ? parsed.model : DEFAULT_MODEL;

    const messages: ChatMessage[] = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ];

    // 主调用 + 触顶续写：finishReason==='length' 时把上一轮输出作为 assistant
    // 消息，再追加「继续」user 消息，逐轮拼接为完整剧本正文。
    let script = '';
    let finishReason = 'length';
    let continuations = 0;
    while (finishReason === 'length' && continuations <= MAX_CONTINUATIONS) {
      const outcome = await callDeepSeek(auth.userId, messages, model);
      script += outcome.content;
      finishReason = outcome.finishReason;
      // 按实际 token 计费（BillingError 402 向上抛 → 余额不足；其他扣费异常由
      // billDirectGeneration 内部写 PENDING_DEBIT 留痕，不阻断交付）。
      await billDirectGeneration({
        userId: auth.userId,
        result: outcome.result,
        description: '根据大纲写剧本',
        taskType: 'long_video_text',
      });
      if (finishReason !== 'length') break;
      continuations += 1;
      messages.push({ role: 'assistant', content: outcome.content });
      messages.push({
        role: 'user',
        content:
          '继续输出剩余剧本正文，从你停下的位置直接接着写，不要重复已输出内容，'
          + '不要任何前言或说明，严格延续同样的格式（第N集 / [集号-场号] 场头 / '
          + '▲ 画面 / 角色名：台词），直到写完全部集数。',
      });
    }

    // 写回项目：videoScriptDraft=剧本，novelText=大纲，scriptData 浅合并。
    await projectRepo.update(projectId, {
      novelText: parsed.outline,
      videoScriptDraft: script,
      status: 'SCREENWRITING',
      scriptData: {
        sourceMode: 'OUTLINE_TO_SCRIPT',
        outlineScript: {
          outline: parsed.outline,
          targetEpisodeCount: parsed.targetEpisodeCount ?? null,
          script,
          generatedAt: new Date().toISOString(),
        },
      },
    });

    return apiSuccess({ projectId, script, status: 'SCREENWRITING' });
  } catch (err) {
    if (err instanceof GatewayError) {
      const status = err.status ?? 502;
      const retryable = err.retryAfter !== null || status === 429 || status >= 500;
      return apiFail(
        {
          error: err.message,
          code: 'PROVIDER_ERROR',
          category: 'provider',
          retryable,
        },
        status,
      );
    }
    return handleApiError(err, 'POST /api/projects/[id]/outline-to-script');
  }
}
