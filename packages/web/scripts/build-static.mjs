/**
 * Build web UI as static export for local mode.
 *
 * Next.js output: 'export' doesn't support API routes.
 * In local mode, all API routes are handled by the Fastify local server,
 * so we temporarily exclude app/api during the static build.
 *
 * Output: packages/web/out/ (static HTML/JS/CSS)
 */
import { execSync } from 'child_process';
import { existsSync, renameSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, '..');
const apiDir = join(webRoot, 'app', 'api');
const apiBackup = join(webRoot, 'app', '_api_backup');

console.log('[build-static] Starting static export build...');

// Step 1: Temporarily move app/api out (export mode doesn't support API routes)
if (existsSync(apiDir)) {
  console.log('[build-static] Temporarily excluding app/api...');
  safeMove(apiDir, apiBackup);
}

/** Move directory safely (handles EPERM on Windows by using copy+delete) */
function safeMove(src, dest) {
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

const origConfigPath = join(webRoot, 'next.config.js');
const origConfigBackup = join(webRoot, 'next.config.js.bak');

try {
  // Step 2: Backup original config and write export config
  if (existsSync(origConfigPath)) {
    safeMove(origConfigPath, origConfigBackup);
  }

  const exportConfig = `// Temporary static export config for local build
const config = {
  reactStrictMode: true,
  output: 'export',
  distDir: '.next-static',
  images: { unoptimized: true },
  transpilePackages: ['@dramaforge/server', '@dramaforge/shared'],
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
export default config;
`;
  writeFileSync(origConfigPath, exportConfig, 'utf-8');

  // Step 3: Run next build
  console.log('[build-static] Running next build with output: export...');
  execSync('npx next build', {
    cwd: webRoot,
    stdio: 'inherit',
    env: { ...process.env, DRAMAFORGE_NEXT_DIST_DIR: '.next-static' },
  });

  // Step 4: Move output to out/
  const outDir = join(webRoot, 'out');
  const exportOutDir = join(webRoot, '.next-static', 'out');
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  if (existsSync(exportOutDir)) {
    renameSync(exportOutDir, outDir);
  }
  console.log('[build-static] Static export complete: packages/web/out/');

  // Restore original config
  if (existsSync(origConfigBackup)) {
    if (existsSync(origConfigPath)) rmSync(origConfigPath, { force: true });
    safeMove(origConfigBackup, origConfigPath);
  }
} catch (err) {
  console.error('[build-static] Build failed:', err.message);
  // Restore config
  if (existsSync(origConfigBackup)) {
    if (existsSync(origConfigPath)) rmSync(origConfigPath);
    renameSync(origConfigBackup, origConfigPath);
  }
  process.exit(1);
} finally {
  // Step 5: Restore app/api
  if (existsSync(apiBackup)) {
    console.log('[build-static] Restoring app/api...');
    safeMove(apiBackup, apiDir);
  }
}
