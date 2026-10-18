// ============================================================
// /api/client/update + /api/client/logs — 契约测试
// ============================================================
//
// update 覆盖：
//   - 返回 { latestVersion, downloadUrl, force }
//   - force=true when version < minVersion
//   - force=false when version >= minVersion
//   - downloadUrl 按 OS 选取
//   - 400 when 缺 version / os 非法
//
// logs 覆盖：
//   - 上传 ClientLogBatch 到 storage → { ok, key }
//   - 400 when body 缺字段
//   - 400 when 存储路径段或日志字段越界；413 when body 超过 512 KiB
//   - 500 when storage.upload 抛错
//
// mock：@dramaforge/server.query + getStorage
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverMock } from './mocks';
import { makeRequest, readJson } from './helpers';
import { GET as updateGET } from '../app/api/client/update/route';
import { POST as logsPOST } from '../app/api/client/logs/route';

const MANIFEST = {
  minVersion: '1.2.0',
  latestVersion: '1.5.0',
  downloadUrls: {
    win: 'https://minio/win.exe',
    mac: 'https://minio/mac.dmg',
    linux: 'https://minio/linux.AppImage',
  },
};

describe('GET /api/client/update', () => {
  beforeEach(() => {
    serverMock.query.mockReset();
    serverMock.query.mockResolvedValue({ rows: [{ value: JSON.stringify(MANIFEST) }] });
  });

  it('returns latestVersion + downloadUrl + force=false when up-to-date', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { version: '1.5.0', os: 'win' },
    });
    const res = await updateGET(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      latestVersion: string;
      downloadUrl: string;
      force: boolean;
    };
    expect(body.latestVersion).toBe('1.5.0');
    expect(body.downloadUrl).toBe('https://minio/win.exe');
    expect(body.force).toBe(false);
  });

  it('returns force=true when version below min', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { version: '1.0.0', os: 'mac' },
    });
    const res = await updateGET(req);
    const body = (await readJson(res)) as { force: boolean; downloadUrl: string };
    expect(body.force).toBe(true);
    expect(body.downloadUrl).toBe('https://minio/mac.dmg');
  });

  it('returns 400 when version missing', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { os: 'win' },
    });
    const res = await updateGET(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when os invalid', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { version: '1.0.0', os: 'solaris' },
    });
    const res = await updateGET(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/client/logs', () => {
  beforeEach(() => {
    serverMock.getStorage.mockReset();
  });

  it('uploads log batch to storage and returns { ok, key }', async () => {
    const upload = vi.fn().mockResolvedValue({
      key: 'sf-clients/m-1/no-task/ts.json',
      url: 'https://minio/sf-clients/m-1/no-task/ts.json',
      size: 100,
      mimeType: 'application/json',
    });
    serverMock.getStorage.mockReturnValue({ upload });
    const req = makeRequest({
      method: 'POST',
      body: {
        machineId: 'm-1',
        logs: [
          { ts: '2026-07-18T00:00:00Z', level: 'info', msg: 'started' },
          { ts: '2026-07-18T00:01:00Z', level: 'error', msg: 'crashed' },
        ],
      },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.key).toMatch(/^sf-clients\/m-1\/no-task\//);
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^sf-clients\/m-1\/no-task\//),
      expect.any(Buffer),
      'application/json',
    );
  });

  it('uses taskId segment when taskId present', async () => {
    const upload = vi.fn().mockResolvedValue({ key: 'k', url: 'u', size: 1, mimeType: 'a' });
    serverMock.getStorage.mockReturnValue({ upload });
    const req = makeRequest({
      method: 'POST',
      body: {
        machineId: 'm-1',
        taskId: 'task-99',
        logs: [{ ts: 't', level: 'info', msg: 'x' }],
      },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(200);
    expect(upload).toHaveBeenCalledWith(
      expect.stringContaining('sf-clients/m-1/task-99/'),
      expect.any(Buffer),
      'application/json',
    );
  });

  it('returns 400 when logs array empty', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { machineId: 'm-1', logs: [] },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when machineId missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { logs: [{ ts: 't', level: 'info', msg: 'x' }] },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(400);
  });

  it.each([
    ['machineId', '../escape'],
    ['machineId', '/absolute/path'],
    ['taskId', '../task'],
    ['taskId', 'task/child'],
  ] as const)('returns 400 when %s is not a safe storage segment', async (field, value) => {
    const req = makeRequest({
      method: 'POST',
      body: {
        machineId: field === 'machineId' ? value : 'm-1',
        ...(field === 'taskId' ? { taskId: value } : {}),
        logs: [{ ts: 't', level: 'info', msg: 'x' }],
      },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(400);
  });

  it('returns 413 before parsing when body exceeds 512 KiB', async () => {
    const req = makeRequest({
      method: 'POST',
      headers: { 'content-length': String(512 * 1024 + 1) },
      body: { machineId: 'm-1', logs: [{ ts: 't', level: 'info', msg: 'x' }] },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(413);
    expect(await readJson(res)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('returns 400 when a log field exceeds its contract limit', async () => {
    const req = makeRequest({
      method: 'POST',
      body: {
        machineId: 'm-1',
        logs: [{ ts: 't', level: 'info', msg: 'x'.repeat(8193) }],
      },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when a batch contains more than 1000 entries', async () => {
    const req = makeRequest({
      method: 'POST',
      body: {
        machineId: 'm-1',
        logs: Array.from({ length: 1001 }, () => ({
          ts: 't',
          level: 'info',
          msg: 'x',
        })),
      },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(400);
  });

  it('returns 500 when storage.upload throws', async () => {
    serverMock.getStorage.mockReturnValue({
      upload: vi.fn().mockRejectedValue(new Error('minio down')),
    });
    const req = makeRequest({
      method: 'POST',
      body: { machineId: 'm-1', logs: [{ ts: 't', level: 'info', msg: 'x' }] },
    });
    const res = await logsPOST(req);
    expect(res.status).toBe(500);
  });
});
