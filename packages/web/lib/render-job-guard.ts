// ============================================================
// web/lib/render-job-guard — 作业认领权校验
// ============================================================
//
// 文件职责：
//   verifyClaim(jobId, userId, machineId, claimToken) — 校验完整租约。
//   progress/result/failed 三个路由共用，防止跨客户端劫持他人作业。
//
// 所有回调都必须同时匹配登录用户、claimed_by 与每次认领独立的 claimToken。
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { RenderJob } from '@dramaforge/shared';
import { renderJobRepo } from '@dramaforge/server';
import { apiError, forbidden } from '@web/lib/response';

export type GuardResult =
  | { ok: true; job: RenderJob }
  | { ok: false; response: Response };

/**
 * 校验登录用户和 machineId 对 jobId 的认领权。
 *
 * @param jobId    - 路径参数作业 ID
 * @param userId - 当前登录用户 ID
 * @param machineId - x-machine-id 头或 ?machineId= 查询参数（null/空 表示缺失）
 * @param claimToken - 仅允许通过 x-claim-token 头传入的单次认领凭据
 */
export async function verifyClaim(
  jobId: string,
  userId: string,
  machineId: string | null,
  claimToken: string | null,
): Promise<GuardResult> {
  const job = await renderJobRepo.getById(jobId);
  if (!job) {
    return { ok: false, response: apiError('作业不存在', 404) };
  }
  if (job.userId !== userId) {
    return {
      ok: false,
      response: forbidden('无权访问该作业'),
    };
  }
  if (!machineId) {
    return {
      ok: false,
      response: apiError('缺少 machineId（查询参数或 x-machine-id 头）', 400),
    };
  }
  if (job.claimedBy !== machineId) {
    return {
      ok: false,
      response: forbidden('作业未被本机认领'),
    };
  }
  if (!claimToken) {
    return {
      ok: false,
      response: apiError('缺少 claimToken（x-claim-token 头）', 400),
    };
  }
  if (job.claimToken !== claimToken) {
    return {
      ok: false,
      response: forbidden('作业租约已失效'),
    };
  }
  return { ok: true, job };
}
