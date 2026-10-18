// ============================================================
// /api/client/heartbeat — 契约测试
// ============================================================
//
// 覆盖：
//   - version < minVersion → status='force_upgrade'
//   - version >= minVersion → status='ok'
//   - 响应含 minVersion/latestVersion/downloadUrl
//   - downloadUrl 按 OS 选取
//   - 400 when body 缺字段
//
// mock：@dramaforge/server.query（返回 system_configs.CLIENT_VERSIONS_MANIFEST）
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock } from './mocks';
import { makeRequest, readJson } from './helpers';
import { POST } from '../app/api/client/heartbeat/route';

const MANIFEST = {
  minVersion: '1.2.0',
  latestVersion: '1.5.0',
  downloadUrls: {
    win: 'https://minio/win.exe',
    mac: 'https://minio/mac.dmg',
    linux: 'https://minio/linux.AppImage',
  },
  signature: 'test-signature-base64',
  sha256: 'test-sha256-hex',
};

describe('POST /api/client/heartbeat', () => {
  beforeEach(() => {
    serverMock.query.mockReset();
    serverMock.query.mockResolvedValue({ rows: [{ value: JSON.stringify(MANIFEST) }] });
  });

  it('returns force_upgrade when version < minVersion', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { version: '1.0.0', os: 'win', machineId: 'm-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { status: string; minVersion: string };
    expect(body.status).toBe('force_upgrade');
    expect(body.minVersion).toBe('1.2.0');
  });

  it('returns ok when version >= minVersion', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { version: '1.2.0', os: 'win', machineId: 'm-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns ok when version is above minVersion', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { version: '2.0.0', os: 'mac', machineId: 'm-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(((await readJson(res)) as { status: string }).status).toBe('ok');
  });

  it('returns latestVersion + downloadUrl in response', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { version: '1.5.0', os: 'linux', machineId: 'm-1' },
    });
    const res = await POST(req);
    const body = (await readJson(res)) as {
      latestVersion: string;
      downloadUrl: string;
    };
    expect(body.latestVersion).toBe('1.5.0');
    expect(body.downloadUrl).toBe('https://minio/linux.AppImage');
  });

  it('selects downloadUrl by os', async () => {
    const macReq = makeRequest({
      method: 'POST',
      body: { version: '1.5.0', os: 'mac', machineId: 'm-1' },
    });
    const macRes = await POST(macReq);
    const macBody = (await readJson(macRes)) as { downloadUrl: string };
    expect(macBody.downloadUrl).toBe('https://minio/mac.dmg');
  });

  it('returns signature + sha256 in response (供应链签名链)', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { version: '1.5.0', os: 'win', machineId: 'm-1' },
    });
    const res = await POST(req);
    const body = (await readJson(res)) as { signature: string; sha256: string };
    expect(body.signature).toBe('test-signature-base64');
    expect(body.sha256).toBe('test-sha256-hex');
  });

  it('returns 400 when body missing machineId', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { version: '1.0.0', os: 'win' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('falls back to SAFE_DEFAULT when system_configs row missing', async () => {
    serverMock.query.mockResolvedValue({ rows: [] });
    const req = makeRequest({
      method: 'POST',
      body: { version: '0.0.1', os: 'win', machineId: 'm-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { status: string; minVersion: string };
    // SAFE_DEFAULT.minVersion = '0.0.0' → 0.0.1 >= 0.0.0 → ok
    expect(body.status).toBe('ok');
    expect(body.minVersion).toBe('0.0.0');
  });

  it('renderJobSlots 默认 10（无 RENDER_JOB_SLOTS 配置行）', async () => {
    // 默认 mock 只返回 CLIENT_VERSIONS_MANIFEST 行 → getRenderJobSlots 回退默认
    const req = makeRequest({
      method: 'POST',
      body: { version: '1.5.0', os: 'win', machineId: 'm-1' },
    });
    const res = await POST(req);
    const body = (await readJson(res)) as { renderJobSlots?: number };
    expect(body.renderJobSlots).toBe(10);
  });

  it('renderJobSlots 透传 system_configs 配置值', async () => {
    // 第一个查询（manifest）返回正常清单，第二个查询（slots）返回数值行
    serverMock.query
      .mockResolvedValueOnce({ rows: [{ value: JSON.stringify(MANIFEST) }] })
      .mockResolvedValueOnce({ rows: [{ value: '5' }] });
    const req = makeRequest({
      method: 'POST',
      body: { version: '1.5.0', os: 'win', machineId: 'm-1' },
    });
    const res = await POST(req);
    const body = (await readJson(res)) as { renderJobSlots?: number };
    expect(body.renderJobSlots).toBe(5);
  });
});
