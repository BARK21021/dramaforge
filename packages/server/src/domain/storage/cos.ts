// ============================================================
// ③ server/domain/storage — 腾讯 COS 后端（骨架/桩）
// ============================================================
//
// 文件职责：
//   实现 StorageBackend 接口的骨架，所有方法抛"尚未实现"异常。
//
// 现状：
//   app1 src/core/storage/cos.ts 本身就是骨架实现（upload/getSignedUrl 返回模拟数据，
//   其余方法抛异常），且未 import cos-nodejs-sdk-v5（仅在 TODO 注释中提及）。
//   dramaforge-cs 未安装 cos-nodejs-sdk-v5（按任务要求不安装、报告）。
//   本实现保持桩状态，所有方法抛错，factory 选择 cos 时会 console.warn。
//
// TODO（未来实现）：
//   - 安装 cos-nodejs-sdk-v5 依赖
//   - 从 env 读取 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION
//   - 用 COS SDK 的 putObject / getObjectUrl / deleteObject 实现各方法
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import type { StorageBackend, StorageUploadResult } from './types';

/**
 * 腾讯云 COS 存储后端（骨架实现）。
 *
 * 所有方法抛"尚未实现"异常。投入生产前需接入 cos-nodejs-sdk-v5。
 */
export class CosStorage implements StorageBackend {
  async upload(): Promise<StorageUploadResult> {
    throw new Error('COS 后端尚未实现：需安装 cos-nodejs-sdk-v5 并实现 upload');
  }

  async presignUpload(): Promise<string> {
    throw new Error('COS 后端尚未实现：需安装 cos-nodejs-sdk-v5 并实现 presignUpload');
  }

  async presignDownload(): Promise<string> {
    throw new Error('COS 后端尚未实现：需安装 cos-nodejs-sdk-v5 并实现 presignDownload');
  }

  async delete(): Promise<void> {
    throw new Error('COS 后端尚未实现：需安装 cos-nodejs-sdk-v5 并实现 delete');
  }
}
