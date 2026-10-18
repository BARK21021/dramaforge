/**
 * Local mode integration for Electron.
 *
 * Dual-process architecture:
 *   1. Fastify local-server (SQLite + API) on port 17419
 *   2. Next.js standalone server (UI) on a random port
 *   3. Next.js rewrites proxy /api/* to Fastify
 *   4. BrowserWindow loads the Next.js server
 */
import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const FASTIFY_PORT = 17419;
const FASTIFY_HOST = '127.0.0.1';

export interface LocalServerHandle {
  port: number;
  webPort: number;
  close: () => Promise<void>;
}

let handle: LocalServerHandle | null = null;
let fastifyProcess: ChildProcess | null = null;
let webProcess: ChildProcess | null = null;

/** Check if we are in local (standalone) mode. */
export function isLocalMode(): boolean {
  if (process.env.DRAMAFORGE_LOCAL_MODE === 'true' || process.env.DRAMAFORGE_LOCAL_MODE === '1') {
    return true;
  }
  const resourcesPath = process.resourcesPath ?? '';
  return existsSync(path.join(resourcesPath, 'local-server', 'index.cjs'));
}

/** Resolve the local server bundle path. */
function resolveLocalServerPath(): string | null {
  const resourcesPath = process.resourcesPath ?? '';
  const packagedPath = path.join(resourcesPath, 'local-server', 'index.cjs');
  if (existsSync(packagedPath)) return packagedPath;
  const devPath = path.join(app.getAppPath(), '..', 'local-server', 'dist', 'index.cjs');
  if (existsSync(devPath)) return devPath;
  return null;
}

/** Resolve the Next.js standalone server path. */
function resolveWebServerPath(): string | null {
  const resourcesPath = process.resourcesPath ?? '';
  const packagedPath = path.join(resourcesPath, 'web-standalone', 'packages', 'web', 'server.js');
  if (existsSync(packagedPath)) return packagedPath;
  const devPath = path.join(app.getAppPath(), '..', 'web', '.next', 'standalone', 'packages', 'web', 'server.js');
  if (existsSync(devPath)) return devPath;
  return null;
}

/** Start the local server. */
export async function startLocalServer(): Promise<LocalServerHandle> {
  const dataDir = app.getPath('userData');

  // 1. Start Fastify
  const serverPath = resolveLocalServerPath();
  if (!serverPath) {
    throw new Error('Local server bundle not found.');
  }

  console.log('[local-mode] Starting Fastify...');
  process.env.DRAMAFORGE_DB_PATH = path.join(dataDir, 'dramaforge.db');

  fastifyProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DRAMAFORGE_LOCAL_MODE: 'true',
      DRAMAFORGE_AUTO_START: 'true',
      DRAMAFORGE_DATA_DIR: dataDir,
      PORT: String(FASTIFY_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  fastifyProcess.stdout?.on('data', (d: Buffer) => console.log('[fastify]', d.toString().trim()));
  fastifyProcess.stderr?.on('data', (d: Buffer) => console.error('[fastify]', d.toString().trim()));

  await waitForPort(FASTIFY_HOST, FASTIFY_PORT, 10000);
  console.log('[local-mode] Fastify ready on', FASTIFY_PORT);

  // 2. Start Next.js standalone
  const webServerPath = resolveWebServerPath();
  let webPort = 0;

  if (webServerPath) {
    webPort = await findFreePort(17500);
    console.log('[local-mode] Starting Next.js on', webPort);

    webProcess = spawn(process.execPath, [webServerPath], {
      cwd: path.dirname(webServerPath),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(webPort),
        HOSTNAME: '127.0.0.1',
        DRAMAFORGE_FASTIFY_PORT: String(FASTIFY_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    webProcess.stdout?.on('data', (d: Buffer) => console.log('[next]', d.toString().trim()));
    webProcess.stderr?.on('data', (d: Buffer) => console.error('[next]', d.toString().trim()));

    await waitForPort('127.0.0.1', webPort, 15000);
    console.log('[local-mode] Next.js ready on', webPort);
  } else {
    console.warn('[local-mode] No standalone, using Fastify only');
    webPort = FASTIFY_PORT;
  }

  handle = {
    port: FASTIFY_PORT,
    webPort,
    close: async () => {
      if (webProcess) { webProcess.kill(); webProcess = null; }
      if (fastifyProcess) { fastifyProcess.kill(); fastifyProcess = null; }
    },
  };

  console.log('[local-mode] Ready: Fastify=' + FASTIFY_PORT + ' Next=' + webPort);
  return handle;
}

export async function stopLocalServer(): Promise<void> {
  if (handle) { await handle.close(); handle = null; }
}

export function getLocalServerUrl(): string | null {
  if (!handle) return null;
  return 'http://127.0.0.1:' + handle.webPort;
}

/** Wait for a TCP port. */
async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const net = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() > deadline) { reject(new Error("Timeout " + host + ":" + port)); return; }
      const s = new net.Socket();
      s.setTimeout(500);
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => { s.destroy(); setTimeout(tryConnect, 200); });
      s.once('timeout', () => { s.destroy(); setTimeout(tryConnect, 200); });
      s.connect(port, host);
    }
    tryConnect();
  });
}

/** Find a free port. */
async function findFreePort(startPort: number): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(findFreePort(startPort + 1)));
    srv.listen(startPort, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => resolve(typeof a === 'object' && a ? a.port : startPort));
    });
  });
}