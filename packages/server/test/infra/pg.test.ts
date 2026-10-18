import { describe, it, expect } from 'vitest';
import { runInTransaction, type QueryFn } from '../../src/infra/pg';

/**
 * 构造 mock client，记录所有 query 调用的 SQL（按顺序）
 */
function makeMockClient(): { client: QueryFn; calls: string[] } {
  const calls: string[] = [];
  const client: QueryFn = {
    async query(sql: string): Promise<{ rows: unknown[]; rowCount: number | null }> {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

describe('runInTransaction', () => {
  it('calls BEGIN, body queries, then COMMIT on success', async () => {
    const { client, calls } = makeMockClient();
    const result = await runInTransaction(client, async (q) => {
      await q.query('SELECT 1');
      await q.query('SELECT 2');
      return 'done';
    });

    expect(result).toBe('done');
    expect(calls).toEqual(['BEGIN', 'SELECT 1', 'SELECT 2', 'COMMIT']);
  });

  it('calls BEGIN then ROLLBACK when body throws', async () => {
    const { client, calls } = makeMockClient();
    await expect(
      runInTransaction(client, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(calls).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('does not call COMMIT when body throws', async () => {
    const { client, calls } = makeMockClient();
    await expect(
      runInTransaction(client, async (q) => {
        await q.query('SELECT 1');
        throw new Error('mid-tx failure');
      }),
    ).rejects.toThrow('mid-tx failure');

    expect(calls).toEqual(['BEGIN', 'SELECT 1', 'ROLLBACK']);
    expect(calls).not.toContain('COMMIT');
  });

  it('rethrows the original error object (not a copy)', async () => {
    const { client } = makeMockClient();
    const original = new Error('specific');
    await expect(
      runInTransaction(client, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('still rethrows original error even if ROLLBACK itself fails', async () => {
    // mock client whose ROLLBACK throws
    const calls: string[] = [];
    const client: QueryFn = {
      async query(sql: string) {
        calls.push(sql);
        if (sql === 'ROLLBACK') throw new Error('rollback failed');
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(
      runInTransaction(client, async () => {
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
    expect(calls).toEqual(['BEGIN', 'ROLLBACK']);
  });
});
