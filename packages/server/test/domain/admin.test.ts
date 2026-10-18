// ============================================================
// server/domain/admin — 单测
// ============================================================
//
// 覆盖：
//   - getAdminStats：4 指标聚合 + 总用户数 + 利润 = 氪金 − AI 成本
//     · billing_ledger.credits 正负号口径（+充值/-消耗）
//     · payment_orders.amount_yuan WHERE status='PAID'（手动充值不计入氪金 ✓）
//     · billing_ledger.metadata.cost WHERE type='TASK_DEBIT'（AI 成本）
//   - listLedgerForAdmin：filter='recharge' 包含 5 种 type
//     （PURCHASE_CREDIT / ADMIN_CREDIT / QUOTA_CREDIT / REFUND_CREDIT / REFUND）
//     —— dramaforge creditRefund 写 'REFUND'（非 app1 'REFUND_CREDIT'），两者都列入以兼容历史数据
//
// mock @server/infra.query：按 SQL pattern 匹配返回固定结果，验证聚合口径正确。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryFn, QueryResult } from '../../src/infra/pg';

vi.mock('@server/infra', () => ({
  query: vi.fn(),
  tx: vi.fn(),
}));

import { getAdminStats, listLedgerForAdmin, listUserFilms, updateUserConcurrency } from '../../src/domain/admin';
import { query } from '@server/infra';

type QueryCall = { sql: string; params?: unknown[] };

/**
 * 构造一个按 SQL pattern 路由的 mock query。
 *
 * 用法：const { calls } = setupQuery({ stats: {...}, ... }) 然后调被测函数。
 * 匹配优先级从上到下；未匹配返空 rows。
 */
function setupQueryRouting(handlers: {
  creditsSummary?: { recharged: string; consumed: string };
  spent?: string;
  cost?: string;
  usersCount?: number;
  ledgerList?: { rows: unknown[]; total: number };
}): { calls: QueryCall[] } {
  const calls: QueryCall[] = [];

  async function execQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    calls.push({ sql, params });

    // getAdminStats — 4 个并行 query
    if (sql.includes('SUM(credits) FILTER (WHERE credits > 0)') && sql.includes('recharged')) {
      return {
        rows: [
          {
            recharged: handlers.creditsSummary?.recharged ?? '0',
            consumed: handlers.creditsSummary?.consumed ?? '0',
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("status = 'PAID'") && sql.includes('amount_yuan')) {
      return { rows: [{ spent: handlers.spent ?? '0' }], rowCount: 1 };
    }
    if (sql.includes("(metadata->>'cost')::numeric")) {
      return { rows: [{ cost: handlers.cost ?? '0' }], rowCount: 1 };
    }
    if (sql === 'SELECT COUNT(*)::int AS total FROM users') {
      return { rows: [{ total: handlers.usersCount ?? 0 }], rowCount: 1 };
    }

    // listLedgerForAdmin — 2 个并行 query（list + count）
    if (sql.startsWith('SELECT id, type, amount, credits, balance, description')) {
      return {
        rows: handlers.ledgerList?.rows ?? [],
        rowCount: (handlers.ledgerList?.rows ?? []).length,
      };
    }
    if (sql.startsWith('SELECT COUNT(*)::int AS total FROM billing_ledger')) {
      return { rows: [{ total: handlers.ledgerList?.total ?? 0 }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  vi.mocked(query).mockImplementation(execQuery);
  return { calls };
}

// ============================================================
// getAdminStats
// ============================================================

describe('getAdminStats — KPI aggregation', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('aggregates 5 metrics + totalUsers correctly (sign-convention on credits)', async () => {
    // 模拟：billing_ledger 累计充值 12000 积分 / 消耗 8000 积分
    //       payment_orders PAID 累计 1000 元
    //       TASK_DEBIT metadata.cost 累计 400 元
    //       users 总数 42 人
    // 期望利润 = 1000 − 400 = 600 元
    setupQueryRouting({
      creditsSummary: { recharged: '12000', consumed: '8000' },
      spent: '1000',
      cost: '400',
      usersCount: 42,
    });

    const stats = await getAdminStats();

    expect(stats.totalUsers).toBe(42);
    expect(stats.totalRechargedCredits).toBe(12000);
    expect(stats.totalConsumedCredits).toBe(8000);
    expect(stats.totalSpentYuan).toBe(1000);
    expect(stats.totalCostYuan).toBe(400);
    expect(stats.profitYuan).toBe(600); // 1000 − 400
  });

  it('profitYuan is negative when AI cost exceeds revenue', async () => {
    setupQueryRouting({
      creditsSummary: { recharged: '100', consumed: '50' },
      spent: '100',
      cost: '350',
      usersCount: 1,
    });
    const stats = await getAdminStats();
    expect(stats.profitYuan).toBe(-250); // 100 − 350
  });

  it('zero ledger / zero payment_orders / zero cost → all metrics 0, profit 0', async () => {
    setupQueryRouting({
      creditsSummary: { recharged: '0', consumed: '0' },
      spent: '0',
      cost: '0',
      usersCount: 0,
    });
    const stats = await getAdminStats();
    expect(stats.totalUsers).toBe(0);
    expect(stats.totalRechargedCredits).toBe(0);
    expect(stats.totalConsumedCredits).toBe(0);
    expect(stats.totalSpentYuan).toBe(0);
    expect(stats.totalCostYuan).toBe(0);
    expect(stats.profitYuan).toBe(0);
  });

  it('handles numeric strings with decimals (rounds to 2 decimal places)', async () => {
    setupQueryRouting({
      creditsSummary: { recharged: '100', consumed: '0' },
      spent: '99.999',
      cost: '33.333',
      usersCount: 1,
    });
    const stats = await getAdminStats();
    expect(stats.totalSpentYuan).toBe(100); // Math.round(99.999 * 100) / 100 = 100
    expect(stats.totalCostYuan).toBe(33.33);
    expect(stats.profitYuan).toBe(66.67); // 100 − 33.33
  });

  it('manual recharge does NOT inflate totalSpentYuan (queries payment_orders, not billing_ledger)', async () => {
    // 关键：creditManual 写 billing_ledger PURCHASE_CREDIT 但不写 payment_orders，
    // 所以 totalSpentYuan 仅来自 payment_orders PAID。这里验证查询确实用 payment_orders。
    const { calls } = setupQueryRouting({
      creditsSummary: { recharged: '5000', consumed: '0' },
      spent: '0', // payment_orders 无 PAID
      cost: '0',
      usersCount: 1,
    });
    const stats = await getAdminStats();
    expect(stats.totalSpentYuan).toBe(0);
    expect(stats.totalRechargedCredits).toBe(5000); // billing_ledger 含手动充值
    // 验证 spent 查询确实走 payment_orders WHERE status='PAID'
    expect(
      calls.some(
        (c) =>
          c.sql.includes('payment_orders') && c.sql.includes("status = 'PAID'"),
      ),
    ).toBe(true);
  });

  it('emits exactly 4 parallel queries (credits + spent + cost + users)', async () => {
    const { calls } = setupQueryRouting({
      creditsSummary: { recharged: '0', consumed: '0' },
      spent: '0',
      cost: '0',
      usersCount: 0,
    });
    await getAdminStats();
    // 4 个不同 SQL pattern
    expect(calls.length).toBe(4);
    expect(calls.some((c) => c.sql.includes('FILTER (WHERE credits > 0)'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('payment_orders'))).toBe(true);
    expect(calls.some((c) => c.sql.includes("metadata->>'cost'"))).toBe(true);
    expect(calls.some((c) => c.sql === 'SELECT COUNT(*)::int AS total FROM users')).toBe(true);
  });
});

// ============================================================
// listLedgerForAdmin — RECHARGE_TYPES filter (含 REFUND 兼容)
// ============================================================

describe('listLedgerForAdmin — RECHARGE_TYPES filter', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('filter=recharge includes 5 types: PURCHASE_CREDIT / ADMIN_CREDIT / QUOTA_CREDIT / REFUND_CREDIT / REFUND', async () => {
    // dramaforge creditRefund 写 'REFUND'（非 app1 'REFUND_CREDIT'）；filter 必须两者都列入
    setupQueryRouting({
      ledgerList: {
        rows: [
          {
            id: 'l-1',
            type: 'PURCHASE_CREDIT',
            amount: -100,
            credits: 100,
            balance: 100,
            description: '充值',
            createdAt: new Date('2026-07-21T00:00:00Z'),
            taskId: null,
          },
          {
            id: 'l-2',
            type: 'REFUND', // dramaforge creditRefund 写的实际 type
            amount: -30,
            credits: 30,
            balance: 130,
            description: '任务退款 (t-1)',
            createdAt: new Date('2026-07-21T00:00:00Z'),
            taskId: 't-1',
          },
        ],
        total: 2,
      },
    });

    const result = await listLedgerForAdmin('u-1', { filter: 'recharge', page: 1, pageSize: 50 });

    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.entries[0].type).toBe('PURCHASE_CREDIT');
    expect(result.entries[1].type).toBe('REFUND');
  });

  it('filter=recharge emits SQL with all 5 types in IN clause', async () => {
    const { calls } = setupQueryRouting({
      ledgerList: { rows: [], total: 0 },
    });
    await listLedgerForAdmin('u-1', { filter: 'recharge', page: 1, pageSize: 50 });

    // 找到 list SQL（含 SELECT id, type, ...）
    const listCall = calls.find((c) =>
      c.sql.startsWith('SELECT id, type, amount, credits, balance, description'),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.sql).toContain('type IN (');
    // params 应包含全部 5 种 type
    expect(listCall!.params).toEqual(
      expect.arrayContaining([
        'PURCHASE_CREDIT',
        'ADMIN_CREDIT',
        'QUOTA_CREDIT',
        'REFUND_CREDIT',
        'REFUND',
      ]),
    );
  });

  it('filter=consume emits SQL with type = TASK_DEBIT', async () => {
    const { calls } = setupQueryRouting({
      ledgerList: { rows: [], total: 0 },
    });
    await listLedgerForAdmin('u-1', { filter: 'consume', page: 1, pageSize: 50 });
    const listCall = calls.find((c) =>
      c.sql.startsWith('SELECT id, type, amount, credits, balance, description'),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.sql).toContain("type = 'TASK_DEBIT'");
  });

  it('filter absent (all) emits no type filter', async () => {
    const { calls } = setupQueryRouting({
      ledgerList: { rows: [], total: 0 },
    });
    await listLedgerForAdmin('u-1', { filter: '', page: 1, pageSize: 50 });
    const listCall = calls.find((c) =>
      c.sql.startsWith('SELECT id, type, amount, credits, balance, description'),
    );
    expect(listCall).toBeDefined();
    expect(listCall!.sql).not.toContain('type IN');
    expect(listCall!.sql).not.toContain("type = 'TASK_DEBIT'");
  });
});

// ============================================================
// listUserFilms — 成片与镜头组产物边界
// ============================================================

describe('listUserFilms — episode-film boundary', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('does not expose a completed render without an episode identity', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{
        id: 'legacy-unscoped-job',
        type: 'CONCAT',
        input: { filmMeta: { projectId: 'project-1' } },
        result: {
          outputUrl: 'sf-asset://legacy-unscoped-job.mp4',
          meta: { localKey: 'legacy-unscoped-job.mp4' },
        },
        created_at: new Date('2026-07-22T00:00:00Z'),
      }],
      rowCount: 1,
    });

    await expect(listUserFilms('user-1')).resolves.toEqual([]);
  });

  it('does not expose a render that covers fewer shots than the completed episode', async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes('FROM render_jobs')) {
        return {
          rows: [
            {
              id: 'group-job',
              type: 'CHAIN_COMPILE',
              input: {
                filmMeta: {
                  projectId: 'project-1',
                  episodeId: 'episode-1',
                  // 任务只覆盖整集 5 镜中的 2 镜，属于中间片段。
                  shotIds: ['shot-1', 'shot-2'],
                  shotCount: 2,
                },
              },
              result: {
                outputUrl: 'sf-asset://group-job.mp4',
                meta: { localKey: 'group-job.mp4' },
              },
              created_at: new Date('2026-07-22T00:00:00Z'),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM shots')) {
        return {
          rows: [{ episodeId: 'episode-1', total: 5, completed: 5 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(listUserFilms('user-1')).resolves.toEqual([]);
  });

  it('keeps an explicitly scoped group out even when it includes every shotId', async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes('FROM render_jobs')) {
        return {
          rows: [
            {
              id: 'full-scoped-job',
              type: 'CHAIN_COMPILE',
              input: {
                filmMeta: {
                  projectId: 'project-1',
                  episodeId: 'episode-1',
                  // 显式 shotIds 是 C/S 镜头组标记；覆盖全体也不能重复进入成片库。
                  shotIds: ['shot-1', 'shot-2'],
                  shotCount: 2,
                },
              },
              result: {
                outputUrl: 'sf-asset://full-scoped-job.mp4',
                meta: { localKey: 'full-scoped-job.mp4' },
              },
              created_at: new Date('2026-07-22T00:00:00Z'),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM shots')) {
        return {
          rows: [{ episodeId: 'episode-1', total: 2, completed: 2 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const films = await listUserFilms('user-1');

    expect(films).toEqual([]);
  });

  it('preserves produced films regardless of current shot status; hides only count-mismatched stale films', async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      if (sql.includes('FROM render_jobs')) {
        const makeFilmRow = (id: string, episodeId: string, shotCount?: number) => ({
          id,
          type: 'CHAIN_COMPILE',
          input: {
            filmMeta: {
              projectId: 'project-1',
              episodeId,
              ...(shotCount !== undefined ? { shotCount } : {}),
            },
          },
          result: {
            outputUrl: `sf-asset://${id}.mp4`,
            meta: { localKey: `${id}.mp4` },
          },
          created_at: new Date('2026-07-22T00:00:00Z'),
        });
        return {
          rows: [
            // 已产出整集成片，shotCount 与当前总数一致 → 即使镜头被重跑 reset 成
            // 4/5 未完成也必须保留展示（回归：重跑后成片库全没了，4928 连续丢失）。
            makeFilmRow('preserved-film', 'episode-reset', 5),
            // 旧成片只覆盖 2 镜，分集后来扩展到 5 镜 → shotCount !== total → 隐藏（防冒充）。
            makeFilmRow('stale-film', 'episode-grew', 2),
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('FROM shots')) {
        return {
          rows: [
            // 重跑 reset 后 4/5 完成（complete:false），但成片仍展示。
            { episodeId: 'episode-reset', total: 5, completed: 4 },
            // 分集扩展并全完成；旧成片只覆盖 2 镜 → count 不匹配 → 隐藏。
            { episodeId: 'episode-grew', total: 5, completed: 5 },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const films = await listUserFilms('user-1');

    expect(films.map((film) => film.id)).toEqual(['preserved-film']);
  });
});

describe('updateUserConcurrency', () => {
  it('UPDATE users 置 maxConcurrent 并返回新值', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    vi.mocked(query).mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('UPDATE users')) {
        return { rows: [{ id: 'u-1', maxConcurrent: 12 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const r = await updateUserConcurrency('u-1', 12);
    expect(r).toEqual({ id: 'u-1', maxConcurrent: 12 });

    const upd = calls.find((c) => c.sql.includes('UPDATE users'))!;
    expect(upd.sql).toContain('"maxConcurrent" = $2');
    expect(upd.sql).toContain('"updatedAt" = NOW()');
    expect(upd.sql).toContain('WHERE id = $1');
    expect(upd.params).toEqual(['u-1', 12]);
  });

  it('用户不存在返回 null', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const r = await updateUserConcurrency('nope', 5);
    expect(r).toBeNull();
  });
});
