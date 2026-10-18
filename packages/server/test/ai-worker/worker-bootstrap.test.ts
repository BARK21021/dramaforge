// ============================================================
// ⑥ server/ai-worker/worker-bootstrap — 单测
// ============================================================
//
// 覆盖：
//   - createTextWorker / createImageWorker / createVideoWorker / createVoiceWorker
//     各创建一个 BullMQ Worker，传入对应队列名
//   - createAllWorkers 一次创建 4 个 Worker
//   - Worker 的 processor 调用 processJob（通过 spy 验证）
//   - shutdownWorkers 调用 worker.close()
//
// mock：
//   - bullmq Worker 构造函数（避免真实 Redis 连接）
//   - @server/infra getRedis（返回空对象）
//   - @server/task/queues QUEUE_NAMES（提供队列名常量）
//   - ./processor processJob（spy，不执行真实逻辑）
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- mock 依赖 ----

const { WorkerMock, workerInstances } = vi.hoisted(() => {
  const workerInstances: Array<{
    name: string;
    processor: (job: unknown) => Promise<void>;
    options: unknown;
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }> = [];
  const WorkerMock = vi.fn().mockImplementation((name: string, processor: (job: unknown) => Promise<void>, options: unknown) => {
    const inst = { name, processor, options, close: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    workerInstances.push(inst);
    return inst;
  });
  return { WorkerMock, workerInstances };
});

vi.mock('bullmq', () => ({ Worker: WorkerMock }));

vi.mock('@server/infra', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('@server/task/queues', () => ({
  QUEUE_NAMES: {
    text: 'tasks-text',
    image: 'tasks-image',
    video: 'tasks-video',
    voice: 'tasks-voice',
  },
}));

const processJobMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/ai-worker/processor', () => ({
  processJob: (...args: unknown[]) => processJobMock(...args),
}));

const markFailedMock = vi.fn().mockResolvedValue(undefined);
const publishTaskEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/ai-worker/task-repo', () => ({
  markFailed: (...args: unknown[]) => markFailedMock(...args),
}));
vi.mock('../../src/ai-worker/event-publisher', () => ({
  publishTaskEvent: (...args: unknown[]) => publishTaskEventMock(...args),
}));

import {
  createTextWorker,
  createImageWorker,
  createVideoWorker,
  createVoiceWorker,
  createAllWorkers,
  shutdownWorkers,
} from '../../src/ai-worker/worker-bootstrap';
import { QUEUE_NAMES } from '@server/task/queues';

beforeEach(() => {
  WorkerMock.mockClear();
  workerInstances.length = 0;
  processJobMock.mockClear();
  markFailedMock.mockClear();
  publishTaskEventMock.mockClear();
  markFailedMock.mockResolvedValue(undefined);
  publishTaskEventMock.mockResolvedValue(undefined);
});

describe('createTextWorker', () => {
  it('creates a Worker for the text queue', () => {
    const w = createTextWorker();
    expect(WorkerMock).toHaveBeenCalledTimes(1);
    expect(WorkerMock.mock.calls[0][0]).toBe(QUEUE_NAMES.text);
    expect(WorkerMock.mock.calls[0][0]).toBe('tasks-text');
    expect(w.name).toBe('tasks-text');
  });

  it('passes getRedis() result as connection in options', () => {
    createTextWorker();
    const opts = WorkerMock.mock.calls[0][2] as { connection: unknown; concurrency: number };
    expect(opts.connection).toBeDefined();
    expect(opts.concurrency).toBe(1);
  });
});

describe('createImageWorker', () => {
  it('creates a Worker for the image queue', () => {
    const w = createImageWorker();
    expect(w.name).toBe('tasks-image');
  });
});

describe('createVideoWorker', () => {
  it('creates a Worker for the video queue', () => {
    const w = createVideoWorker();
    expect(w.name).toBe('tasks-video');
  });
});

describe('createVoiceWorker', () => {
  it('creates a Worker for the voice queue', () => {
    const w = createVoiceWorker();
    expect(w.name).toBe('tasks-voice');
  });
});

describe('createAllWorkers', () => {
  it('creates 4 Workers (text/image/video/voice) in order', () => {
    const workers = createAllWorkers();
    expect(workers).toHaveLength(4);
    expect(workers[0].name).toBe('tasks-text');
    expect(workers[1].name).toBe('tasks-image');
    expect(workers[2].name).toBe('tasks-video');
    expect(workers[3].name).toBe('tasks-voice');
  });

  it('accepts a custom concurrency value', () => {
    createAllWorkers(4);
    for (const call of WorkerMock.mock.calls) {
      const opts = call[2] as { concurrency: number };
      expect(opts.concurrency).toBe(4);
    }
  });

  it('wires processJob as the Worker processor', async () => {
    createAllWorkers();
    // 取第一个 worker 的 processor，模拟 BullMQ 调用
    const processor = workerInstances[0].processor;
    const fakeJob = { name: 'LLM_CHAT', data: { taskId: 't1', userId: 'u1', input: {} } };
    await processor(fakeJob);
    // processor 透传 BullMQ token（测试无 token → undefined）；并发满时 moveToDelayed 需要它
    expect(processJobMock).toHaveBeenCalledWith(fakeJob, undefined);
  });
});

describe('shutdownWorkers', () => {
  it('calls close() on every Worker', async () => {
    const workers = createAllWorkers();
    await shutdownWorkers(workers);
    for (const w of workerInstances) {
      expect(w.close).toHaveBeenCalledTimes(1);
    }
  });
});

describe('stalled config', () => {
  it('configures stalledInterval/maxStalledCount/lockDuration explicitly', () => {
    createImageWorker();
    const opts = WorkerMock.mock.calls[0][2] as {
      stalledInterval: number;
      maxStalledCount: number;
      lockDuration: number;
    };
    expect(opts.stalledInterval).toBe(30_000);
    expect(opts.maxStalledCount).toBe(1);
    // lockDuration 对齐 app1 BaseWorker（base.ts:173）300s（P0-3：原 60s 太紧易误 stall）
    expect(opts.lockDuration).toBe(300_000);
  });
});

describe('failed event → DB FAILED', () => {
  it('marks DB FAILED + publishes event when a job exhausts retries', async () => {
    createImageWorker();
    const w = workerInstances[workerInstances.length - 1];
    const failedCall = w.on.mock.calls.find((c) => c[0] === 'failed');
    expect(failedCall).toBeDefined();
    const handler = failedCall![1] as (job: unknown, err: Error) => Promise<void>;
    const fakeJob = {
      data: { taskId: 't1', userId: 'u1' },
      opts: { attempts: 3 },
      attemptsMade: 3,
    };
    await handler(fakeJob, new Error('boom'));
    expect(markFailedMock).toHaveBeenCalledWith('t1', 'boom');
    expect(publishTaskEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', status: 'FAILED', error: 'boom' }),
    );
  });

  it('does NOT mark FAILED while attempts remain (lets BullMQ retry)', async () => {
    createImageWorker();
    const w = workerInstances[workerInstances.length - 1];
    const failedCall = w.on.mock.calls.find((c) => c[0] === 'failed');
    const handler = failedCall![1] as (job: unknown, err: Error) => Promise<void>;
    const fakeJob = {
      data: { taskId: 't2', userId: 'u1' },
      opts: { attempts: 3 },
      attemptsMade: 1, // 还有重试机会
    };
    await handler(fakeJob, new Error('transient'));
    expect(markFailedMock).not.toHaveBeenCalled();
  });
});
