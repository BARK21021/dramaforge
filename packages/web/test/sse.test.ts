// ============================================================
// /api/sse — 契约测试
// ============================================================
//
// 覆盖：
//   - 初始 connected 事件
//   - Redis task:events 消息 → SSE 帧透传（按 userId 过滤）
//   - 其他 userId 的事件被过滤
//   - 401 when 未登录
//   - 连接首包推送活跃任务快照（listActiveTasksSnapshot，照搬 app1）
//   - Last-Event-ID 头触发持久化事件重放（listEventsAfter，照搬 app1）
//
// mock：@dramaforge/server.getRedis（返回 createRedisMock 的 mainInstance）
//      + @dramaforge/server.listActiveTasksSnapshot / listEventsAfter（默认空数组）
//      + getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
  createRedisMock,
} from './mocks';
import { makeRequest } from './helpers';
import { GET } from '../app/api/sse/route';

/** 读一帧 SSE（到 \n\n 为止）。返回解码后的字符串。 */
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let acc = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return acc;
    acc += decoder.decode(value, { stream: true });
    if (acc.includes('\n\n')) return acc;
  }
}

/** 带超时的 readFrame，防止流卡死时测试挂起。 */
async function readFrameWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 500,
): Promise<string | null> {
  return Promise.race([
    readFrame(reader),
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

/**
 * 等 async start() 完成 subscriber.on('message', ...) 注册。
 *
 * 路由先订阅再确认 connected，通常首帧到达时监听已经就绪；这里仍做短轮询，
 * 让测试不依赖 Promise/Redis mock 的具体微任务调度顺序。
 *
 * 轮询最长 200ms（20 次 × 10ms），路由实际几毫秒内完成；超时由测试断言暴露。
 */
async function waitForSubscriber(
  redisMock: ReturnType<typeof createRedisMock>,
  ms = 200,
): Promise<void> {
  for (let i = 0; i < ms / 10; i++) {
    if (redisMock.subscribers.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /api/sse', () => {
  let redisMock: ReturnType<typeof createRedisMock>;

  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    redisMock = createRedisMock();
    serverMock.getRedis.mockReturnValue(redisMock.mainInstance);
    // 默认 snapshot/replay 返空数组（个别 test 用 mockResolvedValueOnce 覆盖）
    serverMock.listActiveTasksSnapshot.mockReset();
    serverMock.listActiveTasksSnapshot.mockResolvedValue([]);
    serverMock.listEventsAfter.mockReset();
    serverMock.listEventsAfter.mockResolvedValue([]);
  });

  it('sends initial connected event', async () => {
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const frame = await readFrameWithTimeout(reader);
    reader.cancel().catch(() => undefined);
    expect(frame).not.toBeNull();
    expect(frame!).toMatch(/connected.*user-1/s);
  });

  it('disables intermediary buffering and response transformation', async () => {
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);

    // Nginx 必须立刻转发每个 SSE 帧，缓存和内容转换都会让前端进度延迟出现。
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');

    await res.body?.cancel();
  });

  it('forwards a published task:events message as SSE frame', async () => {
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    const reader = res.body!.getReader();

    // 1. 消费 connected 帧
    await readFrameWithTimeout(reader);

    // 2. 等 async start() 完成 subscriber 注册
    await waitForSubscriber(redisMock);

    // 3. 模拟 ⑥ publishTaskEvent 发布的事件
    const payload = {
      taskId: 'task-1',
      userId: 'user-1',
      status: 'COMPLETED',
      result: { outputUrl: 'https://up' },
    };
    const sub = redisMock.subscribers[0];
    expect(sub).toBeDefined();
    sub('task:events', JSON.stringify(payload));

    // 4. 读转发的帧
    const frame = await readFrameWithTimeout(reader);
    reader.cancel().catch(() => undefined);
    expect(frame).not.toBeNull();
    expect(frame!).toMatch(/task-1.*COMPLETED/s);
  });

  it('does not lose a terminal event while the initial snapshot is loading', async () => {
    let releaseSnapshot!: (value: unknown[]) => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    serverMock.listActiveTasksSnapshot.mockImplementationOnce(() => {
      markSnapshotStarted();
      return new Promise<unknown[]>((resolve) => {
        releaseSnapshot = resolve;
      });
    });

    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await snapshotStarted;
    await readFrameWithTimeout(reader); // connected

    // 模拟任务恰好在快照 SQL 执行期间完成；此事件必须已被订阅端接住并暂存。
    const terminal = JSON.stringify({
      taskId: 'task-finished-during-bootstrap',
      userId: 'user-1',
      type: 'status_change',
      status: 'COMPLETED',
    });
    for (const subscriber of redisMock.subscribers) {
      subscriber('task:events', terminal);
    }
    releaseSnapshot([]);

    const frame = await readFrameWithTimeout(reader);
    await reader.cancel().catch(() => undefined);
    expect(frame).not.toBeNull();
    expect(frame!).toMatch(/task-finished-during-bootstrap.*COMPLETED/s);
  });

  it('releases the Redis subscription when the request aborts during bootstrap', async () => {
    let releaseSnapshot!: (value: unknown[]) => void;
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    serverMock.listActiveTasksSnapshot.mockImplementationOnce(() => {
      markSnapshotStarted();
      return new Promise<unknown[]>((resolve) => {
        releaseSnapshot = resolve;
      });
    });
    const abort = new AbortController();
    const req = new NextRequest('http://localhost/api/sse', { signal: abort.signal });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await snapshotStarted;
    await readFrameWithTimeout(reader); // connected

    // 断开发生在快照 await 期间；清理监听必须已注册，不能遗留订阅连接和心跳。
    abort.abort();
    releaseSnapshot([]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(redisMock.subInstance.off).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
    expect(redisMock.subInstance.unsubscribe).toHaveBeenCalledWith('task:events');
    expect(redisMock.subInstance.quit).toHaveBeenCalledTimes(1);
    await reader.cancel().catch(() => undefined);
  });

  it('releases the Redis subscription when the response consumer cancels the stream', async () => {
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await readFrameWithTimeout(reader); // connected
    await waitForSubscriber(redisMock);

    // ReadableStream.cancel 不一定触发 NextRequest.signal；底层流必须提供独立清理入口。
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(redisMock.subInstance.off).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
    expect(redisMock.subInstance.unsubscribe).toHaveBeenCalledWith('task:events');
    expect(redisMock.subInstance.quit).toHaveBeenCalledTimes(1);
  });

  it('filters out events for other users', async () => {
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await readFrameWithTimeout(reader); // connected

    // 等 subscriber 注册
    await waitForSubscriber(redisMock);

    // 发布其他用户的事件 → 应被过滤
    const payload = { taskId: 'task-2', userId: 'other-user', status: 'COMPLETED' };
    const sub = redisMock.subscribers[0];
    sub('task:events', JSON.stringify(payload));

    // 短窗口内不应有新帧（null 表示超时无数据）
    const frame = await readFrameWithTimeout(reader, 200);
    reader.cancel().catch(() => undefined);
    expect(frame).toBeNull();
  });

  it('fails closed when a Redis event has no userId', async () => {
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await readFrameWithTimeout(reader); // connected
    await waitForSubscriber(redisMock);

    // userId 是租户隔离边界；字段缺失时不能为兼容旧格式而广播给所有登录用户。
    redisMock.subscribers[0](
      'task:events',
      JSON.stringify({ taskId: 'task-without-owner', status: 'COMPLETED' }),
    );

    const frame = await readFrameWithTimeout(reader, 200);
    await reader.cancel().catch(() => undefined);
    expect(frame).toBeNull();
  });

  it('returns 401 when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  // ============================================================
  // 批 SSE-2：活跃任务快照（照搬 app1 sse/route.ts:81-84）
  // ============================================================

  it('sends active task snapshot frames after connected (listActiveTasksSnapshot)', async () => {
    // 模拟 ④ listActiveTasksSnapshot 返回 2 条活跃任务快照
    serverMock.listActiveTasksSnapshot.mockResolvedValueOnce([
      {
        taskId: 'task-running',
        userId: 'user-1',
        type: 'status_change',
        status: 'RUNNING',
        progress: 42,
        snapshot: true,
        id: 'snapshot:task-running:1700000000000',
        timestamp: 1700000000000,
      },
      {
        taskId: 'task-pending',
        userId: 'user-1',
        type: 'status_change',
        status: 'PENDING',
        progress: 0,
        snapshot: true,
        id: 'snapshot:task-pending:1700000001000',
        timestamp: 1700000001000,
      },
    ]);

    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    const reader = res.body!.getReader();

    // 1. connected
    const connected = await readFrameWithTimeout(reader);
    expect(connected).toMatch(/connected.*user-1/s);

    // 2. snapshot 1: task-running
    const snap1 = await readFrameWithTimeout(reader);
    expect(snap1).not.toBeNull();
    expect(snap1!).toMatch(/task-running.*RUNNING/s);
    // snapshot id 非纯数字 → 不应出现 id: 行（浏览器 lastEventId 保持上次值）
    expect(snap1!).not.toMatch(/^id: /m);

    // 3. snapshot 2: task-pending
    const snap2 = await readFrameWithTimeout(reader);
    expect(snap2).not.toBeNull();
    expect(snap2!).toMatch(/task-pending.*PENDING/s);

    // 调用了 listActiveTasksSnapshot，参数 = 当前 userId
    expect(serverMock.listActiveTasksSnapshot).toHaveBeenCalledWith('user-1');

    reader.cancel().catch(() => undefined);
  });

  // ============================================================
  // 批 SSE-3：Last-Event-ID 重放（照搬 app1 sse/route.ts:87-92）
  // ============================================================

  it('replays persisted events when Last-Event-ID header is present', async () => {
    // 模拟 ④ listEventsAfter 返回 1 条断线期间持久化事件
    serverMock.listEventsAfter.mockResolvedValueOnce([
      {
        taskId: 'task-missed',
        userId: 'user-1',
        type: 'status_change',
        status: 'COMPLETED',
        result: { videoUrl: 'https://v.mp4' },
        id: '12345', // 纯数字 → SSE 应发 id: 行
        timestamp: 1700000002000,
      },
    ]);

    // 浏览器 EventSource 重连时自动携带 Last-Event-ID 头
    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/sse',
      headers: { 'Last-Event-ID': '12340' },
    });
    const res = await GET(req);
    const reader = res.body!.getReader();

    // 1. connected
    await readFrameWithTimeout(reader);

    // 2. replay 帧：纯数字 id → 应有 id: 行
    const replay = await readFrameWithTimeout(reader);
    expect(replay).not.toBeNull();
    expect(replay!).toMatch(/^id: 12345\n/m);
    expect(replay!).toMatch(/task-missed.*COMPLETED/s);

    // 调用了 listEventsAfter，参数 = (userId, afterId=12340)
    expect(serverMock.listEventsAfter).toHaveBeenCalledWith('user-1', 12340);

    reader.cancel().catch(() => undefined);
  });

  it('deduplicates an event received both from replay and the live subscription', async () => {
    const duplicatedEvent = {
      taskId: 'task-replay-race',
      userId: 'user-1',
      type: 'status_change',
      status: 'COMPLETED',
      id: '12346',
      timestamp: 1700000003000,
    };
    let releaseReplay!: (value: unknown[]) => void;
    let markReplayStarted!: () => void;
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    serverMock.listEventsAfter.mockImplementationOnce(() => {
      markReplayStarted();
      return new Promise<unknown[]>((resolve) => {
        releaseReplay = resolve;
      });
    });

    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/sse',
      headers: { 'Last-Event-ID': '12340' },
    });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await replayStarted;
    await readFrameWithTimeout(reader); // connected

    // Redis 实时消息与 PG 重放可能包含同一个持久化事件 ID，只允许前端收到一次。
    redisMock.subscribers[0]('task:events', JSON.stringify(duplicatedEvent));
    releaseReplay([duplicatedEvent]);

    const first = await readFrameWithTimeout(reader);
    const second = await readFrameWithTimeout(reader, 200);
    await reader.cancel().catch(() => undefined);
    expect(first).toMatch(/task-replay-race.*COMPLETED/s);
    expect(second).toBeNull();
  });

  it('skips replay when Last-Event-ID header is absent', async () => {
    const req = makeRequest({ method: 'GET', url: 'http://localhost/api/sse' });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await readFrameWithTimeout(reader); // connected

    // 无 Last-Event-ID → 不应调用 listEventsAfter
    expect(serverMock.listEventsAfter).not.toHaveBeenCalled();
    reader.cancel().catch(() => undefined);
  });

  it('ignores non-numeric Last-Event-ID header (no replay)', async () => {
    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/sse',
      headers: { 'Last-Event-ID': 'ephemeral:abc' },
    });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await readFrameWithTimeout(reader); // connected

    // 非纯数字 Last-Event-ID → 视为无效，不触发重放
    expect(serverMock.listEventsAfter).not.toHaveBeenCalled();
    reader.cancel().catch(() => undefined);
  });
});
