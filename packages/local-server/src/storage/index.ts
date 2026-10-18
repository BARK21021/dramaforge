import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Local file storage �� replaces MinIO.
 * Files are stored on disk; sf-asset:// URLs map to local paths.
 */
export class LocalStorage {
  constructor(private rootDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.rootDir, 'uploads'), { recursive: true });
    await fs.mkdir(path.join(this.rootDir, 'films'), { recursive: true });
    await fs.mkdir(path.join(this.rootDir, 'thumbnails'), { recursive: true });
  }

  /** Save a buffer to local disk, return a relative key. */
  async save(buffer: Buffer, subdir: string = 'uploads'): Promise<string> {
    const key = `${randomUUID()}`;
    const dir = path.join(this.rootDir, subdir);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, key);
    await fs.writeFile(filePath, buffer);
    return `${subdir}/${key}`;
  }

  /** Save from a file path (move/copy). */
  async saveFromPath(srcPath: string, subdir: string = 'uploads'): Promise<string> {
    const key = `${randomUUID()}`;
    const dir = path.join(this.rootDir, subdir);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(srcPath, path.join(dir, key));
    return `${subdir}/${key}`;
  }

  /** Get full local path for a storage key. */
  resolvePath(key: string): string {
    return path.join(this.rootDir, key);
  }

  /** Write a buffer to a specific key path. */
  async write(key: string, buffer: Buffer, _contentType?: string): Promise<void> {
    const dir = path.dirname(this.resolvePath(key));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.resolvePath(key), buffer);
  }

  /** Read file as buffer. */
  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolvePath(key));
  }

  /** Delete a file by key. */
  async delete(key: string): Promise<void> {
    try { await fs.unlink(this.resolvePath(key)); } catch { /* ignore */ }
  }

  /** Check if file exists. */
  async exists(key: string): Promise<boolean> {
    try { await fs.access(this.resolvePath(key)); return true; } catch { return false; }
  }

  /** Convert sf-asset:// URL to local path. */
  assetUrlToLocalPath(assetUrl: string): string {
    if (assetUrl.startsWith('sf-asset://')) {
      const key = assetUrl.slice('sf-asset://'.length);
      return this.resolvePath(key);
    }
    return assetUrl;
  }

  /** Convert local key to sf-asset:// URL. */
  localPathToAssetUrl(key: string): string {
    return `sf-asset://${key}`;
  }
}

let storageInstance: LocalStorage | null = null;

export function initStorage(rootDir: string): LocalStorage {
  storageInstance = new LocalStorage(rootDir);
  return storageInstance;
}

export function getStorage(): LocalStorage {
  if (!storageInstance) throw new Error('Storage not initialized');
  return storageInstance;
}