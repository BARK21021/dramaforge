// ============================================================
// ③ server/domain/storage — MinIO 对象存储后端
// ============================================================
//
// 文件职责：
//   实现 StorageBackend 接口，将文件操作映射到 MinIO 对象存储服务。
//   MinIO 兼容 Amazon S3 协议，适用于私有云部署。
//
// 移植自 app1 src/core/storage/minio.ts，改造点：
//   - 接口从 StorageProviderAdapter 改为 StorageBackend（presignUpload / presignDownload 拆分）
//   - minio 包改为静态 import（dramaforge-cs 已安装 minio；app1 用动态 import 兜底未安装场景）
//   - env 配置：从 env().MINIO_ENDPOINT 解析 URL 得到 endPoint/port/useSSL
//     （infra 的 env schema 只有 MINIO_ENDPOINT 一个字符串字段，需自行解析）
//   - presignUpload 用 presignedPutObject，presignDownload 用 presignedGetObject
//   - P0.3 修复：两个 Client 分工
//     · client（内网 endPoint=MINIO_ENDPOINT）—— putObject/getObject/removeObject 等真实 I/O，
//       服务器走 docker 内部网络
//     · signingClient（endPoint=MINIO_PUBLIC_BASE_URL 解析出的公网域名）—— 仅用于
//       presignedGetObject/presignedPutObject。SigV4 签名只用 ak/sk/bucket/key/method/region，
//       endPoint 不参与签名计算（见 minio/dist/main/signing.js 的 presignSignatureV4），
//       所以用公网域名签 client 签出的 URL 既能让浏览器解析、又能被实际 MinIO 服务接受。
//       upload() 返回的 url 也改用 ${publicBaseUrl}/${bucket}/${key}。
//     · MINIO_PUBLIC_BASE_URL 未配置时，signingClient = client，publicBaseUrl = MINIO_ENDPOINT
//       （向后兼容现有 dev/test 部署）
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import { Client, type ClientOptions } from 'minio';
import { Readable } from 'node:stream';
import { env } from '@server/infra';
import type { StorageBackend, StorageUploadResult } from './types';

/**
 * MinIO 对象存储后端。
 *
 * 维护两个 minio Client：
 *   - client        —— 真实 I/O（内网 endPoint）
 *   - signingClient —— 仅签名（公网 endPoint），公网未配置时等于 client
 *
 * 用 MINIO_ACCESS_KEY/SECRET_KEY 认证，MINIO_BUCKET 作为默认桶。
 */
export class MinioStorage implements StorageBackend {
  /** 内网 I/O client（putObject/getObject/removeObject 走此实例） */
  private client: Client;
  /**
   * 签名 client：endPoint 绑定公网域名，仅用于 presignedGetObject/presignedPutObject。
   * MINIO_PUBLIC_BASE_URL 未配置时，与 client 同一实例（向后兼容）。
   */
  private signingClient: Client;
  private bucket: string;
  /** 公开访问 base URL，用于拼装 upload() 返回的 url 字段 */
  private publicBaseUrl: string;

  constructor() {
    const e = env();
    this.bucket = e.MINIO_BUCKET;

    // 内网 client：服务器 ↔ MinIO 走 docker 内部网络
    const internalOpts = parseMinioEndpoint(
      e.MINIO_ENDPOINT,
      e.MINIO_ACCESS_KEY,
      e.MINIO_SECRET_KEY,
    );
    this.client = new Client(internalOpts);

    if (e.MINIO_PUBLIC_BASE_URL) {
      // Minor #2 守卫：minio presigned URL 无法携带路径前缀（SigV4 canonical path
      // 不支持反代 prefix），parseMinioEndpoint 也会丢弃 pathname 导致 presign/upload
      // URL 不一致。路径前缀公网 URL 属于误配置，构造期就抛错，避免静默产出错误 URL。
      const publicUrl = new URL(e.MINIO_PUBLIC_BASE_URL);
      if (publicUrl.pathname !== '/' && publicUrl.pathname !== '') {
        throw new Error(
          `MINIO_PUBLIC_BASE_URL must be a host root (scheme://host[:port]), ` +
            `got '${e.MINIO_PUBLIC_BASE_URL}'; path-prefix public URLs are not ` +
            `supported by minio presigning — use a subdomain like ` +
            `https://minio.your-domain.example.com`,
        );
      }
      // 签名 client：endPoint=公网域名，仅用于 presigned*；签名不依赖 endPoint
      const signingOpts = parseMinioEndpoint(
        e.MINIO_PUBLIC_BASE_URL,
        e.MINIO_ACCESS_KEY,
        e.MINIO_SECRET_KEY,
      );
      this.signingClient = new Client(signingOpts);
      // Minor #1：剥离末尾斜杠，避免 `${publicBaseUrl}/${bucket}/${key}` 出现双斜杠
      this.publicBaseUrl = e.MINIO_PUBLIC_BASE_URL.replace(/\/+$/, '');
    } else {
      // 向后兼容：未配置公网域名时复用内网 client
      this.signingClient = this.client;
      this.publicBaseUrl = e.MINIO_ENDPOINT;
    }
  }

  async upload(
    key: string,
    stream: Readable | Buffer,
    mimeType: string = 'application/octet-stream',
  ): Promise<StorageUploadResult> {
    const data = Buffer.isBuffer(stream) ? stream : await drainStream(stream);
    await this.client.putObject(this.bucket, key, data, data.length, { 'Content-Type': mimeType });
    return {
      key,
      url: `${this.publicBaseUrl}/${this.bucket}/${key}`,
      size: data.length,
      mimeType,
    };
  }

  async presignUpload(key: string, expiresInSeconds: number = 3600): Promise<string> {
    return this.signingClient.presignedPutObject(this.bucket, key, expiresInSeconds);
  }

  async presignDownload(key: string, expiresInSeconds: number = 3600): Promise<string> {
    return this.signingClient.presignedGetObject(this.bucket, key, expiresInSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }
}

/**
 * 从 MINIO_ENDPOINT URL 解析 MinIO Client 选项。
 *
 * MINIO_ENDPOINT 形如 "http://localhost:9000" 或 "https://minio.example.com:443"。
 *
 * 显式设 `region: 'us-east-1'`（MinIO 默认 region，被所有标准 MinIO 部署接受），
 * 让 minio 内部 `presignedUrl` → `getBucketRegionAsync` 直接命中
 * `if (this.region) return this.region` 短路（见
 * `minio/dist/main/internal/client.js`），跳过对 endPoint 的 GET ?location
 * region 查询。否则每个 Client 实例首次 presign 都会对 endPoint 发一次
 * `GET /<bucket>?location=`（minio 客户端 `extractRegion` 走 GET，非 HEAD —— 见
 * `minio/dist/main/internal/client.js:557` `const method = 'GET'`）—— 对 signing
 * Client（endPoint=公网域名）意味着 presign 依赖公网反代已部署。
 *
 * @param endpointUrl - MinIO 端点 URL
 * @param accessKey   - 访问密钥
 * @param secretKey   - 密钥
 * @returns MinIO Client 选项（endPoint/port/useSSL/region/accessKey/secretKey）
 */
export function parseMinioEndpoint(
  endpointUrl: string,
  accessKey: string,
  secretKey: string,
): ClientOptions {
  const url = new URL(endpointUrl);
  const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  return {
    endPoint: url.hostname,
    port,
    useSSL: url.protocol === 'https:',
    region: 'us-east-1',
    accessKey,
    secretKey,
  };
}

/** 将 Readable 收集为 Buffer */
async function drainStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
