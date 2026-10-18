/**
 * @dramaforge/local-server — main entry point.
 *
 * Initializes SQLite database, local storage, and starts
 * a Fastify HTTP server that serves the web UI + API routes.
 *
 * Usage in Electron:
 *   import { startLocalServer } from '@dramaforge/local-server';
 *   const { port } = await startLocalServer({ dataDir: app.getPath('userData') });
 *   mainWindow.loadURL(`http://localhost:${port}`);
 */
import path from 'path';
import { promises as fs } from 'fs';
import { createHash, randomUUID } from 'crypto';

export interface StartServerOptions {
  dataDir: string;
  port?: number;
  webStaticDir?: string;
}

export interface StartedServer {
  port: number;
  close: () => Promise<void>;
}

export async function startLocalServer(opts: StartServerOptions): Promise<StartedServer> {
  const port = opts.port ?? 0; // 0 = random available port
  const dataDir = opts.dataDir;

  // 1. Initialize SQLite database
  const dbPath = path.join(dataDir, 'dramaforge.db');
  const { initSqlite } = await import('./compat/pg-pool-compat');
  const { initStorage } = await import('./storage');
  const db = initSqlite(dbPath);
  const storage = initStorage(path.join(dataDir, 'storage'));
  await storage.init();

  // 2. Run schema migrations
  try {
    // Schema is inlined at build time via esbuild text loader
    const schemaSql = (await import('./db/schema.sql')).default;
    db.exec(schemaSql);
    console.log('[local-server] SQLite schema initialized');
  } catch (err) {
    console.error('[local-server] Failed to load schema:', err);
    // Fallback: try reading from disk (dev mode)
    try {
      const schemaPath = path.join(__dirname, 'db', 'schema.sql');
      const schemaSql = await fs.readFile(schemaPath, 'utf-8');
      db.exec(schemaSql);
      console.log('[local-server] SQLite schema loaded from disk (fallback)');
    } catch (err2) {
      console.error('[local-server] Schema fallback also failed:', err2);
    }
  }

  // 3. Seed default data if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (userCount.cnt === 0) {
    console.log('[local-server] No users found, ready for registration');
  }

  // 4. Create Fastify server
  const { default: Fastify } = await import('fastify');
  const fastify = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });

  // Cookie support
  await fastify.register((await import('@fastify/cookie')).default);

  // 5. Register API routes
  const { registerRoutes } = await import('./routes');
  registerRoutes(fastify, { db, storage, dataDir });

  // 6. Serve static web UI (if provided)
  if (opts.webStaticDir) {
    const fastifyStatic = await import('@fastify/static');
    await fastify.register(fastifyStatic.default, {
      root: opts.webStaticDir,
      prefix: '/',
      wildcard: false,
    });
  }

  // 7. Start listening
  await fastify.listen({ port, host: '127.0.0.1' });
  const actualPort = fastify.server.address() && typeof fastify.server.address() === 'object'
    ? (fastify.server.address() as { port: number }).port
    : port;

  // Check license at startup (non-blocking — just loads state for gate)
  try {
    const { checkLicenseGate } = await import('@dramaforge/server');
    const licenseStatus = await checkLicenseGate(dataDir, '1.0.0');
    console.log(`[local-server] License: ${licenseStatus.valid ? 'VALID' : 'NOT_ACTIVATED'}`);
  } catch (err) {
    console.warn('[local-server] License check failed:', err);
  }

  console.log(`[local-server] Listening on http://127.0.0.1:${actualPort}`);

  return {
    port: actualPort,
    close: async () => {
      await fastify.close();
    },
  };
}

// ============================================================
// Self-start: when run directly (node index.cjs), start the server
// ============================================================
if (process.env.DRAMAFORGE_AUTO_START === 'true' || process.argv[1]?.endsWith('index.cjs')) {
  const os = require('os');
  const dataDir = process.env.DRAMAFORGE_DATA_DIR || path.join(os.homedir(), '.dramaforge-local');
  const port = parseInt(process.env.PORT || '17419', 10);

  fs.mkdir(dataDir, { recursive: true }).then(() => {
    return startLocalServer({ dataDir, port });
  }).then((server) => {
    console.log('[local-server] Auto-started on port', server.port);
  }).catch((err) => {
    console.error('[local-server] Failed to auto-start:', err);
    process.exit(1);
  });
}
