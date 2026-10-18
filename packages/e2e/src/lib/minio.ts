// MinIO helpers for the e2e harness.
//
// Wraps the `minio` npm client to: upload clips, presign GET (for clip URLs
// fed to ffmpeg concat) and PUT (for the outputUploadUrl the render-worker
// uploads the concat result to). All objects land under the `e2e/` prefix in
// the `dramaforge` bucket so they're easy to clean up.

import { Client } from 'minio';
import { readFile } from 'node:fs/promises';

export interface MinioConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface UploadedClip {
  /** Object name in MinIO (e.g. `e2e/clips/clip-1.mp4`). */
  objectName: string;
  /** Presigned GET URL (clip URL fed to ffmpeg). */
  getUrl: string;
}

/** Build a MinIO client from env-shaped config. */
export function makeMinioClient(cfg: MinioConfig): Client {
  return new Client({
    endPoint: cfg.endPoint,
    port: cfg.port,
    useSSL: cfg.useSSL,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
  });
}

/** Ensure the bucket exists (idempotent). */
export async function ensureBucket(mc: Client, bucket: string): Promise<void> {
  const exists = await mc.bucketExists(bucket);
  if (!exists) {
    await mc.makeBucket(bucket);
  }
}

/** Upload a local file to MinIO and return its object name. */
export async function uploadFile(
  mc: Client,
  bucket: string,
  objectName: string,
  localPath: string,
): Promise<void> {
  const buf = await readFile(localPath);
  await mc.putObject(bucket, objectName, buf);
}

/** Remove only the objects created by the current E2E run. */
export async function removeObjects(
  mc: Client,
  bucket: string,
  objectNames: string[],
): Promise<void> {
  await Promise.all(objectNames.map((objectName) => mc.removeObject(bucket, objectName)));
}

/** Presign a GET URL for an object (default 1h expiry). */
export async function presignGet(
  mc: Client,
  bucket: string,
  objectName: string,
  expirySeconds = 3600,
): Promise<string> {
  return mc.presignedGetObject(bucket, objectName, expirySeconds);
}

/** Presign a PUT URL for an object (default 1h expiry). */
export async function presignPut(
  mc: Client,
  bucket: string,
  objectName: string,
  expirySeconds = 3600,
): Promise<string> {
  return mc.presignedPutObject(bucket, objectName, expirySeconds);
}

/** Stat an object — returns size in bytes, or null if missing. */
export async function statObject(
  mc: Client,
  bucket: string,
  objectName: string,
): Promise<number | null> {
  try {
    const stat = await mc.statObject(bucket, objectName);
    return stat.size;
  } catch {
    return null;
  }
}
