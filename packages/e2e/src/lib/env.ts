// Env loader for the e2e harness.
//
// Loads the repo-root `.env` (D:\dramaforge-cs\.env) into process.env if it
// exists. Values already set in the environment take precedence (so `set -a;
// source .env; set +a` before running still works). This makes the e2e scripts
// runnable directly via `pnpm --filter @dramaforge/e2e film-export` without a
// separate source step.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the repo-root .env (packages/e2e/src/lib → ../../../../.env). */
const ENV_PATH = resolve(__dirname, '../../../../.env');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Load .env into process.env (does not override existing values). */
export function loadEnvFile(): void {
  if (!existsSync(ENV_PATH)) return;
  const content = readFileSync(ENV_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip an unquoted inline comment (`KEY=value # note`) while preserving
    // hashes inside quoted values.
    if (!value.startsWith('"') && !value.startsWith("'")) {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Read required env, throwing if missing. */
export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}. Run from repo root with .env loaded.`);
  return v;
}

/**
 * Verify DATABASE_URL resolves to an explicit loopback authority.
 *
 * node-postgres/pg-connection-string lets `?host=...` override the hostname in
 * the URI authority. Reject that syntax entirely so a URL which visibly says
 * `@localhost` cannot silently connect the mutating harness to a remote host.
 */
export function assertLocalDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Refusing E2E: DATABASE_URL is not a valid URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`Refusing E2E: unsupported DATABASE_URL protocol ${parsed.protocol}`);
  }
  for (const key of parsed.searchParams.keys()) {
    const normalized = key.trim().toLowerCase();
    if (normalized === 'host' || normalized === 'hostaddr') {
      throw new Error(`Refusing E2E: DATABASE_URL query parameter ${key} may override its host`);
    }
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Refusing E2E against non-local database host ${parsed.hostname}`);
  }
}

/** Require the mutating harness to use a visibly dedicated `_e2e` database. */
export function assertIsolatedE2eDatabaseUrl(databaseUrl: string): void {
  assertLocalDatabaseUrl(databaseUrl);
  const parsed = new URL(databaseUrl);
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('Refusing E2E: database name is not valid URL encoding');
  }
  if (!databaseName || databaseName.includes('/') || !databaseName.endsWith('_e2e')) {
    throw new Error(
      `Refusing E2E: database name must end with _e2e, received ${databaseName || '(empty)'}`,
    );
  }
}

/** Require a dedicated MinIO bucket instead of the application's normal bucket. */
export function assertIsolatedE2eBucket(bucket: string): void {
  if (!bucket.endsWith('-e2e')) {
    throw new Error(`Refusing E2E: MinIO bucket must end with -e2e, received ${bucket}`);
  }
}
