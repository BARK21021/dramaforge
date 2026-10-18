// ============================================================
// GET /api/render/jobs/next — 客户端拉取下一个待执行的 render_job
// ============================================================
//
// ⑨ client/render-worker 长轮询入口。原子认领（FOR UPDATE SKIP LOCKED）
// 保证多客户端并发不会拿到同一行。
//
// 鉴权：session 必须存在，且仅认领当前用户自己的待处理作业。
//   - machineId 从 **查询参数 ?machineId=** 读取（⑨ loop.ts 的实际契约），
//     x-machine-id 头作为 fallback 供未来客户端使用。
//
// 响应：
//   200 { job: RenderJob } — 认领到作业
//   204                    — 无 PENDING 作业（客户端继续轮询）
//   400 — 缺 machineId
//
// web 禁止 import 任何 ffmpeg 模块；本路由只读写 render_jobs 表。
// ============================================================

import type { NextRequest } from 'next/server';
import { getConcurrencyLimit, renderJobRepo } from '@dramaforge/server';
import { requireUser } from '@web/lib/auth';
import { apiError, unauthorized } from '@web/lib/response';

export async function GET(req: NextRequest): Promise<Response> {
  const auth = await requireUser();
  if (!auth) return unauthorized();

  // machineId：优先查询参数（⑨ 的契约），fallback 到 x-machine-id 头。
  const url = new URL(req.url);
  const machineId =
    url.searchParams.get('machineId')?.trim() ||
    req.headers.get('x-machine-id')?.trim() ||
    '';
  if (!machineId) {
    return apiError('缺少 machineId（查询参数或 x-machine-id 头）', 400);
  }

  // Per-user 并发硬上限（多机器合计）：已认领数 ≥ users."maxConcurrent" 即 204。
  // maxConcurrent 原本只限 ai-worker（acquireSlot），此处把它扩为 render 侧真上限
  // （客户端多槽 worker 的槽位数也从它下发）。刚崩溃客户端的残留行会占住上限
  // ~一个回收周期（heartbeat 2min / reapStale 60s 扫描），客户端 5s 轮询自愈；
  // 语义永远偏向「不超上限」。
  const [limit, active] = await Promise.all([
    getConcurrencyLimit(auth.userId),
    renderJobRepo.countActiveClaims(auth.userId),
  ]);
  if (active >= limit) {
    return new Response(null, { status: 204 });
  }

  const job = await renderJobRepo.claimNext(auth.userId, machineId);
  if (!job) {
    // 无待执行作业：204 No Content（无 body）
    return new Response(null, { status: 204 });
  }
  return Response.json({ job }, { status: 200 });
}
