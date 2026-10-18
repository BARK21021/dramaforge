// ============================================================
// POST /api/generate/video-async — 异步云端视频生成派发（⑩ orchestrator 契约）
// ============================================================
//
// chain 编排（client/orchestrators/chain-generate.ts）每个 group POST 此端点，
// 期望秒级返回 { success:true, data:{ taskId } }——**不等待 ark 生成**，只把
// VIDEO_GENERATE 任务入 BullMQ video 队列（由 ai-worker 的 handleVideoGenerate
// 异步消费，ark 20min 轮询在 ai-worker 进程，web 永不参与长等待）。
//
// 为什么需要这个端点（与同步 /api/generate/video 并存）：
//   同步 /api/generate/video 在 web 进程内直接 callAI → ark pollAsync 最长 20min，
//   而 web = next start（Node http server 默认 requestTimeout≈5min）→ 任意一组
//   ark >5min 即被 web reset → chain 逐组重试放大 → 整链假死（4945/4928 同源）。
//   本端点把"等 ark"挪出 web 进程：派发即返回 taskId，客户端轮询 /api/tasks/[taskId]
//   拿结果。每次 HTTP 秒级，永不触 5min reset。这正是记忆 dramaforge-chain-fakedead-hotfix-1117
//   deferred 的"ark 调用挪回服务端 worker"的具体落地。
//
// 单镜头生成仍走同步 /api/generate/video（大多 ark 2-3min <5min 不触发 reset）；
// 本端点仅供 chain 编排使用（payload 带 chainMode:true，让 handler 跳过服务端
// persistVideo + shot 回写，交给 CHAIN_COMPILE render_job G3 体系）。
//
// 鉴权：session REQUIRED（Cookie）。⑩ chain-generate 的 jsonHeaders 带 Cookie。
// userId 从 session 读取。
//
// 请求体：JSON 对象（group 生成参数），必须含 `model`（"provider/model-id"）。
//   可选字段：
//     projectId  — 所属项目（用于 dedupe 作用域 + 任务归属；chain 必传）
//     dedupeKey  — 幂等作用域（如 "jobId:groupIndex"）；同 project+type+dedupeKey
//                  已有活跃任务时复用，防 chain 重试/并发重复派发+扣费
//     chainMode  — true 时 handler 跳过 persistVideo + shot 回写（chain 专用）
//     groupShotIds — 组内镜头 ID（透传 handler，chain 模式下不回写，仅元数据）
//     prompt/duration/aspectRatio/参考图/参考音频/... — 各 provider 按需读取
//
// 响应（UI-facing envelope，GC-4）：
//   200 { success:true, data:{ taskId, status } }  — 已派发（PENDING/QUEUED）
//   400 { success:false, error, code }                — 缺 model / model 格式错 / body 非 JSON
//   401 { success:false, code:'UNAUTHORIZED' }        — 未登录
//   402 { success:false, ... }                        — 余额不足（requireBalanceOrFail）
//   500 { success:false, code:'INTERNAL_ERROR' }      — 入队失败等异常
//
// web 禁止 import 任何 ffmpeg 模块；本端点不调 callAI（ark 在 ai-worker）。
// ============================================================

import type { NextRequest } from 'next/server';
import { enqueueAiTask } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** VIDEO_GENERATE 任务兜底超时：覆盖 ark pollAsync 20min + ai-worker video stall 25min + 余量。 */
const VIDEO_ASYNC_TIMEOUT_MS = 30 * 60 * 1000;

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    // 余额前置预检（对齐同步 /api/generate/video + app1 precheckBalance）。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    let body: Record<string, unknown>;
    try {
      const raw = (await req.json()) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return apiFail(
          { error: 'body 需为 JSON 对象', code: 'BAD_BODY' },
          400,
        );
      }
      body = raw as Record<string, unknown>;
    } catch {
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    const modelRaw = body.model;
    if (typeof modelRaw !== 'string' || modelRaw.length === 0) {
      return apiFail(
        {
          error: 'body 缺少 model 字段（"provider/model-id"）',
          code: 'MISSING_MODEL',
        },
        400,
      );
    }
    // 校验 model 含 provider 前缀（handler 自己 parseModel 拆分；此处只早失败）。
    if (modelRaw.indexOf('/') <= 0) {
      return apiFail(
        {
          error: `model 缺少 provider 前缀（应为 "provider/model-id"）: ${modelRaw}`,
          code: 'BAD_MODEL',
        },
        400,
      );
    }

    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    const dedupeKey = typeof body.dedupeKey === 'string' && body.dedupeKey.length > 0
      ? body.dedupeKey
      : undefined;

    // projectId / dedupeKey 走 enqueueAiTask 顶层参数；其余（含 chainMode / groupShotIds
    // / prompt / model / 参考图音频…）作为 payload 透传给 handleVideoGenerate。
    const payload: Record<string, unknown> = { ...body };
    delete payload.projectId;
    delete payload.dedupeKey;

    const { task } = await enqueueAiTask({
      userId: auth.userId,
      projectId,
      type: 'VIDEO_GENERATE',
      queueName: 'video',
      payload,
      dedupeKey,
      timeoutMs: VIDEO_ASYNC_TIMEOUT_MS,
      // chain 把人物/参考图/音频/末帧 base64 内联进 payload（每 job 4-5MB），100 人并发撑爆
      // Redis。leanBullMQ 让 BullMQ job 只带 taskId/userId/projectId，完整 input 留 PG
      // tasks.input，ai-worker 按 taskId 取。PG 本就存完整 payload（video-async 不传 storedPayload）。
      leanBullMQ: true,
    });

    return apiSuccess({ taskId: task.id, status: task.status });
  } catch (err) {
    return handleApiError(err, 'POST /api/generate/video-async');
  }
}
