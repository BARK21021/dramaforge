// ============================================================
// 任务状态管理 Hooks（移植自 app1，适配 dramaforge render-jobs API）
// ============================================================
//
// 文件职责（与 app1 useTaskStatus.ts 一一对应的合并文件）：
//   1. useSSE()                — 全局单例 EventSource（共享 /api/sse），refCount +
//                                指数退避重连（1s→30s + jitter）+ 事件缓冲（200 条）+
//                                useSyncExternalStore 订阅。
//   2. useTaskStatus(id)       — 单任务状态：5s 轮询兜底 + SSE 事件触发 refetch。
//   3. useTaskList(opts)       — 当前用户任务列表：5s 轮询恢复页面状态。
//   4. trackTaskId(id)         — 注册前端正在跟踪的 taskId（SSE 断线兜底轮询用）。
//   5. useConcurrencyStatus()  — 用户并发额度（dramaforge 短路：无对应端点，待补）。
//   6. cancelTask(id)/retryTask(id) — 任务取消/重试辅助函数（render_jobs 路由家族）。
//   7. parseApiErrorResponse(res)    — 结构化错误响应解析（纯工具函数）。
//   8. useGlobalErrorHandler()  — 全局错误捕获（订阅 SSE error/system_alert 事件）。
//
// ============================================================
// dramaforge 适配点（重要）：
// ============================================================
// app1 原 useTaskStatus 轮询 /api/tasks/{id}，返回 { success, data: TaskInfo }
// envelope，TaskInfo 含 status/progress/stage/type/createdAt/projectId 等丰富字段。
//
// dramaforge 当前没有 /api/tasks 路由，render-jobs 是唯一可对接的兜底：
//   - GET /api/render/jobs/[id] 兼容 renderJobId/taskId，返回状态、类型与创建时间；
//     progress/stage 仍由项目进度或 SSE 事件提供。
//   - GET /api/render/jobs        → 当前用户最小作业列表，支持 status/type/projectId。
//
// SSE 通道与 app1 完全一致：/api/sse 透传 Redis task:events 事件，载荷形状
// 兼容 app1 的 TaskEventPayload（taskId/userId/status/progress/stage 等）。
// ============================================================

"use client";

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { authFetch } from "./useAuthFetch";

// ============================================================
// 类型定义
// ============================================================

/**
 * 任务事件接口（通过 SSE 接收，形状兼容 app1 TaskEventPayload）
 */
interface TaskEvent {
  taskId: string;
  type:
    | "status_change"
    | "progress"
    | "output"
    | "error"
    | "connected"
    | "system_alert";
  status?: string;
  progress?: number;
  output?: unknown;
  /** ai-worker 的完成状态事件沿用服务端冻结契约，结果字段名为 result。 */
  result?: unknown;
  error?: string;
  timestamp: number;
  userId?: string;
  stage?: string;
  stageProgress?: number;
  errorCode?: string;
  errorCategory?: string;
  errorSeverity?: string;
  errorSuggestion?: string;
  retryable?: boolean;
  errorStage?: string;
  traceId?: string;
  errorTimestamp?: string;
  projectId?: string;
  errorStack?: string;
  errorContext?: Record<string, unknown>;
  alertThreshold?: number;
  alertCount?: number;
  alertWindowSeconds?: number;
  id?: string;
  snapshot?: boolean;
  /**
   * 渐进回传(dramaforge 独建):chain 编排器每组完成时,把已落客户端本地的组片 sf-asset:// URL
   * 随 progress 事件下发。前端按 shotIds 乐观更新镜头卡片即时显示视频(不必等整链 COMPLETED)。
   */
  groupClip?: {
    shotIds: string[];
    videoUrl: string;
  };
}

/**
 * 任务信息（dramaforge 适配版）
 *
 * id/status/error/result 为 dramaforge render-jobs [id] 端点直接返回的字段；
 * 其余字段 dramaforge 端点暂不返回（app1 /api/tasks 才有），保留为 optional
 * 以兼容 app1 风格的调用方代码。
 */
export interface TaskInfo {
  id: string;
  status: string;
  error: string | null;
  result: unknown;
  // ---- 进度字段由 SSE/项目进度提供，其余由 render-jobs 状态端点返回 ----
  progress?: number;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  stage?: string;
  stageProgress?: number;
  projectId?: string | null;
  /** AI 任务由服务端执行；render 任务由桌面客户端执行。 */
  backend?: "ai" | "render";
}

async function loadTaskById(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskInfo | null> {
  const encoded = encodeURIComponent(taskId);
  const aiResponse = await authFetch(`/api/tasks/${encoded}`, { signal });
  if (aiResponse.ok) {
    const payload = (await aiResponse.json()) as {
      data?: TaskInfo & { output?: unknown };
    };
    if (payload.data) {
      return {
        ...payload.data,
        result: payload.data.output ?? payload.data.result ?? null,
        error: payload.data.error ?? null,
        backend: "ai",
      };
    }
  } else if (aiResponse.status !== 404) {
    throw new Error(`查询 AI 任务失败（${aiResponse.status}）`);
  }

  const renderResponse = await authFetch(`/api/render/jobs/${encoded}`, { signal });
  if (renderResponse.status === 404) return null;
  if (!renderResponse.ok) {
    throw new Error(`查询客户端任务失败（${renderResponse.status}）`);
  }
  const payload = (await renderResponse.json()) as {
    job?: {
      id?: string;
      taskId?: string;
      status?: string;
      type?: string;
      createdAt?: string;
      updatedAt?: string;
      error?: string | null;
      result?: unknown;
      progress?: number;
      projectId?: string | null;
    };
  };
  if (!payload.job) return null;
  return {
    id: payload.job.taskId ?? taskId,
    status: payload.job.status ?? "UNKNOWN",
    type: payload.job.type,
    createdAt: payload.job.createdAt,
    updatedAt: payload.job.updatedAt,
    projectId: payload.job.projectId,
    progress: payload.job.progress,
    error: payload.job.error ?? null,
    result: payload.job.result ?? null,
    backend: "render",
  };
}

// ============================================================
// 全局单例 SSE（模块级别，所有 useSSE 调用共享同一连接）
// ============================================================

type SSEListener = () => void;

let _sharedEventSource: EventSource | null = null;
let _sharedConnected = false;
let _sharedEvents: TaskEvent[] = [];
const _subscribers = new Set<SSEListener>();
let _refCount = 0;

// ============================================================
// 活动 taskId 注册表 —— SSE 断线时按 ID 轮询，确保完成态不丢
// ============================================================
// （详见下方注释：原批量轮询只查 RUNNING，终态会漏，这里按 ID 查询真实状态。）

const _activeTaskIds = new Set<string>();
const _lastKnownStatus = new Map<string, string>();

/**
 * 注册需要跟踪的任务 ID
 *
 * 创建任务后调用：SSE 断线时轮询会按 ID 查询这些任务的真实状态，
 * 确保任务完成（COMPLETED/FAILED）时即使 SSE 暂断也能及时反馈到前端。
 */
export function trackTaskId(taskId: string): void {
  if (!taskId) return;
  _activeTaskIds.add(taskId);
}

/**
 * 注销任务 ID（任务进入终态或清理时调用）
 */
export function untrackTaskId(taskId: string): void {
  _activeTaskIds.delete(taskId);
  _lastKnownStatus.delete(taskId);
}

// 指数退避重连配置
let _reconnectAttempt = 0;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_BASE_DELAY = 1000; // 初始 1 秒
const RECONNECT_MAX_DELAY = 30000; // 最大 30 秒
const RECONNECT_JITTER = 0.2; // 抖动 ±20%

function calculateReconnectDelay(): number {
  const exponentialDelay =
    RECONNECT_BASE_DELAY * Math.pow(2, _reconnectAttempt);
  const clampedDelay = Math.min(exponentialDelay, RECONNECT_MAX_DELAY);
  const jitter = clampedDelay * RECONNECT_JITTER * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_BASE_DELAY, Math.round(clampedDelay + jitter));
}

function notifySubscribers(): void {
  _subscribers.forEach((fn) => fn());
}

// 缓存 getSnapshot 返回的快照，仅在数据变化时创建新对象，避免无限循环
let _cachedSnapshot: { events: TaskEvent[]; connected: boolean } | null = null;
function sharedGetSnapshot(): { events: TaskEvent[]; connected: boolean } {
  if (
    _cachedSnapshot &&
    _cachedSnapshot.events === _sharedEvents &&
    _cachedSnapshot.connected === _sharedConnected
  ) {
    return _cachedSnapshot;
  }
  _cachedSnapshot = { events: _sharedEvents, connected: _sharedConnected };
  return _cachedSnapshot;
}

// SSR 快照（稳定引用，避免 useSyncExternalStore 无限循环）
const _serverSnapshot = { events: [] as TaskEvent[], connected: false };
function getServerSnapshot(): { events: TaskEvent[]; connected: boolean } {
  return _serverSnapshot;
}

function ensureSSE(): void {
  if (_sharedEventSource) return;
  if (typeof window === "undefined") return; // SSR 防御
  const es = new EventSource("/api/sse");
  es.onopen = () => {
    _sharedConnected = true;
    _reconnectAttempt = 0;
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    // 【SSE 可恢复】重连后清空已知状态，让后端推送的快照/重放事件重新填充基线
    _lastKnownStatus.clear();
    notifySubscribers();
  };
  es.addEventListener("close", () => {
    _sharedConnected = false;
    notifySubscribers();
    scheduleReconnect();
  });
  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as TaskEvent;

      // 快照事件：重建 _activeTaskIds / _lastKnownStatus
      if (event.snapshot === true && event.taskId) {
        _activeTaskIds.add(event.taskId);
        if (event.status) {
          _lastKnownStatus.set(event.taskId, event.status);
        }
      }

      // 缓冲区策略：高优先级（status_change/error/output）保留，progress 满时优先淘汰
      const MAX_EVENTS = 200;
      const isHighPriority =
        event.type === "status_change" ||
        event.type === "error" ||
        event.type === "output";
      if (isHighPriority) {
        _sharedEvents = [event, ..._sharedEvents.slice(0, MAX_EVENTS - 1)];
      } else {
        const candidate = [event, ..._sharedEvents];
        const progressCount = candidate.filter(
          (ev) => ev.type === "progress",
        ).length;
        if (progressCount > 120) {
          const filtered: TaskEvent[] = [];
          let removed = 0;
          const toRemove = progressCount - 120;
          for (let i = candidate.length - 1; i >= 0; i--) {
            if (candidate[i].type === "progress" && removed < toRemove) {
              removed++;
              continue;
            }
            filtered.unshift(candidate[i]);
          }
          _sharedEvents = filtered.slice(0, MAX_EVENTS);
        } else {
          _sharedEvents = candidate.slice(0, MAX_EVENTS);
        }
      }
      notifySubscribers();
    } catch {
      // 忽略无效 JSON
    }
  };
  es.onerror = () => {
    _sharedConnected = false;
    notifySubscribers();
    es.close();
    _sharedEventSource = null;
    scheduleReconnect();
  };
  _sharedEventSource = es;
}

function scheduleReconnect(): void {
  if (_reconnectTimer || _refCount <= 0) return;
  const delay = calculateReconnectDelay();
  console.log(
    `[SSE] 将在 ${delay}ms 后尝试第 ${_reconnectAttempt + 1} 次重连`,
  );
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _reconnectAttempt++;
    if (_refCount > 0 && !_sharedEventSource) {
      ensureSSE();
    }
  }, delay);
}

function subscribeSSE(fn: SSEListener): () => void {
  _refCount++;
  _subscribers.add(fn);
  ensureSSE();
  return () => {
    _subscribers.delete(fn);
    _refCount--;
    if (_refCount <= 0 && _sharedEventSource) {
      if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
      }
      _reconnectAttempt = 0;
      _sharedEventSource.close();
      _sharedEventSource = null;
      _sharedConnected = false;
      _refCount = 0;
    }
  };
}

// ============================================================
// Hook: useSSE
// ============================================================

/**
 * SSE 实时事件监听 Hook（全局单例）
 *
 * 所有调用共享同一个 EventSource 连接（/api/sse）。自动处理连接状态、
 * 指数退避重连，并保留最近 200 条事件。
 *
 * 断线兜底：HTTP 轮询 RUNNING 任务 + 按 ID 轮询 trackTaskId 注册的任务。
 *
 * @returns { events, connected }
 */
export function useSSE(): { events: TaskEvent[]; connected: boolean } {
  const { events, connected } = useSyncExternalStore(
    subscribeSSE,
    sharedGetSnapshot,
    getServerSnapshot,
  );

  // SSE 断线兜底：HTTP 轮询（全局仅一份，connected=true 时停止）
  // 按 ID 轮询 trackTaskId 注册的任务，确保即使作业刚进入终态、不再出现在
  // RUNNING 列表中，也能触发一次完成/失败回调。
  useEffect(() => {
    if (connected) return;

    const pollInterval = setInterval(async () => {
      // 按 ID 轮询 trackTaskId 注册的任务（关键：能发现终态）
      const trackedIds = Array.from(_activeTaskIds);
      if (trackedIds.length === 0) return;
      await Promise.all(
        trackedIds.map(async (taskId) => {
          try {
            const job = await loadTaskById(taskId);
            if (!job) return;
            const newStatus = job.status ?? "UNKNOWN";
            const prevStatus = _lastKnownStatus.get(taskId);
            if (prevStatus !== newStatus) {
              _sharedEvents = [
                {
                  taskId,
                  type: "status_change" as const,
                  status: newStatus,
                  error: job.error ?? undefined,
                  output: job.result,
                  timestamp: Date.now(),
                },
                ..._sharedEvents.slice(0, 199),
              ];
              notifySubscribers();
            }
            _lastKnownStatus.set(taskId, newStatus);
            // 终态注销
            if (
              newStatus === "COMPLETED" ||
              newStatus === "FAILED" ||
              newStatus === "CANCELLED" ||
              newStatus === "TIMEOUT"
            ) {
              untrackTaskId(taskId);
            }
          } catch {
            // 单个任务查询失败不影响其他
          }
        }),
      );
    }, 30_000);

    return () => clearInterval(pollInterval);
  }, [connected]);

  return { events, connected };
}

// ============================================================
// Hook: useTaskStatus
// ============================================================

/**
 * 单任务状态查询 Hook
 *
 * - 5s 轮询 /api/render/jobs/{id} 兜底（dramaforge 适配点：app1 原对 /api/tasks/{id}）
 * - SSE 事件触发即时 refetch（监听全局 events 流）
 * - taskId 变化时重新拉取并 trackTaskId 注册
 *
 * @param taskId - 任务 ID，null 时不发起请求
 * @returns { task, loading, refetch }
 */
export function useTaskStatus(
  taskId: string | null,
): {
  task: TaskInfo | null;
  loading: boolean;
  refetch: () => Promise<void>;
} {
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [loading, setLoading] = useState(false);
  // 订阅 SSE 流，用于事件触发 refetch。
  const { events } = useSSE();
  // AbortController：每次新请求作废上一次 in-flight，防竞态（旧响应覆盖新）。
  const abortRef = useRef<AbortController | null>(null);

  const fetchTask = useCallback(async () => {
    if (!taskId) return;
    // 取消上一次未完成请求（SSE 事件密集触发 / 5s 轮询并发场景）
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      setTask(await loadTaskById(taskId, ctrl.signal));
    } catch (err) {
      // AbortError：被新请求作废，不报错、不动 state
      if ((err as { name?: string })?.name === "AbortError") return;
      // 网络错误：保持现有 task，不覆盖
    } finally {
      // 只有最新一次请求才清 loading（被作废的旧请求跳过）
      if (abortRef.current === ctrl) {
        setLoading(false);
      }
    }
  }, [taskId]);

  // taskId 注册（独立 effect，避免 connected 切换时误 untrack）
  useEffect(() => {
    if (!taskId) return;
    trackTaskId(taskId);
    return () => untrackTaskId(taskId);
  }, [taskId]);

  // 初始加载 + 5s 主动轮询（无论 SSE 在线与否），直至终态。
  // 曾仅 SSE 断线时轮询——但 SSE "connected" ≠ 事件必达：短命 inline 任务的
  // COMPLETED 事件可与订阅/缓冲竞态被漏投 → task.status 停在 RUNNING → 完成不
  // 反馈、需手动刷新。现恒定轮询至终态，SSE 事件仍即时触发 refetch（双保险）。
  useEffect(() => {
    void fetchTask();
    if (!taskId) return;
    const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT']);
    if (task && TERMINAL.has(task.status)) return;
    const interval = setInterval(() => void fetchTask(), 5000);
    return () => clearInterval(interval);
  }, [fetchTask, taskId, task?.status]);

  // SSE 触发 refetch：最新事件与本任务相关时立即拉取最新状态
  useEffect(() => {
    if (!taskId) return;
    const latest = events[0];
    if (latest && latest.taskId === taskId) {
      void fetchTask();
    }
  }, [events, taskId, fetchTask]);

  return { task, loading, refetch: fetchTask };
}

// ============================================================
// Hook: useTaskList
// ============================================================

/**
 * 任务列表查询 Hook
 *
 * GET /api/render/jobs 只返回当前用户的最小展示字段；5 秒轮询用于页面刷新后
 * 恢复活跃任务，SSE 仍负责低延迟的单任务刷新。
 *
 * @returns { tasks, total, loading, refetch }
 */
export function useTaskList(options?: {
  status?: string;
  type?: string;
  projectId?: string;
}): {
  tasks: TaskInfo[];
  total: number;
  loading: boolean;
  refetch: () => Promise<void>;
} {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // 只把原始筛选值放进依赖，避免调用方每次 render 传新对象导致重复轮询。
  const statusFilter = options?.status;
  const typeFilter = options?.type;
  const projectFilter = options?.projectId;

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const commonParams = new URLSearchParams();
      if (typeFilter) commonParams.set("type", typeFilter);
      if (projectFilter) commonParams.set("projectId", projectFilter);
      const aiParams = new URLSearchParams(commonParams);
      const renderParams = new URLSearchParams(commonParams);
      if (statusFilter) {
        aiParams.set("status", statusFilter === "RUNNING" ? "ACTIVE" : statusFilter);
        renderParams.set("status", statusFilter);
      }
      const aiQuery = aiParams.toString();
      const renderQuery = renderParams.toString();
      const [aiResult, renderResult] = await Promise.allSettled([
        authFetch(`/api/tasks${aiQuery ? `?${aiQuery}` : ""}`),
        authFetch(`/api/render/jobs${renderQuery ? `?${renderQuery}` : ""}`),
      ]);
      const aiTasks: TaskInfo[] = [];
      const renderTasks: TaskInfo[] = [];
      if (aiResult.status === "fulfilled" && aiResult.value.ok) {
        const payload = (await aiResult.value.json()) as {
          data?: { tasks?: Array<TaskInfo & { output?: unknown }> };
        };
        for (const task of payload.data?.tasks ?? []) {
          aiTasks.push({
            ...task,
            result: task.output ?? task.result ?? null,
            backend: "ai",
          });
        }
      }
      if (renderResult.status === "fulfilled" && renderResult.value.ok) {
        const payload = (await renderResult.value.json()) as { jobs?: TaskInfo[] };
        for (const task of payload.jobs ?? []) {
          renderTasks.push({ ...task, backend: "render" });
        }
      }
      const nextTasks = [...aiTasks, ...renderTasks].sort((a, b) =>
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
      );
      setTasks(nextTasks);
      setTotal(nextTasks.length);
    } catch {
      // 短暂断网时保留上一次列表；SSE 或下一轮轮询会继续恢复。
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, projectFilter]);

  useEffect(() => {
    void fetchTasks();
    const timer = setInterval(() => void fetchTasks(), 5000);
    return () => clearInterval(timer);
  }, [fetchTasks]);

  return { tasks, total, loading, refetch: fetchTasks };
}

// ============================================================
// Hook: useConcurrencyStatus
// ============================================================
//
// dramaforge 适配点（重要）：
// app1 原打 /api/user/concurrency（DB 查 user_concurrency 表 + per-key 占用）。
// dramaforge 当前**没有**对应路由（并发模型不同——dramaforge 走 render_jobs + 单 worker
// 认领，没有 app1 的 per-user/per-key 并发上限配置 UI）。这里按 useTaskList
// 同款短路策略：返回 null 不发包，避免每 5s 刷 404；hooks 类型签名照搬 app1，
// 后续若 dramaforge 引入并发管理 UI，去掉短路、恢复下面注释的查询逻辑即可。
// ============================================================

/**
 * 单个 API Key 的并发占用状态（形状与 app1 一致，便于未来对接）
 */
export interface ApiKeyConcurrencyStatus {
  /** DB key 用 config.id；env key 用 `env:${provider}` */
  keyId: string;
  provider: string;
  label: string;
  /** 是否为环境变量导入的 key（不可编辑并发上限） */
  isEnv: boolean;
  /** 当前并发占用数 */
  current: number;
  /** 并发上限（per-key 覆盖值或全局默认） */
  max: number;
  /** DB 中配置的 maxConcurrent（null=用全局默认） */
  maxConcurrent: number | null;
}

/**
 * 用户并发状态 Hook（dramaforge 短路版）
 *
 * app1 原意：获取当前用户的并发任务限制、全局队列状态、每个 API Key 的占用，
 * 用于 settings 页 Key 卡片徽章 + 全局并发仪表盘。5 秒轮询。
 *
 * dramaforge 适配：无 /api/user/concurrency 路由，短路返回 null，不发包。
 *
 * @returns { status, apiKeys, refresh } — status/apiKeys 恒为 null，refresh 空操作
 */
export function useConcurrencyStatus(): {
  status: {
    currentPerUser: number;
    maxPerUser: number;
    currentGlobal: number;
    maxGlobal: number;
  } | null;
  apiKeys: ApiKeyConcurrencyStatus[] | null;
  refresh: () => void;
} {
  // 批? 补 /api/user/concurrency 端点后去掉短路，恢复下面注释的查询逻辑：
  //
  // const [status, setStatus] = useState<{...} | null>(null);
  // const [apiKeys, setApiKeys] = useState<ApiKeyConcurrencyStatus[] | null>(null);
  // const fetchStatus = useCallback(() => {
  //   authFetch("/api/user/concurrency")
  //     .then((r) => r.json())
  //     .then((data) => {
  //       if (data.success) {
  //         setStatus(data.data.concurrency);
  //         setApiKeys(data.data.apiKeys ?? []);
  //       }
  //     })
  //     .catch(() => { /* 忽略错误 */ });
  // }, []);
  // useEffect(() => {
  //   fetchStatus();
  //   const timer = setInterval(fetchStatus, 5000);
  //   return () => clearInterval(timer);
  // }, [fetchStatus]);
  // return { status, apiKeys, refresh: fetchStatus };

  const refresh = useCallback(() => {
    // no-op：dramaforge 无并发状态端点
  }, []);
  return { status: null, apiKeys: null, refresh };
}

// ============================================================
// 辅助函数：任务操作（cancel / retry）
// ============================================================
//
// dramaforge 适配点：路径参数可传 taskId 或 renderJobId，route 会在当前用户范围内
// 解析到同一 render_job，并用 CAS 完成取消/重试状态转换。
// ============================================================

/**
 * 取消任务（dramaforge 适配：打 /api/render/jobs/{id}）
 *
 * app1 原打 DELETE /api/tasks/{taskId}。dramaforge 适配到 render_jobs 路由家族。
 * @param taskId - 要取消的任务 ID
 * @throws 网络错误或 API 错误时抛出异常
 */
export async function cancelTask(
  taskId: string,
  backend?: "ai" | "render",
): Promise<void> {
  // AI 任务（BullMQ）打 /api/tasks/{id}；render 任务（客户端 ffmpeg）打 /api/render/jobs/{id}。
  // 默认 render 保持旧调用方向后兼容。两族 route 响应体不同（render {ok:true} / AI {success:true}），
  // 故只校验 res.ok，不再强求 data.ok（AI route 无 ok 字段会误抛）。
  const endpoint =
    backend === "ai"
      ? `/api/tasks/${encodeURIComponent(taskId)}`
      : `/api/render/jobs/${encodeURIComponent(taskId)}`;
  const res = await authFetch(endpoint, { method: "DELETE" });

  if (!res.ok) {
    const errorData = (await res
      .json()
      .catch(() => ({ error: "Unknown error" }))) as { error?: string };
    throw new Error(errorData.error || `Failed to cancel task: ${res.status}`);
  }
}

/**
 * 重试失败的任务（dramaforge 适配：打 /api/render/jobs/{id}/retry）
 *
 * app1 原打 POST /api/tasks/{taskId}/retry。dramaforge 适配到 render_jobs 路由家族。
 * @param taskId - 要重试的任务 ID
 * @throws 网络错误或 API 错误时抛出异常
 */
export async function retryTask(taskId: string): Promise<void> {
  const res = await authFetch(
    `/api/render/jobs/${encodeURIComponent(taskId)}/retry`,
    { method: "POST" },
  );

  if (!res.ok) {
    const errorData = (await res
      .json()
      .catch(() => ({ error: "Unknown error" }))) as { error?: string };
    throw new Error(errorData.error || `Failed to retry task: ${res.status}`);
  }

  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) {
    throw new Error(data.error || "Retry operation failed");
  }
}

// ============================================================
// 结构化错误响应解析
// ============================================================

/**
 * 从 API 响应中解析结构化错误信息（照搬 app1）
 *
 * 后端 handleApiError / apiError(结构化形式) 返回的 JSON 包含：
 *   - success: false
 *   - error: 用户可读消息（向后兼容）
 *   - code / category / severity / retryable / suggestion / traceId / timestamp
 *   - stack / context（仅开发环境）
 *
 * 本函数尝试从响应中提取这些字段，失败时返回仅含 error 的兜底对象。
 *
 * @param res - fetch Response 对象
 * @returns 结构化错误信息对象
 */
export interface ParsedApiError {
  /** 用户可读错误消息 */
  error: string;
  /** 错误代码 */
  code?: string;
  /** 错误类别 */
  category?: string;
  /** 错误严重级别 */
  severity?: string;
  /** 处理建议 */
  suggestion?: string;
  /** 是否可重试 */
  retryable?: boolean;
  /** traceId */
  traceId?: string;
  /** 错误时间戳 */
  timestamp?: string;
  /** 堆栈（仅开发环境） */
  stack?: string;
  /** 上下文（仅开发环境） */
  context?: Record<string, unknown>;
  /** HTTP 状态码 */
  status: number;
  /** AI 提供商展示名（额度不足时填充） */
  providerName?: string;
  /** 提供商充值页 URL（额度不足时填充） */
  rechargeUrl?: string;
}

export async function parseApiErrorResponse(
  res: Response,
): Promise<ParsedApiError> {
  const status = res.status;
  const body = (await res
    .json()
    .catch(() => ({ error: `HTTP ${status} 错误` }))) as Record<
    string,
    unknown
  >;
  return {
    error:
      typeof body.error === "string" ? body.error : `请求失败（${status}）`,
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    ...(typeof body.category === "string" ? { category: body.category } : {}),
    ...(typeof body.severity === "string" ? { severity: body.severity } : {}),
    ...(typeof body.suggestion === "string"
      ? { suggestion: body.suggestion }
      : {}),
    ...(typeof body.retryable === "boolean"
      ? { retryable: body.retryable }
      : {}),
    ...(typeof body.traceId === "string" ? { traceId: body.traceId } : {}),
    ...(typeof body.timestamp === "string" ? { timestamp: body.timestamp } : {}),
    ...(typeof body.stack === "string" ? { stack: body.stack } : {}),
    ...(body.context && typeof body.context === "object"
      ? { context: body.context as Record<string, unknown> }
      : {}),
    status,
    ...(typeof body.providerName === "string"
      ? { providerName: body.providerName }
      : {}),
    ...(typeof body.rechargeUrl === "string"
      ? { rechargeUrl: body.rechargeUrl }
      : {}),
  };
}

// ============================================================
// Hook: useGlobalErrorHandler
// ============================================================

/**
 * 全局错误事件接口（从 SSE 事件提取的错误信息，统一格式）
 */
export interface GlobalErrorEvent {
  /** 唯一标识（traceId 或 taskId+timestamp） */
  id: string;
  /** 错误消息 */
  message: string;
  /** 错误代码 */
  code?: string;
  /** 错误类别 */
  category?: string;
  /** 错误严重级别 */
  severity?: string;
  /** 处理建议 */
  suggestion?: string;
  /** 是否可重试 */
  retryable?: boolean;
  /** 发生阶段 */
  stage?: string;
  /** traceId */
  traceId?: string;
  /** 时间戳 */
  timestamp: number;
  /** 关联的任务 ID */
  taskId?: string;
  /** 关联的项目 ID */
  projectId?: string;
  /** 是否为系统报警（频率超限） */
  isAlert?: boolean;
  /** 报警次数（仅 isAlert=true） */
  alertCount?: number;
  /** 报警阈值（仅 isAlert=true） */
  alertThreshold?: number;
  /** 堆栈（仅开发环境） */
  stack?: string;
  /** 上下文（仅开发环境） */
  context?: Record<string, unknown>;
  /** AI 提供商展示名（额度不足时填充，用于充值弹窗） */
  providerName?: string;
  /** 提供商充值页 URL（额度不足时填充，用于充值弹窗） */
  rechargeUrl?: string;
}

/** 已被 dismiss 的错误 ID 集合（模块级，避免每次渲染重置） */
const _dismissedErrorIds = new Set<string>();

/**
 * 全局错误处理器 Hook（照搬 app1，纯 SSE 消费者无 dramaforge 适配点）
 *
 * 订阅 SSE 事件流，提取所有 error 和 system_alert 事件，
 * 提供统一的错误状态供应用顶层组件渲染全局错误横幅或 Toast。
 *
 * 功能：
 *   - 自动收集 SSE 中的 error 和 system_alert 事件
 *   - 保留最近 20 条错误（避免内存膨胀）
 *   - 提供 dismiss 方法手动清除错误
 *   - 自动去重（相同 traceId 的错误只保留一条）
 *
 * @returns 包含以下字段的对象：
 *   - errors: 最近的错误列表（最新在前，已过滤 dismissed）
 *   - dismiss: 移除指定 ID 的错误
 *   - dismissAll: 清空所有错误
 */
export function useGlobalErrorHandler(): {
  errors: GlobalErrorEvent[];
  dismiss: (id: string) => void;
  dismissAll: () => void;
} {
  const { events } = useSSE();

  // 从 SSE 事件中提取 error 和 system_alert 事件
  const errors: GlobalErrorEvent[] = (() => {
    const collected: GlobalErrorEvent[] = [];
    const seenIds = new Set<string>();

    for (const event of events) {
      // 错误事件
      if (event.type === "error") {
        const id = event.traceId || `${event.taskId}-${event.timestamp}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        collected.push({
          id,
          message: event.error || "未知错误",
          code: event.errorCode,
          category: event.errorCategory,
          severity: event.errorSeverity,
          suggestion: event.errorSuggestion,
          retryable: event.retryable,
          stage: event.errorStage,
          traceId: event.traceId,
          timestamp: event.errorTimestamp
            ? new Date(event.errorTimestamp).getTime()
            : event.timestamp,
          taskId: event.taskId,
          projectId: event.projectId,
          stack: event.errorStack,
          context: event.errorContext,
          providerName: (event as { providerName?: string }).providerName,
          rechargeUrl: (event as { rechargeUrl?: string }).rechargeUrl,
        });
      }
      // 系统报警事件
      else if (event.type === "system_alert") {
        const id = `alert-${event.timestamp}-${event.errorCode || ""}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        collected.push({
          id,
          message: event.error || "系统报警",
          code: event.errorCode,
          category: event.errorCategory,
          severity: event.errorSeverity,
          isAlert: true,
          alertCount: event.alertCount,
          alertThreshold: event.alertThreshold,
          traceId: event.traceId,
          timestamp: event.errorTimestamp
            ? new Date(event.errorTimestamp).getTime()
            : event.timestamp,
          stack: event.errorStack,
          context: event.errorContext,
        });
      }

      if (collected.length >= 20) break;
    }

    return collected;
  })();

  const dismiss = useCallback((id: string) => {
    _dismissedErrorIds.add(id);
  }, []);

  const dismissAll = useCallback(() => {
    for (const e of errors) {
      _dismissedErrorIds.add(e.id);
    }
  }, [errors]);

  // 过滤掉被 dismiss 的错误
  const visibleErrors = errors.filter((e) => !_dismissedErrorIds.has(e.id));

  return { errors: visibleErrors, dismiss, dismissAll };
}
