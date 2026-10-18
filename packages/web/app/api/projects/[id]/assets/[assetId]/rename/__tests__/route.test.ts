// ============================================================
// POST /api/projects/[id]/assets/[assetId]/rename — 契约测试（批3）
// ============================================================
//
// 覆盖：
//   - 401 未登录
//   - 404 项目不属于当前用户 / 资产不存在 / 资产不属于该项目（统一不泄露）
//   - 400 VALIDATION_ERROR：空名 / 非字符串名（RenameValidationError 由 service 抛）
//   - 200 成功：调 renameAsset 并把其结果原样装入 envelope.data
//   - 业务错误（RenameValidationError）转 400 envelope；未知错误交 handleApiError
//
// mock：@dramaforge/server（projectRepo.getById/getAsset/renameAsset/RenameValidationError）
//       + getServerSession（DEFAULT_SESSION / null）
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../../../../test/helpers';
import { POST } from '../route';

/** 构造一条 projectRepo.getById 返回值（ownerId 默认 user-1） */
function makeProject(over: Partial<{ id: string; userId: string }> = {}) {
  return { id: 'proj-1', userId: 'user-1', ...over };
}

/** 构造一条 getAsset 返回值（projectId 默认 proj-1） */
function makeAsset(over: Partial<{ id: string; projectId: string; kind: string; name: string }> = {}) {
  return {
    id: 'ast-1',
    projectId: 'proj-1',
    kind: 'CHARACTER',
    name: '林夏',
    ...over,
  };
}

describe('POST /api/projects/[id]/assets/[assetId]/rename', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.getAsset.mockReset();
    serverMock.renameAsset.mockReset();
  });

  it('401 when unauthenticated (does not call renameAsset)', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1/rename',
      body: { name: '纪云深' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(401);
    expect(serverMock.renameAsset).not.toHaveBeenCalled();
  });

  it('404 when project not owned by current user', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-x/assets/ast-1/rename',
      body: { name: '纪云深' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-x', assetId: 'ast-1' }));
    expect(res.status).toBe(404);
    expect(serverMock.getAsset).not.toHaveBeenCalled();
    expect(serverMock.renameAsset).not.toHaveBeenCalled();
  });

  it('404 when project owned by another user (unified NOT_FOUND, no existence leak)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject({ userId: 'other-user' }));
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1/rename',
      body: { name: '纪云深' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(404);
    expect(serverMock.renameAsset).not.toHaveBeenCalled();
  });

  it('404 when asset does not exist', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.getAsset.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-x/rename',
      body: { name: '纪云深' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-x' }));
    expect(res.status).toBe(404);
    expect(serverMock.renameAsset).not.toHaveBeenCalled();
  });

  it('404 when asset belongs to a different project', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.getAsset.mockResolvedValue(makeAsset({ projectId: 'proj-other' }));
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1/rename',
      body: { name: '纪云深' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(404);
    expect(serverMock.renameAsset).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR when service throws RenameValidationError (empty name)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.getAsset.mockResolvedValue(makeAsset());
    // 用真实 class 实例保证 route 内的 instanceof 检查通过
    serverMock.renameAsset.mockRejectedValue(
      new serverMock.RenameValidationError('新名字不能为空'),
    );
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1/rename',
      body: { name: '   ' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as {
      success: boolean;
      error: string;
      code: string;
      category: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.category).toBe('validation');
    expect(body.error).toContain('新名字');
    expect(serverMock.renameAsset).toHaveBeenCalledWith('proj-1', 'ast-1', '   ');
  });

  it('400 when body is not an object (name defaults to empty → service 400)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.getAsset.mockResolvedValue(makeAsset());
    serverMock.renameAsset.mockRejectedValue(
      new serverMock.RenameValidationError('新名字不能为空'),
    );
    // 强制走 raw={} 分支：makeRequest 会 JSON.stringify，传 undefined 不写 body 字段
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1/rename',
      body: { foo: 'bar' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(400);
    expect(serverMock.renameAsset).toHaveBeenCalledWith('proj-1', 'ast-1', '');
  });

  it('200 success: returns envelope with renameAsset result', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.getAsset.mockResolvedValue(makeAsset());
    const result = {
      assetId: 'ast-1',
      oldName: '林夏',
      newName: '纪云深',
      counts: { assets: 3, episodes: 5, shots: 12, storyboards: 0, tasks: 2 },
    };
    serverMock.renameAsset.mockResolvedValue(result);

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1/rename',
      body: { name: '纪云深' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: typeof result;
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(result);
    expect(serverMock.renameAsset).toHaveBeenCalledTimes(1);
    expect(serverMock.renameAsset).toHaveBeenCalledWith('proj-1', 'ast-1', '纪云深');
  });

  it('200 with extra body fields tolerated (only name forwarded)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.getAsset.mockResolvedValue(makeAsset());
    serverMock.renameAsset.mockResolvedValue({
      assetId: 'ast-1',
      oldName: '林夏',
      newName: '纪云深',
      counts: { assets: 1, episodes: 0, shots: 0, storyboards: 0, tasks: 0 },
    });
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1/rename',
      body: { name: '纪云深', extra: 'ignored', count: 42 },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(200);
    // 只把 name 字段透传给 service
    expect(serverMock.renameAsset).toHaveBeenCalledWith('proj-1', 'ast-1', '纪云深');
  });

  it('500 when service throws unknown error (handled by handleApiError)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.getAsset.mockResolvedValue(makeAsset());
    serverMock.renameAsset.mockRejectedValue(new Error('connection lost'));
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1/rename',
      body: { name: '纪云深' },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(500);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});
