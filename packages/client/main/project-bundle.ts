// ============================================================
// Project Bundle — C/S 项目迁移包（manifest + 客户端本地媒体）
// ============================================================
//
// 该模块只接触 Electron userData 下受控的 clips/original-uploads 目录；
// renderer 无法传入任意本地路径，从而避免把 IPC 变成通用文件读取接口。
// ============================================================

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { clipsDirFrom, newClipId, originalUploadsDirFrom, resolveClipKeyPath } from './asset-store';

const BUNDLE_FORMAT = 'dramaforge-project-bundle';
const BUNDLE_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';

interface BundledMedia {
  originalReference: string;
  relativePath: string;
  storage: 'clips' | 'original-uploads';
}

interface ProjectBundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  createdAt: string;
  snapshot: unknown;
  media: BundledMedia[];
  warnings: string[];
}

export type ExportProjectBundleResult =
  | { ok: true; bundlePath: string; mediaCount: number; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

export type ImportProjectBundleResult =
  | { ok: true; snapshot: unknown; mediaCount: number; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

function safeProjectName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 80);
  return cleaned || 'DramaForge项目';
}

function walkStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
  } else if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) walkStrings(item, visit);
  }
}

function replaceStrings(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let next = value;
    // 某些 JSON 文本会把 URL 嵌在长字符串中，因此不能只做全值相等替换。
    for (const [from, to] of replacements) next = next.split(from).join(to);
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceStrings(item, replacements)]),
    );
  }
  return value;
}

function isPathInside(candidate: string, parent: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedParent = resolve(parent);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${sep}`);
}

/** 写出目录式 .sfproject 包；大视频以流式 copyFile 搬运，不进入 renderer 内存。 */
export async function exportProjectBundle(input: {
  snapshot: unknown;
  title: string;
  destinationParent: string;
  userDataDir: string;
}): Promise<ExportProjectBundleResult> {
  const bundlePath = join(input.destinationParent, `${safeProjectName(input.title)}.sfproject`);
  const mediaDir = join(bundlePath, 'media');
  const clipsDir = clipsDirFrom(input.userDataDir);
  const originalsDir = originalUploadsDirFrom(input.userDataDir);
  const references = new Set<string>();
  walkStrings(input.snapshot, (text) => {
    for (const match of text.matchAll(/sf-asset:\/\/[A-Za-z0-9._-]+/g)) references.add(match[0]);
    // 只允许迁移 DramaForge 自己的 original-uploads，绝不接受 renderer 指定的任意路径。
    if (isPathInside(text, originalsDir)) references.add(text);
  });

  const media: BundledMedia[] = [];
  const warnings: string[] = [];
  try {
    // 使用 wx 标志避免静默覆盖用户已有的同名迁移包。
    await mkdir(bundlePath, { recursive: false });
    await mkdir(mediaDir, { recursive: false });
    let ordinal = 0;
    for (const reference of references) {
      let sourcePath: string | null = null;
      let storage: BundledMedia['storage'] = 'clips';
      if (reference.startsWith('sf-asset://')) {
        sourcePath = resolveClipKeyPath(reference.slice('sf-asset://'.length), clipsDir);
      } else if (isPathInside(reference, originalsDir)) {
        sourcePath = reference;
        storage = 'original-uploads';
      }
      if (!sourcePath) {
        warnings.push(`跳过无效本地媒体引用：${reference}`);
        continue;
      }
      try {
        const info = await stat(sourcePath);
        if (!info.isFile()) throw new Error('not a file');
        const fileName = `${String(++ordinal).padStart(5, '0')}-${basename(sourcePath)}`;
        const relativePath = `media/${fileName}`;
        await copyFile(sourcePath, join(bundlePath, relativePath));
        media.push({ originalReference: reference, relativePath, storage });
      } catch {
        warnings.push(`本机缺少媒体文件：${reference}`);
      }
    }
    const manifest: ProjectBundleManifest = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      createdAt: new Date().toISOString(),
      snapshot: input.snapshot,
      media,
      warnings,
    };
    await writeFile(join(bundlePath, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
    return { ok: true, bundlePath, mediaCount: media.length, warnings };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'EXPORT_FAILED', message: `导出项目失败：${String(error)}` },
    };
  }
}

/** 读取迁移包、恢复本机媒体，并返回已改写为新本地路径的快照。 */
export async function importProjectBundle(input: {
  bundlePath: string;
  userDataDir: string;
}): Promise<ImportProjectBundleResult> {
  try {
    const raw = await readFile(join(input.bundlePath, MANIFEST_NAME), 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 32 * 1024 * 1024) {
      return { ok: false, error: { code: 'MANIFEST_TOO_LARGE', message: '迁移包 manifest 超过 32MB' } };
    }
    const manifest = JSON.parse(raw) as Partial<ProjectBundleManifest>;
    if (
      manifest.format !== BUNDLE_FORMAT || manifest.version !== BUNDLE_VERSION ||
      !Array.isArray(manifest.media) || !('snapshot' in manifest)
    ) {
      return { ok: false, error: { code: 'INVALID_BUNDLE', message: '不是受支持的 DramaForge 项目迁移包' } };
    }

    const clipsDir = clipsDirFrom(input.userDataDir);
    const originalsDir = originalUploadsDirFrom(input.userDataDir);
    await mkdir(clipsDir, { recursive: true });
    await mkdir(originalsDir, { recursive: true });
    const replacements = new Map<string, string>();
    const warnings = [...(manifest.warnings ?? [])];
    let mediaCount = 0;
    for (const entry of manifest.media) {
      if (
        !entry || typeof entry.originalReference !== 'string' ||
        typeof entry.relativePath !== 'string' || !entry.relativePath.startsWith('media/')
      ) {
        warnings.push('跳过一条格式无效的媒体记录');
        continue;
      }
      const sourcePath = resolve(input.bundlePath, entry.relativePath);
      if (!isPathInside(sourcePath, join(input.bundlePath, 'media'))) {
        warnings.push(`跳过越界媒体路径：${entry.relativePath}`);
        continue;
      }
      const extension = extname(sourcePath).replace(/^\./, '').toLowerCase() || 'bin';
      const key = `${newClipId()}.${extension}`;
      if (entry.storage === 'original-uploads') {
        const target = join(originalsDir, key);
        await copyFile(sourcePath, target);
        replacements.set(entry.originalReference, target);
      } else {
        const target = join(clipsDir, key);
        await copyFile(sourcePath, target);
        replacements.set(entry.originalReference, `sf-asset://${key}`);
      }
      mediaCount += 1;
    }
    return {
      ok: true,
      snapshot: replaceStrings(manifest.snapshot, replacements),
      mediaCount,
      warnings,
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'IMPORT_FAILED', message: `导入项目包失败：${String(error)}` },
    };
  }
}
