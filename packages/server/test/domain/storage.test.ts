// ============================================================
// ③ server/domain/storage — 单测（后端选择逻辑）
// ============================================================
//
// 覆盖：
//   - createStorage：local / minio / cos 实例创建 + 未知 provider 抛错
//   - getStorage / resetStorage：单例行为
//   - readProvider（通过 getStorage 间接）：STORAGE_PROVIDER 环境变量解析
//   - parseMinioEndpoint：URL 解析（纯函数）
//   - LocalStorage：presignUpload / presignDownload 返回本地 URL；delete 幂等
//
// 注意：真实 MinIO 集成测试 deferred to Task 13（本地无 MinIO）。
// mock @server/infra env 以避免触发真实 env 校验。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// mock @server/infra：env 返回合法 MinIO 配置，避免 MinioStorage 构造抛错
vi.mock('@server/infra', () => ({
  env: () => ({
    DATABASE_URL: 'postgres://u:p@h:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    MINIO_ENDPOINT: 'http://localhost:9000',
    MINIO_ACCESS_KEY: 'access-key',
    MINIO_SECRET_KEY: 'secret-key',
    MINIO_BUCKET: 'dramaforge',
    NEXTAUTH_SECRET: 'secret',
    NEXTAUTH_URL: 'http://localhost:3000',
  }),
}));

import {
  createStorage,
  getStorage,
  resetStorage,
  LocalStorage,
  MinioStorage,
  CosStorage,
  parseMinioEndpoint,
} from '../../src/domain/storage';

describe('storage/factory', () => {
  beforeEach(() => {
    resetStorage();
    delete process.env.STORAGE_PROVIDER;
  });

  afterEach(() => {
    resetStorage();
    delete process.env.STORAGE_PROVIDER;
  });

  describe('createStorage', () => {
    it('creates LocalStorage for "local"', () => {
      const b = createStorage('local');
      expect(b).toBeInstanceOf(LocalStorage);
    });

    it('creates MinioStorage for "minio"', () => {
      const b = createStorage('minio');
      expect(b).toBeInstanceOf(MinioStorage);
    });

    it('creates CosStorage for "cos" (stub, warns)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const b = createStorage('cos');
      expect(b).toBeInstanceOf(CosStorage);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('getStorage / resetStorage', () => {
    it('returns LocalStorage by default (STORAGE_PROVIDER unset)', () => {
      const b = getStorage();
      expect(b).toBeInstanceOf(LocalStorage);
    });

    it('returns MinioStorage when STORAGE_PROVIDER=minio', () => {
      process.env.STORAGE_PROVIDER = 'minio';
      const b = getStorage();
      expect(b).toBeInstanceOf(MinioStorage);
    });

    it('returns same singleton on repeated calls', () => {
      const a = getStorage();
      const b = getStorage();
      expect(a).toBe(b);
    });

    it('resetStorage clears singleton (next call creates new instance)', () => {
      const a = getStorage();
      resetStorage();
      const b = getStorage();
      expect(a).not.toBe(b);
    });

    it('falls back to local for unknown STORAGE_PROVIDER', () => {
      process.env.STORAGE_PROVIDER = 'invalid-provider';
      const b = getStorage();
      expect(b).toBeInstanceOf(LocalStorage);
    });

    it('case-insensitive STORAGE_PROVIDER', () => {
      process.env.STORAGE_PROVIDER = 'MINIO';
      const b = getStorage();
      expect(b).toBeInstanceOf(MinioStorage);
    });
  });
});

describe('storage/parseMinioEndpoint (pure)', () => {
  it('parses http URL with explicit port', () => {
    const opts = parseMinioEndpoint('http://localhost:9000', 'ak', 'sk');
    expect(opts.endPoint).toBe('localhost');
    expect(opts.port).toBe(9000);
    expect(opts.useSSL).toBe(false);
    expect(opts.accessKey).toBe('ak');
    expect(opts.secretKey).toBe('sk');
  });

  it('parses https URL without port (defaults to 443)', () => {
    const opts = parseMinioEndpoint('https://minio.example.com', 'ak', 'sk');
    expect(opts.endPoint).toBe('minio.example.com');
    expect(opts.port).toBe(443);
    expect(opts.useSSL).toBe(true);
  });

  it('parses http URL without port (defaults to 80)', () => {
    const opts = parseMinioEndpoint('http://minio.local', 'ak', 'sk');
    expect(opts.port).toBe(80);
    expect(opts.useSSL).toBe(false);
  });
});

describe('storage/LocalStorage', () => {
  it('presignUpload returns local URL (no real signing)', async () => {
    const ls = new LocalStorage('/uploads');
    const url = await ls.presignUpload('videos/test.mp4');
    expect(url).toBe('/uploads/videos/test.mp4');
  });

  it('presignDownload returns local URL', async () => {
    const ls = new LocalStorage('/uploads');
    const url = await ls.presignDownload('images/test.png');
    expect(url).toBe('/uploads/images/test.png');
  });

  it('delete is idempotent (non-existent file does not throw)', async () => {
    const ls = new LocalStorage('/uploads');
    await expect(ls.delete('non-existent-file-12345.txt')).resolves.toBeUndefined();
  });

  it('upload accepts Buffer and returns result', async () => {
    const ls = new LocalStorage('/uploads');
    const buf = Buffer.from('hello world');
    const result = await ls.upload('test-buffer-upload.txt', buf, 'text/plain');
    expect(result.key).toBe('test-buffer-upload.txt');
    expect(result.url).toContain('test-buffer-upload.txt');
    expect(result.size).toBe(11);
    expect(result.mimeType).toBe('text/plain');
    // 清理
    await ls.delete('test-buffer-upload.txt');
  });

  it.each([
    '../escape.txt',
    'nested/../../escape.txt',
    '/tmp/absolute.txt',
    'C:\\temp\\absolute.txt',
    'safe\0invalid.txt',
  ])('rejects unsafe key %j for every local storage operation', async (key) => {
    const ls = new LocalStorage('/uploads');

    // 四个入口必须共享同一边界，避免预签名或幂等删除绕过 upload 的校验。
    await expect(ls.upload(key, Buffer.from('x'))).rejects.toThrow(/存储 key/);
    await expect(ls.presignUpload(key)).rejects.toThrow(/存储 key/);
    await expect(ls.presignDownload(key)).rejects.toThrow(/存储 key/);
    await expect(ls.delete(key)).rejects.toThrow(/存储 key/);
  });
});

describe('storage/CosStorage (stub)', () => {
  it('upload throws not-implemented', async () => {
    const cos = new CosStorage();
    await expect(cos.upload('k', Buffer.from(''))).rejects.toThrow('尚未实现');
  });

  it('presignUpload throws not-implemented', async () => {
    const cos = new CosStorage();
    await expect(cos.presignUpload('k')).rejects.toThrow('尚未实现');
  });

  it('delete throws not-implemented', async () => {
    const cos = new CosStorage();
    await expect(cos.delete('k')).rejects.toThrow('尚未实现');
  });
});
