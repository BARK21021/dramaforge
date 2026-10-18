// ============================================================
// /api/projects/[id]/films — 契约测试（批8 Step 2）
// ============================================================
//
// 覆盖 GET：
//   - 401 未登录
//   - 404 项目不存在或无权
//   - 200 返当前 project 的成片列表（input.filmMeta.projectId 过滤）
//   - 200 跳过 filmMeta.projectId 不匹配 / outputUrl 缺失 的行
//
// mock 模式照搬 app/api/projects/[id]/__tests__/route.test.ts。
// query mock 返 render_jobs 行（input/result JSONB 已是对象）。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../../test/helpers';
import { GET } from '../route';
import type { ProjectRecord } from '@dramaforge/shared';

function makeProject(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1',
    userId: 'user-1',
    title: '我的剧',
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
    ...over,
  };
}

interface RenderJobRow {
  id: string;
  type: 'CONCAT' | 'CHAIN_COMPILE';
  input: unknown;
  result: unknown;
  created_at: unknown;
}

function makeRow(over: Partial<RenderJobRow> = {}): RenderJobRow {
  return {
    id: 'job-1',
    type: 'CHAIN_COMPILE',
    input: {
      filmMeta: {
        projectId: 'proj-1',
        episodeId: 'ep-1',
        episodeNumber: 1,
        episodeTitle: '第 1 集',
        projectTitle: '我的剧',
        shotCount: 5,
        totalDuration: 60,
      },
    },
    result: {
      outputUrl: 'sf-asset://job-1.mp4',
      meta: { localKey: 'job-1.mp4' },
    },
    created_at: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

describe('GET /api/projects/[id]/films', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.query.mockReset();
    // 默认夹具中的 ep-1 是完整分集；单个测试可覆盖为未完成。
    serverMock.getEpisodesCompletionMap.mockReset().mockResolvedValue(new Map([
      ['ep-1', { total: 5, completed: 5, complete: true }],
    ]));
  });

  it('401 when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(401);
    expect(serverMock.query).not.toHaveBeenCalled();
  });

  it('404 when project missing', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-x/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-x' }));
    expect(res.status).toBe(404);
  });

  it('404 when project owned by another user', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject({ userId: 'other' }));
    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(404);
  });

  it('200 + films filtered by input.filmMeta.projectId', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    // 3 行：1 个 proj-1 成片 + 1 个 proj-2 成片（不返）+ 1 个 outputUrl 缺失（不返）
    serverMock.query.mockResolvedValue({
      rows: [
        makeRow({ id: 'job-1' }),
        makeRow({
          id: 'job-2',
          input: { filmMeta: { projectId: 'proj-2' } },
        }),
        makeRow({
          id: 'job-3',
          result: { meta: { localKey: 'job-3.mp4' } }, // 无 outputUrl
        }),
      ],
    });

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect((body.data[0] as { id: string }).id).toBe('job-1');
  });

  it('200 + empty array when no completed films', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.query.mockResolvedValue({ rows: [] });

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('200 + film record shape (outputUrl + localKey + filmMeta fields)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.query.mockResolvedValue({ rows: [makeRow()] });

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: Array<{
        id: string;
        type: string;
        outputUrl: string;
        localKey: string;
        episodeId: string;
        episodeNumber: number;
        episodeTitle: string;
        projectTitle: string;
        shotCount: number;
        totalDuration: number;
        createdAt: string;
      }>;
    };
    const film = body.data[0];
    expect(film.id).toBe('job-1');
    expect(film.type).toBe('CHAIN_COMPILE');
    expect(film.outputUrl).toBe('sf-asset://job-1.mp4');
    expect(film.localKey).toBe('job-1.mp4');
    expect(film.episodeId).toBe('ep-1');
    expect(film.episodeNumber).toBe(1);
    expect(film.episodeTitle).toBe('第 1 集');
    expect(film.projectTitle).toBe('我的剧');
    expect(film.shotCount).toBe(5);
    expect(film.totalDuration).toBe(60);
  });

  it('200 + skips row with missing filmMeta (historical data)', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    // 历史数据：input 无 filmMeta 字段（批8 之前生成的 render_job）
    serverMock.query.mockResolvedValue({
      rows: [
        makeRow({ id: 'old-job', input: { clips: [] } }),
      ],
    });

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('200 + skips completed render without episode identity', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.query.mockResolvedValue({
      rows: [makeRow({
        id: 'unscoped-job',
        input: { filmMeta: { projectId: 'proj-1' } },
      })],
    });

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('does not expose a scoped render that covers fewer shots than the episode', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.query.mockResolvedValue({
      rows: [
        makeRow({
          id: 'group-job',
          input: {
            filmMeta: {
              projectId: 'proj-1',
              episodeId: 'ep-1',
              // shotIds 只是范围明细；真正边界是本任务只覆盖了整集 5 镜中的 2 镜。
              shotIds: ['shot-1', 'shot-2'],
              shotCount: 2,
            },
          },
        }),
      ],
    });

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    const body = (await readJson(res)) as { success: boolean; data: unknown[] };

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it('keeps an explicitly scoped group out even when it covers every episode shot', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.query.mockResolvedValue({
      rows: [
        makeRow({
          id: 'full-scoped-job',
          input: {
            filmMeta: {
              projectId: 'proj-1',
              episodeId: 'ep-1',
              // C/S 以显式 shotIds 区分镜头组；覆盖全体也仍由后续无范围 CONCAT 进入成片库。
              shotIds: ['shot-1', 'shot-2', 'shot-3', 'shot-4', 'shot-5'],
              shotCount: 5,
            },
          },
        }),
      ],
    });

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    const body = (await readJson(res)) as { success: boolean; data: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it('preserves a completed film even when the episode has unfinished shots (re-run reset)', async () => {
    // 回归：重跑 reset 把已生成镜头退回 PENDING 后，已产出的成片（COMPLETED render_job
    // + outputUrl + shotCount 匹配）必须仍展示，不能被"当前镜头状态"门禁隐藏
    // （原 complete 门禁 → 「重跑后成片库全没了」，4928 连续丢失）。
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.query.mockResolvedValue({ rows: [makeRow({ id: 'preserved-film' })] });
    serverMock.getEpisodesCompletionMap.mockResolvedValue(new Map([
      ['ep-1', { total: 5, completed: 4, complete: false }],
    ]));

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    const body = (await readJson(res)) as { success: boolean; data: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(serverMock.getEpisodesCompletionMap).toHaveBeenCalledWith(['ep-1']);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('preserved-film');
  });

  it('does not expose an old partial export after the episode later becomes complete', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.query.mockResolvedValue({
      rows: [
        makeRow({
          id: 'old-partial-export',
          type: 'CONCAT',
          input: {
            filmMeta: {
              projectId: 'proj-1',
              episodeId: 'ep-1',
              // 该任务只合了 2 镜；当前分集后来已经扩展并完成到 5 镜。
              shotCount: 2,
            },
          },
        }),
      ],
    });
    serverMock.getEpisodesCompletionMap.mockResolvedValue(new Map([
      ['ep-1', { total: 5, completed: 5, complete: true }],
    ]));

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    const res = await GET(req, makeParamsCtx({ id: 'proj-1' }));
    const body = (await readJson(res)) as { success: boolean; data: unknown[] };

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it('query uses userId from session + COMPLETED + CONCAT/CHAIN_COMPILE filter', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.query.mockResolvedValue({ rows: [] });

    const req = makeRequest({ url: 'http://localhost/api/projects/proj-1/films' });
    await GET(req, makeParamsCtx({ id: 'proj-1' }));

    expect(serverMock.query).toHaveBeenCalledTimes(1);
    const call = serverMock.query.mock.calls[0];
    const sql = call[0] as string;
    expect(sql).toContain("'COMPLETED'");
    expect(sql).toContain("'CONCAT'");
    expect(sql).toContain("'CHAIN_COMPILE'");
    expect(call[1]).toEqual(['user-1']); // userId from session
  });
});
