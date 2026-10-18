// ============================================================
// task-heal-sweep — 卡死任务自愈单测
// ============================================================
// 仿 payment/sweep.test.ts 模式：DI 注入 mock findStuck/bump/redispatch/failTask，
// 验编排（重派/标失败分类计数、retryCount 判断、单笔出错不致命、findStuck 失败不抛、审计日志）。
// 不依赖真实 query/dispatch（默认实现经 vi.mock 替换）。
// ============================================================

import { describe, it, expect, vi } from 'vitest';

// 默认实现依赖 query + dispatchAiTask，mock 掉避免加载真实链
vi.mock('@server/infra', () => ({ query: vi.fn() }));
vi.mock('../../src/task/dispatch', () => ({ dispatchAiTask: vi.fn() }));

import {
  sweepStuckTasks,
  staleRunningSecondsForType,
  stripTerminalVideoGenerateInput,
  type StuckTask,
} from '../../src/task/task-heal-sweep';

const makeTask = (over: Partial<StuckTask>): StuckTask => ({
  id: 't1',
  userId: 'u1',
  type: 'ASSET_IMAGE_GENERATE',
  status: 'QUEUED',
  input: { prompt: 'x' },
  projectId: 'p1',
  retryCount: 0,
  maxRetries: 3,
  ...over,
});

describe('sweepStuckTasks', () => {
  it('无卡死任务 → 全零，不调 redispatch/failTask/bump，不日志', async () => {
    const redispatch = vi.fn();
    const failTask = vi.fn();
    const bump = vi.fn();
    const log = vi.fn();
    const r = await sweepStuckTasks({
      findStuck: async () => [],
      bumpRetryCount: bump,
      redispatch,
      failTask,
      log,
    });
    expect(r).toEqual({ scanned: 0, redispatched: 0, failed: 0, errored: 0 });
    expect(redispatch).not.toHaveBeenCalled();
    expect(failTask).not.toHaveBeenCalled();
    expect(bump).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('retryCount < maxRetries → bump + redispatch', async () => {
    const bump = vi.fn();
    const redispatch = vi.fn();
    const r = await sweepStuckTasks({
      // 新断言对应新行为：bump/fail 仅对 status='RUNNING' 的孤儿生效（P0-A 治"28 张资产图
      // 被误杀"根因——旧实现无脑 bump，把被 slot-gate 反复延迟的健康 QUEUED 推向 retryCount
      // 耗尽误判 FAILED）。makeTask 默认 QUEUED（本就不该 bump），此处显式设 RUNNING 走 bump 路径。
      findStuck: async () => [makeTask({ status: 'RUNNING', retryCount: 0, maxRetries: 3 })],
      bumpRetryCount: bump,
      redispatch,
      failTask: vi.fn(),
      log: () => {},
    });
    expect(r).toEqual({ scanned: 1, redispatched: 1, failed: 0, errored: 0 });
    expect(bump).toHaveBeenCalledWith('t1');
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it('retryCount >= maxRetries → failTask（不再 bump/redispatch）', async () => {
    const bump = vi.fn();
    const redispatch = vi.fn();
    const failTask = vi.fn();
    const r = await sweepStuckTasks({
      // 新断言对应新行为：fail 路径也只对 RUNNING 孤儿生效，QUEUED 不会 bump/fail。
      findStuck: async () => [
        makeTask({ id: 't-full', status: 'RUNNING', retryCount: 3, maxRetries: 3 }),
      ],
      bumpRetryCount: bump,
      redispatch,
      failTask,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 1, redispatched: 0, failed: 1, errored: 0 });
    expect(bump).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
    expect(failTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-full' }),
      expect.any(String),
    );
  });

  it('单笔 redispatch 抛错 → 计 errored，其余照常，sweep 不抛', async () => {
    const r = await sweepStuckTasks({
      findStuck: async () => [makeTask({ id: 'a' }), makeTask({ id: 'b' })],
      bumpRetryCount: vi.fn(),
      redispatch: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined),
      failTask: vi.fn(),
      log: () => {},
    });
    expect(r).toEqual({ scanned: 2, redispatched: 1, failed: 0, errored: 1 });
  });

  it('findStuck 抛错 → 返回全零不抛，记失败日志', async () => {
    const log = vi.fn();
    const r = await sweepStuckTasks({
      findStuck: async () => {
        throw new Error('db down');
      },
      log,
    });
    expect(r).toEqual({ scanned: 0, redispatched: 0, failed: 0, errored: 0 });
    expect(log).toHaveBeenCalledWith(
      '[task-heal] findStuck 失败，本 tick 跳过',
      expect.objectContaining({ err: expect.any(String) }),
    );
  });

  it('有处理时记审计日志（含统计）', async () => {
    const log = vi.fn();
    await sweepStuckTasks({
      findStuck: async () => [makeTask({})],
      bumpRetryCount: vi.fn(),
      redispatch: vi.fn(),
      failTask: vi.fn(),
      log,
    });
    expect(log).toHaveBeenCalledWith(
      '[task-heal] tick 完成',
      expect.objectContaining({ scanned: 1, redispatched: 1 }),
    );
  });

  it('混合：1 个重派 + 1 个标失败 + 1 个出错', async () => {
    const r = await sweepStuckTasks({
      findStuck: async () => [
        makeTask({ id: 'ok', retryCount: 0 }),
        // 新断言对应新行为：fail 路径只对 RUNNING 孤儿生效，故 dead 必须是 RUNNING。
        // ok/err 保持默认 QUEUED（走 redispatch 不 bump，体现"QUEUED 不消耗重试额度"）。
        makeTask({ id: 'dead', status: 'RUNNING', retryCount: 3, maxRetries: 3 }),
        makeTask({ id: 'err', retryCount: 0 }),
      ],
      bumpRetryCount: vi.fn(),
      redispatch: vi.fn().mockRejectedValueOnce(new Error('x')), // err 那个抛错？顺序问题
      failTask: vi.fn(),
      log: () => {},
    });
    // 顺序：ok→redispatch(ok), dead→failTask, err→bump+redispatch(抛错→errored)
    // 注：上面 redispatch mockRejectedValueOnce 会命中第一个 redispatch 调用（ok），故 ok 计 errored
    expect(r.scanned).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.redispatched + r.errored).toBe(2);
  });
});

describe('staleRunningSecondsForType (F2: 防 heal 误杀长任务)', () => {
  // 阈值必须严格 > 对应 handler 超时（processor.ts timeoutForType），否则健康任务跑过
  // 阈值即被 heal 当孤儿 → retryCount 累计 → 假 FAILED（key 已烧、markCompleted CAS 拒绝）。
  it('VIDEO_GENERATE 阈值 > video handler 25min', () => {
    expect(staleRunningSecondsForType('VIDEO_GENERATE')).toBeGreaterThan(25 * 60);
  });
  it('EPISODE_SPLIT 阈值 > handler 30min', () => {
    expect(staleRunningSecondsForType('EPISODE_SPLIT')).toBeGreaterThan(30 * 60);
  });
  it('未知/短任务类型走默认 12min（> image 8min / text 3min / voice 5min）', () => {
    expect(staleRunningSecondsForType('IMAGE_GENERATE')).toBe(12 * 60);
    expect(staleRunningSecondsForType('LLM_CHAT')).toBe(12 * 60);
    expect(staleRunningSecondsForType('UNKNOWN')).toBe(12 * 60);
  });
});

describe('stripTerminalVideoGenerateInput (2026-08-02 traffic patch)', () => {
  it('strips 3 base64 keys from terminal VIDEO_GENERATE input and logs', async () => {
    const { query } = await import('@server/infra');
    const mockQuery = query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValue({ rowCount: 42 });
    const log = vi.fn();

    const n = await stripTerminalVideoGenerateInput(log);

    expect(n).toBe(42);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("'referenceImageBase64'");
    expect(sql).toContain("'referenceImageUrls'");
    expect(sql).toContain("'characterReferenceImageUrls'");
    expect(sql).toContain("status IN ('COMPLETED','FAILED','CANCELLED','TIMEOUT')");
    expect(log).toHaveBeenCalledWith('[task-heal] VIDEO_GENERATE input 大字段瘦身', { updated: 42 });
  });

  it('zero hits logs nothing', async () => {
    const { query } = await import('@server/infra');
    const mockQuery = query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValue({ rowCount: 0 });
    const log = vi.fn();

    const n = await stripTerminalVideoGenerateInput(log);

    expect(n).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('query failure returns 0 without throwing', async () => {
    const { query } = await import('@server/infra');
    const mockQuery = query as ReturnType<typeof vi.fn>;
    mockQuery.mockRejectedValue(new Error('pg down'));
    const log = vi.fn();

    await expect(stripTerminalVideoGenerateInput(log)).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('stripTerminalVideoGenerateInput'),
      expect.any(Object),
    );
  });
});
