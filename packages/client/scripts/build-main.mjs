// ============================================================
// build-main.mjs — esbuild bundle Electron main + preload
// ============================================================
//
// 为什么用 esbuild 而非 tsc emit：
//   client/main/index.ts 使用 ../src/* 相对引用进入 client/src/，src 内部
//   大量跨模块引用 + @dramaforge/shared workspace 包（TS 源，未编译）。
//   tsc emit 不解析 @client/* @shared/* 别名，且不处理 electron external。
//   esbuild bundle 在构建时解析全部别名 + 内联 workspace 源码，产出单文件 CJS。
//
// 产物：
//   dist-main/index.js   — Electron 主进程入口（main 进程 + render-worker + ops）
//   dist-main/preload.js — contextBridge preload（沙箱隔离）
//
// external：
//   electron              — 运行时由 Electron 提供，不打包
//   @ffmpeg-installer/ffmpeg — 含平台二进制动态解析，runtime 从 node_modules 取
//   sharp                 — 原生 .node 模块，esbuild 无法打包
//   fluent-ffmpeg         — 依赖 @ffmpeg-installer，一并 external
//
// alias（对应 tsconfig paths，当前代码用相对路径，alias 作安全网）：
//   @client/* → ./src/*
//   @shared/* → ../shared/src/*
// ============================================================

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(__dirname, '..');

/** @type {import('esbuild').BuildOptions} */
const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  // 不 minify：bytenode 编译后源码不可读，esbuild 层保持可读便于调试
  minify: false,
  logLevel: 'info',
  alias: {
    '@client': resolve(clientRoot, 'src'),
    '@shared': resolve(clientRoot, '../shared/src'),
  },
  external: [
    'electron',
    '@ffmpeg-installer/ffmpeg',
    '@ffmpeg-installer/win32-x64',
    'sharp',
    'fluent-ffmpeg',
  ],
};

// --- main process entry ---
await build({
  ...commonOptions,
  entryPoints: [resolve(clientRoot, 'main/index.ts')],
  outfile: resolve(clientRoot, 'dist-main/index.js'),
});

// --- preload script ---
await build({
  ...commonOptions,
  entryPoints: [resolve(clientRoot, 'main/preload.ts')],
  outfile: resolve(clientRoot, 'dist-main/preload.js'),
});

console.log('[build-main] done: dist-main/index.js + dist-main/preload.js');
