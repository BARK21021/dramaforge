// force_upgrade E2E against an explicitly local stack.

import { randomUUID } from 'node:crypto';
import { assertIsolatedE2eDatabaseUrl, loadEnvFile, requireEnv } from './lib/env.js';
import {
  acquireVersionsManifestLock,
  getVersionsManifestSnapshot,
  installVersionsManifestForE2e,
  makePool,
  releaseVersionsManifestLock,
  restoreVersionsManifestSnapshot,
  type VersionsManifestSnapshot,
} from './lib/db.js';
import { pollFor } from './lib/wait.js';
import { withDeadline } from './lib/deadline.js';
import { startHeartbeat, lockout } from '@dramaforge/client/ops/heartbeat';
import type { HeartbeatResponse } from '@dramaforge/shared';

loadEnvFile();

const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:3000';
const MACHINE_ID = 'e2e-machine-1';
const CLIENT_VERSION = '0.1.0';
const FORCE_MIN_VERSION = '999.0.0';
const FORCE_LATEST_VERSION = '999.0.1';
const RUN_ID = randomUUID();
const EXPECTED_DOWNLOAD_URL = `${API_BASE}/fake-upgrade.exe?e2e=${RUN_ID}`;

function assertLocalTarget(apiBase: string, databaseUrl: string): void {
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  const api = new URL(apiBase);
  assertIsolatedE2eDatabaseUrl(databaseUrl);
  if (!allowed.has(api.hostname)) {
    throw new Error(
      `Refusing E2E against non-local target (api=${api.hostname})`,
    );
  }
}

function requireMutationOptIn(): void {
  if (process.env.E2E_ALLOW_MUTATION !== '1') {
    throw new Error(
      'Set E2E_ALLOW_MUTATION=1 to allow the temporary local version-manifest mutation',
    );
  }
}

function assertExpectedManifestResponse(response: HeartbeatResponse): void {
  if (
    response.status !== 'force_upgrade' ||
    response.minVersion !== FORCE_MIN_VERSION ||
    response.latestVersion !== FORCE_LATEST_VERSION ||
    response.downloadUrl !== EXPECTED_DOWNLOAD_URL
  ) {
    throw new Error(
      `heartbeat did not reflect this E2E manifest: ${JSON.stringify(response)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('force_upgrade E2E — heartbeat version gate');
  console.log('============================================================');

  const databaseUrl = requireEnv('E2E_DATABASE_URL');
  requireMutationOptIn();
  assertLocalTarget(API_BASE, databaseUrl);
  const pool = makePool({ connectionString: databaseUrl });
  let manifestClient: Awaited<ReturnType<typeof acquireVersionsManifestLock>> | null = null;
  let previousManifest: VersionsManifestSnapshot | null = null;
  const testManifest = {
    minVersion: FORCE_MIN_VERSION,
    latestVersion: FORCE_LATEST_VERSION,
    downloadUrls: { win: EXPECTED_DOWNLOAD_URL, mac: '', linux: '' },
    // E2E 测 force_upgrade 逻辑不验签；signature/sha256 空串占位满足 schema。
    signature: '',
    sha256: '',
  };
  let testManifestValue: string | null = null;
  let heartbeat: ReturnType<typeof startHeartbeat> | null = null;
  let directResult: HeartbeatResponse | null = null;
  let callbackResult: HeartbeatResponse | null = null;
  const interruption = new AbortController();
  let interruptedBy: NodeJS.Signals | null = null;
  const onInterrupt = (signal: NodeJS.Signals): void => {
    if (interruption.signal.aborted) return;
    interruptedBy = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    heartbeat?.stop();
    interruption.abort(new Error(`force-upgrade E2E interrupted by ${signal}`));
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  try {
    manifestClient = await acquireVersionsManifestLock(pool);
    previousManifest = await getVersionsManifestSnapshot(manifestClient);

    await withDeadline(async (signal) => {
      const health = await fetch(`${API_BASE}/api/health`, { signal });
      if (!health.ok) throw new Error(`web health failed: HTTP ${health.status}`);
    }, { signal: interruption.signal, label: 'web health check' });

    testManifestValue = await installVersionsManifestForE2e(
      manifestClient,
      previousManifest,
      testManifest,
    );
    if (interruption.signal.aborted) throw interruption.signal.reason;

    const direct = await withDeadline(async (signal) => {
      const response = await fetch(`${API_BASE}/api/client/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: CLIENT_VERSION, os: 'win', machineId: MACHINE_ID }),
        signal,
      });
      if (!response.ok) throw new Error(`heartbeat failed: HTTP ${response.status}`);
      return (await response.json()) as HeartbeatResponse;
    }, { signal: interruption.signal, label: 'direct heartbeat' });
    assertExpectedManifestResponse(direct);
    directResult = direct;

    lockout.reset();
    const state: { response: HeartbeatResponse | null } = { response: null };
    heartbeat = startHeartbeat({
      version: CLIENT_VERSION,
      machineId: MACHINE_ID,
      apiBase: API_BASE,
      intervalMs: 500,
      requestTimeoutMs: 5_000,
      onForceUpgrade: (result) => {
        state.response = result;
      },
    });
    const fired = await pollFor(
      () => {
        if (interruption.signal.aborted) throw interruption.signal.reason;
        return state.response;
      },
      { intervalMs: 200, timeoutMs: 10_000 },
    );
    heartbeat.stop();
    heartbeat = null;

    if (!fired || !lockout.isActive()) {
      throw new Error('client heartbeat did not activate force-upgrade lockout');
    }
    assertExpectedManifestResponse(fired);
    callbackResult = fired;
  } finally {
    try {
      heartbeat?.stop();
      try {
        if (manifestClient && previousManifest && testManifestValue !== null) {
          await restoreVersionsManifestSnapshot(
            manifestClient,
            previousManifest,
            testManifestValue,
          );
          const restoredManifest = await getVersionsManifestSnapshot(manifestClient);
          if (
            restoredManifest.exists !== previousManifest.exists ||
            restoredManifest.value !== previousManifest.value
          ) {
            throw new Error('CLIENT_VERSIONS_MANIFEST did not restore to its exact prior state');
          }
        }
      } finally {
        try {
          if (manifestClient) await releaseVersionsManifestLock(manifestClient);
        } finally {
          await pool.end();
          lockout.reset();
        }
      }
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
    }
  }

  if (interruptedBy) throw new Error(`force-upgrade E2E interrupted by ${interruptedBy}`);

  console.log('============================================================');
  console.log(`direct heartbeat           : ${directResult?.status}`);
  console.log(`client callback            : ${callbackResult?.status}`);
  console.log('client lockout             : true (observed before cleanup)');
  console.log('manifest/API identity      : unique run marker observed');
  console.log('manifest restoration       : exact prior state restored');
  console.log('============================================================');
  console.log('[e2e] force_upgrade: PASS');
}

main().catch((err) => {
  console.error('[e2e] fatal:', err);
  if (process.exitCode === undefined) process.exitCode = 1;
});
