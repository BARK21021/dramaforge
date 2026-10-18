// ============================================================
// /api/projects/[id]/films/[jobId] — 契约测试（批8 Step 6）
// ============================================================
//
// 覆盖 DELETE：
//   - 401 未登录
//   - 404 项目不存在 / 不属当前用户，且不查询成片
//   - 404 render_job 不存在 / 不属当前用户 / 类型非 CONCAT/CHAIN_COMPILE
//   - 200 deleted:true + localKey 透传（前端 IPC removeFilm 用）
//   - 200 deleted:true + localKey:null（result.meta.localKey 缺失）
//
// 双面清理：DB 行由本 route 删，本地文件由前端 IPC removeFilm 删（route 只返 localKey）。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../../../test/helpers';
import { DELETE } from '../route';

interface SelectRow {
  id: string;
  user_id: string;
  type: string;
  result: unknown;
}

describe('DELETE /api/projects/[id]/films/[jobId]', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    // 默认提供当前用户项目，让成片相关用例只关注 render_job 契约。
    serverMock.projectRepo.getById.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
    });
    serverMock.query.mockReset();
  });

  it('401 when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/films/job-1',
    });
    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1', jobId: 'job-1' }));
    expect(res.status).toBe(401);
    expect(serverMock.query).not.toHaveBeenCalled();
  });

  it('404 when project not found', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-x/films/job-1',
    });
    const res = await DELETE(req, makeParamsCtx({ id: 'proj-x', jobId: 'job-1' }));

    expect(res.status).toBe(404);
    expect(serverMock.projectRepo.getById).toHaveBeenCalledWith('proj-x');
    // ownership 未通过时不能探测或删除任何 render_job。
    expect(serverMock.query).not.toHaveBeenCalled();
  });

  it('404 when project belongs to another user', async () => {
    serverMock.projectRepo.getById.mockResolvedValue({
      id: 'proj-1',
      userId: 'other-user',
    });

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/films/job-1',
    });
    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1', jobId: 'job-1' }));

    expect(res.status).toBe(404);
    // 越权和不存在保持相同响应，同时不触碰当前用户的成片记录。
    expect(serverMock.query).not.toHaveBeenCalled();
  });

  it('404 when render_job not found', async () => {
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // SELECT 返空

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/films/job-x',
    });
    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1', jobId: 'job-x' }));
    expect(res.status).toBe(404);
    // 第二次 query（DELETE）不应被调用
    expect(serverMock.query).toHaveBeenCalledTimes(1);
  });

  it('200 + deleted:true + localKey when valid', async () => {
    const row: SelectRow = {
      id: 'job-1',
      user_id: 'user-1',
      type: 'CHAIN_COMPILE',
      result: {
        outputUrl: 'sf-asset://job-1.mp4',
        meta: { localKey: 'job-1.mp4' },
      },
    };
    serverMock.query.mockResolvedValueOnce({ rows: [row] }); // SELECT
    serverMock.query.mockResolvedValueOnce({ rowCount: 1 }); // DELETE

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/films/job-1',
    });
    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1', jobId: 'job-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { deleted: boolean; localKey: string | null };
    };
    expect(body.data.deleted).toBe(true);
    expect(body.data.localKey).toBe('job-1.mp4');
    // 第二次 query 是 DELETE SQL
    const deleteCall = serverMock.query.mock.calls[1];
    const deleteSql = deleteCall[0] as string;
    expect(deleteSql).toMatch(/DELETE FROM render_jobs/);
    expect(deleteCall[1]).toEqual(['job-1', 'user-1']);
  });

  it('200 + localKey:null when result.meta.localKey missing', async () => {
    const row: SelectRow = {
      id: 'job-2',
      user_id: 'user-1',
      type: 'CONCAT',
      result: { outputUrl: 'sf-asset://job-2.mp4' }, // 无 meta.localKey
    };
    serverMock.query.mockResolvedValueOnce({ rows: [row] });
    serverMock.query.mockResolvedValueOnce({ rowCount: 1 });

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/films/job-2',
    });
    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1', jobId: 'job-2' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { deleted: boolean; localKey: string | null };
    };
    expect(body.data.deleted).toBe(true);
    expect(body.data.localKey).toBeNull();
  });

  it('404 when type is not CONCAT/CHAIN_COMPILE (e.g. SPLIT_BY_DURATION)', async () => {
    // SELECT 过滤 type IN (CONCAT, CHAIN_COMPILE)，其他类型返空 → 404
    serverMock.query.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/films/job-split',
    });
    const res = await DELETE(req, makeParamsCtx({ id: 'proj-1', jobId: 'job-split' }));
    expect(res.status).toBe(404);
  });

  it('SELECT filters by jobId + userId + type', async () => {
    serverMock.query.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/films/job-1',
    });
    await DELETE(req, makeParamsCtx({ id: 'proj-1', jobId: 'job-1' }));

    const selectCall = serverMock.query.mock.calls[0];
    const sql = selectCall[0] as string;
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(sql).toMatch(/AND user_id = \$2/);
    expect(sql).toContain("'CONCAT'");
    expect(sql).toContain("'CHAIN_COMPILE'");
    expect(selectCall[1]).toEqual(['job-1', 'user-1']);
  });
});
