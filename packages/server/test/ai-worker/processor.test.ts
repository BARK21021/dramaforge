// ============================================================
// ⑥ server/ai-worker/processor — 单测（生命周期编排）
// ============================================================
//
// 覆盖：
//   - 成功路径：acquireSlot → markRunning → handleTask → markCompleted →
//     chargeCredits → publishTaskEvent(COMPLETED) → releaseSlot
//   - 失败路径：acquireSlot → markRunning → handleTask(throw) →
//     markFailed → publishTaskEvent(FAILED) → releaseSlot
//   - 并发已满：acquireSlot(allowed=false) → throw（不调 handleTask）
//   - 扣费失败不阻断：chargeCredits throw → 任务仍 COMPLETED + 事件仍发布
//   - getConcurrencyLimit 决定 acquireSlot 的 limit 参数
//
// mock：
//   - ./handlers handleTask
//   - ./task-repo markRunning/markCompleted/markFailed/getConcurrencyLimit
//   - ./event-publisher publishTaskEvent
//   - @server/domain acquireSlot/releaseSlot/chargeCredits
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DelayedError } from 'bullmq';

// ---- mock 依赖 ----

const handleTaskMock = vi.fn();
const markRunningMock = vi.fn();
const markCompletedMock = vi.fn();
const markFailedMock = vi.fn();
const updateTaskProgressMock = vi.fn();
const getConcurrencyLimitMock = vi.fn();
const getTaskStatusMock = vi.fn();
const getTaskInputMock = vi.fn();
const publishTaskEventMock = vi.fn();
const acquireSlotMock = vi.fn();
const releaseSlotMock = vi.fn();
const chargeCreditsMock = vi.fn();
const getCachedProcessResultMock = vi.fn();
const markProcessCompletedMock = vi.fn();

vi.mock('../../src/ai-worker/handlers', () => ({
  handleTask: (...args: unknown[]) => handleTaskMock(...args),
}));

vi.mock('../../src/ai-worker/processed-cache', () => ({
  getCachedProcessResult: (...args: unknown[]) => getCachedProcessResultMock(...args),
  markProcessCompleted: (...args: unknown[]) => markProcessCompletedMock(...args),
}));

vi.mock('../../src/ai-worker/task-repo', () => ({
  markRunning: (...args: unknown[]) => markRunningMock(...args),
  markCompleted: (...args: unknown[]) => markCompletedMock(...args),
  markFailed: (...args: unknown[]) => markFailedMock(...args),
  updateTaskProgress: (...args: unknown[]) => updateTaskProgressMock(...args),
  getConcurrencyLimit: (...args: unknown[]) => getConcurrencyLimitMock(...args),
  getTaskStatus: (...args: unknown[]) => getTaskStatusMock(...args),
  getTaskInput: (...args: unknown[]) => getTaskInputMock(...args),
  updateShotMaterial: vi.fn(),
  markShotsVideoStatus: vi.fn(),
}));

vi.mock('../../src/ai-worker/event-publisher', () => ({
  publishTaskEvent: (...args: unknown[]) => publishTaskEventMock(...args),
}));

vi.mock('@server/domain', () => ({
  acquireSlot: (...args: unknown[]) => acquireSlotMock(...args),
  releaseSlot: (...args: unknown[]) => releaseSlotMock(...args),
  chargeCredits: (...args: unknown[]) => chargeCreditsMock(...args),
  // 1 元平台成本按当前 1.2 加价和 0.1 元/积分换算为 12 积分。
  yuanToCredits: (yuan: number) => yuan > 0 ? Math.max(1, Math.ceil(yuan * 12)) : 0,
}));

import { processJob } from '../../src/ai-worker/processor';
import type { WorkerJobData } from '../../src/ai-worker/types';

beforeEach(() => {
  handleTaskMock.mockReset();
  markRunningMock.mockReset();
  markCompletedMock.mockReset();
  markFailedMock.mockReset();
  updateTaskProgressMock.mockReset();
  getConcurrencyLimitMock.mockReset();
  getTaskStatusMock.mockReset();
  getTaskInputMock.mockReset();
  publishTaskEventMock.mockReset();
  acquireSlotMock.mockReset();
  releaseSlotMock.mockReset();
  chargeCreditsMock.mockReset();
  getCachedProcessResultMock.mockReset();
  markProcessCompletedMock.mockReset();

  // 默认 happy-path 行为
  getConcurrencyLimitMock.mockResolvedValue(3);
  getTaskStatusMock.mockResolvedValue('QUEUED');
  getTaskInputMock.mockResolvedValue(null); // 默认 PG 无 input（现有测试都带 data.input，不触发）
  acquireSlotMock.mockResolvedValue({ allowed: true, current: 1, max: 3 });
  releaseSlotMock.mockResolvedValue(undefined);
  chargeCreditsMock.mockResolvedValue({});
  markRunningMock.mockResolvedValue(undefined);
  markCompletedMock.mockResolvedValue(true);
  markFailedMock.mockResolvedValue(undefined);
  updateTaskProgressMock.mockResolvedValue(undefined);
  publishTaskEventMock.mockResolvedValue(undefined);
  // 默认缓存未命中 → 正常执行；写标记 no-op
  getCachedProcessResultMock.mockResolvedValue(null);
  markProcessCompletedMock.mockResolvedValue(undefined);
});

function makeJob(
  name: string,
  data: Partial<WorkerJobData>,
): { name: string; data: WorkerJobData } {
  return {
    name,
    data: {
      taskId: data.taskId ?? 't1',
      userId: data.userId ?? 'u1',
      input: data.input ?? {},
      ...data,
    },
  };
}

describe('processJob — success path', () => {
  it('runs full lifecycle: acquire → running → handler → completed → charge → publish → release', async () => {
    handleTaskMock.mockResolvedValueOnce({
      output: { content: 'hello' },
      modelProvider: 'ark',
      modelName: 'ark/doubao',
      cost: 0,
      billingDescription: 'LLM 对话',
    });

    await processJob(makeJob('LLM_CHAT', { input: { model: 'ark/doubao' } }));

    // 1. 查并发上限
    expect(getConcurrencyLimitMock).toHaveBeenCalledWith('u1');
    // 2. 获取槽位
    expect(acquireSlotMock).toHaveBeenCalledWith('u1', 3);
    // 3. 标记 RUNNING
    expect(markRunningMock).toHaveBeenCalledWith('t1', expect.any(String));
    // 4. 发布 RUNNING 事件
    expect(publishTaskEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', userId: 'u1', status: 'RUNNING' }),
    );
    // 5. 调 handler
    expect(handleTaskMock).toHaveBeenCalledWith(
      'LLM_CHAT',
      { model: 'ark/doubao' },
      'u1',
      't1',
      expect.any(Function),
      expect.any(AbortSignal),
    );
    // 6. 标记 COMPLETED
    expect(markCompletedMock).toHaveBeenCalledWith('t1', expect.objectContaining({
      output: { content: 'hello' },
      modelProvider: 'ark',
    }));
    // 6b. 写入幂等缓存（P0-3，在 markCompleted 之前，防 stall 重投重复扣费）
    expect(markProcessCompletedMock).toHaveBeenCalledWith('t1', expect.objectContaining({
      output: { content: 'hello' },
      modelProvider: 'ark',
    }));
    const markProcessCompletedOrder = markProcessCompletedMock.mock.invocationCallOrder[0];
    const markCompletedOrder = markCompletedMock.mock.invocationCallOrder[0];
    expect(markProcessCompletedOrder).toBeLessThan(markCompletedOrder);
    // 7. 扣费
    expect(chargeCreditsMock).toHaveBeenCalledWith('u1', 0, expect.objectContaining({
      taskId: 't1',
      description: 'LLM 对话',
    }));
    // 8. 发布 COMPLETED 事件
    expect(publishTaskEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', status: 'COMPLETED', result: { content: 'hello' } }),
    );
    // 9. 释放槽位
    expect(releaseSlotMock).toHaveBeenCalledWith('u1');
  });

  it('publishes modelProvider/modelName in COMPLETED event', async () => {
    handleTaskMock.mockResolvedValueOnce({
      output: { videoUrl: 'https://v' },
      modelProvider: 'ark',
      modelName: 'ark/seedance',
    });

    await processJob(makeJob('VIDEO_GENERATE', {}));

    const completedCall = publishTaskEventMock.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'COMPLETED',
    );
    expect(completedCall).toBeDefined();
    expect(completedCall![0]).toMatchObject({
      modelProvider: 'ark',
      modelName: 'ark/seedance',
    });
  });

  it('converts platform yuan cost to credits and records the original cost', async () => {
    handleTaskMock.mockResolvedValueOnce({
      output: { imageUrls: ['https://img'] },
      cost: 0.4,
      billingDescription: '图片生成',
    });

    await processJob(makeJob('IMAGE_GENERATE', {}));

    expect(chargeCreditsMock).toHaveBeenCalledWith('u1', 5, expect.objectContaining({
      metadata: expect.objectContaining({ platformCostYuan: 0.4 }),
    }));
  });
});

describe('processJob — failure path', () => {
  it('catches handler error: marks FAILED + publishes FAILED + releases slot (no rethrow)', async () => {
    handleTaskMock.mockRejectedValueOnce(new Error('callAI 限流'));

    // 不应抛错（catch-all）
    await expect(processJob(makeJob('IMAGE_GENERATE', {}))).resolves.toBeUndefined();

    // markRunning 仍被调用
    expect(markRunningMock).toHaveBeenCalledTimes(1);
    // markFailed 被调用
    expect(markFailedMock).toHaveBeenCalledWith('t1', 'callAI 限流');
    // 发布 FAILED 事件
    expect(publishTaskEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', status: 'FAILED', error: 'callAI 限流' }),
    );
    // markCompleted 不应被调用
    expect(markCompletedMock).not.toHaveBeenCalled();
    // 扣费不应被调用（任务失败）
    expect(chargeCreditsMock).not.toHaveBeenCalled();
    // 槽位仍被释放
    expect(releaseSlotMock).toHaveBeenCalledWith('u1');
  });

  it('continues if markFailed throws (still publishes + releases)', async () => {
    handleTaskMock.mockRejectedValueOnce(new Error('handler boom'));
    markFailedMock.mockRejectedValueOnce(new Error('DB down'));

    await expect(processJob(makeJob('LLM_CHAT', {}))).resolves.toBeUndefined();
    // 仍尝试发布 FAILED 事件
    expect(publishTaskEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
    // 仍释放槽位
    expect(releaseSlotMock).toHaveBeenCalledWith('u1');
  });
});

describe('processJob — concurrency gate', () => {
  it('throws when acquireSlot denies (no handler call)', async () => {
    acquireSlotMock.mockResolvedValueOnce({
      allowed: false,
      current: 3,
      max: 3,
      reason: '用户并发任务数已达上限',
    });

    await expect(processJob(makeJob('LLM_CHAT', {}))).rejects.toThrow('用户并发任务数已达上限');

    // handler 不应被调用
    expect(handleTaskMock).not.toHaveBeenCalled();
    // markRunning 不应被调用
    expect(markRunningMock).not.toHaveBeenCalled();
    // 槽位不应被释放（acquire 失败时 releaseSlot 不在 finally 触发？— 实际在 finally 仍触发）
    // 注意：acquireSlot 失败时抛错在 try 之前，finally 仍执行 releaseSlot
    // 但 acquireSlot 失败时未占用槽位，release 会 floor 在 0（③ 自纠正）
  });

  it('passes user maxConcurrent as limit to acquireSlot', async () => {
    getConcurrencyLimitMock.mockResolvedValueOnce(5);
    handleTaskMock.mockResolvedValueOnce({ output: {} });

    await processJob(makeJob('LLM_CHAT', {}));

    expect(acquireSlotMock).toHaveBeenCalledWith('u1', 5);
  });
});

// 基础设施抖动（Redis OOM / 网络断 / DB hiccup）应走重投，绝不 fatal FAILED。
// 生产 61 次 VIDEO_GENERATE 假死根因：acquireSlot 的 Redis INCR 抛 OOM → 旧实现无 catch →
// 上抛 → worker.on('failed') → markFailed。本组锁死「infra 异常 = 重试，不是死刑」。
describe('processJob — infra-resilient slot acquisition (Redis OOM / DB hiccup)', () => {
  it('retries via moveToDelayed (DelayedError) when acquireSlot throws Redis OOM — never marks FAILED', async () => {
    acquireSlotMock.mockRejectedValueOnce(
      new Error('OOM command not allowed when used memory > maxmemory'),
    );
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    const job = {
      name: 'VIDEO_GENERATE',
      data: { taskId: 't1', userId: 'u1', input: {} },
      moveToDelayed,
    };
    const token = 'worker-token-xyz';

    await expect(processJob(job, token)).rejects.toBeInstanceOf(DelayedError);

    // 重投：moveToDelayed 被调用，第二参数是 worker token，第一参数是 ~5s 后的时间戳
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(moveToDelayed.mock.calls[0][1]).toBe(token);
    expect(moveToDelayed.mock.calls[0][0]).toBeGreaterThan(Date.now() - 1000);
    // infra 抖动不是业务失败：不调 handler、不 markRunning、不 markFailed
    expect(handleTaskMock).not.toHaveBeenCalled();
    expect(markRunningMock).not.toHaveBeenCalled();
    expect(markFailedMock).not.toHaveBeenCalled();
    // 槽位获取抛在 try 之前，finally 不执行 → 不 releaseSlot（也没占用槽位）
    expect(releaseSlotMock).not.toHaveBeenCalled();
  });

  it('retries when getConcurrencyLimit throws (DB hiccup) — same retry path, not FAILED', async () => {
    getConcurrencyLimitMock.mockRejectedValueOnce(new Error('Connection terminated'));
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    const job = {
      name: 'IMAGE_GENERATE',
      data: { taskId: 't1', userId: 'u1', input: {} },
      moveToDelayed,
    };

    await expect(processJob(job, 'tok')).rejects.toBeInstanceOf(DelayedError);

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(markFailedMock).not.toHaveBeenCalled();
    // DB 挂时 acquireSlot 不应被调用（limit 没拿到）
    expect(acquireSlotMock).not.toHaveBeenCalled();
  });

  it('without token/moveToDelayed, infra error degrades to retryable throw (backoff fallback, still not FAILED)', async () => {
    acquireSlotMock.mockRejectedValueOnce(new Error('Redis ECONNRESET'));
    // makeJob 不带 moveToDelayed，也不传 token → delayForRetry 降级 throw Error(reason)
    await expect(processJob(makeJob('LLM_CHAT', {}))).rejects.toThrow(/基础设施抖动/);

    // 仍不 markFailed（processJob 自身只 reject；fatal 与否由 BullMQ backoff 决定，会重试）
    expect(markFailedMock).not.toHaveBeenCalled();
    expect(handleTaskMock).not.toHaveBeenCalled();
  });
});

describe('processJob — billing failure', () => {
  it('does not fail the task when chargeCredits throws', async () => {
    handleTaskMock.mockResolvedValueOnce({ output: { ok: true }, billingDescription: 'x' });
    chargeCreditsMock.mockRejectedValueOnce(new Error('余额不足'));

    await processJob(makeJob('LLM_CHAT', {}));

    // 任务仍标记 COMPLETED
    expect(markCompletedMock).toHaveBeenCalledTimes(1);
    // 仍发布 COMPLETED 事件
    expect(publishTaskEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' }),
    );
    // 不发布 FAILED 事件
    const failedCall = publishTaskEventMock.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'FAILED',
    );
    expect(failedCall).toBeUndefined();
  });
});

describe('processJob — releaseSlot always called', () => {
  it('releases slot in finally even on success', async () => {
    handleTaskMock.mockResolvedValueOnce({ output: {} });
    await processJob(makeJob('LLM_CHAT', {}));
    expect(releaseSlotMock).toHaveBeenCalledTimes(1);
  });

  it('releases slot in finally even on handler failure', async () => {
    handleTaskMock.mockRejectedValueOnce(new Error('boom'));
    await processJob(makeJob('LLM_CHAT', {}));
    expect(releaseSlotMock).toHaveBeenCalledTimes(1);
  });
});

describe('processJob — terminal-state early-exit', () => {
  it('skips entirely when task already COMPLETED (stalled reprocess)', async () => {
    getTaskStatusMock.mockResolvedValueOnce('COMPLETED');
    await processJob(makeJob('LLM_CHAT', {}));
    expect(acquireSlotMock).not.toHaveBeenCalled();
    expect(handleTaskMock).not.toHaveBeenCalled();
    expect(markRunningMock).not.toHaveBeenCalled();
    expect(markCompletedMock).not.toHaveBeenCalled();
    // 早退在 try 之前 return，finally 不执行 → 不释放槽位
    expect(releaseSlotMock).not.toHaveBeenCalled();
  });

  it('skips entirely when task already FAILED', async () => {
    getTaskStatusMock.mockResolvedValueOnce('FAILED');
    await processJob(makeJob('LLM_CHAT', {}));
    expect(acquireSlotMock).not.toHaveBeenCalled();
    expect(handleTaskMock).not.toHaveBeenCalled();
  });

  it('proceeds normally when task is non-terminal (QUEUED)', async () => {
    handleTaskMock.mockResolvedValueOnce({ output: {} });
    getTaskStatusMock.mockResolvedValueOnce('QUEUED');
    await processJob(makeJob('LLM_CHAT', {}));
    expect(getTaskStatusMock).toHaveBeenCalledWith('t1');
    expect(acquireSlotMock).toHaveBeenCalledTimes(1);
    expect(handleTaskMock).toHaveBeenCalledTimes(1);
  });

  it('does not double-charge when markCompleted returns false (already terminal)', async () => {
    handleTaskMock.mockResolvedValueOnce({ output: {}, billingDescription: 'x' });
    markCompletedMock.mockResolvedValueOnce(false);
    await processJob(makeJob('LLM_CHAT', {}));
    // completed=false → 不扣费、不发 COMPLETED 事件
    expect(chargeCreditsMock).not.toHaveBeenCalled();
    const completedCall = publishTaskEventMock.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'COMPLETED',
    );
    expect(completedCall).toBeUndefined();
    // 槽位仍在 finally 释放
    expect(releaseSlotMock).toHaveBeenCalledWith('u1');
  });
});

describe('processJob — idempotency cache (P0-3 stall-retry)', () => {
  it('skips entirely when cache hits (RUNNING stall-retry): no slot, no handler, no billing', async () => {
    // stalled 重投：任务仍 RUNNING（非终态），终态检查放行，但缓存命中
    getTaskStatusMock.mockResolvedValueOnce('RUNNING');
    getCachedProcessResultMock.mockResolvedValueOnce({
      output: { content: 'cached' },
      modelProvider: 'ark',
      modelName: 'ark/doubao',
    });

    await processJob(makeJob('LLM_CHAT', {}));

    // 不获取槽位、不调 handler、不 markRunning/markCompleted
    expect(acquireSlotMock).not.toHaveBeenCalled();
    expect(handleTaskMock).not.toHaveBeenCalled();
    expect(markRunningMock).not.toHaveBeenCalled();
    expect(markCompletedMock).not.toHaveBeenCalled();
    // 不扣费、不写缓存、不发布事件
    expect(chargeCreditsMock).not.toHaveBeenCalled();
    expect(markProcessCompletedMock).not.toHaveBeenCalled();
    expect(publishTaskEventMock).not.toHaveBeenCalled();
    // 早退在 try 之前 return，finally 不执行 → 不释放槽位
    expect(releaseSlotMock).not.toHaveBeenCalled();
  });

  it('checks cache after terminal-status check (COMPLETED short-circuits before cache)', async () => {
    // 终态检查先命中 → 不应读缓存
    getTaskStatusMock.mockResolvedValueOnce('COMPLETED');
    await processJob(makeJob('LLM_CHAT', {}));
    expect(getCachedProcessResultMock).not.toHaveBeenCalled();
  });

  it('does not write cache when handler throws (only cache successful process)', async () => {
    handleTaskMock.mockRejectedValueOnce(new Error('callAI 限流'));
    await processJob(makeJob('LLM_CHAT', {}));
    expect(markProcessCompletedMock).not.toHaveBeenCalled();
    // 失败仍 markFailed + 发布
    expect(markFailedMock).toHaveBeenCalledWith('t1', 'callAI 限流');
  });

  it('writes cache before markCompleted so billing/COMPLETED crash still idempotent', async () => {
    handleTaskMock.mockResolvedValueOnce({
      output: { ok: 1 },
      modelProvider: 'ark',
      cost: 0.2,
      billingDescription: 'x',
    });
    // 模拟 markCompleted 抛错（崩溃窗口）
    markCompletedMock.mockRejectedValueOnce(new Error('DB connection lost'));

    await processJob(makeJob('LLM_CHAT', {}));

    // 缓存在 markCompleted 之前已写
    expect(markProcessCompletedMock).toHaveBeenCalledWith('t1', expect.objectContaining({
      output: { ok: 1 },
      modelProvider: 'ark',
    }));
    const markProcessCompletedOrder = markProcessCompletedMock.mock.invocationCallOrder[0];
    const markCompletedOrder = markCompletedMock.mock.invocationCallOrder[0];
    expect(markProcessCompletedOrder).toBeLessThan(markCompletedOrder);
  });
});

describe('processJob — lean BullMQ job (input 从 PG 取)', () => {
  it('fetches input from PG when job.data has no input (leanBullMQ video job)', async () => {
    getTaskInputMock.mockResolvedValueOnce({ prompt: 'from-pg', model: 'ark/seedance' });
    handleTaskMock.mockResolvedValueOnce({ output: { videoUrl: 'https://v' } });

    await processJob({ name: 'VIDEO_GENERATE', data: { taskId: 't1', userId: 'u1' } });

    expect(getTaskInputMock).toHaveBeenCalledWith('t1', 'u1');
    expect(handleTaskMock).toHaveBeenCalledWith(
      'VIDEO_GENERATE',
      { prompt: 'from-pg', model: 'ark/seedance' },
      'u1',
      't1',
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it('marks FAILED when PG input missing for a lean job', async () => {
    getTaskInputMock.mockResolvedValueOnce(null);
    handleTaskMock.mockResolvedValueOnce({ output: {} });

    await processJob({ name: 'VIDEO_GENERATE', data: { taskId: 't1', userId: 'u1' } });

    expect(getTaskInputMock).toHaveBeenCalledWith('t1', 'u1');
    // input 取不到 → throw → catch → markFailed；handler 不应被调用
    expect(handleTaskMock).not.toHaveBeenCalled();
    expect(markFailedMock).toHaveBeenCalledWith('t1', expect.stringContaining('input'));
  });
});

describe('processJob — cancel (CANCELLED 终态)', () => {
  it('CANCELLED 早退：不调 handleTask/acquireSlot（终态早退挡 stall 重投）', async () => {
    getTaskStatusMock.mockResolvedValueOnce('CANCELLED');
    await processJob(makeJob('LLM_CHAT', { input: {} }));
    expect(handleTaskMock).not.toHaveBeenCalled();
    expect(acquireSlotMock).not.toHaveBeenCalled();
  });

  it('catch 守卫：handler 抛错 + markFailed 返回 false（已 CANCELLED）→ 不发 FAILED 事件', async () => {
    handleTaskMock.mockRejectedValueOnce(new Error('boom'));
    markFailedMock.mockResolvedValueOnce(false);
    await expect(processJob(makeJob('IMAGE_GENERATE', {}))).resolves.toBeUndefined();
    expect(markFailedMock).toHaveBeenCalledWith('t1', 'boom');
    const failedCall = publishTaskEventMock.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'FAILED',
    );
    // 取消的终态事件已由 cancel route 发出，不重复发假 FAILED。
    expect(failedCall).toBeUndefined();
    expect(releaseSlotMock).toHaveBeenCalledWith('u1');
  });
});
