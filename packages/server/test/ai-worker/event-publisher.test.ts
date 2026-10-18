// ============================================================
// ⑥ server/ai-worker/event-publisher — 单测
// ============================================================
//
// 覆盖：
//   - publishTaskEvent：调用 redis.publish(TASK_EVENTS_CHANNEL, JSON)
//   - COMPLETED 事件携带 result
//   - FAILED 事件携带 error
//   - 发布失败不抛错（吞掉 + console.warn）
//
// mock @server/infra 的 getRedis：返回带 publish spy 的 mock 客户端。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

const publishMock = vi.fn().mockResolvedValue(1);
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('@server/infra', () => ({
  getRedis: () => ({ publish: publishMock }),
}));

import {
  publishTaskEvent,
  TASK_EVENTS_CHANNEL,
} from '../../src/ai-worker/event-publisher';

beforeEach(() => {
  publishMock.mockReset();
  publishMock.mockResolvedValue(1);
  warnSpy.mockClear();
});

describe('publishTaskEvent', () => {
  it('publishes COMPLETED event with result to task:events channel', async () => {
    await publishTaskEvent({
      taskId: 't1',
      userId: 'u1',
      status: 'COMPLETED',
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
  });

  it('publishes FAILED event with error', async () => {
    await publishTaskEvent({
      taskId: 't2',
      userId: 'u2',
      status: 'FAILED',
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
    });

    const payload = JSON.parse(publishMock.mock.calls[0][1]);
    expect(payload.status).toBe('RUNNING');
  });

  it('swallows publish errors without throwing', async () => {
    publishMock.mockRejectedValueOnce(new Error('Redis 断开'));
    await expect(
      publishTaskEvent({ taskId: 't4', userId: 'u4', status: 'COMPLETED', result: {} }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
