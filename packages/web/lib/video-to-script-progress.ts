// ============================================================
// 视频转剧本浏览器进度契约
// ============================================================
// 保持 raw File 正文，不转 base64；taskId 只关联 tasks/SSE。进度值来自服务端
// 持久化任务，尚未收到首个事件时只显示当前确实正在执行的本地准备阶段。
// ============================================================

/** 构造 raw File 流请求头；输入只需 File 的三项元数据，便于纯函数回归测试。 */
export function buildVideoStreamHeaders(
  file: Pick<File, 'name' | 'type' | 'size'>,
  taskId: string,
): Record<string, string> {
  return {
    'Content-Type': file.type || 'video/mp4',
    'X-SF-Video-Stream': '1',
    'X-SF-Video-Name': encodeURIComponent(file.name || 'video.mp4'),
    'X-SF-Video-Size': String(file.size),
    'X-SF-Task-Id': taskId,
  };
}

export interface VideoProgressTask {
  status?: string;
  progress?: number;
  stage?: string;
}

/**
 * 区分“请求尚未建立就失败”和“已提交任务后的 HTTP 连接中断”。
 * 后者不能抢在服务端 tasks 终态之前宣判失败，否则会与运行中进度同时出现。
 */
export function resolveVideoTransportFailure(
  submittedTaskId: string | null,
): { error: string | null; notice: string | null } {
  if (submittedTaskId && VIDEO_TASK_ID_PATTERN.test(submittedTaskId)) {
    return {
      error: null,
      notice: '上传连接已中断，后台任务状态仍会继续同步，请勿重复提交',
    };
  }
  return { error: '视频转剧本失败，请重试', notice: null };
}

/** sessionStorage 恢复窗口覆盖服务端 30 分钟 inline task 生命周期。 */
export const VIDEO_TASK_RECOVERY_TTL_MS = 30 * 60 * 1000;
const VIDEO_TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 仅依赖 Storage 的三个方法，测试和受限浏览器环境无需真实 window。 */
interface VideoTaskStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}

/** 项目 + 分集隔离，避免多标签页任务串到另一集。 */
function videoTaskStorageKey(projectId: string, episodeId: string): string {
  return `sf:video-to-script:${projectId}:${episodeId}`;
}

/** 保存正在处理的 taskId；只存 ID 和时间戳，不存文件名、正文或任何凭证。 */
export function saveRecoverableVideoTask(
  storage: VideoTaskStorage,
  projectId: string,
  episodeId: string,
  taskId: string,
  startedAt = Date.now(),
): void {
  if (!VIDEO_TASK_ID_PATTERN.test(taskId)) return;
  try {
    storage.setItem(
      videoTaskStorageKey(projectId, episodeId),
      JSON.stringify({ taskId, startedAt }),
    );
  } catch {
    // 隐私模式/存储配额不可用时仍继续当前请求，只失去刷新恢复能力。
  }
}

/** 恢复未过期任务；损坏、越集或超过 30 分钟的记录立即清理。 */
export function loadRecoveredVideoTask(
  storage: VideoTaskStorage,
  projectId: string,
  episodeId: string,
  now = Date.now(),
): string | null {
  const key = videoTaskStorageKey(projectId, episodeId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as { taskId?: unknown; startedAt?: unknown };
    const startedAt = Number(value.startedAt);
    const age = now - startedAt;
    if (
      typeof value.taskId === 'string'
      && VIDEO_TASK_ID_PATTERN.test(value.taskId)
      && Number.isFinite(startedAt)
      && age >= 0
      && age <= VIDEO_TASK_RECOVERY_TTL_MS
    ) {
      return value.taskId;
    }
    storage.removeItem(key);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // 存储完全不可用时无事可做；调用方退化为本次页面内跟踪。
    }
  }
  return null;
}

/** 完成或失败后清除恢复指针；服务端 tasks 历史记录仍保留。 */
export function clearRecoveredVideoTask(
  storage: VideoTaskStorage,
  projectId: string,
  episodeId: string,
): void {
  try {
    storage.removeItem(videoTaskStorageKey(projectId, episodeId));
  } catch {
    // sessionStorage 不可用不影响任务终态。
  }
}

/** 把 /api/tasks + SSE 状态转成 ProgressBar 的稳定展示模型。 */
export function resolveVideoTaskProgress(
  task: VideoProgressTask | null,
  uploading: boolean,
  trackingTask = false,
): { progress: number; stage: string; completed: boolean; busy: boolean } {
  const reported = typeof task?.progress === 'number' && Number.isFinite(task.progress)
    ? task.progress
    : null;
  const progress = reported === null
    ? (uploading ? 8 : 0)
    : Math.max(0, Math.min(100, reported));
  const completed = task?.status === 'COMPLETED' || progress >= 100;
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(task?.status ?? '');
  return {
    progress,
    stage: task?.stage?.trim() || (uploading ? '正在准备并上传视频' : '等待开始'),
    completed,
    // HTTP transport 与后端任务生命周期不同步：连接结束不等于服务端停止。
    busy: uploading || (trackingTask && !terminal),
  };
}
