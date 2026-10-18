// ============================================================
// ③ server/domain/storage — 存储后端接口与类型
// ============================================================
//
// 文件职责：
//   定义统一的存储后端接口 StorageBackend，供 local / minio / cos 实现。
//   接口契约对齐 Task ⑥ render-worker 上传需求：
//     - upload(key, stream)         上传流到 key
//     - presignUpload(key)          生成 PUT 预签名 URL（客户端直传）
//     - presignDownload(key)        生成 GET 预签名 URL（客户端下载）
//     - delete(key)                 删除对象
//
// 与 app1 的差异：
//   app1 用单一 getSignedUrl（仅 GET）；本接口拆为 presignUpload / presignDownload，
//   因为 C/S 重构中客户端 render-worker 需 PUT 产物到 MinIO（presignUpload），
//   也需 GET 拉取输入（presignDownload）。
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import type { Readable } from 'node:stream';

/** 存储后端类型 */
export type StorageProvider = 'local' | 'minio' | 'cos';

/** 上传结果 */
export interface StorageUploadResult {
  key: string;
  url: string;
  size: number;
  mimeType: string;
}

/**
 * 存储后端统一接口。
 *
 * 所有后端（local / minio / cos）必须实现此接口。
 * render-worker 与 web API 通过此接口操作对象存储。
 */
export interface StorageBackend {
  /** 上传流到指定 key */
  upload(key: string, stream: Readable | Buffer, mimeType?: string): Promise<StorageUploadResult>;
  /** 生成 PUT 预签名 URL（客户端直传上传） */
  presignUpload(key: string, expiresInSeconds?: number): Promise<string>;
  /** 生成 GET 预签名 URL（客户端下载） */
  presignDownload(key: string, expiresInSeconds?: number): Promise<string>;
  /** 删除对象（幂等：对象不存在不抛错） */
  delete(key: string): Promise<void>;
}
