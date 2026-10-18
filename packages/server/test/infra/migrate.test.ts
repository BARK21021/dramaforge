import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runMigrations,
  discoverMigrations,
  computePending,
  type MigrationFile,
} from '../../src/infra/migrate';
import type { QueryFn } from '../../src/infra/pg';

/**
 * mock queryFn：模拟 _migrations 表的 INSERT/SELECT 行为，
 * 记录所有调用供断言。applied Set 在同一 mock 实例的多次调用间持久
 * （模拟 DB 状态），用于验证幂等性。
 */
function makeMockQueryFn(): {
  qf: QueryFn;
  applied: Set<string>;
  calls: { sql: string; params?: unknown[] }[];
} {
  const applied = new Set<string>();
  const calls: { sql: string; params?: unknown[] }[] = [];
  const qf: QueryFn = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT INTO _migrations')) {
        applied.add(params![0] as string);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT name FROM _migrations')) {
        return {
          rows: [...applied].sort().map((name) => ({ name })),
          rowCount: applied.size,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { qf, applied, calls };
}

describe('computePending', () => {
  const files: MigrationFile[] = [
    { name: '0001-a.sql', sql: '-- a' },
    { name: '0002-b.sql', sql: '-- b' },
    { name: '0003-c.sql', sql: '-- c' },
  ];

  it('returns all files when none applied', () => {
    expect(computePending([], files)).toEqual(files);
  });

  it('skips applied files, preserves order', () => {
    expect(computePending(['0001-a.sql'], files)).toEqual([files[1], files[2]]);
    expect(computePending(['0002-b.sql'], files)).toEqual([files[0], files[2]]);
  });

  it('returns empty when all applied', () => {
    expect(computePending(['0001-a.sql', '0002-b.sql', '0003-c.sql'], files)).toEqual([]);
  });

  it('ignores applied names not present in files', () => {
    expect(computePending(['9999-x.sql'], files)).toEqual(files);
  });
});

describe('discoverMigrations (real migrations dir)', () => {
  it('lists .sql files sorted by name, includes 0001-init.sql', async () => {
    const files = await discoverMigrations();
    const names = files.map((f) => f.name);
    expect(names).toContain('0001-init.sql');
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('reads 0001-init.sql contents with render_jobs table', async () => {
    const files = await discoverMigrations();
    const init = files.find((f) => f.name === '0001-init.sql');
    expect(init).toBeDefined();
    expect(init!.sql).toContain('CREATE TABLE');
    expect(init!.sql).toContain('render_jobs');
    expect(init!.sql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(init!.sql).toContain('claim_token TEXT');
    expect(init!.sql).toContain('heartbeat_at TIMESTAMPTZ');
  });

  it('includes idempotent 0003 render lease columns migration', async () => {
    const files = await discoverMigrations();
    const lease = files.find((f) => f.name === '0003-render-job-leases.sql');
    expect(lease).toBeDefined();
    expect(lease!.sql).toContain('ADD COLUMN IF NOT EXISTS claim_token TEXT');
    expect(lease!.sql).toContain('ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ');
  });

  it('includes 0006 task lookup and platform multi-key index fixes', async () => {
    const files = await discoverMigrations();
    // 0005 已用于平台密钥表，契约索引必须使用独立序号以保证部署追踪稳定。
    const contractIndexes = files.find((f) => f.name === '0006-contract-indexes.sql');

    expect(contractIndexes).toBeDefined();
    expect(contractIndexes!.sql).toContain('idx_render_jobs_task_user_created');
    expect(contractIndexes!.sql).toContain('idx_render_jobs_user_created');
    expect(contractIndexes!.sql).toContain('ON render_jobs(user_id, created_at DESC)');
    expect(contractIndexes!.sql).toContain("CASE WHEN label = 'env' THEN \"apiKey\"");
  });
});

describe('runMigrations (mock pg)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `sf-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, '0001-a.sql'), 'CREATE TABLE a ();');
    writeFileSync(join(tmpDir, '0002-b.sql'), 'CREATE TABLE b ();');
    writeFileSync(join(tmpDir, '0003-c.sql'), 'CREATE TABLE c ();');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs all pending migrations in order on first call', async () => {
    const { qf, applied, calls } = makeMockQueryFn();
    const executed = await runMigrations({ queryFn: qf, migrationsDir: tmpDir });

    expect(executed).toEqual(['0001-a.sql', '0002-b.sql', '0003-c.sql']);
    expect([...applied].sort()).toEqual(['0001-a.sql', '0002-b.sql', '0003-c.sql']);

    // each migration wrapped in BEGIN/SQL/INSERT/COMMIT
    expect(calls.filter((c) => c.sql === 'BEGIN').length).toBe(3);
    expect(calls.filter((c) => c.sql === 'COMMIT').length).toBe(3);
    expect(calls.filter((c) => c.sql === 'ROLLBACK').length).toBe(0);

    // verify INSERT calls recorded each migration name in order
    const inserts = calls.filter((c) => c.sql.startsWith('INSERT INTO _migrations'));
    expect(inserts.map((c) => c.params![0])).toEqual([
      '0001-a.sql',
      '0002-b.sql',
      '0003-c.sql',
    ]);
  });

  it('skips already-applied migrations on second call (idempotent)', async () => {
    const { qf, calls } = makeMockQueryFn();

    const first = await runMigrations({ queryFn: qf, migrationsDir: tmpDir });
    expect(first).toEqual(['0001-a.sql', '0002-b.sql', '0003-c.sql']);

    const beginAfterFirst = calls.filter((c) => c.sql === 'BEGIN').length;

    const second = await runMigrations({ queryFn: qf, migrationsDir: tmpDir });
    expect(second).toEqual([]);

    // no new BEGIN/COMMIT for migrations on second call
    const beginAfterSecond = calls.filter((c) => c.sql === 'BEGIN').length;
    expect(beginAfterSecond).toBe(beginAfterFirst);
  });

  it('wraps each migration in its own transaction (per-file BEGIN/COMMIT)', async () => {
    const { qf, calls } = makeMockQueryFn();
    await runMigrations({ queryFn: qf, migrationsDir: tmpDir });

    // extract just the structural calls (BEGIN/COMMIT/ROLLBACK) in order
    const structural = calls
      .filter((c) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(c.sql))
      .map((c) => c.sql);
    expect(structural).toEqual([
      'BEGIN',
      'COMMIT',
      'BEGIN',
      'COMMIT',
      'BEGIN',
      'COMMIT',
    ]);
  });

  it('rolls back and rethrows when a migration SQL fails, stops subsequent', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const qf: QueryFn = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql === 'CREATE TABLE b ();') throw new Error('syntax error in b');
        if (sql.startsWith('SELECT name FROM _migrations')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith('INSERT INTO _migrations')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    await expect(
      runMigrations({ queryFn: qf, migrationsDir: tmpDir }),
    ).rejects.toThrow('syntax error in b');

    // 0001 should have committed; 0002 should have rolled back; 0003 never started
    const structural = calls
      .filter((c) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(c.sql))
      .map((c) => c.sql);
    expect(structural).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);

    // 0003-c.sql SQL never executed
    expect(calls.some((c) => c.sql === 'CREATE TABLE c ();')).toBe(false);
  });

  it('creates the _migrations tracking table before querying it', async () => {
    const { qf, calls } = makeMockQueryFn();
    await runMigrations({ queryFn: qf, migrationsDir: tmpDir });

    const createIdx = calls.findIndex((c) =>
      c.sql.startsWith('CREATE TABLE IF NOT EXISTS _migrations'),
    );
    const selectIdx = calls.findIndex((c) =>
      c.sql.startsWith('SELECT name FROM _migrations'),
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(createIdx);
  });
});
