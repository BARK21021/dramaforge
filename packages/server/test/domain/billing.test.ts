// ============================================================
// ③ server/domain/billing — 单测
// ============================================================
//
// 覆盖：
//   - 纯函数 rules（yuanToCredits / rawYuanToCredits / normalizeBillableCredits / formatCredits）
//   - getBalance：返回余额 / 404 用户不存在 / unlimited ADMIN
//   - chargeCredits：充足余额扣费 / 余额不足 402 / ADMIN no-op / amount<=0 no-op / 写账本
//   - creditRefund：退款增加余额 / amount<=0 no-op / 写账本
//
// mock @server/infra 的 query/tx：用有状态 mock 模拟 users.credits 与 billing_ledger，
// 不依赖真实 DB。tx(fn) 直接以 mock QueryFn 调用 fn，验证事务内的 SQL 序列。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryFn, QueryResult } from '../../src/infra/pg';

// mock @server/infra（query / tx），具体实现由每个测试通过 setupStatefulInfra 注入
vi.mock('@server/infra', () => ({
  query: vi.fn(),
  tx: vi.fn(),
}));

// mock @shared/utils（genId），避免 vitest 无法解析 @shared/* 路径别名
vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'test-uuid-' + Math.random().toString(36).slice(2, 8)),
}));

// 导入被测函数 + mocked infra
import {
  getBalance,
  chargeCredits,
  chargeAggregatedTaskCost,
  refundTaskDebit,
  creditRefund,
  creditManual,
  BillingError,
  yuanToCredits,
  rawYuanToCredits,
  normalizeBillableCredits,
  formatCredits,
} from '../../src/domain/billing';
import { query, tx } from '@server/infra';

// ============================================================
// 有状态 mock infra
// ============================================================

interface MockUser {
  credits: number;
  role: string;
}

interface MockLedgerEntry {
  id: string;
  userId: string;
  taskId: string | null;
  type: string;
  amount: number;
  balance: number;
  credits: number;
  description: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface InfraState {
  users: Record<string, MockUser>;
  ledger: MockLedgerEntry[];
}

/**
 * 构造有状态 mock：模拟 users 表的 credits 读写 + billing_ledger 的 INSERT。
 * UPDATE 的条件 `credits >= $1` 由 mock 自行判定，模拟真实 DB 语义。
 */
function setupStatefulInfra(initialUsers: Record<string, MockUser>): {
  state: InfraState;
  calls: { sql: string; params?: unknown[] }[];
} {
  const state: InfraState = {
    users: JSON.parse(JSON.stringify(initialUsers)),
    ledger: [],
  };
  const calls: { sql: string; params?: unknown[] }[] = [];

  async function execQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    calls.push({ sql, params });

    // getBalance / chargeCredits 预检：SELECT credits, role FROM users WHERE id = $1
    if (sql.startsWith('SELECT credits, role FROM users')) {
      const userId = params![0] as string;
      const u = state.users[userId];
      if (!u) return { rows: [], rowCount: 0 };
      return { rows: [{ credits: u.credits, role: u.role }], rowCount: 1 };
    }

    // chargeCredits：条件扣减 UPDATE users SET credits = credits - $1 ... WHERE id = $2 AND credits >= $1 RETURNING credits
    if (sql.startsWith('UPDATE users SET credits = credits -')) {
      const amount = params![0] as number;
      const userId = params![1] as string;
      const u = state.users[userId];
      if (!u || u.credits < amount) return { rows: [], rowCount: 0 };
      u.credits -= amount;
      return { rows: [{ credits: u.credits }], rowCount: 1 };
    }

    // creditRefund：增加余额 UPDATE users SET credits = credits + $1 ... RETURNING credits
    if (sql.startsWith('UPDATE users SET credits = credits +')) {
      const amount = params![0] as number;
      const userId = params![1] as string;
      const u = state.users[userId];
      if (!u) return { rows: [], rowCount: 0 };
      u.credits += amount;
      return { rows: [{ credits: u.credits }], rowCount: 1 };
    }

    // billing_ledger INSERT
    if (sql.startsWith('INSERT INTO billing_ledger')) {
      const p = params ?? [];
      // 参数顺序与生产 SQL 一致：(id, userId, taskId, type, amount, balance, credits, description, metadata)
      // metadata 在生产代码里是 JSON.stringify 后的字符串；这里解析回来供幂等 SELECT 查询。
      const rawMeta = p[8];
      let parsedMeta: Record<string, unknown> | null = null;
      if (typeof rawMeta === 'string') {
        try {
          parsedMeta = JSON.parse(rawMeta) as Record<string, unknown>;
        } catch {
          parsedMeta = null;
        }
      } else if (rawMeta && typeof rawMeta === 'object') {
        parsedMeta = rawMeta as Record<string, unknown>;
      }
      state.ledger.push({
        id: p[0] as string,
        userId: p[1] as string,
        taskId: p[2] as string | null,
        type: p[3] as string,
        amount: p[4] as number,
        balance: p[5] as number,
        credits: p[6] as number,
        description: p[7] as string,
        metadata: parsedMeta,
        createdAt: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    // creditManual 幂等检查：SELECT id, amount, balance, credits, description, metadata, "createdAt"
    //   FROM billing_ledger WHERE "userId" = $1 AND type = 'PURCHASE_CREDIT'
    //   AND metadata->>'idempotencyKey' = $2 AND metadata->>'adminUserId' = $3 LIMIT 1
    if (
      sql.startsWith('SELECT id, amount, balance, credits, description, metadata, "createdAt"') &&
      sql.includes("metadata->>'idempotencyKey'")
    ) {
      const userId = params![0] as string;
      const idemKey = params![1] as string;
      const adminUserId = params![2] as string;
      const match = state.ledger.find(
        (e) =>
          e.userId === userId &&
          e.type === 'PURCHASE_CREDIT' &&
          e.metadata?.idempotencyKey === idemKey &&
          e.metadata?.adminUserId === adminUserId,
      );
      if (match) {
        return {
          rows: [
            {
              id: match.id,
              amount: match.amount,
              balance: match.balance,
              credits: match.credits,
              description: match.description,
              metadata: JSON.stringify(match.metadata ?? {}),
              createdAt: match.createdAt,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  const mockQFn: QueryFn = { query: execQuery };

  vi.mocked(query).mockImplementation(execQuery);
  vi.mocked(tx).mockImplementation(async (fn) => fn(mockQFn));

  return { state, calls };
}

// ============================================================
// 纯函数 rules
// ============================================================

describe('billing/rules (pure)', () => {
  describe('rawYuanToCredits', () => {
    it('applies markup and converts to credits (1 yuan = 12 credits)', () => {
      // 1 yuan × 1.2 / 0.1 = 12
      expect(rawYuanToCredits(1)).toBeCloseTo(12, 5);
      expect(rawYuanToCredits(10)).toBeCloseTo(120, 5);
    });

    it('returns 0 for non-positive or non-finite input', () => {
      expect(rawYuanToCredits(0)).toBe(0);
      expect(rawYuanToCredits(-5)).toBe(0);
      expect(rawYuanToCredits(Number.NaN)).toBe(0);
      expect(rawYuanToCredits(Number.POSITIVE_INFINITY)).toBe(0);
    });
  });

  describe('normalizeBillableCredits', () => {
    it('ceil rounds up to minimum 1 for positive input', () => {
      expect(normalizeBillableCredits(0.1)).toBe(1);
      expect(normalizeBillableCredits(1)).toBe(1);
      expect(normalizeBillableCredits(12.4)).toBe(13);
      expect(normalizeBillableCredits(100)).toBe(100);
    });

    it('returns 0 for non-positive or non-finite input', () => {
      expect(normalizeBillableCredits(0)).toBe(0);
      expect(normalizeBillableCredits(-3)).toBe(0);
      expect(normalizeBillableCredits(Number.NaN)).toBe(0);
    });
  });

  describe('yuanToCredits', () => {
    it('combines raw + normalize: 1 yuan = 12 credits', () => {
      expect(yuanToCredits(1)).toBe(12);
      expect(yuanToCredits(0.5)).toBe(6); // 0.5 × 1.2 / 0.1 = 6
    });

    it('returns 0 for non-positive', () => {
      expect(yuanToCredits(0)).toBe(0);
      expect(yuanToCredits(-1)).toBe(0);
    });
  });

  describe('formatCredits', () => {
    it('formats as ceil-min-1 string', () => {
      expect(formatCredits(12)).toBe('12');
      expect(formatCredits(12.9)).toBe('13');
      expect(formatCredits(0.5)).toBe('1');
    });
  });
});

// ============================================================
// getBalance
// ============================================================

describe('getBalance', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(tx).mockReset();
  });

  it('returns balance for existing FREE user', async () => {
    setupStatefulInfra({ 'u-free': { credits: 150, role: 'FREE' } });
    const b = await getBalance('u-free');
    expect(b.userId).toBe('u-free');
    expect(b.credits).toBe(150);
    expect(b.frozenCredits).toBe(0);
    expect(b.availableCredits).toBe(150);
    expect(b.unlimited).toBe(false);
  });

  it('marks ADMIN as unlimited', async () => {
    setupStatefulInfra({ 'u-admin': { credits: 0, role: 'ADMIN' } });
    const b = await getBalance('u-admin');
    expect(b.unlimited).toBe(true);
    expect(b.credits).toBe(0);
  });

  it('throws BillingError(404) when user not found', async () => {
    setupStatefulInfra({});
    await expect(getBalance('ghost')).rejects.toMatchObject({
      name: 'BillingError',
      statusCode: 404,
    });
  });

  it('emits SELECT credits, role FROM users WHERE id = $1', async () => {
    const { calls } = setupStatefulInfra({ 'u-1': { credits: 50, role: 'FREE' } });
    await getBalance('u-1');
    expect(calls.some((c) => c.sql.startsWith('SELECT credits, role FROM users'))).toBe(true);
  });
});

// ============================================================
// chargeCredits
// ============================================================

describe('chargeCredits', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(tx).mockReset();
  });

  it('deducts credits on sufficient balance and writes ledger in tx', async () => {
    const { state, calls } = setupStatefulInfra({ 'u-1': { credits: 100, role: 'FREE' } });

    const entry = await chargeCredits('u-1', 30, { taskId: 't-1', description: '剧本分析' });

    expect(state.users['u-1'].credits).toBe(70);
    expect(entry.type).toBe('TASK_DEBIT');
    expect(entry.amount).toBe(30);
    expect(entry.credits).toBe(-30);
    expect(entry.balance).toBe(70);
    expect(entry.taskId).toBe('t-1');
    expect(entry.description).toBe('剧本分析');

    // tx was used (atomic update + ledger insert)
    expect(vi.mocked(tx)).toHaveBeenCalledTimes(1);
    // inside tx: UPDATE ... RETURNING credits, then INSERT INTO billing_ledger
    const txCalls = calls.filter(
      (c) =>
        c.sql.startsWith('UPDATE users SET credits = credits -') ||
        c.sql.startsWith('INSERT INTO billing_ledger'),
    );
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0].sql).toContain('credits >= $1');
  });

  it('throws BillingError(402) on insufficient balance, no ledger written', async () => {
    const { state, calls } = setupStatefulInfra({ 'u-1': { credits: 10, role: 'FREE' } });

    await expect(
      chargeCredits('u-1', 50, { taskId: 't-2' }),
    ).rejects.toMatchObject({ name: 'BillingError', statusCode: 402 });

    // 余额未变
    expect(state.users['u-1'].credits).toBe(10);
    // 没写账本（tx 抛错，外部 query 的 INSERT 未触发）
    const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO billing_ledger'));
    expect(inserts).toHaveLength(0);
  });

  it('ADMIN user: no-op ledger, credits unchanged', async () => {
    const { state, calls } = setupStatefulInfra({ 'u-adm': { credits: 5, role: 'ADMIN' } });

    const entry = await chargeCredits('u-adm', 999, { taskId: 't-3' });

    expect(state.users['u-adm'].credits).toBe(5); // 未扣
    expect(entry.amount).toBe(0);
    expect(entry.credits).toBe(0);
    expect(entry.metadata).toMatchObject({ adminUnlimited: true, requestedAmount: 999 });
    // tx 未使用（no-op 走外部 query 写账本）
    expect(vi.mocked(tx)).not.toHaveBeenCalled();
  });

  it('amount <= 0: no-op ledger, credits unchanged', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 100, role: 'FREE' } });

    const entry = await chargeCredits('u-1', 0, { taskId: 't-4' });
    expect(state.users['u-1'].credits).toBe(100);
    expect(entry.amount).toBe(0);
    expect(entry.credits).toBe(0);
    expect(entry.metadata).toMatchObject({ noOp: true });
  });

  it('ceil-fractional amount to integer (0.5 -> 1 credit)', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 100, role: 'FREE' } });
    const entry = await chargeCredits('u-1', 0.5);
    expect(entry.amount).toBe(1);
    expect(state.users['u-1'].credits).toBe(99);
  });

  it('throws 404 when user not found', async () => {
    setupStatefulInfra({});
    await expect(chargeCredits('ghost', 10)).rejects.toMatchObject({
      name: 'BillingError',
      statusCode: 404,
    });
  });
});

describe('chargeAggregatedTaskCost', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(tx).mockReset();
  });

  it('aggregates raw costs and rounds only the whole task once', async () => {
    const calls: string[] = [];
    const execQuery = vi.fn(async (sql: string): Promise<QueryResult> => {
      calls.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT credits, role FROM users')) {
        return { rows: [{ credits: 99, role: 'FREE' }], rowCount: 1 };
      }
      if (sql.includes('FROM billing_ledger')) {
        return {
          rows: [{
            id: 'ledger-1',
            amount: 1,
            balance: 99,
            credits: -1,
            description: '镜头视频生成',
            metadata: { cost: 0.04, unitCosts: { '0': 0.04 } },
            createdAt: '2026-07-22T00:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const q: QueryFn = { query: execQuery };
    vi.mocked(tx).mockImplementation(async (fn) => fn(q));

    const entry = await chargeAggregatedTaskCost('u-1', 'render-1', '1', 0.04);

    // 每次单独结算会扣 1+1=2；汇总 0.08×12=0.96，只应累计扣 1。
    expect(entry.amount).toBe(1);
    expect(entry.metadata).toMatchObject({
      cost: 0.08,
      billedCredits: 1,
      billingMode: 'aggregate-video-task',
      unitCosts: { '0': 0.04, '1': 0.04 },
    });
    expect(calls.some((sql) => sql.startsWith('UPDATE users SET credits = credits -'))).toBe(false);
    expect(calls.some((sql) => sql.startsWith('UPDATE billing_ledger'))).toBe(true);
  });

  it('treats a repeated unit id as an idempotent retry', async () => {
    const calls: string[] = [];
    const execQuery = vi.fn(async (sql: string): Promise<QueryResult> => {
      calls.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT credits, role FROM users')) {
        return { rows: [{ credits: 99, role: 'FREE' }], rowCount: 1 };
      }
      return {
        rows: [{
          id: 'ledger-1', amount: 1, balance: 99, credits: -1,
          description: '镜头视频生成',
          metadata: { cost: 0.04, unitCosts: { '0': 0.04 } },
          createdAt: '2026-07-22T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn({ query: execQuery }));

    const entry = await chargeAggregatedTaskCost('u-1', 'render-1', '0', 0.04);

    expect(entry.amount).toBe(1);
    expect(calls.some((sql) => sql.startsWith('UPDATE users'))).toBe(false);
    expect(calls.some((sql) => sql.startsWith('UPDATE billing_ledger'))).toBe(false);
  });

  it('rejects a delayed settlement after the render job has failed', async () => {
    const calls: string[] = [];
    const execQuery = vi.fn(async (sql: string): Promise<QueryResult> => {
      calls.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      // 终态门必须按 task_id 查 render_jobs（billingTaskId = render_jobs.task_id，非主键 id）。
      // mock 仅在 SQL 用 task_id 时返回 FAILED；若误用主键 id（WHERE id）则查不到 →
      // renderStatus 恒 undefined → 409 不抛 → 迟到结算被扣费。此分支抓该回归。
      if (sql.startsWith('SELECT status FROM render_jobs') && sql.includes('task_id')) {
        return { rows: [{ status: 'FAILED' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn({ query: execQuery }));

    await expect(
      chargeAggregatedTaskCost('u-1', 'render-1', '0', 0.04),
    ).rejects.toMatchObject({ statusCode: 409 });

    // 终态门 SQL 必须按 task_id 查（防 P0-B：主键 id 查不到 → 失败任务迟到结算仍扣费）。
    expect(
      calls.some((sql) => sql.includes('SELECT status FROM render_jobs') && sql.includes('task_id')),
    ).toBe(true);
    // 终态检查发生在读用户和扣费之前，迟到的模型结果不会再扣积分。
    expect(calls.some((sql) => sql.startsWith('UPDATE users'))).toBe(false);
  });
});

describe('refundTaskDebit', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(tx).mockReset();
  });

  it('refunds the task debit exactly once', async () => {
    let balance = 21;
    let refundWritten = false;
    const execQuery = vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes("type = 'REFUND'")) {
        return refundWritten
          ? {
              rows: [{
                id: 'refund-1', amount: -179, balance: 200, credits: 179,
                description: '任务失败退款 (render-1)',
                metadata: { refundCredits: 179 },
                createdAt: '2026-07-23T00:00:00.000Z',
              }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("type = 'TASK_DEBIT'")) {
        return { rows: [{ amount: 179 }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE users SET credits = credits +')) {
        balance += Number(params?.[0] ?? 0);
        return { rows: [{ credits: balance }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO billing_ledger')) {
        refundWritten = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn({ query: execQuery }));

    const first = await refundTaskDebit('u-1', 'render-1');
    const second = await refundTaskDebit('u-1', 'render-1');

    expect(first).toMatchObject({ amount: -179, credits: 179, balance: 200 });
    expect(second).toMatchObject({ id: 'refund-1', credits: 179 });
    // 第二次命中已有 REFUND，不会再次增加余额。
    expect(balance).toBe(200);
  });

  it('returns null when the task has no debit yet', async () => {
    const execQuery = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn({ query: execQuery }));

    expect(await refundTaskDebit('u-1', 'render-1')).toBeNull();
    expect(execQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE users'))).toBe(false);
  });
});

// ============================================================
// creditRefund
// ============================================================

describe('creditRefund', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(tx).mockReset();
  });

  it('refunds credits and writes REFUND ledger entry with taskId', async () => {
    const { state, calls } = setupStatefulInfra({ 'u-1': { credits: 20, role: 'FREE' } });

    const entry = await creditRefund('u-1', 30, 'task-xyz');

    expect(state.users['u-1'].credits).toBe(50);
    expect(entry.type).toBe('REFUND');
    expect(entry.amount).toBe(-30); // 负=充值
    expect(entry.credits).toBe(30); // 正=增加
    expect(entry.balance).toBe(50);
    expect(entry.taskId).toBe('task-xyz');
    expect(entry.description).toContain('task-xyz');

    expect(vi.mocked(tx)).toHaveBeenCalledTimes(1);
    const txCalls = calls.filter(
      (c) =>
        c.sql.startsWith('UPDATE users SET credits = credits +') ||
        c.sql.startsWith('INSERT INTO billing_ledger'),
    );
    expect(txCalls).toHaveLength(2);
  });

  it('amount <= 0: no-op ledger, credits unchanged', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 20, role: 'FREE' } });

    const entry = await creditRefund('u-1', 0, 't-1');
    expect(state.users['u-1'].credits).toBe(20);
    expect(entry.amount).toBe(0);
    expect(entry.credits).toBe(0);
    expect(entry.metadata).toMatchObject({ noOp: true });
  });

  it('throws 404 when user not found', async () => {
    setupStatefulInfra({});
    await expect(creditRefund('ghost', 10, 't-1')).rejects.toMatchObject({
      name: 'BillingError',
      statusCode: 404,
    });
  });

  it('taskId defaults to null when omitted', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 5, role: 'FREE' } });
    const entry = await creditRefund('u-1', 10);
    expect(state.users['u-1'].credits).toBe(15);
    expect(entry.taskId).toBeNull();
  });
});

// ============================================================
// creditManual (admin 手动充值 + 幂等)
// ============================================================

describe('creditManual', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(tx).mockReset();
  });

  it('credits balance and writes PURCHASE_CREDIT ledger entry (admin manual happy path)', async () => {
    const { state, calls } = setupStatefulInfra({ 'u-1': { credits: 20, role: 'FREE' } });

    const entry = await creditManual('u-1', 100, '管理员充值 ¥10', {
      adminUserId: 'adm-1',
      note: '现金',
    });

    expect(state.users['u-1'].credits).toBe(120);
    expect(entry.userId).toBe('u-1');
    expect(entry.taskId).toBeNull();
    expect(entry.type).toBe('PURCHASE_CREDIT');
    expect(entry.amount).toBe(-100); // 负=充值
    expect(entry.credits).toBe(100); // 正=增加
    expect(entry.balance).toBe(120);
    expect(entry.description).toBe('管理员充值 ¥10');
    expect(entry.metadata).toMatchObject({
      source: 'admin_manual',
      rechargeCredits: 100,
      adminUserId: 'adm-1',
      note: '现金',
    });

    // tx 用了一次（UPDATE + INSERT 同事务）
    expect(vi.mocked(tx)).toHaveBeenCalledTimes(1);
    const txCalls = calls.filter(
      (c) =>
        c.sql.startsWith('UPDATE users SET credits = credits +') ||
        c.sql.startsWith('INSERT INTO billing_ledger'),
    );
    expect(txCalls).toHaveLength(2);
  });

  it('credits <= 0: writes no-op ledger, balance unchanged', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 50, role: 'FREE' } });

    const entry = await creditManual('u-1', 0, '空', { adminUserId: 'adm-1' });

    expect(state.users['u-1'].credits).toBe(50);
    expect(entry.amount).toBe(0);
    expect(entry.credits).toBe(0);
    expect(entry.metadata).toMatchObject({ noOp: true, source: 'admin_manual' });
    expect(vi.mocked(tx)).not.toHaveBeenCalled();
  });

  it('throws BillingError(404) when user not found', async () => {
    setupStatefulInfra({});
    await expect(creditManual('ghost', 10, 'desc')).rejects.toMatchObject({
      name: 'BillingError',
      statusCode: 404,
    });
  });

  it('ceil-fractional credits to integer (0.5 -> 1 credit)', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 0, role: 'FREE' } });
    const entry = await creditManual('u-1', 0.5, 'desc');
    expect(entry.credits).toBe(1);
    expect(state.users['u-1'].credits).toBe(1);
  });

  // --------------------------------------------------------
  // 幂等（idempotencyKey）—— dramaforge 增量（app1 无）
  // --------------------------------------------------------

  it('idempotency: same idempotencyKey returns cached entry, no double-credit, no second ledger write', async () => {
    const { state, calls } = setupStatefulInfra({ 'u-1': { credits: 0, role: 'FREE' } });

    // 第一次：正常写入
    const entry1 = await creditManual('u-1', 100, '管理员充值 ¥10', {
      adminUserId: 'adm-1',
      idempotencyKey: 'idem-key-1',
    });
    expect(state.users['u-1'].credits).toBe(100);
    expect(entry1.metadata).toMatchObject({ idempotencyKey: 'idem-key-1' });

    const txCountAfterFirst = vi.mocked(tx).mock.calls.length;
    const insertCountAfterFirst = calls.filter((c) =>
      c.sql.startsWith('INSERT INTO billing_ledger'),
    ).length;

    // 第二次：相同 idempotencyKey + 相同 adminUserId → 命中缓存，不双扣
    const entry2 = await creditManual('u-1', 100, '管理员充值 ¥10', {
      adminUserId: 'adm-1',
      idempotencyKey: 'idem-key-1',
    });

    // 余额没变（关键：不双扣）
    expect(state.users['u-1'].credits).toBe(100);
    // 返回的是同一个历史 ledger id
    expect(entry2.id).toBe(entry1.id);
    expect(entry2.balance).toBe(entry1.balance);
    expect(entry2.credits).toBe(entry1.credits);
    expect(entry2.amount).toBe(entry1.amount);
    // 第二次没进 tx（没写新账本）
    expect(vi.mocked(tx).mock.calls.length).toBe(txCountAfterFirst);
    expect(
      calls.filter((c) => c.sql.startsWith('INSERT INTO billing_ledger')).length,
    ).toBe(insertCountAfterFirst);
    // 校验确实发出了带 metadata->>'idempotencyKey' 的幂等 SELECT
    expect(calls.some((c) => c.sql.includes("metadata->>'idempotencyKey'"))).toBe(true);
  });

  it('idempotency: different idempotencyKey credits normally (no false dedup)', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 0, role: 'FREE' } });

    await creditManual('u-1', 100, 'desc1', {
      adminUserId: 'adm-1',
      idempotencyKey: 'key-A',
    });
    await creditManual('u-1', 100, 'desc2', {
      adminUserId: 'adm-1',
      idempotencyKey: 'key-B',
    });

    expect(state.users['u-1'].credits).toBe(200); // 两次都加了
  });

  it('idempotency: same idempotencyKey but different adminUserId credits normally (composite key)', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 0, role: 'FREE' } });

    await creditManual('u-1', 100, 'desc1', {
      adminUserId: 'adm-1',
      idempotencyKey: 'shared-key',
    });
    await creditManual('u-1', 100, 'desc2', {
      adminUserId: 'adm-2',
      idempotencyKey: 'shared-key',
    });

    // (userId, idempotencyKey, adminUserId) 是复合维度；不同 admin 各记一次
    expect(state.users['u-1'].credits).toBe(200);
  });

  it('no idempotencyKey: always credits (backwards-compat with app1 path)', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 0, role: 'FREE' } });

    await creditManual('u-1', 100, 'desc1', { adminUserId: 'adm-1' });
    await creditManual('u-1', 100, 'desc2', { adminUserId: 'adm-1' });

    expect(state.users['u-1'].credits).toBe(200); // 无 idempotencyKey 不去重
  });

  it('idempotency: empty/whitespace idempotencyKey treated as absent', async () => {
    const { state } = setupStatefulInfra({ 'u-1': { credits: 0, role: 'FREE' } });

    await creditManual('u-1', 100, 'desc1', {
      adminUserId: 'adm-1',
      idempotencyKey: '   ',
    });
    await creditManual('u-1', 100, 'desc2', {
      adminUserId: 'adm-1',
      idempotencyKey: '',
    });

    // 空/空白 idempotencyKey 不触发去重，两次都加
    expect(state.users['u-1'].credits).toBe(200);
  });
});
