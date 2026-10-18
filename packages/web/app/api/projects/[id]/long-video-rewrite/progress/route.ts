// ============================================================
// GET/PUT /api/projects/[id]/long-video-rewrite/progress — 整剧重写进度（转绘 X3.6a）
// ============================================================
//
// 长视频整剧重写 orchestrator（client，X3.4）按阶段回写 project.longVideoProgress
// JSONB；UI（OriginalRewriteStage，X3.7）轮询 GET 渲染进度条/阶段文案。
//
//   GET  → { success:true, data:{ progress: LongVideoProgress | null } }
//   PUT  → body: LongVideoProgress（stage/progress/currentStep/…），整列覆盖写回
//
// 对齐 app1 processLongVideo 的 `longVideoProgress` 阶段回写（splitting 0-8% /
// transcribing 10-55% / outlining 55-74% / scripting 78-96% / completed 100%）。
//
// 鉴权 + ownership：requireUser → projectRepo.getById → 校验 userId 归属，统一 404。
// 写入方是 client render-worker（带 authCookie），同属该 user 故 ownership 通过。
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

const LONG_VIDEO_STAGES = [
  'splitting',
  'transcribing',
  'outlining',
  'scripting',
  'episoding',
  'completed',
  'failed',
] as const;

/** LongVideoProgress 写入校验（整列覆盖；optional 字段透传）。 */
const progressSchema = z.object({
  taskId: z.string().optional(),
  stage: z.enum(LONG_VIDEO_STAGES),
  progress: z.number().min(0).max(100),
  currentStep: z.string().optional(),
  totalSteps: z.number().optional(),
  currentStepIndex: z.number().optional(),
  error: z.string().optional(),
  updatedAt: z.string().min(1),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id } = await params;
    const project = await projectRepo.getById(id);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    return apiSuccess({ progress: project.longVideoProgress ?? null });
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/long-video-rewrite/progress');
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id } = await params;
    const project = await projectRepo.getById(id);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    let parsed: z.infer<typeof progressSchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = progressSchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    await projectRepo.update(id, { longVideoProgress: parsed });
    return apiSuccess({ progress: parsed });
  } catch (err) {
    return handleApiError(err, 'PUT /api/projects/[id]/long-video-rewrite/progress');
  }
}
