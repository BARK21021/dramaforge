// ============================================================
// GET /api/sse — Server-Sent Events 转发 Redis task:events
// ============================================================
//
// 前端（⑪ shell BrowserWindow 或未来 UI）建立 SSE 长连接，实时接收任务状态
// 变更。web 订阅 Redis `task:events` 频道（④ task/event-publisher 与本路由 ⑤
// publishTaskEvent 共同发布到此频道），按 userId 过滤后透传给前端。
//
// 流程（以 app1 的快照/重放语义为基线，并补齐 C/S 初始化竞态）：
//   1. requireUser 鉴权 → 401 if 未登录
//   2. 先建立 Redis 订阅；初始化期间到达的实时事件暂存，消除快照/订阅窗口
//   3. 发初始 connected 事件（订阅已就绪后才让前端停用轮询）
//   4. 发活跃任务快照（listActiveTasksSnapshot）：页面刷新或重连后能立即恢复
//      运行中的任务状态（snapshot:true 标记，id 非纯数字 → 不发 id: 行）
//   5. Last-Event-ID 头存在时，补发断线期间的持久化事件并按 id 去重
//   6. 补发初始化期间暂存事件 + 启动 30s 心跳
//   7. 收到事件时严格按 userId 过滤后转发（缺 userId 一律丢弃）
//   8. 请求 abort 或响应 cancel 时幂等清理：停心跳、退订、关连接
//
// 鉴权：session REQUIRED（浏览器 EventSource 自动带 Cookie）。
//
// 响应：text/event-stream
//   - 初始 connected 事件
//   - 活跃任务快照事件（snapshot:true）
//   - Last-Event-ID 重放事件（来自 PG task_events 表）
//   - 30s 心跳注释帧（保活，防代理断连）
//   - task:events 中的实时事件（按 userId 过滤）
//   401 — 未登录
//
// 设计要点：
//   - 用 getRedis().duplicate() 创建独立订阅连接，避免影响 BullMQ 主连接
//     （ioredis 订阅模式下该连接只能 SUBSCRIBE/UNSUBSCRIBE）。
//   - abort 监听在任何 await 前注册，响应 cancel 也走同一个幂等清理函数。
//   - 频道名 TASK_EVENTS_CHANNEL 与 ④⑥ 冻结一致（两端独立硬编码）。
//   - listActiveTasksSnapshot/listEventsAfter 内部已有 try/catch，失败返空数组
//     不抛；本路由无需额外防御。
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  getRedis,
  listActiveTasksSnapshot,
  listEventsAfter,
} from '@dramaforge/server';
import { requireUser } from '@web/lib/auth';
import { unauthorized } from '@web/lib/response';
import {
  TASK_EVENTS_CHANNEL,
  SSE_HEARTBEAT_MS,
  SSE_HEARTBEAT_FRAME,
  encodeSseEvent,
} from '@web/lib/sse-events';

/**
 * 解析 Last-Event-ID 请求头（照搬 app1 sse/route.ts:28）。
 *
 * 浏览器 EventSource 重连时自动携带上次最后收到的事件 id（纯数字字符串）。
 * 非纯数字或非正整数 → 返回 null（不触发重放）。
 */
function parseLastEventId(req: NextRequest): number | null {
  const raw = req.headers.get('last-event-id')?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const auth = await requireUser();
  if (!auth) return unauthorized();
  const userId = auth.userId;
  const lastEventId = parseLastEventId(req);

  // Response 消费者取消不保证会同步触发 NextRequest.signal，保留独立清理入口。
  let cleanupStream: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let cleaned = false;
      const subscriber = getRedis().duplicate();
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let bootstrapping = true;
      const bufferedEvents: Record<string, unknown>[] = [];

      function send(text: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // enqueue 失败同样代表消费者已离开；必须走完整清理，不能只改 closed 标志。
          cleanup();
        }
      }

      const onMessage = (channel: string, message: string): void => {
        if (channel !== TASK_EVENTS_CHANNEL) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(message) as Record<string, unknown>;
        } catch {
          return; // 忽略无效 JSON
        }
        // userId 是租户隔离边界：只推送明确属于当前用户的 Redis 任务事件。
        // 字段缺失或类型非法必须 fail-closed，不能为兼容旧格式广播给所有登录用户。
        const eventUserId = event.userId;
        if (typeof eventUserId !== 'string' || eventUserId !== userId) return;
        if (bootstrapping) {
          // 初始化查询期间先暂存实时事件；快照/重放发送完后按到达顺序补发。
          bufferedEvents.push(event);
          return;
        }
        send(encodeSseEvent(event));
      };

      /** 幂等释放心跳、Redis 监听和订阅连接；可由 abort/enqueue 失败共同调用。 */
      function cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        closed = true;
        if (cleanupStream === cleanup) cleanupStream = null;
        if (heartbeat !== null) clearInterval(heartbeat);
        req.signal.removeEventListener('abort', cleanup);
        subscriber.off('message', onMessage);
        void subscriber.unsubscribe(TASK_EVENTS_CHANNEL).catch(() => undefined);
        void subscriber.quit().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      cleanupStream = cleanup;
      // 监听必须在任何 await 之前注册；否则初始化查询期间断开不会再次触发 abort。
      req.signal.addEventListener('abort', cleanup, { once: true });
      if (req.signal.aborted) {
        cleanup();
        return;
      }

      // 先完成 Redis 订阅，再读取快照/重放。若反过来执行，任务恰好在两者之间
      // 完成时事件会永久丢失，而前端又会因 SSE 已连接而停用轮询兜底。
      subscriber.on('message', onMessage);
      try {
        await subscriber.subscribe(TASK_EVENTS_CHANNEL);
      } catch {
        // 订阅未建立时关闭流，让 EventSource 自动重连；不把内部 Redis 错误暴露给用户。
        cleanup();
        return;
      }
      if (closed) return;

      // 1. 订阅已就绪后再确认连接，避免前端过早停用轮询。
      send(encodeSseEvent({ type: 'connected', userId }));

      // 2. 推送活跃任务快照（照搬 app1 sse/route.ts:81-84）
      //    listActiveTasksSnapshot 内部 try/catch，失败返空数组不抛
      const snapshots = await listActiveTasksSnapshot(userId);
      if (closed) return;
      for (const snapshot of snapshots) {
        send(encodeSseEvent(snapshot));
      }

      // 3. Last-Event-ID 重放：浏览器断线重连时补发错过的持久化事件
      //    listEventsAfter 内部 try/catch，失败返空数组不抛
      if (lastEventId !== null) {
        const replayEvents = await listEventsAfter(userId, lastEventId);
        if (closed) return;
        const replayedEventIds = new Set(
          replayEvents.flatMap((event) =>
            typeof event.id === 'string' ? [event.id] : []),
        );
        for (const replayEvent of replayEvents) {
          send(encodeSseEvent(replayEvent));
        }
        // 同一持久化事件可能同时从 PG 重放和 Redis 实时订阅抵达；按事件 ID 去重。
        for (let index = bufferedEvents.length - 1; index >= 0; index -= 1) {
          const eventId = bufferedEvents[index].id;
          if (typeof eventId === 'string' && replayedEventIds.has(eventId)) {
            bufferedEvents.splice(index, 1);
          }
        }
      }

      // 4. 初始化完成后补发期间暂存的实时事件，再切换为直接转发。
      bootstrapping = false;
      for (const bufferedEvent of bufferedEvents) {
        send(encodeSseEvent(bufferedEvent));
      }
      bufferedEvents.length = 0;

      // 5. 心跳：每 30s 发注释帧保活
      heartbeat = setInterval(() => {
        send(SSE_HEARTBEAT_FRAME);
      }, SSE_HEARTBEAT_MS);
    },
    cancel() {
      // 覆盖 reader.cancel()/代理主动取消，而不依赖请求侧 abort 事件是否传播。
      cleanupStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      // 禁止浏览器/CDN 转换或缓存长连接内容，确保每个进度事件按原始边界送达。
      'Cache-Control': 'no-cache, no-transform',
      // 告诉 Nginx 不要缓冲这个上游响应；仅依赖通用代理默认值会聚合 SSE 帧。
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
