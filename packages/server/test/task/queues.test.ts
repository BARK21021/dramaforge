// ============================================================
// ④ server/task/queues — 单测
// ============================================================
//
// 覆盖：
//   - 4 个队列被创建，name 分别为 tasks-text / tasks-image / tasks-video / tasks-voice
//   - QUEUE_NAMES 常量包含 text/image/video/voice 四个逻辑键
//   - new Queue() 被调用 4 次，每次传入对应队列名 + getRedis() 作为 connection
//   - addJob 调用对应 queue.add 并返回 job.id
//
// mock bullmq 的 Queue 构造函数（避免真实 Redis 连接；BullMQ Queue 构造会触发
// RedisConnection.init() 连接 Redis，测试环境无 Redis 故需 mock）。
// mock @server/infra 的 getRedis：返回空对象，验证 queues.ts 通过 getRedis 取连接。
// ============================================================

import { describe, it, expect, vi } from 'vitest';

// 用 vi.hoisted 提前定义 Queue mock，使 vi.mock 工厂能引用（vi.mock 被提升到顶部）
const { QueueMock } = vi.hoisted(() => {
  const QueueMock = vi.fn().mockImplementation((name: string) => ({
    name,
    add: vi.fn().mockResolvedValue({ id: `job-${name}` }),
    close: vi.fn().mockResolvedValue(undefined),
  }));
  return { QueueMock };
});

// mock bullmq：Queue 构造函数替换为 spy，避免真实 Redis 连接
vi.mock('bullmq', () => ({ Queue: QueueMock }));

// mock @server/infra：getRedis 返回空对象（BullMQ Queue 已被 mock，不会用到它）
vi.mock('@server/infra', () => ({
  getRedis: vi.fn(() => ({})),
}));

import {
  queues,
  QUEUE_NAMES,
  addJob,
  type QueueName,
} from '../../src/task/queues';
import { getRedis } from '@server/infra';

describe('QUEUE_NAMES', () => {
  it('defines 4 logical queue keys: text/image/video/voice', () => {
    expect(Object.keys(QUEUE_NAMES).sort()).toEqual([
      'image',
      'text',
      'video',
      'voice',
    ]);
  });

  it('maps logical keys to bullmq queue name strings', () => {
    expect(QUEUE_NAMES.text).toBe('tasks-text');
    expect(QUEUE_NAMES.image).toBe('tasks-image');
    expect(QUEUE_NAMES.video).toBe('tasks-video');
    expect(QUEUE_NAMES.voice).toBe('tasks-voice');
  });
});

describe('queues', () => {
  it('creates 4 Queue instances with the correct names', () => {
    expect(queues.text.name).toBe(QUEUE_NAMES.text);
    expect(queues.image.name).toBe(QUEUE_NAMES.image);
    expect(queues.video.name).toBe(QUEUE_NAMES.video);
    expect(queues.voice.name).toBe(QUEUE_NAMES.voice);
  });

  it('calls new Queue() exactly 4 times, once per queue name', () => {
    expect(QueueMock).toHaveBeenCalledTimes(4);
    const namesPassed = QueueMock.mock.calls.map((c) => c[0]);
    expect(namesPassed).toEqual([
      'tasks-text',
      'tasks-image',
      'tasks-video',
      'tasks-voice',
    ]);
  });

  it('passes getRedis() result as connection to each Queue', () => {
    // queues.ts 在构造每个 Queue 时调用 getRedis() 作为 connection
    expect(vi.mocked(getRedis)).toHaveBeenCalledTimes(4);
    for (const call of QueueMock.mock.calls) {
      const opts = call[1] as { connection: unknown; defaultJobOptions: unknown } | undefined;
      expect(opts).toBeDefined();
      expect(opts!.connection).toBeDefined();
      expect(opts!.defaultJobOptions).toBeDefined();
    }
  });

  it('exposes a QueueName for each key', () => {
    const names: QueueName[] = ['text', 'image', 'video', 'voice'];
    for (const n of names) {
      expect(queues[n]).toBeDefined();
      expect(typeof queues[n].name).toBe('string');
    }
  });
});

describe('addJob', () => {
  it('calls queue.add with the given jobName + data and returns job.id', async () => {
    const data = { prompt: 'a cat', taskId: 't1', userId: 'u1' };
    const id = await addJob('video', 'VIDEO_GENERATE', data);

    expect(id).toBe('job-tasks-video');
    expect(queues.video.add).toHaveBeenCalledTimes(1);
    // P0-1：addJob 在无 jobId 时给 queue.add 传第 3 参 undefined（jobId ? {jobId} : undefined），
    // 占位让有 jobId 的调用走同一签名。断言末尾需带 undefined。
    expect(queues.video.add).toHaveBeenCalledWith('VIDEO_GENERATE', data, undefined);
  });

  it('routes to the text queue when queueName=text', async () => {
    await addJob('text', 'LLM_CHAT', { msg: 'hi' });
    // P0-1：无 jobId 时第 3 参 undefined
    expect(queues.text.add).toHaveBeenCalledWith('LLM_CHAT', { msg: 'hi' }, undefined);
  });

  it('returns empty string when job.id is undefined', async () => {
    // 临时覆盖 text queue 的 add 返回 { id: undefined }
    vi.mocked(queues.text.add).mockResolvedValueOnce({ id: undefined } as Awaited<ReturnType<typeof queues.text.add>>);
    const id = await addJob('text', 'LLM_CHAT', { msg: 'x' });
    expect(id).toBe('');
  });
});
