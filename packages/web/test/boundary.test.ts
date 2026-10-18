// ============================================================
// boundary — web 禁止 import 任何 ffmpeg 模块
// ============================================================
//
// 这是 web 包的硬约束（task spec: "boundary test: web must NOT import
// @client/ffmpeg or any ffmpeg module. Web dispatches render_jobs; it NEVER
// runs ffmpeg"）。本测试扫描 packages/web/app + lib 的所有源文件，断言
// 不存在 ffmpeg 相关 import。
//
// 检测模式：
//   - import ... from 'fluent-ffmpeg'
//   - import ... from '@ffmpeg-installer/ffmpeg'
//   - import ... from '@client/ffmpeg'
//   - import ... from '@client/ffmpeg/...'
//   - import ... from '...ffmpeg...'（任何含 ffmpeg 的模块说明符）
//   - require('...ffmpeg...')
//
// 注意：仅扫描 web 自己的源文件，不扫描 node_modules。
// ============================================================

import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCAN_DIRS = ['app', 'lib'];
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/** ffmpeg 模块说明符检测正则 */
const FFMPEG_IMPORT_RE =
  /(?:import|require)\s*\(?\s*['"](?:[^'"]*ffmpeg[^'"]*)['"]|from\s+['"](?:[^'"]*ffmpeg[^'"]*)['"]/i;

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      out.push(...(await listSourceFiles(full)));
    } else if (SOURCE_EXTS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

describe('ffmpeg boundary — web must NOT import ffmpeg', () => {
  it('no source file under app/ or lib/ imports any ffmpeg module', async () => {
    const files: string[] = [];
    for (const sub of SCAN_DIRS) {
      files.push(...(await listSourceFiles(join(WEB_ROOT, sub))));
    }
    expect(files.length).toBeGreaterThan(0); // 确保扫描到了文件
    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      // 逐行检查，跳过注释行（// 开头）
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (FFMPEG_IMPORT_RE.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('package.json does not declare any ffmpeg dependency', async () => {
    const pkg = JSON.parse(
      await readFile(join(WEB_ROOT, 'package.json'), 'utf-8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const ffmpegDeps = Object.keys(all).filter((k) => /ffmpeg/i.test(k));
    expect(ffmpegDeps).toEqual([]);
  });
});
