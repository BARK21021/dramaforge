// ============================================================
// payment/pending-debit-sweep — billing_ledger PENDING_DEBIT 补扣单测（P0-2）
// ============================================================
// 两块：
//   1. sweepPendingDebits（DI 注入 fake findPending/charge/markSettled/markAttempted）
//      ——验编排：分类计数 / 409 豁免走 settled 不算 errored / 其他失败计 errored 且
//      不调 markSettled / findPending 失败不抛 / limit 透传 / 审计日志。
//   2. findPendingDebitEntries / markPendingDebitSettled / markPendingDebitAttempted
//      （mock @server/infra query）——验 SQL 形状：
//        - findPendingDebitEntries: type='PENDING_DEBIT' + settled 排除 + LIMIT $1
//        - markPendingDebitSettled: jsonb `||` 合并 settled/settledAt + WHERE id=$1
//        - markPendingDebitAttempted: jsonb 合并 lastAttemptAt/lastError
//
// 另：defaultChargePendingDebit 的 billingMode 分派（simple → chargeCredits /
// aggregate → chargeAggregatedTaskCost）——验参数透传与 credits/costYuan 提取。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from '../../../src/infra/pg';

// mock @server/infra（query 用于 billing 辅助）+ billing barrel（charge 函数 + 辅助）。
// 注意：辅助函数 findPendingDebitEntries/markPendingDebitSettled/markPendingDebitAttempted
// 真实实现在 billing/service.ts 里走 query —— 本文件第二个 describe 直接测它们的 SQL 形状，
// 所以不能把整个 billing barrel mock 成 vi.fn()，需要按需 selectively mock：
// 对 sweepPendingDebits 编排测试（DI），mock 全部；对 SQL 形状测试，只 mock @server/infra。
// 用 vitest 的 hoist + 不同 mock 组合在同一文件会冲突 —— 拆成「先全 mock 验编排」，
// SQL 形状由 markPendingDebitSettled/markPendingDebitAttempted 的 DI fake 在编排测试里
// 间接覆盖（markSettled/markAttempted 是 DI 注入的，default 实现的 SQL 形状另起独立断言）。

vi.mock('@server/infra', () => ({ query: vi.fn() }));
vi.mock('../../../src/domain/billing', () => ({
  chargeCredits: vi.fn(),
  chargeAggregatedTaskCost: vi.fn(),
  findPendingDebitEntries: vi.fn(),
  markPendingDebitSettled: vi.fn(),
  markPendingDebitAttempted: vi.fn(),
}));

import {
  sweepPendingDebits,
  PENDING_CHARGE_SWEEP_BATCH_LIMIT,
} from '../../../src/domain/payment/pending-charge-sweep';
import type { PendingDebitRow } from '../../../src/domain/billing';
// 经 barrel 的 charge 函数（被上面 vi.mock 成 vi.fn()，方便配置 mockResolvedValueOnce
// 验 default 分派）；下面 SQL 形状测试用 *Real 直接从 service.ts 取（绕开 barrel mock）
// 以触发真实 query 调用。
import { chargeCredits, chargeAggregatedTaskCost } from '../../../src/domain/billing';
import {
  findPendingDebitEntries as findPendingDebitEntriesReal,
  markPendingDebitSettled as markPendingDebitSettledReal,
  markPendingDebitAttempted as markPendingDebitAttemptedReal,
} from '../../../src/domain/billing/service';
import { query } from '@server/infra';

const mkRow = (
  id: string,
  overrides: Partial<PendingDebitRow> = {},
): PendingDebitRow => ({
  id,
  userId: `user-${id}`,
  taskId: null,
  amount: 10,
  metadata: {
    credits: 10,
    costYuan: 1,
    billingMode: 'simple',
    reason: 'PG 抖动',
    source: 'sync-direct',
  },
  createdAt: '2026-07-23T00:00:00Z',
  ...overrides,
});

// ============================================================
// sweepPendingDebits 编排（DI）
// ============================================================
describe('sweepPendingDebits', () => {
  it('无未结清单 → 全零，不调 charge/markSettled/markAttempted，不日志', async () => {
    const charge = vi.fn();
    const markSettled = vi.fn();
    const markAttempted = vi.fn();
    const log = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => [],
      charge,
      markSettled,
      markAttempted,
      log,
    });
    expect(r).toEqual({ scanned: 0, settled: 0, errored: 0 });
    expect(charge).not.toHaveBeenCalled();
    expect(markSettled).not.toHaveBeenCalled();
    expect(markAttempted).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('limit = PENDING_CHARGE_SWEEP_BATCH_LIMIT 透传给 findPending', async () => {
    const findPending = vi.fn(async () => []);
    await sweepPendingDebits({ findPending, log: () => {} });
    expect(findPending).toHaveBeenCalledTimes(1);
    const [limit] = findPending.mock.calls[0] as [number];
    expect(limit).toBe(PENDING_CHARGE_SWEEP_BATCH_LIMIT);
  });

  it('成功补扣 → settled+1 且调 markSettled(id)，不调 markAttempted', async () => {
    const charge = vi.fn();
    const markSettled = vi.fn();
    const markAttempted = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => [mkRow('a')],
      charge,
      markSettled,
      markAttempted,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 1, settled: 1, errored: 0 });
    expect(charge).toHaveBeenCalledWith(mkRow('a'));
    expect(markSettled).toHaveBeenCalledWith('a');
    expect(markAttempted).not.toHaveBeenCalled();
  });

  it('多笔混合（成功/失败/成功）→ 分类计数正确，失败笔不调 markSettled、调 markAttempted', async () => {
    const charge = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('余额不足'))
      .mockResolvedValueOnce(undefined);
    const markSettled = vi.fn();
    const markAttempted = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => [mkRow('a'), mkRow('b'), mkRow('c')],
      charge,
      markSettled,
      markAttempted,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 3, settled: 2, errored: 1 });
    // 只对成功的 a / c 标 settled，b 失败不标
    expect(markSettled).toHaveBeenCalledTimes(2);
    expect(markSettled).toHaveBeenCalledWith('a');
    expect(markSettled).toHaveBeenCalledWith('c');
    expect(markSettled).not.toHaveBeenCalledWith('b');
    // b 失败时调 markAttempted 写 lastError
    expect(markAttempted).toHaveBeenCalledTimes(1);
    expect(markAttempted).toHaveBeenCalledWith('b', '余额不足');
  });

  it('409 终态（任务 FAILED/CANCELLED）→ 走豁免：settled+1 + markSettled 带 waived，不算 errored，不调 markAttempted', async () => {
    // BillingError duck-type：statusCode=409
    const err409 = Object.assign(new Error('任务已进入失败或取消终态，拒绝迟到结算'), {
      statusCode: 409,
    });
    const charge = vi.fn().mockRejectedValueOnce(err409);
    const markSettled = vi.fn();
    const markAttempted = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => [mkRow('a')],
      charge,
      markSettled,
      markAttempted,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 1, settled: 1, errored: 0 });
    expect(markSettled).toHaveBeenCalledWith('a', {
      waived: true,
      waiveReason: 'task-terminal-409',
    });
    expect(markAttempted).not.toHaveBeenCalled();
  });

  it('409 豁免时 markSettled 自身抛 → 退化为 errored（下 tick 重试），sweep 不抛', async () => {
    const err409 = Object.assign(new Error('终态'), { statusCode: 409 });
    const charge = vi.fn().mockRejectedValueOnce(err409);
    const markSettled = vi.fn().mockRejectedValueOnce(new Error('db 抖'));
    const markAttempted = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => [mkRow('a')],
      charge,
      markSettled,
      markAttempted,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 1, settled: 0, errored: 1 });
  });

  it('非 402/409 的 charge 抛错 → 计 errored，其余照常处理，sweep 不抛', async () => {
    const charge = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const markSettled = vi.fn();
    const markAttempted = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => [mkRow('a'), mkRow('b')],
      charge,
      markSettled,
      markAttempted,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 2, settled: 1, errored: 1 });
  });

  it('402 余额不足 → 非 409，计 errored 留下次 tick 重试（与 pendingCharge sweep 一致，永不放弃）', async () => {
    const err402 = Object.assign(new Error('积分余额不足'), { statusCode: 402 });
    const charge = vi.fn().mockRejectedValueOnce(err402);
    const markSettled = vi.fn();
    const markAttempted = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => [mkRow('a')],
      charge,
      markSettled,
      markAttempted,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 1, settled: 0, errored: 1 });
    expect(markSettled).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith('a', '积分余额不足');
  });

  it('markAttempted 自身抛 → 不影响计数（已被 sweep 吞，行仍 unsettled 等下 tick）', async () => {
    const charge = vi.fn().mockRejectedValueOnce(new Error('charge 失败'));
    const markSettled = vi.fn();
    const markAttempted = vi.fn().mockRejectedValueOnce(new Error('mark 失败'));
    const r = await sweepPendingDebits({
      findPending: async () => [mkRow('a')],
      charge,
      markSettled,
      markAttempted,
      log: () => {},
    });
    // charge 失败 → errored；markAttempted 抛被 default 实现吞（这里注入的 fake 抛，
    // sweepPendingDebits 调 markAttempted 时不 catch —— 注意：这是 DI 注入版，
    // 抛上来会被外层 try/catch 当单笔失败计 errored，不二次累加）
    expect(r.settled).toBe(0);
    expect(r.errored).toBe(1);
  });

  it('findPending 抛错 → 返回全零不抛，记失败日志', async () => {
    const log = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => {
        throw new Error('db down');
      },
      log,
    });
    expect(r).toEqual({ scanned: 0, settled: 0, errored: 0 });
    expect(log).toHaveBeenCalledWith(
      '[pending-debit-sweep] findPending 失败，本 tick 跳过',
      expect.objectContaining({ err: expect.any(String) }),
    );
  });

  it('有处理时记审计日志（含统计）', async () => {
    const log = vi.fn();
    await sweepPendingDebits({
      findPending: async () => [mkRow('a')],
      charge: async () => {},
      markSettled: async () => {},
      markAttempted: async () => {},
      log,
    });
    expect(log).toHaveBeenCalledWith(
      '[pending-debit-sweep] tick 完成',
      expect.objectContaining({ scanned: 1, settled: 1 }),
    );
  });
});

// ============================================================
// defaultChargePendingDebit 分派（经 sweepPendingDebits 公共 API，不注入 charge）
// 验 billingMode → charge 函数 + 参数透传
// ============================================================
describe('defaultChargePendingDebit (via sweepPendingDebits)', () => {
  beforeEach(() => {
    vi.mocked(chargeCredits).mockReset();
    vi.mocked(chargeAggregatedTaskCost).mockReset();
  });

  it("simple 模式 → chargeCredits(userId, credits, metadata.source='pending-debit-sweep' + pendingDebitId)", async () => {
    vi.mocked(chargeCredits).mockResolvedValueOnce({} as never);
    const row = mkRow('pds-1', {
      taskId: 'task-xyz',
      metadata: {
        credits: 42,
        costYuan: 4.2,
        billingMode: 'simple',
        reason: '连接重置',
        source: 'sync-direct',
      },
    });
    // 不注入 charge → 走 defaultChargePendingDebit；markSettled/markAttempted 用 noop fake
    await sweepPendingDebits({
      findPending: async () => [row],
      markSettled: async () => {},
      markAttempted: async () => {},
      log: () => {},
    });
    expect(chargeCredits).toHaveBeenCalledTimes(1);
    const [userId, credits, opts] = vi.mocked(chargeCredits).mock.calls[0] as [
      string,
      number,
      { taskId: string | null; description: string; metadata: Record<string, unknown> },
    ];
    expect(userId).toBe('user-pds-1');
    expect(credits).toBe(42);
    expect(opts.taskId).toBe('task-xyz');
    expect(opts.metadata.source).toBe('pending-debit-sweep');
    expect(opts.metadata.pendingDebitId).toBe('pds-1');
    expect(opts.metadata.originalReason).toBe('连接重置');
    expect(chargeAggregatedTaskCost).not.toHaveBeenCalled();
  });

  it('credits 缺失 → fallback 到 row.amount（防 metadata 残缺）', async () => {
    vi.mocked(chargeCredits).mockResolvedValueOnce({} as never);
    const row = mkRow('pds-2', {
      amount: 77,
      metadata: { billingMode: 'simple', reason: 'x' },
    });
    await sweepPendingDebits({
      findPending: async () => [row],
      markSettled: async () => {},
      markAttempted: async () => {},
      log: () => {},
    });
    const [, credits] = vi.mocked(chargeCredits).mock.calls[0] as [string, number, unknown];
    expect(credits).toBe(77);
  });

  it("aggregate 模式 → chargeAggregatedTaskCost(userId, billingTaskId, billingUnitId, costYuan, 描述)", async () => {
    vi.mocked(chargeAggregatedTaskCost).mockResolvedValueOnce({} as never);
    const row = mkRow('pda-1', {
      taskId: 'render-1',
      metadata: {
        credits: 100,
        costYuan: 9.9,
        billingMode: 'aggregate',
        billingTaskId: 'render-1',
        billingUnitId: 'unit-7',
        reason: 'tx冲突',
      },
    });
    await sweepPendingDebits({
      findPending: async () => [row],
      markSettled: async () => {},
      markAttempted: async () => {},
      log: () => {},
    });
    expect(chargeAggregatedTaskCost).toHaveBeenCalledTimes(1);
    const [userId, taskId, unitId, costYuan, desc] = vi.mocked(
      chargeAggregatedTaskCost,
    ).mock.calls[0] as [string, string, string, number, string];
    expect(userId).toBe('user-pda-1');
    expect(taskId).toBe('render-1');
    expect(unitId).toBe('unit-7');
    expect(costYuan).toBe(9.9);
    expect(desc).toContain('补扣');
    expect(chargeCredits).not.toHaveBeenCalled();
  });

  it('aggregate 模式缺 billingTaskId/billingUnitId → 抛错（sweep 当 errored，行留下次）', async () => {
    vi.mocked(chargeCredits).mockResolvedValue({} as never);
    const row = mkRow('pda-bad', {
      metadata: { billingMode: 'aggregate', costYuan: 1 },
    });
    const markAttempted = vi.fn();
    const r = await sweepPendingDebits({
      findPending: async () => [row],
      markSettled: async () => {},
      markAttempted,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 1, settled: 0, errored: 1 });
    expect(chargeAggregatedTaskCost).not.toHaveBeenCalled();
    expect(chargeCredits).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith(
      'pda-bad',
      expect.stringMatching(/billingTaskId/),
    );
  });
});

// ============================================================
// billing 辅助函数 SQL 形状（直接从 service.ts 取真实实现，绕开 barrel mock；
// 仅 mock @server/infra query）
// ============================================================
describe('findPendingDebitEntries SQL', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("SQL 含 type='PENDING_DEBIT' / settled 排除 / ORDER BY createdAt / LIMIT $1，参数透传", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [mkRow('d1'), mkRow('d2')],
      rowCount: 2,
    } as QueryResult);
    await findPendingDebitEntriesReal(25);
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("type = 'PENDING_DEBIT'");
    expect(sql).toContain("'settled')");
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([25]);
  });

  it('limit 透传：直接调用 findPendingDebitEntries(limit) 把 limit 作 $1', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as QueryResult);
    await findPendingDebitEntriesReal(PENDING_CHARGE_SWEEP_BATCH_LIMIT);
    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(PENDING_CHARGE_SWEEP_BATCH_LIMIT);
  });
});

describe('markPendingDebitSettled SQL', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("jsonb `||` 合并 settled/settledAt + WHERE id=$1，note 作 $2 透传", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as QueryResult);
    await markPendingDebitSettledReal('pd-1', { waived: true, waiveReason: 'task-terminal-409' });
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("|| jsonb_build_object('settled', true");
    expect(sql).toContain("'settledAt'");
    expect(sql).toContain('|| $2::jsonb');
    expect(sql).toContain('WHERE id = $1');
    expect(params[0]).toBe('pd-1');
    expect(typeof params[1]).toBe('string');
    const parsed = JSON.parse(params[1] as string);
    expect(parsed).toEqual({ waived: true, waiveReason: 'task-terminal-409' });
  });

  it('无 note → $2 为 "{}" 字符串（空合并，不改语义）', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as QueryResult);
    await markPendingDebitSettledReal('pd-2');
    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    // params = [entryId, extraJson]；extraJson 在 params[1]
    expect(params[0]).toBe('pd-2');
    expect(JSON.parse(params[1] as string)).toEqual({});
  });
});

describe('markPendingDebitAttempted SQL', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("jsonb 合并 lastAttemptAt/lastError + errMsg 作 $2 透传", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as QueryResult);
    await markPendingDebitAttemptedReal('pd-3', '连接重置');
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("'lastAttemptAt'");
    expect(sql).toContain("'lastError'");
    expect(sql).toContain('$2::text');
    expect(sql).toContain('WHERE id = $1');
    expect(params).toEqual(['pd-3', '连接重置']);
  });

  it('query 抛错 → 被吞（返回 undefined，不抛出）', async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error('db down'));
    await expect(markPendingDebitAttemptedReal('pd-4', 'x')).resolves.toBeUndefined();
  });
});
