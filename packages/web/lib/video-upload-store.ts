// ============================================================
// video-upload-store.ts — 转剧本上传的「导航无关」单例 store
// ============================================================
//
// 为什么需要（B 方案切集丢进度的根因）：
//   dramaforge 是 B 方案：每集一个独立路由，切集 = router.push → 当前集的
//   EpisodeWorkspace / InputStage **整个 unmount**。而视频转剧本的上传 fetch、
//   uploading 态、taskId、终态去重 ref 此前全部挂在 InputStage 的组件局部 state
//   上。一切集，这些瞬态全丢；虽然 sessionStorage 还留着 taskId 指针，但上传
//   fetch 的归属没了、终态去重对不齐，运行时流再一断，任务就 FAILED。
//
//   拆分镜不受影响：POST 只发一小段 JSON（瞬间收完，服务端自跑），且用
//   useInFlightGeneration 的 localStorage 锁 + reconcile 回来能续。
//
// 解法（对齐指令「任何任务切菜单都跑到完成」）：
//   把转剧本的「上传 fetch 归属 + uploading/taskId/error/script/终态去重」
//   提到模块级单例——不随路由/组件卸载而销毁。组件只通过 useVideoUpload 订阅。
//   useApi/useAuthFetch 均无 AbortController，故模块级 fetch 在 SPA 导航下继续
//   跑到完成；切回来时组件重新订阅，进度/结果自动恢复。
//
// 边界（与既有设计一致）：
//   - 进度仍由 useTaskStatus(taskId)（hooks/useTaskStatus 的模块级 SSE 单例）驱动，
//     跨导航存活；本 store 不重复造进度通道。
//   - sessionStorage 指针仍作为「整页刷新」后的恢复兜底（模块级 store 只活在内存，
//     整页刷新会重建；刷新时上传 fetch 已死，靠服务端 task 续命 + 这里 seedFromStorage
//     把 taskId 灌回 store）。
//   - 服务器不存视频字节（dramaforge-assets-client-local 硬约束）：本 store 只拥有客户端
//     侧的 fetch 生命周期与瞬态，不碰服务端存储。
// ============================================================

import {
  buildVideoStreamHeaders,
  clearRecoveredVideoTask,
  loadRecoveredVideoTask,
  resolveVideoTransportFailure,
  saveRecoverableVideoTask,
} from "./video-to-script-progress";

/** store 对外暴露的快照（稳定引用，供 useSyncExternalStore）。 */
export interface VideoUploadState {
  /** 浏览器预生成 taskId；关联 tasks/SSE。null = 本集无在途转剧本。 */
  taskId: string | null;
  /** 上传阶段（raw File 流还在传）；false = 上传已结束（可能仍在服务端处理）。 */
  uploading: boolean;
  /** 硬错误（前置校验失败 / 终态 FAILED 文案）。null = 无。 */
  error: string | null;
  /** 上传连接中断的中性提示（不等于失败，后台任务仍可能在跑）。 */
  transportNotice: string | null;
  /** HTTP 成功时服务端返回的剧本（用于即时回填，省一次 episode 重载）。 */
  script: string | null;
  /** 任务进入时间戳（ms）。0 = 未开始。 */
  startedAt: number;
  /** 终态（COMPLETED/FAILED）是否已处理过，防重复 onCompleted/onFailed。跨导航存活。 */
  handledTerminal: boolean;
}

/** 内部态与对外快照同构（不再额外字段；保留别名便于以后扩展内部态）。 */
type VideoUploadInternal = VideoUploadState;

const EMPTY_INTERNAL: VideoUploadInternal = {
  taskId: null,
  uploading: false,
  error: null,
  transportNotice: null,
  script: null,
  startedAt: 0,
  handledTerminal: false,
};

/** SSR 稳定空快照（useSyncExternalStore 的 getServerSnapshot 用）。 */
const EMPTY_SNAPSHOT: VideoUploadState = {
  taskId: null,
  uploading: false,
  error: null,
  transportNotice: null,
  script: null,
  startedAt: 0,
  handledTerminal: false,
};

const keyFor = (projectId: string, episodeId: string): string =>
  `${projectId}:${episodeId}`;

/** 每个 key 的内部态。 */
const _state = new Map<string, VideoUploadInternal>();
/**
 * 每个 key 的对外快照缓存。patch 时失效对应 key，保证 useSyncExternalStore 的
 * getSnapshot 在无变更时返回同一引用（否则无限循环）。
 */
const _snapshotCache = new Map<string, VideoUploadState>();
/** 全局订阅者（任一 key 变更都通知；各订阅者 getSnapshot 取自己 key 的快照）。 */
const _listeners = new Set<() => void>();

function emit(): void {
  _listeners.forEach((fn) => fn());
}

function readInternal(projectId: string, episodeId: string): VideoUploadInternal {
  return _state.get(keyFor(projectId, episodeId)) ?? EMPTY_INTERNAL;
}

function patch(
  projectId: string,
  episodeId: string,
  partial: Partial<VideoUploadInternal>,
): void {
  const key = keyFor(projectId, episodeId);
  const prev = _state.get(key) ?? EMPTY_INTERNAL;
  _state.set(key, { ...prev, ...partial });
  _snapshotCache.delete(key); // 失效快照，下次 getSnapshot 重建新引用
  emit();
}

/** 构建对外快照（命中缓存返回稳定引用）。 */
export function getVideoUploadState(
  projectId: string,
  episodeId: string,
): VideoUploadState {
  const key = keyFor(projectId, episodeId);
  const cached = _snapshotCache.get(key);
  if (cached) return cached;
  const internal = readInternal(projectId, episodeId);
  const snapshot: VideoUploadState = {
    taskId: internal.taskId,
    uploading: internal.uploading,
    error: internal.error,
    transportNotice: internal.transportNotice,
    script: internal.script,
    startedAt: internal.startedAt,
    handledTerminal: internal.handledTerminal,
  };
  _snapshotCache.set(key, snapshot);
  return snapshot;
}

/** useSyncExternalStore 订阅函数。 */
export function subscribeVideoUpload(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/** SSR 快照。 */
export function getVideoUploadServerSnapshot(): VideoUploadState {
  return EMPTY_SNAPSHOT;
}

/**
 * 整页刷新后的恢复：若内存里没有本集在途任务，但 sessionStorage 有 30 分钟窗口内
 * 的指针，把 taskId 灌回 store（uploading=true，让 useTaskStatus 续命取进度）。
 *
 * 仅当本集无内存任务时灌入，避免覆盖正在跑的内存态。
 */
export function seedFromStorage(projectId: string, episodeId: string): void {
  if (readInternal(projectId, episodeId).taskId) return; // 已有内存任务，不覆盖
  if (typeof window === "undefined") return;
  const recovered = loadRecoveredVideoTask(window.sessionStorage, projectId, episodeId);
  if (!recovered) return;
  patch(projectId, episodeId, {
    taskId: recovered,
    uploading: true,
    error: null,
    transportNotice: null,
    script: null,
    startedAt: Date.now(),
    handledTerminal: false,
  });
}

/** 前置校验失败 / 用户重试前清错。msg=null 清空。 */
export function reportVideoUploadError(
  projectId: string,
  episodeId: string,
  msg: string | null,
): void {
  patch(projectId, episodeId, { error: msg });
}

/**
 * 启动转剧本上传（模块级 fetch，跨导航存活）。
 *
 * 流程：
 *   1. crypto.randomUUID() 生成 taskId（route 会按它建 tasks 行 + 推 SSE）
 *   2. patch uploading=true / 写 sessionStorage 指针
 *   3. 模块级发起 raw File 流 POST（不挂任何 AbortController；组件卸载不影响它）
 *   4. 返回即 patch uploading=false（上传阶段结束）；script/transportNotice 按结果落
 *   终态（COMPLETED/FAILED）由 useVideoUpload 的 useTaskStatus 回调处理，非这里。
 *
 * @param api useApi 装配的请求函数（envelope 解析 + toast；失败返 null 不抛）
 */
export function startVideoUpload(
  projectId: string,
  episodeId: string,
  file: File,
  api: (url: string, options?: RequestInit) => Promise<unknown>,
  opts: { sourceDurationSeconds: number | null; model?: string },
): void {
  const taskId = globalThis.crypto.randomUUID();
  patch(projectId, episodeId, {
    taskId,
    uploading: true,
    error: null,
    transportNotice: null,
    script: null,
    startedAt: Date.now(),
    handledTerminal: false,
  });
  if (typeof window !== "undefined") {
    saveRecoverableVideoTask(window.sessionStorage, projectId, episodeId, taskId);
  }
  // 模块级发起：fetch 的 Promise 归 store 所有，组件 unmount / 切集都不杀它。
  void runVideoUploadFetch(projectId, episodeId, taskId, file, api, opts);
}

/**
 * 实际的上传 fetch（模块级，跨导航存活）。
 *
 * api 失败时返回 null（不抛），故区分：
 *   - result.script 有值 → HTTP 成功，任务已落库；存 script 供即时回填。
 *   - 否则（null / 空）→ 上传连接中断或服务端错误；taskId 仍在，由 useTaskStatus
 *     给出最终状态（可能仍在跑 / 可能 FAILED）。落中性 transportNotice。
 */
async function runVideoUploadFetch(
  projectId: string,
  episodeId: string,
  taskId: string,
  file: File,
  api: (url: string, options?: RequestInit) => Promise<unknown>,
  opts: { sourceDurationSeconds: number | null; model?: string },
): Promise<void> {
  const params = new URLSearchParams();
  if (opts.sourceDurationSeconds !== null) {
    params.set("sourceDurationSeconds", String(opts.sourceDurationSeconds));
  }
  // 选中的 Kimi 模型透传到 route ?model=（route 再进 callAI('kimi', model)）。
  // 不传时 route 走带前缀默认值 kimi/kimi-k2.6（计费表命中，不再 0 扣）。
  if (opts.model) {
    params.set("model", opts.model);
  }
  try {
    const result = (await api(
      `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/video-to-script?${params.toString()}`,
      {
        method: "POST",
        // File/Blob 正文由浏览器按背压上传，服务端原样流式接力给 Kimi。
        body: file,
        headers: buildVideoStreamHeaders(file, taskId),
      },
    )) as { script?: string } | null;

    if (result && typeof result.script === "string" && result.script.trim()) {
      // HTTP 成功已证明服务端落库 + 任务完成。
      patch(projectId, episodeId, {
        uploading: false,
        script: result.script,
      });
      // 终态清理由 useVideoUpload 的 useTaskStatus 回调统一做（单一所有者）。
      return;
    }
    // null / 空：连接中断或服务端返空。taskId 已建，让 useTaskStatus 兜底判终态。
    patch(projectId, episodeId, {
      uploading: false,
      transportNotice: resolveVideoTransportFailure(taskId).notice,
    });
  } catch {
    // api 正常不抛；此处兜底防未知异常。taskId 仍在，靠 useTaskStatus 续。
    patch(projectId, episodeId, {
      uploading: false,
      transportNotice: resolveVideoTransportFailure(taskId).notice,
    });
  }
}

/**
 * 标记终态已处理（COMPLETED/FAILED）。清 uploading、记 error、置 handledTerminal。
 * 由 useVideoUpload 的终态 effect 调用（单一所有者），同时清 sessionStorage 指针。
 */
export function markVideoUploadTerminal(
  projectId: string,
  episodeId: string,
  result: { status: "completed" | "failed"; error?: string | null },
): void {
  patch(projectId, episodeId, {
    uploading: false,
    handledTerminal: true,
    ...(result.status === "failed"
      ? { error: result.error || "视频转剧本失败，请重试" }
      : {}),
  });
  if (typeof window !== "undefined") {
    clearRecoveredVideoTask(window.sessionStorage, projectId, episodeId);
  }
}

/** 清空本集在途态（重置 / 切走清理用）。 */
export function clearVideoUpload(projectId: string, episodeId: string): void {
  const key = keyFor(projectId, episodeId);
  _state.delete(key);
  _snapshotCache.delete(key);
  emit();
}
