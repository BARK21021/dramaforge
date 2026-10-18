/**
 * Build web UI in standalone mode for local Electron app.
 * Produces: .next/standalone/ (self-contained Next.js server)
 * Usage: pnpm --filter @dramaforge/web build:standalone
 */
import { execSync } from 'child_process';
import { existsSync, copyFileSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, '..');

console.log('[build-standalone] Starting standalone build...');

// Step 1: Swap config
const origConfig = join(webRoot, 'next.config.mjs');
const localConfig = join(webRoot, 'next.config.local.mjs');
const bakConfig = join(webRoot, 'next.config.mjs.bak');

copyFileSync(origConfig, bakConfig);
copyFileSync(localConfig, origConfig);

try {
  // Step 2: Build
  console.log('[build-standalone] Running next build...');
  execSync('npx next build', {
    cwd: webRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy',
      REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
      MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
      MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || 'dummy',
      MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || 'dummy',
      MINIO_BUCKET: process.env.MINIO_BUCKET || 'dummy',
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET || 'dummy',
      NEXTAUTH_URL: process.env.NEXTAUTH_URL || 'http://localhost:3000',
    },
  });

  // Step 3: Copy static assets into standalone output
  const staticSrc = join(webRoot, '.next', 'static');
  const staticDst = join(webRoot, '.next', 'standalone', 'packages', 'web', '.next', 'static');
  if (existsSync(staticSrc)) {
    console.log('[build-standalone] Copying static assets...');
    execSync('xcopy /E /I /Y "' + staticSrc.replace(/\//g, '\\') + '" "' + staticDst.replace(/\//g, '\\') + '"', { stdio: 'pipe' });
  }

  // Step 4: Patch server.js — inject dynamic Fastify port
  const serverPath = join(webRoot, '.next', 'standalone', 'packages', 'web', 'server.js');
  if (existsSync(serverPath)) {
    console.log('[build-standalone] Patching server.js for dynamic port...');
    let code = readFileSync(serverPath, 'utf-8');
    
    // The rewrites are baked into nextConfig JSON as:
    // "destination":"http://127.0.0.1:17419/api/:path*"
    // Replace with runtime-evaluated port.
    // Since nextConfig is assigned then JSON.stringify'd into env, we inject
    // a post-processing step that rewrites the config object before passing to startServer.
    
    // Insert a port patcher right before startServer call
    code = code.replace(
      /(startServer\()/,
      // Patch rewrites destination with dynamic port
      [
        '// === Local mode: patch rewrites with runtime Fastify port ===',
        'const _fastifyPort = process.env.DRAMAFORGE_FASTIFY_PORT || "17419";',
        'if (nextConfig._originalRewrites && nextConfig._originalRewrites.afterFiles) {',
        '  nextConfig._originalRewrites.afterFiles = nextConfig._originalRewrites.afterFiles.map(r => ({',
        '    ...r,',
        '    destination: r.destination.replace(/127\.0\.0\.1:\\d+/, "127.0.0.1:" + _fastifyPort),',
        '  }));',
        '}',
        'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);',
        '',
        '$1'
      ].join('\n')
    );
    
    writeFileSync(serverPath, code, 'utf-8');
    console.log('[build-standalone] server.js patched');
  }

  console.log('[build-standalone] ✓ Complete: .next/standalone/');
} catch (err) {
  console.error('[build-standalone] Failed:', err.message);
  process.exit(1);
} finally {
  // Restore original config
  if (existsSync(bakConfig)) {
    copyFileSync(bakConfig, origConfig);
    rmSync(bakConfig);
  }
}
