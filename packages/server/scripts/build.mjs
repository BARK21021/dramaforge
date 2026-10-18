// ============================================================
// build.mjs — esbuild bundle ai-worker 入口 + migrate runner
// ============================================================
//
// 为什么用 esbuild 而非 tsc emit：
//   server src 大量使用 @server/* 和 @shared/* 路径别名（tsconfig.base.json
//   paths），tsc emit 不解析别名，产出的 .js 里 require('@server/...') 在
//   Node 运行时无法解析。esbuild bundle 在构建时解析别名 + 内联 workspace
//   源码，产出单文件 CJS。
//
// 策略：packages:'external'
//   所有 npm 包（pg/ioredis/bullmq/minio/next-auth/bcryptjs/zod 等）标记为
//   external，runtime 从 node_modules 加载。workspace 源码（@server/* @shared/*
//   通过 alias 解析）全部内联进 bundle。
//
// 产物：
//   dist/ai-worker/index.js — 虚拟入口按队列解析并发后启动全部 worker
//   dist/migrate.js         — 虚拟入口调用 runMigrations()
//
// 虚拟入口：esbuild stdin 注入一段调用代码，import 真实模块后立即执行。
//           不新建 src 文件（遵守"不改已提交源码"约束）。
// ============================================================

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '..');

/** @type {import('esbuild').BuildOptions} */
const commonOptions = {
  bundle: true,
  platform: 'node',
  // ESM：server package.json 有 "type":"module"，.js 文件被 Node 当 ESM 解析。
  // import.meta.url 在 ESM 下原生可用（migrate.ts 用它定位 migrations 目录）。
  // 外部 CJS 包（pg/bullmq 等）通过 Node ESM-CJS 互操作正常 import。
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  // 所有 npm 包 external（pg/ioredis/bullmq/minio/next-auth/bcryptjs/zod 等）
  // runtime 从 node_modules 加载；workspace 源码通过 alias 内联
  packages: 'external',
  alias: {
    '@server': resolve(serverRoot, 'src'),
    '@shared': resolve(serverRoot, '../shared/src'),
    // 业务代码也会通过 workspace 包名导入共享纯函数；必须内联，否则
    // packages:'external' 会把它误判成生产镜像中不存在的第三方 npm 包。
    '@dramaforge/shared': resolve(serverRoot, '../shared/src/index.ts'),
  },
};

// --- ai-worker 入口：调用 startAllWorkers ---
await build({
  ...commonOptions,
  stdin: {
    contents: [
      `import { resolveWorkerConcurrency, startAllWorkers } from './index';`,
      `// 图片 I/O 并发独立于视频，提速时不会放大视频下载的内存峰值。`,
      `const concurrency = resolveWorkerConcurrency(process.env);`,
      `startAllWorkers(concurrency).catch((e) => {`,
      `  console.error('[ai-worker] fatal:', e);`,
      `  process.exit(1);`,
      `});`,
      ``,
      `// 优雅关闭：SIGTERM/SIGINT 时 stopAllWorkers`,
      `process.on('SIGTERM', () => { console.log('[ai-worker] SIGTERM, exiting'); process.exit(0); });`,
      `process.on('SIGINT', () => { console.log('[ai-worker] SIGINT, exiting'); process.exit(0); });`,
    ].join('\n'),
    resolveDir: resolve(serverRoot, 'src/ai-worker'),
    sourcefile: 'ai-worker-entry.ts',
  },
  outfile: resolve(serverRoot, 'dist/ai-worker/index.js'),
});

// --- migrate runner：调用 runMigrations ---
await build({
  ...commonOptions,
  stdin: {
    contents: [
      `import { runMigrations } from './migrate';`,
      `runMigrations()`,
      `  .then((names) => {`,
      `    console.log('[migrate] done:', names.length ? names.join(', ') : '(none pending)');`,
      `    process.exit(0);`,
      `  })`,
      `  .catch((e) => {`,
      `    console.error('[migrate] failed:', e);`,
      `    process.exit(1);`,
      `  });`,
    ].join('\n'),
    resolveDir: resolve(serverRoot, 'src/infra'),
    sourcefile: 'migrate-entry.ts',
  },
  outfile: resolve(serverRoot, 'dist/migrate.js'),
});

// --- guarded maintenance runner: exact episode repair (dry-run by default) ---
await build({
  ...commonOptions,
  stdin: {
    contents: [
      `import { runEpisodeRepairCli } from './repair-project-episodes';`,
      `runEpisodeRepairCli()`,
      `  .then(() => process.exit(0))`,
      `  .catch((e) => {`,
      `    console.error('[episode-repair] failed:', e);`,
      `    process.exit(1);`,
      `  });`,
    ].join('\n'),
    resolveDir: resolve(serverRoot, 'src/maintenance'),
    sourcefile: 'episode-repair-entry.ts',
  },
  outfile: resolve(serverRoot, 'dist/episode-repair.js'),
});

// --- guarded maintenance runner: AI reprocess for original-series targets ---
await build({
  ...commonOptions,
  stdin: {
    contents: [
      `import { runOriginalSeriesAiReprocessCli } from './reprocess-original-series-ai';`,
      `runOriginalSeriesAiReprocessCli()`,
      `  .then(() => process.exit(0))`,
      `  .catch((e) => {`,
      `    console.error('[original-series-ai-reprocess] failed:', e);`,
      `    process.exit(1);`,
      `  });`,
    ].join('\n'),
    resolveDir: resolve(serverRoot, 'src/maintenance'),
    sourcefile: 'original-series-ai-reprocess-entry.ts',
  },
  outfile: resolve(serverRoot, 'dist/original-series-ai-reprocess.js'),
});

// --- guarded maintenance runner: Chinese PROP/LOCATION normalization ---
await build({
  ...commonOptions,
  stdin: {
    contents: [
      `import { runAssetRepairCli } from './repair-project-assets';`,
      `runAssetRepairCli()`,
      `  .then(() => process.exit(0))`,
      `  .catch((e) => {`,
      `    console.error('[asset-repair] failed:', e);`,
      `    process.exit(1);`,
      `  });`,
    ].join('\n'),
    resolveDir: resolve(serverRoot, 'src/maintenance'),
    sourcefile: 'asset-repair-entry.ts',
  },
  outfile: resolve(serverRoot, 'dist/asset-repair.js'),
});

// --- maintenance: per-episode 批量编剧分析+分镜（绕 session，复刻 route 核心）---
await build({
  ...commonOptions,
  stdin: {
    contents: [
      `import { main } from './per-episode';`,
      `main()`,
      `  .then(() => process.exit(0))`,
      `  .catch((e) => { console.error('[per-episode] failed:', e); process.exit(1); });`,
    ].join('\n'),
    resolveDir: resolve(serverRoot, 'src/maintenance'),
    sourcefile: 'per-episode-entry.ts',
  },
  outfile: resolve(serverRoot, 'dist/per-episode.js'),
});

// --- copy migrations SQL → dist/migrations ---
// 打包后的 dist/migrate.js 用 `new URL('./migrations', import.meta.url)` 定位
// 迁移目录（import.meta.url 此时指向 dist/migrate.js），所以 SQL 必须落到
// dist/migrations/。esbuild 只 bundle JS，不拷 .sql，这里显式拷。
// 生产 docker migrate 服务跑 `node dist/migrate.js`，依赖此目录存在。
const migrationsSrc = resolve(serverRoot, 'src/infra/migrations');
const migrationsDest = resolve(serverRoot, 'dist/migrations');
mkdirSync(migrationsDest, { recursive: true });
cpSync(migrationsSrc, migrationsDest, { recursive: true });
console.log('[build] copied migrations/*.sql → dist/migrations');

console.log('[build] done: worker + migrate + guarded repair runners + migrations');
