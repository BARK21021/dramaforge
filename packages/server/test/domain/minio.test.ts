// ============================================================
// ③ server/domain/storage/minio — MinioStorage 公网 URL 修复单测
// ============================================================
//
// 覆盖 P0.3 修复（hazard②）：
//   - MINIO_PUBLIC_BASE_URL 配置时：
//     · presignDownload / presignUpload 返回的 URL host = 公网域名（非内网 "minio"）
//     · upload() 返回的 url 以公网 base URL 起头
//     · 构造两个独立的 minio Client（内网 I/O + 公网签名）
//     · 签名 client 用公网域名解析出的 endPoint/port/useSSL
//     · 真实 I/O（putObject/removeObject）仍走内网 client
//   - MINIO_PUBLIC_BASE_URL 未配置时（向后兼容）：
//     · presignDownload URL host = 内网 endpoint host
//     · upload() url 用内网 endpoint
//     · 仅构造一个 Client（不创建签名 client）
//
// 设计要点：
//   - 真实 minio Client 必须被替换（presignedGetObject 会发网络请求取 region）。
//     用 FakeClient 替换：记录每次 new Client(opts) 的 opts，并按 opts.endPoint
//     生成 URL —— 这样断言落在「URL host 来自哪个 endPoint」这一真实不变量上，
//     而不是 mock-of-mock。
//   - @server/infra 用可变 state 模拟，每条用例独立设置 MINIO_PUBLIC_BASE_URL。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- vi.hoisted: 在 vi.mock 提升之前初始化的、被 mock 工厂引用的可变状态 ---

const mockEnv = vi.hoisted(() => {
  const state: Record<string, string | undefined> = {
    DATABASE_URL: 'postgres://u:p@h:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ACCESS_KEY: 'ak',
    MINIO_SECRET_KEY: 'sk',
    MINIO_BUCKET: 'dramaforge',
    NEXTAUTH_SECRET: 's',
    NEXTAUTH_URL: 'http://localhost:3000',
    MINIO_PUBLIC_BASE_URL: undefined,
  };
  return { state };
});

const fakeMinio = vi.hoisted(() => {
  // 记录所有 new Client(opts) 调用，便于断言「构造了几个 client、各用哪个 endPoint / region」
  const instances: Array<{
    opts: {
      endPoint: string;
      port: number;
      useSSL: boolean;
      accessKey: string;
      secretKey: string;
      region?: string;
    };
  }> = [];
  let counter = 0;

  function buildUrl(opts: {
    endPoint: string;
    port: number;
    useSSL: boolean;
  }, bucket: string, key: string, method: string, id: number): string {
    const proto = opts.useSSL ? 'https' : 'http';
    const portStr = opts.port === 80 || opts.port === 443 ? '' : `:${opts.port}`;
    return `${proto}://${opts.endPoint}${portStr}/${bucket}/${key}?method=${method}&client=${id}`;
  }

  class FakeClient {
    opts: {
      endPoint: string;
      port: number;
      useSSL: boolean;
      accessKey: string;
      secretKey: string;
      region?: string;
    };
    instanceId: number;
    constructor(opts: {
      endPoint: string;
      port: number;
      useSSL: boolean;
      accessKey: string;
      secretKey: string;
      region?: string;
    }) {
      this.opts = opts;
      this.instanceId = ++counter;
      instances.push(this);
    }
    async putObject(): Promise<{ etag: string }> {
      return { etag: 'mock-etag' };
    }
    async removeObject(): Promise<void> {}
    async presignedGetObject(bucket: string, key: string): Promise<string> {
      return buildUrl(this.opts, bucket, key, 'GET', this.instanceId);
    }
    async presignedPutObject(bucket: string, key: string): Promise<string> {
      return buildUrl(this.opts, bucket, key, 'PUT', this.instanceId);
    }
  }

  return {
    Client: FakeClient,
    instances,
    reset: () => {
      instances.length = 0;
      counter = 0;
    },
  };
});

vi.mock('@server/infra', () => ({
  env: () => mockEnv.state,
}));
vi.mock('minio', () => ({ Client: fakeMinio.Client }));

// mock 后再 import SUT
import { MinioStorage } from '../../src/domain/storage/minio';

describe('MinioStorage URL fix (P0.3)', () => {
  beforeEach(() => {
    fakeMinio.reset();
    // 每条用例从干净 state 开始
    mockEnv.state.MINIO_ENDPOINT = 'http://minio:9000';
    mockEnv.state.MINIO_PUBLIC_BASE_URL = undefined;
  });

  describe('when MINIO_PUBLIC_BASE_URL is set', () => {
    beforeEach(() => {
      mockEnv.state.MINIO_PUBLIC_BASE_URL = 'https://minio.example.com';
    });

    it('presignDownload returns URL whose host is the public base URL, not internal "minio"', async () => {
      const s = new MinioStorage();
      const url = await s.presignDownload('assets/foo.png');
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('minio.example.com');
      expect(parsed.hostname).not.toBe('minio');
    });

    it('presignUpload returns URL whose host is the public base URL', async () => {
      const s = new MinioStorage();
      const url = await s.presignUpload('assets/foo.png');
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('minio.example.com');
    });

    it('upload() returned url uses the public base URL (browser-resolvable)', async () => {
      const s = new MinioStorage();
      const result = await s.upload('assets/foo.png', Buffer.from('hello'), 'image/png');
      expect(result.url).toBe('https://minio.example.com/dramaforge/assets/foo.png');
    });

    it('constructs TWO minio Client instances: internal (I/O) + signing (public host)', () => {
      new MinioStorage();
      expect(fakeMinio.instances).toHaveLength(2);
      // 第一个 = 内网 client（用于 putObject/getObject/removeObject）
      expect(fakeMinio.instances[0]!.opts.endPoint).toBe('minio');
      expect(fakeMinio.instances[0]!.opts.port).toBe(9000);
      expect(fakeMinio.instances[0]!.opts.useSSL).toBe(false);
      // 第二个 = 签名 client（公网域名）
      expect(fakeMinio.instances[1]!.opts.endPoint).toBe('minio.example.com');
      expect(fakeMinio.instances[1]!.opts.useSSL).toBe(true);
      // 默认 https 端口 443
      expect(fakeMinio.instances[1]!.opts.port).toBe(443);
    });

    it('signing client is constructed with region=us-east-1 (skips region-lookup GET ?location)', () => {
      // Important #1: 设 region 让 minio presignedUrl 内部 getBucketRegionAsync
      // 直接命中 `if (this.region) return this.region` 短路，跳过对公网 endPoint 的
      // `GET /<bucket>?location=`（minio 客户端 extractRegion 走 GET，非 HEAD —— 见
      // `minio/dist/main/internal/client.js:557` `const method = 'GET'`）。
      // region 是 MinIO 的默认值，被所有标准 MinIO 部署接受。
      new MinioStorage();
      expect(fakeMinio.instances).toHaveLength(2);
      expect(fakeMinio.instances[1]!.opts.region).toBe('us-east-1');
      // region 同样落到内网 client（自然外溢，无副作用）
      expect(fakeMinio.instances[0]!.opts.region).toBe('us-east-1');
    });

    it('trailing slash on MINIO_PUBLIC_BASE_URL is stripped (no double slash in urls)', async () => {
      mockEnv.state.MINIO_PUBLIC_BASE_URL = 'https://minio.example.com/';
      const s = new MinioStorage();
      const result = await s.upload('assets/foo.png', Buffer.from('hello'), 'image/png');
      // upload() url 不含双斜杠 —— trailing slash 必须先被剥离
      expect(result.url).toBe('https://minio.example.com/dramaforge/assets/foo.png');
      expect(result.url).not.toMatch(/minio\.example\.com\/\/dramaforge/);
      // presign URL hostname 仍是纯净的（FakeClient 用 endPoint 拼，本就不含尾斜杠）
      const presigned = await s.presignDownload('assets/foo.png');
      expect(new URL(presigned).hostname).toBe('minio.example.com');
    });

    it('real I/O (putObject) routes through internal client, not signing client', async () => {
      const s = new MinioStorage();
      const internalClient = fakeMinio.instances[0]!;
      const signingClient = fakeMinio.instances[1]!;
      const internalPut = vi.spyOn(internalClient, 'putObject').mockResolvedValue({ etag: 'mock' } as never);
      const signingPut = vi.spyOn(signingClient, 'putObject').mockResolvedValue({ etag: 'mock' } as never);
      await s.upload('assets/foo.png', Buffer.from('hello'), 'image/png');
      expect(internalPut).toHaveBeenCalledTimes(1);
      expect(signingPut).not.toHaveBeenCalled();
    });

    it('delete() routes through internal client', async () => {
      const s = new MinioStorage();
      const internalClient = fakeMinio.instances[0]!;
      const signingClient = fakeMinio.instances[1]!;
      const internalRm = vi.spyOn(internalClient, 'removeObject').mockResolvedValue(undefined as never);
      const signingRm = vi.spyOn(signingClient, 'removeObject').mockResolvedValue(undefined as never);
      await s.delete('assets/foo.png');
      expect(internalRm).toHaveBeenCalledTimes(1);
      expect(signingRm).not.toHaveBeenCalled();
    });

    it('presign calls route through signing client (not internal)', async () => {
      const s = new MinioStorage();
      const internalClient = fakeMinio.instances[0]!;
      const signingClient = fakeMinio.instances[1]!;
      const internalGet = vi.spyOn(internalClient, 'presignedGetObject').mockResolvedValue('http://internal' as never);
      const signingGet = vi.spyOn(signingClient, 'presignedGetObject').mockResolvedValue('http://signing' as never);
      await s.presignDownload('k');
      expect(signingGet).toHaveBeenCalled();
      expect(internalGet).not.toHaveBeenCalled();
    });

    it('https with explicit port parsed correctly', async () => {
      mockEnv.state.MINIO_PUBLIC_BASE_URL = 'https://cdn.example.com:8443';
      const s = new MinioStorage();
      const url = await s.presignDownload('k');
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('cdn.example.com');
      expect(parsed.port).toBe('8443');
    });
  });

  describe('when MINIO_PUBLIC_BASE_URL has a path prefix (misconfiguration)', () => {
    // Minor #2: minio presigned URLs cannot carry a path prefix, so
    // path-prefix public URLs are unsupported. Make it loud at construction.
    it('throws a clear error when env value has a non-empty pathname', () => {
      mockEnv.state.MINIO_PUBLIC_BASE_URL = 'https://your-domain.example.com/minio';
      expect(() => new MinioStorage()).toThrow(
        /MINIO_PUBLIC_BASE_URL must be a host root.*path-prefix public URLs are not supported/,
      );
    });

    it('error message echoes the bad value and suggests a subdomain', () => {
      mockEnv.state.MINIO_PUBLIC_BASE_URL = 'https://your-domain.example.com/minio';
      expect(() => new MinioStorage()).toThrow(
        /got 'https:\/\/your-domain\.cn\/minio'.*https:\/\/minio\.your-domain\.cn/,
      );
    });

    it('does NOT throw for a host-root URL with bare trailing slash', () => {
      // 只剩末尾斜杠的 URL 仍合法（pathname === '/'），不应误报。
      // 注意：上面的 trailing-slash 用例会保证末尾斜杠被剥离。
      mockEnv.state.MINIO_PUBLIC_BASE_URL = 'https://minio.example.com/';
      expect(() => new MinioStorage()).not.toThrow();
    });
  });

  describe('when MINIO_PUBLIC_BASE_URL is unset (backward compat)', () => {
    beforeEach(() => {
      mockEnv.state.MINIO_PUBLIC_BASE_URL = undefined;
    });

    it('presignDownload falls back to internal endpoint host', async () => {
      const s = new MinioStorage();
      const url = await s.presignDownload('assets/foo.png');
      expect(new URL(url).hostname).toBe('minio');
    });

    it('presignUpload falls back to internal endpoint host', async () => {
      const s = new MinioStorage();
      const url = await s.presignUpload('assets/foo.png');
      expect(new URL(url).hostname).toBe('minio');
    });

    it('upload() url falls back to internal endpoint (legacy behavior)', async () => {
      const s = new MinioStorage();
      const result = await s.upload('assets/foo.png', Buffer.from('hello'), 'image/png');
      expect(result.url).toBe('http://minio:9000/dramaforge/assets/foo.png');
    });

    it('constructs only ONE minio Client (signing client not created)', () => {
      new MinioStorage();
      expect(fakeMinio.instances).toHaveLength(1);
      expect(fakeMinio.instances[0]!.opts.endPoint).toBe('minio');
    });
  });
});
