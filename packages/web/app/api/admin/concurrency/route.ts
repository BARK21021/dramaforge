// ============================================================
// GET /api/admin/concurrency — 服务器级并发配置读取
// PUT /api/admin/concurrency — 调参全局客户端 render-worker 槽位（RENDER_JOB_SLOTS）
// ============================================================
//
// 并发分两层管理：
//   ① 每用户：users."maxConcurrent"（PATCH /api/admin/users/[userId]），
//      同时是 AI 任务槽 + render 认领硬上限的唯一旋钮。
//   ② 服务器/全局：system_configs.RENDER_JOB_SLOTS（客户端 render-worker 槽位提示，
//      客户端按 users."maxConcurrent" 硬封顶，此处为全局默认提示）。
//   BullMQ 的 WORKER_*_CONCURRENCY 仍是部署时 env（boot-time），不在运行时调参范围。
//
// requireAdmin 守卫。
// GET 响应：200 { success:true, data:{ renderJobSlots } }
// PUT body: { renderJobSlots: 1-16 整数 }
// ============================================================

import type { NextRequest } from 'next/server';
import { getRenderJobSlots, setRenderJobSlots } from '@web/lib/render-job-slots';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
    const renderJobSlots = await getRenderJobSlots();
    return apiSuccess({ renderJobSlots });
  } catch (err) {
    return handleApiError(err, 'GET /api/admin/concurrency');
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  try {
    await requireAdmin();

    let body: { renderJobSlots?: unknown };
    try {
      body = (await req.json()) as { renderJobSlots?: unknown };
    } catch {
      return apiFail({ error: '无效 JSON', code: 'INVALID_BODY' }, 400);
    }
    const n = body.renderJobSlots;
    if (
      typeof n !== 'number'
      || !Number.isInteger(n)
      || n < 1
      || n > 16
    ) {
      return apiFail(
        { error: 'renderJobSlots 必须是 1-16 的整数', code: 'INVALID_RENDER_JOB_SLOTS' },
        400,
      );
    }

    await setRenderJobSlots(n);
    return apiSuccess({ renderJobSlots: n });
  } catch (err) {
    return handleApiError(err, 'PUT /api/admin/concurrency');
  }
}
