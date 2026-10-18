// ============================================================
// /api/projects — 契约测试（UI-facing envelope，GC-4）
// ============================================================
//
// 覆盖：
//   GET
//     - 未登录 → 401 { success:false, code:'UNAUTHORIZED' }
//     - 已登录 → 200 { success:true, data: ProjectRecord[] }（data === repo 返回值）
//   POST
//     - 未登录 → 401
//     - body 校验失败（空 title / title>100 / 非法 category）→ 400 VALIDATION_ERROR
//     - 成功 → 201 + data.title 回填 + projectRepo.create 以 (userId, parsed) 调用
//
// mock 模式参照 test/render-dispatch.test.ts：
//   - getServerSessionMock 控制登录态（DEFAULT_SESSION vs null）
//   - serverMock.projectRepo.{listByUser, create} 控制仓储返回值
//   - createProjectSchema 走真实 @dramaforge/shared 源（alias 见 vitest.config）
//
// 注：mocks.ts 的全局 vi.mock('@dramaforge/server') 在 test/setup.ts 注册，
// 本文件无需再 vi.mock——直接 import { GET, POST } 即可拿到挂载后的路由。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../test/mocks';
import { makeRequest, readJson } from '../../../test/helpers';
import { GET, POST } from './route';
import type { ProjectRecord } from '@dramaforge/shared';

/** 构造一个完整的 ProjectRecord（DB DEFAULT 字段已回填的形态）。 */
function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1',
    userId: 'user-1',
    title: '我的项目',
    description: null,
    category: 'DOMESTIC',
    status: 'DRAFT',
    version: 1,
    artStyle: null,
    artStylePrompt: null,
    novelText: null,
    videoScriptDraft: null,
    scriptData: null,
    characterMapping: null,
    voiceprintMapping: null,
    longVideoProgress: null,
    sourceProjectId: null,
    scriptOverride: false,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('GET /api/projects', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.listByUser.mockReset();
  });

  it('returns 401 UNAUTHORIZED envelope when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
    // 未登录时不应触达仓储
    expect(serverMock.projectRepo.listByUser).not.toHaveBeenCalled();
  });

  it('returns 200 + { success:true, data: ProjectRecord[] } when authenticated', async () => {
    const projects = [
      makeProject({ id: 'proj-a', title: 'A' }),
      makeProject({ id: 'proj-b', title: 'B' }),
    ];
    serverMock.projectRepo.listByUser.mockResolvedValue(projects);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: ProjectRecord[];
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // data 透传仓储返回值（NextResponse.json 会做 JSON 序列化 → 反序列化，
    // 引用断裂，故用 deep equality；内容必须与仓储返回值逐字段相等）
    expect(body.data).toEqual(projects);
    // 仓储以 session.userId 调用
    expect(serverMock.projectRepo.listByUser).toHaveBeenCalledWith('user-1');
  });

  it('returns empty array verbatim when user has no projects', async () => {
    serverMock.projectRepo.listByUser.mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });
});

describe('POST /api/projects', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.create.mockReset();
  });

  it('returns 401 UNAUTHORIZED envelope when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({ method: 'POST', body: { title: 'X' } });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(serverMock.projectRepo.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR when title is empty', async () => {
    const req = makeRequest({ method: 'POST', body: { title: '' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(serverMock.projectRepo.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR when title exceeds 100 chars', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { title: 'x'.repeat(101) },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(serverMock.projectRepo.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR when category is not one of the enum', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { title: '合法标题', category: 'INVALID_CATEGORY' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(serverMock.projectRepo.create).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_JSON when body is malformed JSON', async () => {
    // makeRequest 会 JSON.stringify body，造不出畸形 JSON；手搓 NextRequest
    // （照 dispatch 模式：SyntaxError 由 inner catch 转 400 INVALID_JSON）。
    const req = new NextRequest('http://localhost/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_JSON');
    // 解析失败不应触达仓储
    expect(serverMock.projectRepo.create).not.toHaveBeenCalled();
  });

  it('creates a project and returns 201 + envelope with echoed title', async () => {
    const created = makeProject({ id: 'proj-new', title: '新项目' });
    serverMock.projectRepo.create.mockResolvedValue(created);

    const req = makeRequest({
      method: 'POST',
      body: { title: '新项目', description: '描述', category: 'ORIGINAL' },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = (await readJson(res)) as {
      success: boolean;
      data: ProjectRecord;
    };
    expect(body.success).toBe(true);
    expect(body.data.title).toBe('新项目');
    expect(body.data.id).toBe('proj-new');

    // projectRepo.create 以 (userId, parsed) 调用，parsed 是 zod 处理后的对象
    expect(serverMock.projectRepo.create).toHaveBeenCalledTimes(1);
    expect(serverMock.projectRepo.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: '新项目',
        description: '描述',
        category: 'ORIGINAL',
      }),
    );
  });

  it('forwards the required style for a domestic project', async () => {
    const created = makeProject({
      title: '国内项目',
      category: 'DOMESTIC',
      artStyle: '2d_anime',
    });
    serverMock.projectRepo.create.mockResolvedValue(created);

    const req = makeRequest({
      method: 'POST',
      body: { title: '国内项目', category: 'DOMESTIC', artStyle: '2d_anime' },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = (await readJson(res)) as {
      success: boolean;
      data: ProjectRecord;
    };
    expect(body.success).toBe(true);
    expect(body.data.title).toBe('国内项目');

    expect(serverMock.projectRepo.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: '国内项目',
        category: 'DOMESTIC',
        artStyle: '2d_anime',
      }),
    );
  });

  it('forwards a valid OVERSEAS REFERENCE_VIDEO source mode', async () => {
    serverMock.projectRepo.create.mockResolvedValue(
      makeProject({ title: '参考视频转绘', category: 'OVERSEAS' }),
    );
    const req = makeRequest({
      method: 'POST',
      body: {
        title: '参考视频转绘',
        category: 'OVERSEAS',
        sourceMode: 'REFERENCE_VIDEO',
        artStyle: 'realistic',
      },
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(serverMock.projectRepo.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ sourceMode: 'REFERENCE_VIDEO' }),
    );
  });

  it('forwards a valid LOCAL_SCRIPT source mode instead of stripping it', async () => {
    serverMock.projectRepo.create.mockResolvedValue(
      makeProject({ title: '原创整剧', category: 'ORIGINAL' }),
    );
    const req = makeRequest({
      method: 'POST',
      body: {
        title: '原创整剧',
        category: 'ORIGINAL',
        sourceMode: 'LOCAL_SCRIPT',
      },
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(serverMock.projectRepo.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ sourceMode: 'LOCAL_SCRIPT' }),
    );
  });

  it.each([
    {
      title: '原创分类不能逐集输入',
      body: { title: 'x', category: 'ORIGINAL', sourceMode: 'EPISODE_INPUT' },
    },
    {
      title: '海外转绘必须选择风格',
      body: { title: 'x', category: 'OVERSEAS', sourceMode: 'EPISODE_INPUT' },
    },
    {
      title: '国内直出必须选择风格',
      body: { title: 'x', category: 'DOMESTIC', sourceMode: 'EPISODE_INPUT' },
    },
    {
      title: '引用原创整剧必须提供源项目',
      body: { title: 'x', category: 'DOMESTIC', sourceMode: 'ORIGINAL_PROJECT' },
    },
    {
      title: '原创分类不支持参考视频转绘',
      body: { title: 'x', category: 'ORIGINAL', sourceMode: 'REFERENCE_VIDEO' },
    },
    {
      title: '国内直出不支持参考视频转绘',
      body: { title: 'x', category: 'DOMESTIC', sourceMode: 'REFERENCE_VIDEO' },
    },
  ])('rejects invalid creation rule: $title', async ({ body }) => {
    const res = await POST(makeRequest({ method: 'POST', body }));

    expect(res.status).toBe(400);
    expect((await readJson(res)) as { code: string }).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(serverMock.projectRepo.create).not.toHaveBeenCalled();
  });

  it('maps database-backed source project validation to 400', async () => {
    const error = new Error('引用的剧本原创项目不存在或无权访问');
    error.name = 'ProjectValidationError';
    serverMock.projectRepo.create.mockRejectedValue(error);
    const req = makeRequest({
      method: 'POST',
      body: {
        title: '引用项目',
        category: 'DOMESTIC',
        sourceMode: 'ORIGINAL_PROJECT',
        sourceProjectId: 'foreign-project',
        artStyle: 'realistic',
      },
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      code: 'PROJECT_VALIDATION_ERROR',
    });
  });
});
