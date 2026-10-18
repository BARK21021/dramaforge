// ============================================================
// protect.mjs — bytenode V8 字节码保护（编译 .js → .jsc + stub loader）
// ============================================================
//
// 原理：bytenode 将 esbuild 产出的 CJS bundle 编译为 V8 字节码 (.jsc)，
//      原始 .js 被替换为 stub loader（require('bytenode') + require('./x.jsc')）。
//      运行时 bytenode 注册 .jsc 扩展名 hook，Electron 加载 stub → 加载 .jsc。
//
// ⚠️ Electron ≥ 42 (V8 ≥ 14.8) 兼容性：
//   bytenode README 明确：ELECTRON_RUN_AS_NODE 模式编译的 .jsc 在 Electron 主进程
//   加载时会 SIGTRAP 崩溃（read-only snapshot checksum 不匹配）。
//   解决方案：使用 electronMain:true 选项，在真正的 Electron 主进程内编译。
//   本脚本使用 compileFile({ electronMain: true })，bytenode 会 spawn Electron
//   进程编译，确保 V8 flags 与运行时一致。
//
//   若编译失败（Electron 未安装 / 显示问题），回退方案：
//     1. 确认 electron 在 devDependencies 中且已 pnpm install
//     2. 或改用 javascript-obfuscator（见 app1/scripts/protect.mjs 的替代方案）
//
// 保护范围：仅 dist-main/index.js（主进程）。
// preload.js 不保护（sandbox 受限 require 加载不了 bytenode，详见 targets 注释）。
// bytenode 依赖：在 dependencies 中（main stub 运行时需要 require('bytenode')）
// ============================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(__dirname, '..');

const require = createRequire(import.meta.url);
const bytenode = require('bytenode');

const targets = [
  { js: 'dist-main/index.js', jsc: 'dist-main/index.jsc' },
  // ⚠️ preload.js 不编译成 .jsc：Electron ≥ 20 sandbox 默认 true，沙箱 preload 的
  // 受限 require（VM sandbox_bundle，白名单仅 electron + builtin）解析不了 bytenode
  // → `module not found: bytenode` → 整个 preload 加载失败 → window.sfShell 全丢
  // （downloadAsset/saveFilm/removeFilm 全断）。preload 只是 contextBridge IPC 桥接，
  // 无敏感逻辑（key 在云端 GC-1），保留 esbuild 明文 JS 即可。main/index.jsc 继续
  // 保护（主进程非沙箱，bytenode 正常 require）。
];

let ok = 0;
let skip = 0;
let fail = 0;

for (const { js, jsc } of targets) {
  const jsPath = resolve(clientRoot, js);
  const jscPath = resolve(clientRoot, jsc);

  if (!existsSync(jsPath)) {
    console.log(`[skip] not found:        ${js}`);
    skip++;
    continue;
  }

  const source = readFileSync(jsPath, 'utf-8');
  if (source.length < 100) {
    console.log(`[skip] too small:        ${js} (${source.length} bytes)`);
    skip++;
    continue;
  }

  // 跳过已经是 stub 的文件（幂等：重复运行不二次编译 stub）
  if (source.includes("require('bytenode')") && source.includes('.jsc')) {
    console.log(`[skip] already stub:     ${js}`);
    skip++;
    continue;
  }

  try {
    const beforeKB = (Buffer.byteLength(source, 'utf-8') / 1024).toFixed(1);

    // electronMain:true — 在 Electron 主进程内编译（V8 ≥ 14.8 安全）
    // bytenode 内部 spawn electron 进程，app.whenReady() 后编译
    await bytenode.compileFile({
      filename: jsPath,
      output: jscPath,
      electronMain: true,
    });

    // 用 stub loader 覆盖原 .js
    const jscName = basename(jsc);
    const stub = `require('bytenode');module.exports=require('./${jscName}');\n`;
    writeFileSync(jsPath, stub);

    const jscSize = (readFileSync(jscPath).length / 1024).toFixed(1);
    console.log(`[ok]   compiled:         ${js}  (${beforeKB}KB -> ${jscSize}KB .jsc + stub)`);
    ok++;
  } catch (e) {
    console.warn(`[fail] ${js}: ${e.message}`);
    fail++;
  }
}

console.log(`\nprotect done — ok:${ok} skip:${skip} fail:${fail}`);
if (fail > 0) process.exitCode = 1;
