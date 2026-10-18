// ============================================================
// /compile — 合片提交纯函数（node-env 单测，对齐 generate-flow 风格）
// ============================================================
//
// 拆成三个可独立测试的函数 + page.tsx 胶水（SSE + 持久状态轮询）：
//   dispatchCompile(clips)        — POST /api/render/dispatch(FILM_EXPORT)，返 taskId
//   matchCompileEvent(event,taskId) — 把一个 SSE 事件归类为 done/failed/null
//   fetchCompileStatus(renderJobId) — GET 持久状态，兜底 pub/sub 丢事件
// page.tsx 负责订阅/轮询 + 调这些函数（UI 胶水不单测，同 /generate）。
//
// 契约：
//   POST /api/render/dispatch → 200 { success:true, data:{ renderJobId, taskId } }
//                              4xx/5xx { success:false, error, code? }
//   GET /api/sse（result/failed 路由发的 task:events 事件）
//     { taskId, userId, status:'COMPLETED'|'FAILED', result?:{ outputUrl }, error? }
//   GET /api/render/jobs/[id] → { job:{ status, result, error } }
//   result.outputUrl = sf-asset://<jobId>.mp4（P5 Task A：成品客户端本地）
//
// 硬约束：
//   - 资产客户端本地：成品 = sf-asset://，桌面客户端 <video> 播本地；
//     浏览器无法解析 sf-asset:// → page 提示"需桌面客户端查看"。
//   - AI key 隔离：合片本身（CONCAT）不调 AI，不需 key。
//   - 服务器零媒体字节：dispatch 只写 render_jobs，成品字节在客户端本地。

/** 派发结果（永不 reject）。 */
export type DispatchOutcome =
  | { ok: true; taskId: string; renderJobId: string }
  | { ok: false; message: string; code?: string };

/** SSE 事件最小形状（result/failed 路由发的 task:events 子集 + connected 帧）。 */
export interface CompileSseEvent {
  /** `type:'connected'` = /api/sse 初始握手帧（无 taskId/status，matchCompileEvent 返 null）。 */
  type?: string;
  taskId?: string;
  status?: string;
  result?: { outputUrl?: string };
  error?: string;
}

/** matchCompileEvent 结果。 */
export type CompileMatch =
  | { kind: "done"; filmUrl: string }
  | { kind: "failed"; message: string };

/** render-job 状态查询的最小响应；与 GET /api/render/jobs/[id] 对齐。 */
interface CompileStatusResponse {
  job?: {
    status?: unknown;
    result?: { outputUrl?: unknown } | null;
    error?: unknown;
  };
}

/**
 * 单次读取 render-job 的持久状态，作为 SSE 丢事件时的兜底。
 *
 * 永不 reject：网络失败、非 2xx、非 JSON 或畸形响应都返回 null，调用方可在
 * 下一轮继续查询。只有可用的 COMPLETED / FAILED 终态才返回 CompileMatch。
 */
export async function fetchCompileStatus(input: {
  renderJobId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<CompileMatch | null> {
  const fetchFn = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 10_000;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  // Promise.race is intentional: a custom fetch may ignore AbortSignal. The whole
  // request *and body parse* live inside the raced promise, so a stalled body also
  // cannot wedge polling. Catch the losing promise to prevent late rejections.
  const request: Promise<CompileMatch | null> = Promise.resolve()
    .then(async () => {
      const res = await fetchFn(
        `/api/render/jobs/${encodeURIComponent(input.renderJobId)}`,
        { method: "GET", cache: "no-store", signal: controller.signal },
      );
      if (!res.ok) return null;

      const data = (await res.json()) as CompileStatusResponse;
      if (data.job?.status === "COMPLETED") {
        const outputUrl = data.job.result?.outputUrl;
        if (typeof outputUrl === "string" && outputUrl.length > 0) {
          return { kind: "done" as const, filmUrl: outputUrl };
        }
        return null;
      }
      if (data.job?.status === "FAILED") {
        return {
          kind: "failed" as const,
          message:
            typeof data.job.error === "string" && data.job.error.length > 0
              ? data.job.error
              : "合片失败",
        };
      }
      return null;
    })
    .catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, Math.max(0, timeoutMs));
  });

  const outcome = await Promise.race([request, timeout]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  return outcome;
}

/**
 * 派发合片任务。POST /api/render/dispatch(FILM_EXPORT)，返回 taskId（SSE 关联键）。
 *
 * 永不 reject：网络错 / 非 JSON / envelope success:false / 缺 taskId 全降级 error。
 */
export async function dispatchCompile(input: {
  clips: string[];
  fetchImpl?: typeof fetch;
}): Promise<DispatchOutcome> {
  const fetchFn = input.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchFn("/api/render/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "FILM_EXPORT",
        input: { clips: input.clips.map((url) => ({ url })) },
      }),
    });
  } catch {
    return { ok: false, message: "网络错误，请稍后重试" };
  }

  type Envelope = {
    success?: boolean;
    data?: { renderJobId?: unknown; taskId?: unknown };
    error?: string;
    code?: string;
  };
  let data: Envelope | null = null;
  try {
    data = (await res.json()) as Envelope;
  } catch {
    data = null;
  }

  if (!data || data.success !== true) {
    return {
      ok: false,
      message: data?.error ?? `请求失败 (${res.status})`,
      code: data?.code,
    };
  }

  const taskId = data.data?.taskId;
  const renderJobId = data.data?.renderJobId;
  if (typeof taskId !== "string" || typeof renderJobId !== "string") {
    return { ok: false, message: "响应缺少任务 ID" };
  }
  return { ok: true, taskId, renderJobId };
}

/**
 * 把一个 SSE 事件归类为合片结果。
 * - taskId 不匹配         → null（别人的事件，忽略）
 * - COMPLETED + outputUrl → done（filmUrl = sf-asset://...）
 * - FAILED                → failed（message = event.error ?? 默认）
 * - 其他（progress/RUNNING/connected/COMPLETED 缺 url）→ null（继续等）
 */
export function matchCompileEvent(
  event: CompileSseEvent,
  taskId: string,
): CompileMatch | null {
  if (event.taskId !== taskId) return null;
  if (event.status === "COMPLETED") {
    const url = event.result?.outputUrl;
    if (typeof url === "string" && url.length > 0) {
      return { kind: "done", filmUrl: url };
    }
    return null;
  }
  if (event.status === "FAILED") {
    return { kind: "failed", message: event.error ?? "合片失败" };
  }
  return null;
}
