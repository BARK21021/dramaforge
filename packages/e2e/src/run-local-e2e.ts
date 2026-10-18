// Start the current production web build against the isolated E2E database,
// run both mutating harnesses, and always stop the temporary web process.

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertIsolatedE2eBucket,
  assertIsolatedE2eDatabaseUrl,
  loadEnvFile,
  requireEnv,
} from './lib/env.js';
import { withDeadline } from './lib/deadline.js';
import { sleep } from './lib/wait.js';

loadEnvFile();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const nextCli = resolve(repoRoot, 'packages/web/node_modules/next/dist/bin/next');
const tsxCli = resolve(repoRoot, 'packages/e2e/node_modules/tsx/dist/cli.mjs');
const filmScript = resolve(here, 'film-export-e2e.ts');
const upgradeScript = resolve(here, 'force-upgrade-e2e.ts');

function runScript(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, script], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${script} exited with code=${String(code)} signal=${String(signal)}`));
    });
  });
}

async function waitForWeb(apiBase: string, child: ChildProcess): Promise<void> {
  await withDeadline(async (signal) => {
    while (!signal.aborted) {
      if (child.exitCode !== null) {
        throw new Error(`temporary web server exited with code ${child.exitCode}`);
      }
      try {
        const response = await fetch(`${apiBase}/api/health`, { signal });
        if (response.ok) return;
      } catch (error) {
        if (signal.aborted) throw error;
      }
      await sleep(200);
    }
    throw signal.reason;
  }, { timeoutMs: 20_000, label: 'temporary web startup' });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  try {
    await withDeadline(
      async () => new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())),
      { timeoutMs: 5_000, label: 'temporary web shutdown' },
    );
  } catch {
    child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  if (process.env.E2E_ALLOW_MUTATION !== '1') {
    throw new Error('Set E2E_ALLOW_MUTATION=1 before starting the local E2E runner');
  }
  const apiBase = process.env.E2E_API_BASE ?? 'http://localhost:3002';
  const api = new URL(apiBase);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(api.hostname)) {
    throw new Error(`temporary E2E web must use loopback, received ${api.hostname}`);
  }
  const databaseUrl = requireEnv('E2E_DATABASE_URL');
  const bucket = requireEnv('E2E_MINIO_BUCKET');
  assertIsolatedE2eDatabaseUrl(databaseUrl);
  assertIsolatedE2eBucket(bucket);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    MINIO_BUCKET: bucket,
    NEXTAUTH_URL: apiBase,
    E2E_API_BASE: apiBase,
  };
  const port = api.port || '3002';
  const web = spawn(
    process.execPath,
    [nextCli, 'start', resolve(repoRoot, 'packages/web'), '-H', api.hostname, '-p', port],
    {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    },
  );

  try {
    await waitForWeb(apiBase, web);
    await runScript(filmScript, env);
    await runScript(upgradeScript, env);
  } finally {
    await stopChild(web);
  }
}

main().catch((error) => {
  console.error('[e2e-runner] fatal:', error);
  process.exitCode = 1;
});
