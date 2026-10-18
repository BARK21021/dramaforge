// FILM_EXPORT end-to-end: remote input clips -> client-local ffmpeg output.

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  assertIsolatedE2eBucket,
  assertIsolatedE2eDatabaseUrl,
  loadEnvFile,
  requireEnv,
} from './lib/env.js';
import {
  makeMinioClient,
  ensureBucket,
  uploadFile,
  presignGet,
  removeObjects,
} from './lib/minio.js';
import {
  E2E_USER_PASSWORD,
  cleanupFilmExportRun,
  makePool,
  seedE2eUser,
  seedConcatRenderJob,
  getRenderJob,
} from './lib/db.js';
import { loginE2eUser } from './lib/auth.js';
import { withDeadline } from './lib/deadline.js';
import { generateTestClips, probeDuration, FFMPEG_PATH } from './lib/ffmpeg.js';
import { pollFor, sleep } from './lib/wait.js';
import { startRenderWorker } from '@dramaforge/client/render-worker';

loadEnvFile();

const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:3000';
const MACHINE_ID = 'e2e-machine-1';
const CLIP_COUNT = 2;
const CLIP_DURATION_SEC = 2;
const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;

const logger = {
  info: (m: string, c?: Record<string, unknown>) =>
    console.log(`[client.rw] info: ${m}`, c ? JSON.stringify(c) : ''),
  warn: (m: string, c?: Record<string, unknown>) =>
    console.warn(`[client.rw] warn: ${m}`, c ? JSON.stringify(c) : ''),
  error: (m: string, c?: Record<string, unknown>) =>
    console.error(`[client.rw] error: ${m}`, c ? JSON.stringify(c) : ''),
  flush: async () => {},
};

function localHostname(value: string): string {
  return new URL(value.includes('://') ? value : `http://${value}`).hostname;
}

function assertLocalTarget(
  apiBase: string,
  databaseUrl: string,
  minioEndpoint: string,
): void {
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  const apiHost = localHostname(apiBase);
  const minioHost = localHostname(minioEndpoint);
  assertIsolatedE2eDatabaseUrl(databaseUrl);
  if (!allowed.has(apiHost) || !allowed.has(minioHost)) {
    throw new Error(
      `Refusing E2E against non-local target ` +
        `(api=${apiHost}, minio=${minioHost}). ` +
        'Set E2E_API_BASE and E2E_DATABASE_URL to an isolated local stack.',
    );
  }
}

function requireMutationOptIn(): void {
  if (process.env.E2E_ALLOW_MUTATION !== '1') {
    throw new Error('Set E2E_ALLOW_MUTATION=1 to allow local DB/MinIO test mutations');
  }
}

async function checkWebUp(signal?: AbortSignal): Promise<void> {
  try {
    await withDeadline(async (signal) => {
      const res = await fetch(`${API_BASE}/api/health`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }, { signal, label: 'web health check' });
    console.log(`[e2e] web healthy: ${API_BASE}/api/health`);
  } catch (err) {
    throw new Error(
      `web not healthy at ${API_BASE}: ${(err as Error).message}. Start the isolated local stack first.`,
    );
  }
}

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('FILM_EXPORT E2E — client-local ffmpeg output');
  console.log('============================================================');

  const databaseUrl = requireEnv('E2E_DATABASE_URL');
  const minioEndpoint = requireEnv('MINIO_ENDPOINT');
  requireMutationOptIn();
  assertLocalTarget(API_BASE, databaseUrl, minioEndpoint);
  const minioCfg = {
    endPoint: minioEndpoint,
    port: parseInt(requireEnv('MINIO_PORT'), 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: requireEnv('MINIO_ACCESS_KEY'),
    secretKey: requireEnv('MINIO_SECRET_KEY'),
    bucket: requireEnv('E2E_MINIO_BUCKET'),
  };
  assertIsolatedE2eBucket(minioCfg.bucket);
  const pool = makePool({ connectionString: databaseUrl });
  const filmsDir = await mkdtemp(join(tmpdir(), 'sf-e2e-films-'));
  const jobId = `e2e-job-${RUN_ID}`;
  const userId = `e2e-user-${RUN_ID}`;
  const userLogin = `e2e-${RUN_ID}@test.local`;
  let clipsDir: string | null = null;
  let worker: ReturnType<typeof startRenderWorker> | null = null;
  let mc: ReturnType<typeof makeMinioClient> | null = null;
  const uploadedObjects: string[] = [];
  let runError: unknown = null;
  const interruption = new AbortController();
  const onInterrupt = (signal: NodeJS.Signals): void => {
    if (interruption.signal.aborted) return;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    void worker?.stop();
    interruption.abort(new Error(`FILM_EXPORT E2E interrupted by ${signal}`));
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  try {
    await checkWebUp(interruption.signal);
    await seedE2eUser(pool, userId, userLogin);
    if (interruption.signal.aborted) throw interruption.signal.reason;
    const authCookie = await loginE2eUser(
      API_BASE,
      userLogin,
      E2E_USER_PASSWORD,
      interruption.signal,
    );
    console.log('[e2e] real NextAuth credentials session acquired');

    mc = makeMinioClient(minioCfg);
    await ensureBucket(mc, minioCfg.bucket);
    const clips = await generateTestClips(CLIP_COUNT, CLIP_DURATION_SEC);
    if (interruption.signal.aborted) throw interruption.signal.reason;
    clipsDir = dirname(clips[0].localPath);
    const uploadedClips: { url: string; durationSec: number }[] = [];
    for (let i = 0; i < clips.length; i++) {
      const objectName = `e2e/clips/${jobId}-${i + 1}.mp4`;
      // Track before upload: a server-side success followed by a broken client
      // response must still leave the object in the cleanup set.
      uploadedObjects.push(objectName);
      await uploadFile(mc, minioCfg.bucket, objectName, clips[i].localPath);
      if (interruption.signal.aborted) throw interruption.signal.reason;
      uploadedClips.push({
        url: await presignGet(mc, minioCfg.bucket, objectName),
        durationSec: clips[i].durationSec,
      });
    }
    await seedConcatRenderJob(pool, jobId, userId, { clips: uploadedClips });

    worker = startRenderWorker({
      apiBase: API_BASE,
      machineId: MACHINE_ID,
      logger,
      pollMs: 500,
      authCookie,
      filmsDir,
      toAssetUrl: (key) => `sf-asset://${key}`,
    });

    const terminal = await pollFor(
      async () => {
        if (interruption.signal.aborted) throw interruption.signal.reason;
        const state = await getRenderJob(pool, jobId);
        return state?.status === 'COMPLETED' || state?.status === 'FAILED' ? state : null;
      },
      { intervalMs: 500, timeoutMs: 60_000 },
    );
    await worker.stop();
    worker = null;
    await sleep(200);

    if (!terminal) throw new Error('render_job did not reach a terminal state within 60s');
    if (terminal.status !== 'COMPLETED') {
      throw new Error(`render_job ${terminal.status}: ${terminal.error ?? 'unknown error'}`);
    }

    const result = terminal.result as
      | { outputUrl?: unknown; meta?: { localKey?: unknown } }
      | null;
    const expectedKey = `${jobId}.mp4`;
    if (result?.outputUrl !== `sf-asset://${expectedKey}`) {
      throw new Error(`unexpected local outputUrl: ${String(result?.outputUrl)}`);
    }
    if (result.meta?.localKey !== expectedKey) {
      throw new Error(`unexpected localKey: ${String(result.meta?.localKey)}`);
    }

    const localOutput = join(filmsDir, expectedKey);
    const outputStat = await stat(localOutput);
    const duration = await probeDuration(localOutput);
    const expectedDuration = CLIP_COUNT * CLIP_DURATION_SEC;
    const durationOk = Math.abs(duration - expectedDuration) < 0.5;
    if (!durationOk) {
      throw new Error(`output duration ${duration.toFixed(2)}s, expected ~${expectedDuration}s`);
    }

    console.log('============================================================');
    console.log('FILM_EXPORT E2E — EVIDENCE REPORT');
    console.log(`render_jobs.status          : ${terminal.status}`);
    console.log(`render_jobs.claimed_by      : ${terminal.claimedBy}`);
    console.log(`result.outputUrl            : ${result.outputUrl}`);
    console.log(`client-local output         : ${localOutput} (${outputStat.size} bytes)`);
    console.log(`output duration             : ${duration.toFixed(2)}s`);
    console.log(`ffmpeg binary (client only) : ${FFMPEG_PATH}`);
    console.log('server output object        : none (no outputUploadUrl minted)');
    console.log('============================================================');
  } catch (error) {
    runError = error;
  }

  // Cleanup is part of the E2E contract: attempt every scoped cleanup and do
  // not report PASS when any temporary row/object/file could have leaked.
  const cleanupErrors: string[] = [];
  try {
    await worker?.stop();
  } catch (error) {
    cleanupErrors.push(`render-worker stop: ${String(error)}`);
  }
  if (mc && uploadedObjects.length > 0) {
    try {
      await removeObjects(mc, minioCfg.bucket, uploadedObjects);
    } catch (error) {
      cleanupErrors.push(`MinIO objects: ${String(error)}`);
    }
  }
  try {
    await cleanupFilmExportRun(pool, jobId, userId);
  } catch (error) {
    cleanupErrors.push(`database rows: ${String(error)}`);
  }
  try {
    await pool.end();
  } catch (error) {
    cleanupErrors.push(`database pool: ${String(error)}`);
  }
  try {
    await rm(filmsDir, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(`film temp directory: ${String(error)}`);
  }
  if (clipsDir) {
    try {
      await rm(clipsDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`clip temp directory: ${String(error)}`);
    }
  }

  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);
  if (interruption.signal.aborted && runError === null) {
    runError = interruption.signal.reason;
  }

  if (runError !== null) {
    if (cleanupErrors.length > 0) {
      throw new Error(
        `${String(runError)}; cleanup also failed: ${cleanupErrors.join('; ')}`,
      );
    }
    throw runError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`E2E cleanup failed: ${cleanupErrors.join('; ')}`);
  }

  console.log('[e2e] FILM_EXPORT: PASS (including cleanup)');
}

main().catch((err) => {
  console.error('[e2e] fatal:', err);
  if (process.exitCode === undefined) process.exitCode = 1;
});
