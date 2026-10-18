// ============================================================
// ③ server/domain/storage — 本地文件系统后端
// ============================================================
//
// 文件职责：
//   实现 StorageBackend 接口，将文件操作映射到本地文件系统。
//   文件存储在 process.cwd()/public/uploads 下，通过 HTTP 路径访问。
//
// 移植自 app1 src/core/storage/local.ts，改造点：
//   - 接口从 app1 的 StorageProviderAdapter 改为本项目的 StorageBackend
//   - upload 接受 Readable | Buffer（app1 仅接受 Buffer）
//   - presignUpload / presignDownload 拆分（app1 只有 getSignedUrl）
//   - 本地存储无需签名，直接返回公开路径
//
// 安全约束：零 ffmpeg 依赖；所有 key 必须解析在 uploads 根目录内。
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { StorageBackend, StorageUploadResult } from './types';

/** 本地文件存储根目录 */
const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');

/**
 * 把对象 key 解析为上传根目录内的绝对路径。
 *
 * key 同时可能来自 Web/API 与后台任务，不能直接交给 path.join；这里显式拒绝
 * 绝对路径、父目录段和 NUL，再用 relative 做最终的目录包含校验。
 */
function resolveStoragePath(key: string): string {
  if (!key || key.includes('\0')) {
    throw new Error('无效的本地存储 key');
  }
  if (path.isAbsolute(key) || path.win32.isAbsolute(key) || path.posix.isAbsolute(key)) {
    throw new Error('本地存储 key 不允许使用绝对路径');
  }
  if (key.split(/[\\/]+/u).includes('..')) {
    throw new Error('本地存储 key 不允许包含父目录段');
  }

  const root = path.resolve(UPLOAD_DIR);
  const filePath = path.resolve(root, key);
  const relative = path.relative(root, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('本地存储 key 超出上传目录');
  }
  return filePath;
}

/**
 * 本地文件系统存储后端。
 *
 * 将文件保存到本地磁盘，通过 baseUrl 拼接 HTTP 访问路径。
 * 自动创建必要的目录结构。
 */
export class LocalStorage implements StorageBackend {
  constructor(private baseUrl: string = '/uploads') {
    void this.ensureDir(UPLOAD_DIR);
  }

  async upload(
    key: string,
    stream: Readable | Buffer,
    mimeType: string = 'application/octet-stream',
  ): Promise<StorageUploadResult> {
    const filePath = resolveStoragePath(key);
    const dir = path.dirname(filePath);
    await this.ensureDir(dir);

    if (Buffer.isBuffer(stream)) {
      await fs.writeFile(filePath, stream);
      return {
        key,
        url: `${this.baseUrl}/${key}`,
        size: stream.length,
        mimeType,
      };
    }

    // Readable: 收集到 Buffer 后写入
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    await fs.writeFile(filePath, buf);
    return {
      key,
      url: `${this.baseUrl}/${key}`,
      size: buf.length,
      mimeType,
    };
  }

  /** 本地存储无需签名，直接返回公开上传路径（无真正 PUT 预签名） */
  async presignUpload(key: string): Promise<string> {
    // 预签名虽不触碰磁盘，也必须执行与 upload 相同的 key 边界校验。
    resolveStoragePath(key);
    return `${this.baseUrl}/${key}`;
  }

  /** 本地存储无需签名，直接返回公开下载路径 */
  async presignDownload(key: string): Promise<string> {
    // 下载 URL 不能成为目录穿越 key 的旁路。
    resolveStoragePath(key);
    return `${this.baseUrl}/${key}`;
  }

  async delete(key: string): Promise<void> {
    // 校验放在 try 外，确保非法 key 不会被“幂等删除”的容错逻辑吞掉。
    const filePath = resolveStoragePath(key);
    try {
      await fs.unlink(filePath);
    } catch {
      // 文件不存在或已删除，忽略错误（幂等）
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // 目录已存在或创建失败，忽略
    }
  }
}
