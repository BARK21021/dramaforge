// GET /api/tasks — AI 任务列表与刷新恢复。
// 媒体生成走专用瞬时路由，防止本地音视频 data URL 进入 ai_tasks JSONB。

import { listAiTasks } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const search = new URL(request.url).searchParams;
    const tasks = await listAiTasks(auth.userId, {
      status: search.get('status')?.trim() || undefined,
      type: search.get('type')?.trim() || undefined,
      projectId: search.get('projectId')?.trim() || undefined,
      limit: 100,
    });
    // 与 GET /api/tasks/[taskId] 一致的防流量爆炸裁剪：AI 任务 input 内含
    // base64 参考图（3-6MB/任务），列表接口同样不得透传给前端。
    const publicTasks = tasks.map(({ input: _input, ...rest }) => {
      void _input;
      return rest;
    });
    return apiSuccess({ tasks: publicTasks, total: publicTasks.length });
  } catch (error) {
    return handleApiError(error, 'GET /api/tasks');
  }
}
