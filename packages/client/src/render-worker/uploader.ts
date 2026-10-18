// ============================================================
// ⑨ client/render-worker — artifact uploader
// ============================================================
//
// PUTs a local file (produced by ffmpeg on the user's machine) to a presigned
// MinIO `uploadUrl` using the global `fetch` (Node 18+ / Electron). The file is
// read with node:fs/promises.readFile and sent as application/octet-stream.
//
// Nothing is swallowed: a network error propagates as a thrown Error, and any
// non-2xx response is turned into a thrown Error. The caller (the poll loop)
// catches and reports the job as failed. This is intentionally the opposite of
// the ops-logger's best-effort uploader — a failed artifact upload MUST fail
// the job so the server can re-queue it.
//
// Leaf module: no @server/* imports (the render-worker talks to the server ONLY
// via HTTP). No @client/orchestrators import.

import { readFile } from 'node:fs/promises';

/**
 * Upload a local file to a presigned PUT URL.
 *
 * @param localPath - absolute path to the local artifact produced by ffmpeg
 * @param uploadUrl - presigned MinIO PUT URL (from the job input's outputUploadUrl)
 * @param signal - 服务端取消任务时中断文件上传
 * @throws on any fetch rejection (network error) or non-2xx response
 */
export async function uploadArtifact(
  localPath: string,
  uploadUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const body = await readFile(localPath);
  signal?.throwIfAborted();
  const res = await globalThis.fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `uploadArtifact: HTTP ${res.status} ${res.statusText} (${uploadUrl})`,
    );
  }
}
