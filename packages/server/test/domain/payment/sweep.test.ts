// ============================================================
// payment/sweep — 对账兜底单测（防漏单，P6.1-C）
// ============================================================
// 两块：
//   1. sweepStalePendingOrders（DI 注入 fake findStale/syncOrder）——验编排：
//      分类计数 / 单笔出错不致命 / threshold 与 limit 透传 / findStale 失败不抛 / 审计日志
//   2. findStalePending（mock @server/infra query）——验 SQL 形状与参数
//      （status='PENDING' AND created_at < $1 LIMIT $2），确保只捞陈年 PENDING。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from '../../../src/infra/pg';

// mock @server/infra（findStalePending repo 用 query）
vi.mock('@server/infra', () => ({ query: vi.fn() }));

import {
  sweepStalePendingOrders,
  SWEEP_AGE_MS,
  SWEEP_BATCH_LIMIT,
} from '../../../src/domain/payment/sweep';
import { findStalePending } from '../../../src/domain/payment/repo';
import { query } from '@server/infra';

const FIXED_NOW = new Date('2026-07-19T15:00:00Z');

// ============================================================
// sweepStalePendingOrders 编排（DI）
// ============================================================
describe('sweepStalePendingOrders', () => {
  it('无陈年单 → 全零，不调 syncOrder，不日志', async () => {
    const syncOrder = vi.fn();
    const log = vi.fn();
    const r = await sweepStalePendingOrders({
      findStale: async () => [],
      syncOrder,
      now: () => FIXED_NOW,
      log,
    });
    expect(r).toEqual({ scanned: 0, credited: 0, closed: 0, unchanged: 0, errored: 0 });
    expect(syncOrder).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('threshold = now - SWEEP_AGE_MS 且 limit = SWEEP_BATCH_LIMIT 透传给 findStale', async () => {
    const findStale = vi.fn(async () => []);
    await sweepStalePendingOrders({ findStale, now: () => FIXED_NOW, log: () => {} });
    expect(findStale).toHaveBeenCalledTimes(1);
    const [threshold, limit] = findStale.mock.calls[0] as [Date, number];
    expect(threshold).toEqual(new Date(FIXED_NOW.getTime() - SWEEP_AGE_MS));
    expect(limit).toBe(SWEEP_BATCH_LIMIT);
  });

  it('PAID / CLOSED / PENDING 分类计数正确', async () => {
    const syncOrder = vi
      .fn()
      .mockResolvedValueOnce({ status: 'PAID' })
      .mockResolvedValueOnce({ status: 'CLOSED' })
      .mockResolvedValueOnce({ status: 'PENDING' });
    const r = await sweepStalePendingOrders({
      findStale: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      syncOrder,
      now: () => FIXED_NOW,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 3, credited: 1, closed: 1, unchanged: 1, errored: 0 });
  });

  it('单笔抛错 → 计 errored，其余照常处理，sweep 不抛', async () => {
    const syncOrder = vi
      .fn()
      .mockResolvedValueOnce({ status: 'PAID' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'PAID' });
    const r = await sweepStalePendingOrders({
      findStale: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      syncOrder,
      now: () => FIXED_NOW,
      log: () => {},
    });
    expect(r).toEqual({ scanned: 3, credited: 2, closed: 0, unchanged: 0, errored: 1 });
  });

  it('findStale 抛错 → 返回全零不抛，记失败日志', async () => {
    const log = vi.fn();
    const r = await sweepStalePendingOrders({
      findStale: async () => {
        throw new Error('db down');
      },
      now: () => FIXED_NOW,
      log,
    });
    expect(r).toEqual({ scanned: 0, credited: 0, closed: 0, unchanged: 0, errored: 0 });
    expect(log).toHaveBeenCalledWith(
      '[payment-sweep] findStale 失败，本 tick 跳过',
      expect.objectContaining({ err: expect.any(String) }),
    );
  });

  it('有处理时记审计日志（含统计）', async () => {
    const log = vi.fn();
    await sweepStalePendingOrders({
      findStale: async () => [{ id: 'a' }],
      syncOrder: async () => ({ status: 'PAID' }),
      now: () => FIXED_NOW,
      log,
    });
    expect(log).toHaveBeenCalledWith(
      '[payment-sweep] tick 完成',
      expect.objectContaining({ scanned: 1, credited: 1 }),
    );
  });
});

// ============================================================
// findStalePending repo SQL
// ============================================================
describe('findStalePending', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('返回 id 列表，SQL 含 status=PENDING / created_at<$1 / LIMIT $2，参数透传', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ id: 'o1' }, { id: 'o2' }],
      rowCount: 2,
    } as QueryResult);
    const threshold = new Date('2026-07-19T14:50:00Z');
    const ids = await findStalePending(threshold, 50);
    expect(ids).toEqual([{ id: 'o1' }, { id: 'o2' }]);
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('created_at < $1');
    expect(sql).toContain('LIMIT $2');
    expect(params).toEqual([threshold, 50]);
  });

  it('未传 limit → 默认 100', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as QueryResult);
    await findStalePending(new Date());
    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(100);
  });

  it('空结果 → 空数组', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as QueryResult);
    const ids = await findStalePending(new Date());
    expect(ids).toEqual([]);
  });
});
