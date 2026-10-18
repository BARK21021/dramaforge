// ============================================================
// ⑪ client/shell — preset voice library (200 wav + manifest)
// ============================================================
//
// 批6 音色库客户端侧：预置 200 个 wav（女声/男声多语种）+ manifest.json 一并
// 打包进客户端 exe（electron-builder extraResources → resources/voices/）。
// renderer 通过 sfShell.listPresetVoices() / readPresetVoice(file) IPC 读取。
//
// 合规（硬约束 dramaforge-assets-client-local）：wav 字节只存 Electron 客户端本地
// （打包进 exe 也算本地），服务器零媒体字节。data: URL 仅给 renderer 试听，
// 不跨进程上传服务器。
//
// Pure / side-effect-free（沿用 asset-store.ts 模式）：不 import electron。
// `voicesDir` 由调用方注入（main/index.ts 按 app.isPackaged 解析后传入），
// 故可在 vitest 里直接 mock fs / tmpdir 测试，无需 electron mock。
//
// 安全模型：`readPresetVoice(file)` 把 file 强制校验为「manifest 里列出的
// 裸文件名」——任何路径穿透（`../`、绝对路径、反斜杠、查询串）都被拒。
// manifest 即权威 allowlist：file 必须 === manifest 某条目的 file 字段。
//
// 错误模型：结构化结果 envelope（{ ok: true } | { ok: false, code, message }），
// 永不 throw。IPC handler 直接把 envelope 转发给 renderer，main 进程不崩。

import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import os from 'node:os';
import { trimAudio } from '../src/ffmpeg/ffmpeg-pipeline';

/**
 * 预置音色条目（与 manifest.json 字段一一对应）。
 * 与 IPC 契约（packages/web/types/sf-shell.d.ts PresetVoice）严格同步。
 */
export interface PresetVoice {
  file: string;
  gender: string;
  dur: number;
  desc: string;
  text: string;
  lang: string;
}

/**
 * listPresetVoices / readPresetVoice 的结果 envelope。永不 throw。
 * code 字段供 renderer 区分错误类型（toast 文案分支）。
 */
export type ListPresetVoicesResult =
  | { ok: true; voices: PresetVoice[] }
  | { ok: false; code: string; message: string };

export type ReadPresetVoiceResult =
  | { ok: true; dataUrl: string }
  | { ok: false; code: string; message: string };

/**
 * 校验 + 规范化一条 manifest 记录。manifest 是打包进 exe 的可信文件，但
 * 字段可能缺/类型错（构建期被改坏）——单条坏不能整盘崩，跳过该条返回 null。
 *
 * `file` 字段额外强制为「裸文件名」：禁 `/` `\` `..`，必须以 `.wav` 结尾。
 * 这是 path 穿透的源头防御（readPresetVoice 二次校验时也用同样的 allowlist）。
 */
function normalizePresetVoice(raw: unknown): PresetVoice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { file, gender, dur, desc, text, lang } = r;
  if (typeof file !== 'string' || !isBareWavName(file)) return null;
  if (typeof gender !== 'string') return null;
  if (typeof dur !== 'number' || !Number.isFinite(dur)) return null;
  if (typeof desc !== 'string') return null;
  if (typeof text !== 'string') return null;
  if (typeof lang !== 'string') return null;
  return { file, gender, dur, desc, text, lang };
}

/**
 * 裸 .wav 文件名校验：禁路径分隔符（/ \）、禁 `..` 段、必须 .wav 扩展名。
 * 大小写不敏感（Windows 文件系统不区分）。
 *
 * 注意：这只验「形状」，不验「在 manifest 里」——readPresetVoice 用 manifest
 * 作为权威 allowlist（isAllowedPresetFile），形状 + allowlist 双层防御。
 */
const BARE_WAV_RE = /^[^\\/]+\.wav$/i;
export function isBareWavName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.includes('..')) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return BARE_WAV_RE.test(name);
}

/**
 * 读 manifest.json → 返回全部合法的 PresetVoice 条目。
 *
 * manifest.json 在 <voicesDir>/manifest.json。读取失败（不存在/权限/JSON 坏）
 * 返 { ok:false, code:'READ_ERROR' }；JSON 顶层不是数组返 { ok:false, code:'INVALID_MANIFEST' }。
 *
 * 单条坏（字段缺/类型错/file 非 bare wav 名）跳过，不计入 voices。
 */
export async function listPresetVoices(voicesDir: string): Promise<ListPresetVoicesResult> {
  const manifestPath = join(voicesDir, 'manifest.json');
  let rawText: string;
  try {
    rawText = await readFile(manifestPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      code: 'READ_ERROR',
      message: `listPresetVoices: failed to read manifest at ${manifestPath}: ${stringifyErr(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_MANIFEST',
      message: `listPresetVoices: manifest.json is not valid JSON: ${stringifyErr(err)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'INVALID_MANIFEST',
      message: `listPresetVoices: manifest.json top-level must be an array, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    };
  }
  const voices: PresetVoice[] = [];
  for (const entry of parsed) {
    const v = normalizePresetVoice(entry);
    if (v) voices.push(v);
  }
  return { ok: true, voices };
}

/**
 * 读单个预置 wav 为 `data:audio/wav;base64,...` data URL（给 renderer `<audio>` 试听）。
 *
 * 安全力（双层防御）：
 *   1. `file` 形状校验（isBareWavName）——禁 `..` / `/` / `\`
 *   2. `file` 必须在 manifest 允许列表里（listPresetVoices 读出的 voices[].file）
 *      ——权威 allowlist，挡住任何「形状合法但不在库里」的猜测
 *   3. 解析后路径必须仍在 voicesDir 内（belt-and-braces，理论上 1+2 已挡全）
 *
 * 任一层失败返 { ok:false, code:'INVALID_FILE' }；文件不存在/读失败返
 * { ok:false, code:'READ_ERROR' }；永不 throw。
 */
export async function readPresetVoice(
  file: string,
  voicesDir: string,
): Promise<ReadPresetVoiceResult> {
  // Layer 1: 形状校验。
  if (!isBareWavName(file)) {
    return {
      ok: false,
      code: 'INVALID_FILE',
      message: `readPresetVoice: file must be a bare <name>.wav (no path separators or ..): ${typeof file === 'string' ? file : '<non-string>'}`,
    };
  }

  // Layer 2: manifest allowlist。读 manifest 失败也直接返（不能让 readPresetVoice
  // 在 manifest 缺失时退化为「只形状校验」，那会削弱防御）。
  const list = await listPresetVoices(voicesDir);
  if (!list.ok) {
    return {
      ok: false,
      code: list.code,
      message: `readPresetVoice: cannot read manifest to verify file allowlist: ${list.message}`,
    };
  }
  const allowed = list.voices.some((v) => v.file === file);
  if (!allowed) {
    return {
      ok: false,
      code: 'INVALID_FILE',
      message: `readPresetVoice: file not in manifest: ${file}`,
    };
  }

  // Layer 3: 解析后路径必须仍在 voicesDir 内（防御性深度，1+2 已挡全）。
  const absVoicesDir = join(voicesDir, '.'); // normalize trailing sep
  const filePath = join(absVoicesDir, file);
  if (!filePath.startsWith(absVoicesDir + sep) && filePath !== absVoicesDir) {
    return {
      ok: false,
      code: 'INVALID_FILE',
      message: `readPresetVoice: resolved path escapes voicesDir: ${file}`,
    };
  }

  try {
    // 显式 access 检查 + readFile 双保险：readFile 的 ENOENT 也能捕，但 access
    // 让错误信息更精准（区分「不存在」与「读失败」）。
    try {
      await access(filePath);
    } catch (err) {
      return {
        ok: false,
        code: 'READ_ERROR',
        message: `readPresetVoice: wav not found or inaccessible: ${file}: ${stringifyErr(err)}`,
      };
    }
    const bytes = await readFile(filePath);
    return { ok: true, dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}` };
  } catch (err) {
    return {
      ok: false,
      code: 'READ_ERROR',
      message: `readPresetVoice: read failed for ${file}: ${stringifyErr(err)}`,
    };
  }
}

/**
 * 读单个预置 wav 为 `data:audio/wav;base64,...`，可选**裁到前 maxSec 秒**。
 *
 * 用途：Seedance 2.0 限制「所有参考音频总时长不超过 15s」；多角色镜头把多条
 * 预置音色塞进一个请求时，每条裁到 5s（3×5=15）保证总时长合法。`maxSec` 为
 * null/undefined 时等价 `readPresetVoice`（原样读，不裁）。
 *
 * 安全模型与 `readPresetVoice` 完全一致（三层校验：isBareWavName + manifest
 * allowlist + 路径仍在 voicesDir 内）；dur 取自 manifest（layer-2 已加载），
 * dur ≤ maxSec 时省一次 ffmpeg 原样读，dur > maxSec 时 trimAudio 到 os.tmpdir()
 * 临时文件再读 base64。永不 throw：trim 失败返 `{ ok:false, code:'TRIM_ERROR' }`。
 */
export async function readPresetVoiceTrimmed(
  file: string,
  voicesDir: string,
  maxSec?: number | null,
): Promise<ReadPresetVoiceResult> {
  // maxSec 未给 → 原样读（等价 readPresetVoice）。
  if (maxSec == null) return readPresetVoice(file, voicesDir);

  // Layer 1: 形状校验。
  if (!isBareWavName(file)) {
    return {
      ok: false,
      code: 'INVALID_FILE',
      message: `readPresetVoiceTrimmed: file must be a bare <name>.wav (no path separators or ..): ${typeof file === 'string' ? file : '<non-string>'}`,
    };
  }

  // Layer 2: manifest allowlist（同时拿到 dur）。
  const list = await listPresetVoices(voicesDir);
  if (!list.ok) {
    return {
      ok: false,
      code: list.code,
      message: `readPresetVoiceTrimmed: cannot read manifest to verify file allowlist: ${list.message}`,
    };
  }
  const entry = list.voices.find((v) => v.file === file);
  if (!entry) {
    return {
      ok: false,
      code: 'INVALID_FILE',
      message: `readPresetVoiceTrimmed: file not in manifest: ${file}`,
    };
  }

  // Layer 3: 解析后路径必须仍在 voicesDir 内。
  const absVoicesDir = join(voicesDir, '.');
  const filePath = join(absVoicesDir, file);
  if (!filePath.startsWith(absVoicesDir + sep) && filePath !== absVoicesDir) {
    return {
      ok: false,
      code: 'INVALID_FILE',
      message: `readPresetVoiceTrimmed: resolved path escapes voicesDir: ${file}`,
    };
  }

  // dur ≤ maxSec（或 dur 未知）→ 原样读，省一次 ffmpeg。
  const dur = Number.isFinite(entry.dur) ? entry.dur : 0;
  if (!(dur > maxSec)) {
    try {
      const bytes = await readFile(filePath);
      return { ok: true, dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}` };
    } catch (err) {
      return {
        ok: false,
        code: 'READ_ERROR',
        message: `readPresetVoiceTrimmed: read failed for ${file}: ${stringifyErr(err)}`,
      };
    }
  }

  // dur > maxSec → 从头裁到 maxSec 到临时文件，再读 base64。
  let tmpDir: string | null = null;
  try {
    try {
      await access(filePath);
    } catch (err) {
      return {
        ok: false,
        code: 'READ_ERROR',
        message: `readPresetVoiceTrimmed: wav not found or inaccessible: ${file}: ${stringifyErr(err)}`,
      };
    }
    tmpDir = await mkdtemp(join(os.tmpdir(), 'dramaforge-voice-trim-'));
    const tmpPath = join(tmpDir, file);
    await trimAudio(filePath, maxSec, tmpPath);
    const bytes = await readFile(tmpPath);
    return { ok: true, dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}` };
  } catch (err) {
    return {
      ok: false,
      code: 'TRIM_ERROR',
      message: `readPresetVoiceTrimmed: trim failed for ${file} → ${maxSec}s: ${stringifyErr(err)}`,
    };
  } finally {
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** Render any thrown value into a single-line string for error messages. */
function stringifyErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
