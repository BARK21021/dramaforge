// Unit tests for ⑨ render-worker uploader.
//
// Mocks global `fetch` and asserts uploadArtifact:
//   - PUTs the file body (read from disk) to the presigned URL with
//     Content-Type: application/octet-stream.
//   - Throws on any non-2xx response (does NOT swallow).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadArtifact } from '../../src/render-worker/uploader';

const originalFetch = globalThis.fetch;

describe('uploadArtifact', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tmpFile: string;

  beforeEach(async () => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tmpFile = path.join(os.tmpdir(), `sf-upl-test-${rand}.bin`);
    await fs.writeFile(tmpFile, Buffer.from('hello world'));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(tmpFile, { force: true });
  });

  it('PUTs the file body to the upload URL with Content-Type octet-stream', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await uploadArtifact(tmpFile, 'https://minio.local/out/concat.mp4');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://minio.local/out/concat.mp4');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' });

    // The body is the file contents (a Buffer from readFile).
    const body = init.body as unknown as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.toString()).toBe('hello world');
  });

  it('throws on a non-2xx response (does not swallow)', async () => {
    fetchMock.mockResolvedValue(new Response('Forbidden', { status: 403 }));

    await expect(
      uploadArtifact(tmpFile, 'https://minio.local/out/concat.mp4'),
    ).rejects.toThrow(/403/);
  });

  it('throws on a 5xx response', async () => {
    fetchMock.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    await expect(
      uploadArtifact(tmpFile, 'https://minio.local/out/concat.mp4'),
    ).rejects.toThrow(/500/);
  });

  it('propagates a network error (fetch rejection) as a thrown Error', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(
      uploadArtifact(tmpFile, 'https://minio.local/out/concat.mp4'),
    ).rejects.toThrow('network down');
  });

  it('任务已取消时不再读取并上传产物', async () => {
    const controller = new AbortController();
    const cancelError = new Error('lease lost');
    controller.abort(cancelError);

    await expect(
      uploadArtifact(
        tmpFile,
        'https://minio.local/out/concat.mp4',
        controller.signal,
      ),
    ).rejects.toBe(cancelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
