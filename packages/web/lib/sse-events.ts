// ============================================================
// web/lib/sse-events — SSE 事件通道与编码
// ============================================================
//
// 文件职责：
//   - TASK_EVENTS_CHANNEL — Redis 频道名，与 ⑥ ai-worker/event-publisher +
//     ④ task/event-publisher 的 publishTaskEvent 约定一致（frozen: 'task:events'）。
//   - encodeSseEvent(payload) — 把任意 JSON 可序列化载荷编码为 SSE 帧。
//     当 payload.id 为纯数字字符串时（来自 PG task_events 自增 id），前置
//     `id: <n>` 行，让浏览器 EventSource 跟踪 Last-Event-ID 用于断线重连重放。
//     非 pure-numeric id（ephemeral:/snapshot: 前缀）或不带 id 的事件不发 id: 行，
//     保持浏览器 lastEventId 上次持久化值不变（照搬 app1 sse/route.ts:38 行为）。
//   - SSE 心跳注释帧（':heartbeat\n\n'）保持代理/浏览器不断连。
//
// 设计要点：
//   - 频道名硬编码为字符串字面量，避免 web import @server/ai-worker（
//     ai-worker 是 BullMQ worker，不应进 web bundle）。该字符串是 ④⑥ 与 ⑤
//     的冻结契约，两端独立硬编码。
//   - SSE 帧格式遵循 W3C EventSource 规范：`[id: <n>\n]data: <json>\n\n`。
//   - 与 app1 src/app/api/sse/route.ts 的 encodeSseEvent 同形态（条件发 id 行）。
//
// web 禁止 import 任何 ffmpeg 模块；本模块为纯编码工具。
// ============================================================

/** Redis 频道名（与 ④⑥ publishTaskEvent 的 TASK_EVENTS_CHANNEL 冻结一致） */
export const TASK_EVENTS_CHANNEL = 'task:events';

/** SSE 心跳间隔（毫秒） */
export const SSE_HEARTBEAT_MS = 30_000;

/** 纯数字事件 id 校验（与 app1 sse/route.ts:38 同正则） */
const NUMERIC_ID_REGEX = /^\d+$/;

/**
 * 把载荷编码为 SSE 事件帧。
 *
 * 当 payload.id 为纯数字字符串时（来自 PG task_events 自增 id），前置 `id:` 行，
 * 让浏览器 EventSource 跟踪 Last-Event-ID 用于断线重连重放。非纯数字 id（ephemeral:
 * 或 snapshot: 前缀）或不带 id 的事件不发 id: 行（浏览器 lastEventId 保持上次值）。
 *
 * @param payload - JSON 可序列化对象（可包含可选 `id` 字段）
 * @returns SSE 帧字符串（`[id: <n>\n]data: <json>\n\n`）
 */
export function encodeSseEvent(payload: unknown): string {
  const lines: string[] = [];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    // 持久化事件 id 为纯数字 → 发 id: 行让浏览器 Last-Event-ID 跟进
    // ephemeral / snapshot / 未持久化 → 不发 id: 行，浏览器保留上次持久化 id
    if (typeof obj.id === 'string' && NUMERIC_ID_REGEX.test(obj.id)) {
      lines.push(`id: ${obj.id}`);
    }
  }
  lines.push(`data: ${JSON.stringify(payload)}`);
  return `${lines.join('\n')}\n\n`;
}

/** SSE 心跳注释帧（EventSource 忽略注释行，仅保活） */
export const SSE_HEARTBEAT_FRAME = ':heartbeat\n\n';
