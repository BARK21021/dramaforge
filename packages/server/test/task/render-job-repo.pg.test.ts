import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  claimNext,
  createOrReuseChainGenerate,
  markResult,
  markRunning,
} from '../../src/task/render-job-repo';
import { endPool } from '../../src/infra/pg';
import { _resetEnvCacheForTests } from '../../src/infra/env';

const databaseUrl = process.env.DATABASE_URL;
const mutationEnabled = process.env.E2E_ALLOW_MUTATION === '1';
const runPg = mutationEnabled && Boolean(databaseUrl);
const describePg = runPg ? describe : describe.skip;

describePg('render-job repo real PostgreSQL concurrency', () => {
  const userId = `lease-pg-${globalThis.crypto.randomUUID()}`;
  let admin: Pool;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      throw new Error('render-job PG integration test only permits a localhost DATABASE_URL');
    }

    // pg.ts validates the complete server environment before creating its pool.
    process.env.REDIS_URL ||= 'redis://localhost:6379';
    process.env.MINIO_ENDPOINT ||= 'localhost:9000';
    process.env.MINIO_ACCESS_KEY ||= 'integration-test';
    process.env.MINIO_SECRET_KEY ||= 'integration-test';
    process.env.MINIO_BUCKET ||= 'integration-test';
    process.env.NEXTAUTH_SECRET ||= 'integration-test';
    process.env.NEXTAUTH_URL ||= 'http://localhost:3000';
    _resetEnvCacheForTests();

    admin = new Pool({ connectionString: databaseUrl });
    await admin.query('ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS claim_token TEXT');
    await admin.query('ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ');
  });

  afterEach(async () => {
    await admin.query('DELETE FROM render_jobs WHERE user_id=$1', [userId]);
  });

  afterAll(async () => {
    await endPool();
    await admin.end();
  });

  async function insertPending(id: string): Promise<void> {
    await admin.query(
      `INSERT INTO render_jobs (id, task_id, user_id, type, input, status)
       VALUES ($1, $2, $3, 'CONCAT', '{"clips":[]}'::jsonb, 'PENDING')`,
      [id, `task-${id}`, userId],
    );
  }

  it('allows only one of two concurrent claims to take one PENDING row', async () => {
    const id = `job-${globalThis.crypto.randomUUID()}`;
    await insertPending(id);

    const claims = await Promise.all([
      claimNext(userId, 'machine-a'),
      claimNext(userId, 'machine-b'),
    ]);

    const won = claims.filter((job) => job !== null);
    expect(won).toHaveLength(1);
    expect(won[0]!.id).toBe(id);
    expect(won[0]!.claimToken).toBeTruthy();
  }, 15_000);

  it('creates only one scoped CHAIN_COMPILE row under concurrent dispatches', async () => {
    const episodeId = `episode-${globalThis.crypto.randomUUID()}`;
    const input = {
      groupResults: [{ url: '', shotIds: ['shot-1'] }],
      filmMeta: {
        projectId: 'project-concurrency',
        episodeId,
        shotIds: ['shot-1'],
      },
    };

    const [first, second] = await Promise.all([
      createOrReuseChainGenerate('task-a', userId, input),
      createOrReuseChainGenerate('task-b', userId, input),
    ]);

    expect(first.job.id).toBe(second.job.id);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    // 复用方必须继承胜出任务的 taskId，才能恢复同一条 SSE/轮询生命周期。
    expect(first.job.taskId).toBe(second.job.taskId);
    const rows = await admin.query(
      `SELECT id FROM render_jobs
        WHERE user_id=$1 AND input #>> '{filmMeta,episodeId}'=$2`,
      [userId, episodeId],
    );
    expect(rows.rowCount).toBe(1);
  }, 15_000);

  it('rejects an old token after the same machine reclaims a stale lease', async () => {
    const id = `job-${globalThis.crypto.randomUUID()}`;
    await insertPending(id);

    const first = await claimNext(userId, 'machine-shared');
    expect(first?.claimToken).toBeTruthy();
    await admin.query(
      `UPDATE render_jobs
          SET claimed_at=now() - interval '10 minutes',
              heartbeat_at=now() - interval '10 minutes'
        WHERE id=$1`,
      [id],
    );

    const second = await claimNext(userId, 'machine-shared');
    expect(second?.id).toBe(id);
    expect(second?.claimToken).toBeTruthy();
    expect(second!.claimToken).not.toBe(first!.claimToken);

    expect(await markRunning(
      id, userId, 'machine-shared', first!.claimToken!,
    )).toBeNull();
    expect(await markRunning(
      id, userId, 'machine-shared', second!.claimToken!,
    )).not.toBeNull();

    const staleResult = await markResult(
      id,
      userId,
      'machine-shared',
      first!.claimToken!,
      { outputUrl: 'sf-asset://stale.mp4' },
    );
    expect(staleResult.outcome).toBe('rejected');

    const currentResult = await markResult(
      id,
      userId,
      'machine-shared',
      second!.claimToken!,
      { outputUrl: 'sf-asset://current.mp4' },
    );
    expect(currentResult.outcome).toBe('applied');
  }, 15_000);
});
