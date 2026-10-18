// PostgreSQL helpers for the e2e harness.
//
// Talks directly to the dockerized `dramaforge-postgres` (localhost:5432) so the
// harness can:
//   1. Seed a test user (FK target for render_jobs.user_id).
//   2. INSERT a PENDING render_job row that simulates a dispatch (bypassing
//      /api/render/dispatch which requires a NextAuth session).
//   3. Poll the render_job status until COMPLETED/FAILED.
//   4. Set/restore system_configs.CLIENT_VERSIONS_MANIFEST for force_upgrade.
//
// Every run uses unique e2e-scoped ids and removes the rows it created.

import { Pool, type PoolClient } from 'pg';

type ManifestDb = Pool | PoolClient;
const MANIFEST_KEY = 'CLIENT_VERSIONS_MANIFEST';
const MANIFEST_LOCK_NAMESPACE = 1_397_115_070;
const MANIFEST_LOCK_ID = 1;

export interface DbConfig {
  connectionString: string;
}

export function makePool(cfg: DbConfig): Pool {
  return new Pool({
    connectionString: cfg.connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
}

export const E2E_USER_PASSWORD = 'dramaforge-e2e-password';

// bcryptjs hash of E2E_USER_PASSWORD. Fixed so the harness is deterministic
// and does not need bcrypt as an additional runtime dependency.
const E2E_PASSWORD_HASH = '$2a$10$5zd0UU96n1IhiPE7p781wOXToiugWLFR7GEoMvN2lpBX0J/zNvc6u';

/** Seed the unique user for this E2E run. */
export async function seedE2eUser(
  pool: Pool,
  userId: string,
  login: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, "passwordHash", role, credits, provider)
     VALUES ($1, $2, $3, 'FREE', 100, 'CREDENTIALS')
     ON CONFLICT (id) DO UPDATE
       SET email=EXCLUDED.email,
           "passwordHash"=EXCLUDED."passwordHash"`,
    [userId, login, E2E_PASSWORD_HASH],
  );
}

/** Insert a PENDING CONCAT render_job with the given input JSON. Idempotent on id. */
export async function seedConcatRenderJob(
  pool: Pool,
  jobId: string,
  userId: string,
  input: { clips: { url: string; durationSec?: number }[] },
): Promise<void> {
  await pool.query(
    `INSERT INTO render_jobs (id, task_id, user_id, type, input, status)
     VALUES ($1, 'e2e-task-1', $2, 'CONCAT', $3::jsonb, 'PENDING')
     ON CONFLICT (id) DO UPDATE
       SET status='PENDING',
           user_id=$2,
           claimed_by=NULL,
           claimed_at=NULL,
           completed_at=NULL,
           error=NULL,
           result=NULL,
           input=$3::jsonb`,
    [jobId, userId, JSON.stringify(input)],
  );
}

/** Remove only the rows created by this E2E run. */
export async function cleanupFilmExportRun(
  pool: Pool,
  jobId: string,
  userId: string,
): Promise<void> {
  await pool.query(`DELETE FROM render_jobs WHERE id=$1 AND user_id=$2`, [jobId, userId]);
  await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
}

export interface RenderJobStatus {
  status: string;
  result: unknown;
  error: string | null;
  claimedBy: string | null;
}

/** Read the current status/result/error of a render_job. */
export async function getRenderJob(
  pool: Pool,
  jobId: string,
): Promise<RenderJobStatus | null> {
  const res = await pool.query(
    `SELECT status, result, error, claimed_by FROM render_jobs WHERE id=$1`,
    [jobId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as {
    status: string;
    result: unknown;
    error: string | null;
    claimed_by: string | null;
  };
  return {
    status: row.status,
    result: row.result,
    error: row.error,
    claimedBy: row.claimed_by,
  };
}

/** Set system_configs.CLIENT_VERSIONS_MANIFEST to a JSON manifest. Idempotent. */
export async function setVersionsManifest(
  pool: ManifestDb,
  manifest: {
    minVersion: string;
    latestVersion: string;
    downloadUrls: { win: string; mac: string; linux: string };
    signature: string;
    sha256: string;
  },
): Promise<void> {
  const value = JSON.stringify(manifest);
  await pool.query(
    `INSERT INTO system_configs (id, key, value)
     VALUES ('e2e-versions', 'CLIENT_VERSIONS_MANIFEST', $1)
     ON CONFLICT (key) DO UPDATE SET value=$1`,
    [value],
  );
}

export interface VersionsManifestSnapshot {
  exists: boolean;
  value: string | null;
}

function encodeVersionsManifest(manifest: {
  minVersion: string;
  latestVersion: string;
  downloadUrls: { win: string; mac: string; linux: string };
  signature: string;
  sha256: string;
}): string {
  return JSON.stringify(manifest);
}

/** Snapshot row existence separately from its nullable value. */
export async function getVersionsManifestSnapshot(
  pool: ManifestDb,
): Promise<VersionsManifestSnapshot> {
  const result = await pool.query(
    `SELECT value FROM system_configs WHERE key=$1 LIMIT 1`,
    [MANIFEST_KEY],
  );
  if (result.rows.length === 0) return { exists: false, value: null };
  const value = (result.rows[0] as { value: unknown }).value;
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Unexpected ${MANIFEST_KEY} value type: ${typeof value}`);
  }
  return { exists: true, value };
}

function sameSnapshot(a: VersionsManifestSnapshot, b: VersionsManifestSnapshot): boolean {
  return a.exists === b.exists && a.value === b.value;
}

/** Atomically replace exactly the snapshotted state with this run's unique value. */
export async function installVersionsManifestForE2e(
  pool: ManifestDb,
  snapshot: VersionsManifestSnapshot,
  manifest: {
    minVersion: string;
    latestVersion: string;
    downloadUrls: { win: string; mac: string; linux: string };
    signature: string;
    sha256: string;
  },
): Promise<string> {
  const value = encodeVersionsManifest(manifest);
  const result = snapshot.exists
    ? await pool.query(
        `UPDATE system_configs
            SET value=$1
          WHERE key=$2 AND value IS NOT DISTINCT FROM $3
        RETURNING key`,
        [value, MANIFEST_KEY, snapshot.value],
      )
    : await pool.query(
        `INSERT INTO system_configs (id, key, value)
         VALUES ('e2e-versions', $1, $2)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [MANIFEST_KEY, value],
      );
  if (result.rowCount !== 1) {
    throw new Error(`${MANIFEST_KEY} changed concurrently; refusing E2E mutation`);
  }
  return value;
}

/**
 * Restore a prior snapshot without overwriting a concurrent writer.
 *
 * The current value must be either the unique value written by this E2E or the
 * already-restored snapshot. Any third value is treated as concurrent mutation
 * and left untouched while the test fails loudly.
 */
export async function restoreVersionsManifestSnapshot(
  pool: ManifestDb,
  snapshot: VersionsManifestSnapshot,
  expectedTestValue: string,
): Promise<void> {
  const current = await getVersionsManifestSnapshot(pool);
  if (sameSnapshot(current, snapshot)) return;
  if (!current.exists || current.value !== expectedTestValue) {
    throw new Error(`${MANIFEST_KEY} changed concurrently; refusing to overwrite it`);
  }

  if (!snapshot.exists) {
    const restored = await pool.query(
      `DELETE FROM system_configs
        WHERE key=$1 AND value IS NOT DISTINCT FROM $2
      RETURNING key`,
      [MANIFEST_KEY, expectedTestValue],
    );
    if (restored.rowCount !== 1) {
      const after = await getVersionsManifestSnapshot(pool);
      if (!sameSnapshot(after, snapshot)) {
        throw new Error(`${MANIFEST_KEY} changed concurrently during restore`);
      }
    }
    return;
  }
  const restored = await pool.query(
    `UPDATE system_configs
        SET value=$1
      WHERE key=$2 AND value IS NOT DISTINCT FROM $3
    RETURNING key`,
    [snapshot.value, MANIFEST_KEY, expectedTestValue],
  );
  if (restored.rowCount !== 1) {
    const after = await getVersionsManifestSnapshot(pool);
    if (!sameSnapshot(after, snapshot)) {
      throw new Error(`${MANIFEST_KEY} changed concurrently during restore`);
    }
  }
}

/** Hold a session advisory lock so two force-upgrade harnesses cannot overlap. */
export async function acquireVersionsManifestLock(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT pg_try_advisory_lock($1, $2) AS acquired`, [
      MANIFEST_LOCK_NAMESPACE,
      MANIFEST_LOCK_ID,
    ]);
    if ((result.rows[0] as { acquired?: unknown } | undefined)?.acquired !== true) {
      throw new Error('another force-upgrade E2E is already running');
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

/** Release the force-upgrade harness lock and its dedicated connection. */
export async function releaseVersionsManifestLock(client: PoolClient): Promise<void> {
  try {
    await client.query(`SELECT pg_advisory_unlock($1, $2)`, [
      MANIFEST_LOCK_NAMESPACE,
      MANIFEST_LOCK_ID,
    ]);
  } finally {
    client.release();
  }
}

/** Restore the manifest to a safe default (no client locked out). */
export async function resetVersionsManifest(pool: Pool): Promise<void> {
  await setVersionsManifest(pool, {
    minVersion: '0.0.0',
    latestVersion: '0.0.0',
    downloadUrls: { win: '', mac: '', linux: '' },
    signature: '',
    sha256: '',
  });
}

/** Run a fn inside a short-lived client; ensures the client is released. */
export async function withClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
