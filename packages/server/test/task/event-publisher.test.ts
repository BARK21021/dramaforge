// ============================================================
// ④ server/task/event-publisher — 单测
// ============================================================
//
// 覆盖：
//   - publishTaskEvent：调用 redis.publish(TASK_EVENTS_CHANNEL, JSON)
//   - COMPLETED 事件携带 result；FAILED 携带 error；RUNNING 也发
//   - 持久化事件先 INSERT task_events 拿自增 id 再 publish（payload.id 为纯数字）
//   - 不污染调用方 payload 对象（浅拷贝；toHaveBeenCalledWith 严格匹配）
//   - 无 userId 的 progress 事件用 LRU 缓存 / tasks 表查 userId 补全
//   - 持久化失败降级 ephemeral id（不抛错）
//   - 发布失败不抛错（吞掉 + console.warn）
//   - listEventsAfter：返回持久化事件（payload.id 填自 PG row id）
//   - listActiveTasksSnapshot：合成 status_change + snapshot:true 事件
//
// mock @server/infra 的 getRedis + query：返回各自 spy。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

const publishMock = vi.fn().mockResolvedValue(1);
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

// query mock：默认返回空结果（INSERT 失败时 persistEvent 降级 ephemeral）
const queryMock = vi.fn().mockResolvedValue({ rows: [] });

vi.mock('@server/infra', () => ({
  getRedis: () => ({ publish: publishMock }),
  query: (...args: unknown[]) => queryMock(...args),
}));

import {
  publishTaskEvent,
  listEventsAfter,
  listActiveTasksSnapshot,
  listTaskProgressClips,
  TASK_EVENTS_CHANNEL,
} from '../../src/task/event-publisher';

beforeEach(() => {
  publishMock.mockReset();
  publishMock.mockResolvedValue(1);
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
  warnSpy.mockClear();
});

describe('publishTaskEvent', () => {
  it('publishes COMPLETED event with result to task:events channel', async () => {
    await publishTaskEvent({
      taskId: 't1',
      userId: 'u1',
      status: 'COMPLETED',
      type: 'status_change',
      result: { videoUrl: 'https://x/v.mp4' },
      modelProvider: 'ark',
      modelName: 'ark/doubao',
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = publishMock.mock.calls[0];
    expect(channel).toBe(TASK_EVENTS_CHANNEL);
    expect(channel).toBe('task:events');
    const parsed = JSON.parse(payload);
    expect(parsed.taskId).toBe('t1');
    expect(parsed.userId).toBe('u1');
    expect(parsed.status).toBe('COMPLETED');
    expect(parsed.result).toEqual({ videoUrl: 'https://x/v.mp4' });
    expect(parsed.modelProvider).toBe('ark');
    // id 字段一定存在（持久化失败降级 ephemeral）
    expect(typeof parsed.id).toBe('string');
    // timestamp 自动补默认
    expect(typeof parsed.timestamp).toBe('number');
  });

  it('publishes FAILED event with error', async () => {
    await publishTaskEvent({
      taskId: 't2',
      userId: 'u2',
      status: 'FAILED',
      type: 'status_change',
      error: 'API 限流',
    });

    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    expect(payload.status).toBe('FAILED');
    expect(payload.error).toBe('API 限流');
    expect(payload.taskId).toBe('t2');
  });

  it('publishes RUNNING event', async () => {
    await publishTaskEvent({
      taskId: 't3',
      userId: 'u3',
      status: 'RUNNING',
      type: 'status_change',
    });

    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    expect(payload.status).toBe('RUNNING');
  });

  it('persists event to task_events and uses returned id (pure numeric)', async () => {
    // 模拟 INSERT ... RETURNING id 拿到 BIGSERIAL id
    queryMock.mockResolvedValueOnce({ rows: [{ id: '12345' }] });

    await publishTaskEvent({
      taskId: 't4',
      userId: 'u4',
      status: 'COMPLETED',
      type: 'status_change',
      result: { ok: true },
    });

    // 调用了 INSERT INTO task_events
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sqlText = queryMock.mock.calls[0][0] as string;
    expect(sqlText).toContain('INSERT INTO task_events');
    // render_jobs 与 AI tasks 共用 SSE，但只有真实 tasks 才允许写入带外键的历史表。
    expect(sqlText).toContain('WHERE EXISTS (SELECT 1 FROM tasks WHERE id = $1)');
    expect(sqlText).toContain('RETURNING id');

    // payload.id 是 INSERT 返回的纯数字字符串
    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    expect(payload.id).toBe('12345');
  });

  it('falls back to ephemeral id when persistEvent INSERT returns no row', async () => {
    // INSERT 返回空（极端情况：DB 故障返回 0 行）
    queryMock.mockResolvedValueOnce({ rows: [] });

    await publishTaskEvent({
      taskId: 't5',
      userId: 'u5',
      status: 'COMPLETED',
      type: 'status_change',
    });

    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    // 降级为 ephemeral: 前缀
    expect(payload.id).toMatch(/^ephemeral:/);
    // render_job 事件返回 0 行是正常分流，不应刷屏成数据库故障。
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not mutate the caller payload object (snapshot stays clean)', async () => {
    // dispatch.test.ts 用 toHaveBeenCalledWith 严格匹配；publisher 不能污染入参对象
    const payload = {
      taskId: 't6',
      userId: 'u6',
      status: 'QUEUED',
      type: 'status_change',
    };
    const snapshot = { ...payload };

    await publishTaskEvent(payload);

    // 调用方对象保持原样（未被新增 id / timestamp 字段污染）
    expect(payload).toEqual(snapshot);
  });

  it('swallows redis publish errors without throwing', async () => {
    publishMock.mockRejectedValueOnce(new Error('Redis 断开'));
    await expect(
      publishTaskEvent({
        taskId: 't7',
        userId: 'u7',
        status: 'COMPLETED',
        type: 'status_change',
        result: {},
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('swallows persistEvent errors (query throws) and falls back to ephemeral', async () => {
    queryMock.mockRejectedValueOnce(new Error('PG 断开'));

    await expect(
      publishTaskEvent({
        taskId: 't8',
        userId: 'u8',
        status: 'COMPLETED',
        type: 'status_change',
      }),
    ).resolves.toBeUndefined();

    // 持久化失败 → warn；仍发 Redis publish；payload.id 为 ephemeral
    expect(warnSpy).toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    expect(payload.id).toMatch(/^ephemeral:/);
  });

  it('does not persist when type is non-persistable (e.g., connected)', async () => {
    // type 未在 PERSISTABLE 中（'connected'）→ 不调 INSERT
    await publishTaskEvent({
      taskId: 't9',
      userId: 'u9',
      // 无 status/type/result/error/progress → inferEventType 返回 undefined
    } as never);

    expect(queryMock).not.toHaveBeenCalled();
    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    expect(payload.id).toMatch(/^ephemeral:/);
  });

  it('infers eventType=progress when payload has progress field', async () => {
    // render-jobs/progress route 上报：status=RUNNING + progress=50 + stage
    // 应该归为 progress 类别（持久化有益，SSE 重放可恢复进度）
    queryMock.mockResolvedValueOnce({ rows: [{ id: '999' }] });

    await publishTaskEvent({
      taskId: 't10',
      userId: 'u10',
      status: 'RUNNING',
      progress: 50,
      stage: 'concatenating',
    });

    // 持久化被调用（progress 是 PERSISTABLE 类型）
    expect(queryMock).toHaveBeenCalledTimes(1);
    const params = queryMock.mock.calls[0][1] as unknown[];
    // 第 3 个参数是 eventType，应为 'progress'
    expect(params[2]).toBe('progress');

    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    expect(payload.progress).toBe(50);
    expect(payload.stage).toBe('concatenating');
  });

  it('resolves userId from tasks table when payload lacks it (progress event)', async () => {
    // 模拟 tasks 表查询返回 userId
    queryMock
      .mockResolvedValueOnce({ rows: [{ userId: 'from-db' }] }) // resolveUserId
      .mockResolvedValueOnce({ rows: [{ id: '555' }] }); // INSERT RETURNING

    await publishTaskEvent({
      taskId: 't11',
      userId: '', // 空 userId，触发查表
      status: 'RUNNING',
      progress: 75,
    } as never);

    // 第一次 query 是 SELECT userId FROM tasks
    const firstCallSql = queryMock.mock.calls[0][0] as string;
    expect(firstCallSql).toContain('SELECT "userId" FROM tasks');
    // payload.userId 被回填
    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    expect(payload.userId).toBe('from-db');
    expect(payload.id).toBe('555');
  });
});

describe('listEventsAfter', () => {
  it('returns persisted events with id filled from PG row id', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: '100',
          payload: JSON.stringify({
            taskId: 't1',
            userId: 'u1',
            status: 'COMPLETED',
            type: 'status_change',
          }),
        },
        {
          id: '101',
          payload: JSON.stringify({
            taskId: 't2',
            userId: 'u1',
            status: 'FAILED',
            type: 'status_change',
          }),
        },
      ],
    });

    const events = await listEventsAfter('u1', 99);

    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('100');
    expect(events[0].taskId).toBe('t1');
    expect(events[1].id).toBe('101');
    expect(events[1].status).toBe('FAILED');
    // 查询用了 afterId 参数
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe(99);
  });

  it('returns empty array when query throws (best-effort)', async () => {
    queryMock.mockRejectedValueOnce(new Error('PG down'));
    const events = await listEventsAfter('u1', 1);
    expect(events).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('clamps limit to hard cap of 5000', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listEventsAfter('u1', 1, 99999);
    const params = queryMock.mock.calls[0][1] as unknown[];
    // 第 3 个参数是 LIMIT，被钳到 5000
    expect(params[2]).toBe(5000);
  });
});

describe('listActiveTasksSnapshot', () => {
  it('returns active tasks as status_change snapshot events', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'task-a',
          type: 'VIDEO_GENERATE',
          status: 'RUNNING',
          progress: 50,
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        },
        {
          id: 'task-b',
          type: 'IMAGE_GENERATE',
          status: 'PENDING',
          progress: 0,
          updatedAt: new Date('2024-01-01T00:00:01.000Z'),
        },
      ],
    });

    const snapshots = await listActiveTasksSnapshot('user-x');

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      taskId: 'task-a',
      userId: 'user-x',
      type: 'status_change',
      status: 'RUNNING',
      progress: 50,
      snapshot: true,
    });
    // id 为非纯数字（snapshot: 前缀）→ SSE encodeSseEvent 不发 id: 行
    expect(snapshots[0].id).toMatch(/^snapshot:task-a:/);
    expect(snapshots[1].id).toMatch(/^snapshot:task-b:/);
  });

  it('returns empty array when query throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('PG down'));
    const snapshots = await listActiveTasksSnapshot('user-x');
    expect(snapshots).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('listTaskProgressClips', () => {
  it('queries progress+groupClip events for the task and returns clips in order', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          payload: JSON.stringify({
            taskId: 't1',
            status: 'RUNNING',
            progress: 30,
            groupClip: { shotIds: ['s1', 's2'], videoUrl: 'sf-asset://g1.mp4' },
          }),
        },
        {
          payload: JSON.stringify({
            taskId: 't1',
            status: 'RUNNING',
            progress: 60,
            groupClip: { shotIds: ['s3'], videoUrl: 'sf-asset://g2.mp4' },
          }),
        },
      ],
    });

    const clips = await listTaskProgressClips('t1');

    // SQL 按 taskId 过滤 progress 事件且要求 payload 含 groupClip
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('"taskId" = $1');
    expect(sql).toContain("'progress'");
    expect(sql).toContain("payload ? 'groupClip'");
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('t1');

    expect(clips).toEqual([
      { shotIds: ['s1', 's2'], videoUrl: 'sf-asset://g1.mp4' },
      { shotIds: ['s3'], videoUrl: 'sf-asset://g2.mp4' },
    ]);
  });

  it('skips progress events without groupClip and dedups fully-duplicate clips', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        // 无 groupClip 的普通进度事件 → 跳过
        { payload: JSON.stringify({ taskId: 't1', progress: 10 }) },
        // 第一组
        {
          payload: JSON.stringify({
            groupClip: { shotIds: ['s1', 's2'], videoUrl: 'sf-asset://g1.mp4' },
          }),
        },
        // 完全重复回传（同 shotIds）→ 跳过
        {
          payload: JSON.stringify({
            groupClip: { shotIds: ['s1', 's2'], videoUrl: 'sf-asset://g1.mp4' },
          }),
        },
        // 部分重叠（s2 已见、s4 新）→ 保留
        {
          payload: JSON.stringify({
            groupClip: { shotIds: ['s2', 's4'], videoUrl: 'sf-asset://g2.mp4' },
          }),
        },
      ],
    });

    const clips = await listTaskProgressClips('t1');
    expect(clips).toEqual([
      { shotIds: ['s1', 's2'], videoUrl: 'sf-asset://g1.mp4' },
      { shotIds: ['s2', 's4'], videoUrl: 'sf-asset://g2.mp4' },
    ]);
  });

  it('ignores malformed groupClip payloads (missing shotIds/videoUrl)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { payload: JSON.stringify({ groupClip: { shotIds: [], videoUrl: 'u' } }) },
        { payload: JSON.stringify({ groupClip: { shotIds: ['s1'] } }) },
        { payload: JSON.stringify({ groupClip: { shotIds: ['s2'], videoUrl: '' } }) },
        {
          payload: JSON.stringify({
            groupClip: { shotIds: ['s3'], videoUrl: 'sf-asset://g.mp4' },
          }),
        },
      ],
    });
    const clips = await listTaskProgressClips('t1');
    expect(clips).toEqual([{ shotIds: ['s3'], videoUrl: 'sf-asset://g.mp4' }]);
  });

  it('returns empty array when query throws (best-effort)', async () => {
    queryMock.mockRejectedValueOnce(new Error('PG down'));
    const clips = await listTaskProgressClips('t1');
    expect(clips).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
