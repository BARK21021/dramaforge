// ============================================================
// episode-task-store.ts — 分集任务 taskId + 剧本草稿的 localStorage 持久化
// ============================================================
//
// 为什么需要（F2/F3，对齐 video-upload-store 模式）：
//   dramaforge 是 B 方案：每集一个独立路由，切集 = router.push → 当前集的
//   EpisodeWorkspace / InputStage / AnalyzingStage 整个 unmount。in-flight
//   taskId 和未保存草稿此前挂在组件 state，切集即丢。
//
//   本 store 把 taskId（按 type+episodeId）和草稿（按 projectId+episodeId）
//   落到 localStorage，刷新/切集/导航都能恢复：
//     - taskId 用于 GenerationProgress 绑定（POST 202 返回 taskId → 写 store →
//       useEpisodeTask 读 store 喂 useTaskStatus → SSE 实时进度）。
//     - 草稿用于 InputStage 切集不丢（编辑未保存 → 切走 → 切回 → 草稿恢复）。
//
// SSR 安全 + 隐私模式兜底：所有读写都包 typeof localStorage 守卫 + try/catch。
// key 前缀统一 `dramaforge:`，避免与其它 localStorage key 冲突。
// ============================================================

const PREFIX = "dramaforge:";

function draftKey(projectId: string, episodeId: string): string {
  return `${PREFIX}draft:${projectId}:${episodeId}`;
}

function taskKey(type: string, episodeId: string): string {
  return `${PREFIX}task:${type}:${episodeId}`;
}

// ============================================================
// Draft（剧本文本草稿）
// ============================================================

/** 读指定分集的草稿；无则返回 null。 */
export function getDraft(projectId: string, episodeId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(draftKey(projectId, episodeId));
  } catch {
    return null;
  }
}

/** 写指定分集的草稿（覆盖）。 */
export function setDraft(projectId: string, episodeId: string, text: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(draftKey(projectId, episodeId), text);
  } catch {
    // 隐私模式 / quota exceeded — 静默降级（组件内存态仍可用，只是不持久）
  }
}

/** 清指定分集的草稿（保存成功后调用，防 stale 覆盖落库值）。 */
export function clearDraft(projectId: string, episodeId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(draftKey(projectId, episodeId));
  } catch {
    // no-op
  }
}

// ============================================================
// TaskId（inline AI 任务的 taskId 指针）
// ============================================================

/**
 * 读指定 type+episodeId 的 taskId。
 * 返回 null 表示无在途任务（或刷新后首次进入）。
 */
export function getTaskId(type: string, episodeId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const v = localStorage.getItem(taskKey(type, episodeId));
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 写指定 type+episodeId 的 taskId（POST 202 返回 taskId 后立即调用）。 */
export function setTaskId(
  type: string,
  episodeId: string,
  taskId: string,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(taskKey(type, episodeId), taskId);
  } catch {
    // no-op
  }
}

/** 清指定 type+episodeId 的 taskId（任务终态后调用，防陈旧 key 残留）。 */
export function clearTaskId(type: string, episodeId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(taskKey(type, episodeId));
  } catch {
    // no-op
  }
}
