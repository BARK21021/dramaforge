// ============================================================
// GET /api/storage/presign — 契约测试（UI-facing envelope，GC-4）
// ============================================================
//
// 覆盖：
//   - 自己的 renders/<userId>/foo.mp4 → 200 { success:true, data:{ url } }
//   - 自己的 uploads/<userId>/foo.png → 200
//   - 他人前缀 renders/<otherUserId>/foo.mp4 → 403，presignDownload 未调用
//   - 前缀碰撞 renders/user-1evil/... 以 user-1 身份请求 → 403，
//     presignDownload 未调用（锁 startsWith('renders/user-1/') 的尾斜杠守卫）
//   - 裸 key random/key → 403
//   - 未登录 → 401
//   - 缺 key → 400
//   - 路径穿越 renders/<userId>/../<other>/x → 403，presignDownload 未调用
//     URL-encoded 变体（%2E%2E）也要被 searchParams 解码后再走同一道校验
//
// mock：@dramaforge/server.getStorage + next-auth getServerSession
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from './mocks';
import { makeRequest, readJson } from './helpers';
import { GET, POST } from '../app/api/storage/presign/route';

/**
 * 构造一个保留 raw percent-encoding 的 GET 请求。
 *
 * `makeRequest({ searchParams })` 用 `URLSearchParams.set`，会把 `%` 重新
 * 编码成 `%25`，再被 `searchParams.get` 解回 `%` —— 一来一回 `%2E` 还是
 * 字面 `%2E`，没法模拟真实 HTTP 里 `?key=...%2E%2E...` 被服务端一次性解码
 * 成 `..` 的场景。这里直接用 URL 字符串构造 NextRequest，保证路由内
 * `new URL(req.url).searchParams.get('key')` 解码一次后的形态与真实请求一致。
 */
function makeRawGetRequest(rawQueryString: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/storage/presign?${rawQueryString}`,
    { method: 'GET' },
  );
}

const SENTINEL_URL = 'https://presigned.example/sentinel';

describe('GET /api/storage/presign', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.getStorage.mockReset();
    serverMock.getStorage.mockReturnValue({
      presignDownload: vi.fn().mockResolvedValue(SENTINEL_URL),
    });
  });

  it('presigns own renders/<userId>/ key and returns envelope { success:true, data:{ url } }', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: 'renders/user-1/job-xyz.mp4' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { url: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.url).toBe(SENTINEL_URL);
    const storage = serverMock.getStorage();
    expect(storage.presignDownload).toHaveBeenCalledTimes(1);
    expect(storage.presignDownload).toHaveBeenCalledWith(
      'renders/user-1/job-xyz.mp4',
    );
  });

  it('presigns own uploads/<userId>/ key and returns success envelope', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: 'uploads/user-1/avatar.png' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { url: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.url).toBe(SENTINEL_URL);
    const storage = serverMock.getStorage();
    expect(storage.presignDownload).toHaveBeenCalledWith(
      'uploads/user-1/avatar.png',
    );
  });

  it('returns 403 and does NOT call presignDownload for another user renders/ prefix', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: 'renders/user-other/foo.mp4' },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as {
      success: boolean;
      code: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
    const storage = serverMock.getStorage();
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });

  it('returns 403 for a bare key without renders/uploads prefix', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: 'random/key' },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as {
      success: boolean;
      code: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
    const storage = serverMock.getStorage();
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: 'renders/user-1/foo.mp4' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as {
      success: boolean;
      code: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
    const storage = serverMock.getStorage();
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });

  it('returns 400 when key param missing', async () => {
    const req = makeRequest({ method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as {
      success: boolean;
      code: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    const storage = serverMock.getStorage();
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });

  it('returns 400 when key param is empty string', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: '' },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects path traversal renders/<userId>/../<other>/x with 403', async () => {
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: 'renders/user-1/../user-2/secret.mp4' },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
    const storage = serverMock.getStorage();
    // The whole point: presignDownload is NEVER called with a key that
    // resolves into another user's namespace.
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });

  it('rejects URL-encoded path traversal renders/<userId>/%2E%2E/<other>/x with 403', async () => {
    // Bypass makeRequest's searchParams round-trip (see makeRawGetRequest
    // doc): we want the route's `searchParams.get('key')` to perform the
    // single decode that a real HTTP server would — turning %2E%2E into ..,
    // which the route must then normalize-and-reject.
    const req = makeRawGetRequest(
      'key=renders/user-1/%2E%2E/user-2/secret.mp4',
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
    const storage = serverMock.getStorage();
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });

  it('rejects prefix collision: renders/user-1evil/... must NOT match startsWith(renders/user-1/)', async () => {
    // Locks the trailing-slash defense in the authorization guard. Without
    // the trailing slash, `renders/user-1evil/secret.mp4` would erroneously
    // satisfy `startsWith('renders/user-1')` and let user `user-1` download
    // another user's namespace (the classic prefix-collision auth bypass).
    // Authenticated as DEFAULT_SESSION (user-1); request a key under a
    // sibling namespace `user-1evil/` that shares the `user-1` prefix.
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: 'renders/user-1evil/secret.mp4' },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
    const storage = serverMock.getStorage();
    // The whole point: presignDownload is NEVER called for the collided key.
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });

  it('wraps presignDownload errors in 500 INTERNAL_ERROR envelope', async () => {
    serverMock.getStorage.mockReturnValue({
      presignDownload: vi.fn().mockRejectedValue(new Error('minio down')),
    });
    const req = makeRequest({
      method: 'GET',
      searchParams: { key: 'renders/user-1/foo.mp4' },
    });
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = (await readJson(res)) as {
      success: boolean;
      code: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});

describe('POST /api/storage/presign（参考视频切片 presigned PUT）', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.getStorage.mockReset();
    serverMock.getStorage.mockReturnValue({
      presignUpload: vi.fn().mockImplementation((key: string) => `https://put.example/${key}`),
      presignDownload: vi.fn().mockResolvedValue(SENTINEL_URL),
    });
    serverMock.projectRepo.getById.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
      title: '海外参考视频项目',
      category: 'OVERSEAS',
    } as never);
  });

  it('signs N upload URLs with server-generated keys under the user+project namespace', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { projectId: 'proj-1', count: 2 },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: { keys: string[]; urls: string[] } };
    expect(body.success).toBe(true);
    expect(body.data.keys).toEqual([
      'uploads/user-1/reference-video/proj-1/clip-0.mp4',
      'uploads/user-1/reference-video/proj-1/clip-1.mp4',
    ]);
    expect(body.data.urls).toHaveLength(2);
    const storage = serverMock.getStorage();
    expect(storage.presignUpload).toHaveBeenCalledTimes(2);
    expect(storage.presignUpload).toHaveBeenNthCalledWith(
      1,
      'uploads/user-1/reference-video/proj-1/clip-0.mp4',
      604800,
    );
  });

  it('returns 400 for out-of-range count', async () => {
    for (const count of [0, 41, -1, 2.5]) {
      const res = await POST(makeRequest({ method: 'POST', body: { projectId: 'proj-1', count } }));
      expect(res.status).toBe(400);
      const body = (await readJson(res)) as { code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    }
    expect(serverMock.getStorage().presignUpload).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(makeRequest({ method: 'POST', body: { projectId: 'proj-1', count: 1 } }));
    expect(res.status).toBe(401);
    expect(serverMock.getStorage().presignUpload).not.toHaveBeenCalled();
  });

  it('returns 404 when project missing or not owned by the user', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const res = await POST(makeRequest({ method: 'POST', body: { projectId: 'ghost', count: 1 } }));
    expect(res.status).toBe(404);
    expect(serverMock.getStorage().presignUpload).not.toHaveBeenCalled();
  });
});
