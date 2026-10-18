// ============================================================
// POST /api/render/dispatch — 派发 render_job（⑫ e2e + 未来 UI 入口）
// ============================================================
//
// 新端点：供 ⑫ 端到端演练与未来 UI 创建 render_job。根据 body.type 调用
// ④ 的 dispatchFilmExport / dispatchChainGenerate / dispatchVideoSplit，
// 返回成功 envelope { success: true, data: { renderJobId } }。客户端 ⑨
// render-worker 通过 /api/render/jobs/next 拉取并执行。
//
// 鉴权：session → userId。
// 请求体（Zod 校验）：
//   { projectId?: string,   // optional（render_jobs 表无 project_id 列；P5 /compile 不发）
//     type: 'FILM_EXPORT' | 'CHAIN_GENERATE' | 'VIDEO_SPLIT',
//     input: <对应类型的 input> }
// 响应（UI-facing envelope，GC-4）：
//   200 { success:true, data: { renderJobId } }
//   400 { success:false, error, code:'VALIDATION_ERROR' | 'INVALID_JSON' | 'BAD_TYPE'}
//   401 { success:false, error, code:'UNAUTHORIZED' }
//   500 { success:false, error, code:'INTERNAL_ERROR' } — 派发失败等
//
// web 禁止 import 任何 ffmpeg 模块；本路由只写 render_jobs 表，不跑 ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { genId } from '@dramaforge/shared';
import {
  dispatchFilmExport,
  dispatchChainGenerate,
  dispatchVideoSplit,
  dispatchLongVideoRewrite,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

// --- Zod schemas（与 @dramaforge/shared 的 RenderJobInput 契约对齐） ---

const concatInputSchema = z.object({
  clips: z.array(
    z.object({
      url: z.string(),
      durationSec: z.number().optional(),
    }),
  ),
  // LEGACY (P5): films are client-local now — dispatchFilmExport no longer
  // mints a MinIO URL. Kept optional only for backward compat with callers
  // that pre-mint their own URL (e2e/tests); the product path leaves it unset.
  outputUploadUrl: z.string().optional(),
});

const chainCompileInputSchema = z.object({
  // groupResults 在 shared 契约里是 {url:string}[]（frozen）；⑩ 客户端扩展了
  // 可选 params 字段，passthrough() 允许透传而不报错。
  groupResults: z.array(z.object({ url: z.string() }).passthrough()),
  // LEGACY (batch 7 OP1): chain films are client-local now —
  // dispatchChainGenerate no longer mints a MinIO URL. Kept optional only for
  // backward compat with callers that pre-mint their own URL (e2e/tests);
  // the product path leaves it unset and the orchestrator writes locally.
  outputUploadUrl: z.string().optional(),
});

const splitByDurationInputSchema = z.object({
  videoUrl: z.string(),
  durationSec: z.number(),
  outputPrefix: z.string(),
});

const splitEvenlyInputSchema = z.object({
  videoUrl: z.string(),
  segments: z.number(),
  outputPrefix: z.string(),
});

// 转绘 X3.6b：长视频整剧重写 input（与 LongVideoRewriteInput 契约对齐）。
// projectId、时长和字节数必须在入队前校验，避免客户端领到一个注定失败的任务。
const longVideoRewriteInputSchema = z.object({
  videoUrl: z.string().min(1),
  segments: z.number().int().min(1),
  outputUploadUrl: z.string().optional(),
  projectId: z.string().min(1),
  totalDurationSec: z.number().finite().positive(),
  totalBytes: z.number().int().positive(),
  segmentSec: z.number().finite().positive().optional(),
  kimiModel: z.string().optional(),
  outlineModel: z.string().optional(),
  rewriteModel: z.string().optional(),
  sourceScriptOverride: z.string().optional(),
  checkpointDir: z.string().optional(),
});

const videoSplitInputSchema = z.union([
  splitByDurationInputSchema,
  splitEvenlyInputSchema,
]);

const dispatchBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('FILM_EXPORT'),
    projectId: z.string().optional(),
    input: concatInputSchema,
  }),
  z.object({
    type: z.literal('CHAIN_GENERATE'),
    projectId: z.string().optional(),
    input: chainCompileInputSchema,
  }),
  z.object({
    type: z.literal('VIDEO_SPLIT'),
    projectId: z.string().optional(),
    input: videoSplitInputSchema,
  }),
  z.object({
    type: z.literal('LONG_VIDEO_REWRITE'),
    projectId: z.string().optional(),
    input: longVideoRewriteInputSchema,
  }),
]);

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    let parsed: z.infer<typeof dispatchBodySchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = dispatchBodySchema.parse(raw);
    } catch (err) {
      // ZodError 交由 handleApiError 转 VALIDATION_ERROR envelope；
      // JSON 解析失败保持 400 INVALID_JSON。
      if (err instanceof z.ZodError) {
        return handleApiError(err);
      }
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    // taskId 作为 render_job 的关联键（render_jobs.task_id）。web 用 genId 生成，
    // 未来 UI 可传入既有 task ID（当前 scope 不需要）。
    const taskId = genId();

    let renderJobId: string;
    try {
      switch (parsed.type) {
        case 'FILM_EXPORT': {
          const job = await dispatchFilmExport(taskId, auth.userId, parsed.input);
          renderJobId = job.id;
          break;
        }
        case 'CHAIN_GENERATE': {
          const job = await dispatchChainGenerate(taskId, auth.userId, parsed.input);
          renderJobId = job.id;
          break;
        }
        case 'VIDEO_SPLIT': {
          const job = await dispatchVideoSplit(taskId, auth.userId, parsed.input);
          renderJobId = job.id;
          break;
        }
        case 'LONG_VIDEO_REWRITE': {
          // input.userId 只能来自已鉴权 session，不能信任请求体里的身份字段。
          const job = await dispatchLongVideoRewrite(taskId, auth.userId, {
            ...parsed.input,
            userId: auth.userId,
          });
          renderJobId = job.id;
          break;
        }
        default: {
          // exhaustiveness check — discriminatedUnion 已覆盖所有 type
          const _exhaustive: never = parsed;
          return apiFail(
            { error: `不支持的 type: ${String(_exhaustive)}`, code: 'BAD_TYPE' },
            400,
          );
        }
      }
    } catch (err) {
      throw err; // re-throw → outer catch → handleApiError → 500 INTERNAL_ERROR
    }

    // P5: 返回 taskId 供 UI 订阅 SSE 关联（result/failed 路由发的 task:events
    // 事件带 taskId；renderJobId 是 render_jobs.id，不在 SSE 事件里，留作调试）。
    return apiSuccess({ renderJobId, taskId });
  } catch (err) {
    return handleApiError(err, 'POST /api/render/dispatch');
  }
}
