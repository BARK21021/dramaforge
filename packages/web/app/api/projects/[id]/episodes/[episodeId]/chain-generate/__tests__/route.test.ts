// ============================================================
// /api/projects/[id]/episodes/[episodeId]/chain-generate — 契约测试（批8 R6/R7）
// ============================================================
//
// 覆盖批8 R6/R7 增量：
//   R6: input.filmMeta 透传 projectId/episodeId/episodeNumber/episodeTitle/
//       projectTitle/shotCount/totalDuration（dispatchChainGenerate 调用参数校验）
//   R7: 同 episodeId 有活跃 render_job → 返 202 + reused:true（不重复派发）
//
// 也覆盖基本 ownership + NO_SHOTS（回归保护）。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../../../test/mocks';
import { makeRequest, makeParamsCtx, readJson } from '../../../../../../../../test/helpers';
import { POST } from '../route';
import type { EpisodeRecord, ProjectRecord } from '@dramaforge/shared';
import type { RenderJob } from '@dramaforge/shared';

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

function makeEpisode(over: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: 'ep-1',
    projectId: 'proj-1',
    episodeNumber: 1,
    title: '第 1 集',
    content: null,
    contentKilo: null,
    status: 'PENDING',
    defaultVisualStyle: null,
    scenes: null,
    emotionArc: null,
    videoScriptDraft: null,
    novelText: null,
    stageStatus: 'input',
    scriptData: null,
    sortOrder: 0,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...over,
  };
}

function makeJob(over: Partial<RenderJob> = {}): RenderJob {
  return {
    id: 'job-1',
    taskId: 'task-1',
    userId: 'user-1',
    type: 'CHAIN_COMPILE',
    status: 'PENDING',
    progress: 0,
    stage: null,
    input: { groupResults: [] } as never,
    result: null,
    claimedBy: null,
    claimToken: null,
    error: null,
    createdAt: '2026-07-21T00:00:00.000Z',
    claimedAt: null,
    heartbeatAt: null,
    completedAt: null,
    progressClips: [],
    ...over,
  };
}

const shotsFixture = [
  {
    id: 'shot-1',
    projectId: 'proj-1',
    episodeId: 'ep-1',
    shotIndex: 0,
    sortOrder: 0,
    visualPrompt: '镜头一',
    durationSeconds: 5,
    aspectRatio: '9:16',
    videoStatus: 'PENDING',
    currentMaterialUrl: null,
    createdAt: new Date('2026-07-21T00:00:00.000Z'),
    updatedAt: new Date('2026-07-21T00:00:00.000Z'),
  },
];

describe('POST /api/projects/[id]/episodes/[episodeId]/chain-generate (批8 R6/R7)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.getById.mockReset();
    serverMock.query.mockReset();
    serverMock.dispatchChainGenerate.mockReset();
    serverMock.dispatchChainGenerateOnce.mockReset();
    // 绝大多数旧断言继续观察 input 构造；幂等派发 mock 默认把它转给原 spy。
    serverMock.dispatchChainGenerateOnce.mockImplementation(async (
      taskId: string,
      userId: string,
      input: never,
    ) => ({
      job: await serverMock.dispatchChainGenerate(taskId, userId, input),
      reused: false,
    }));
    serverMock.listShots.mockReset();
    serverMock.listAssets.mockReset();
    serverMock.updateShot.mockReset();
  });

  it('401 when unauthenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(401);
  });

  it('404 when project not owned', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-x/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-x', episodeId: 'ep-1' }));
    expect(res.status).toBe(404);
  });

  it('400 NO_SHOTS when episode has no shots', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7 active job check
    serverMock.listShots.mockResolvedValue([]); // listShots 返空

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { code: string };
    expect(body.code).toBe('NO_SHOTS');
  });

  it('R7: 202 reused:true when active job exists for same episodeId', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerateOnce.mockResolvedValue({
      reused: true,
      job: makeJob({ id: 'active-job-1', taskId: 'active-task-1' }),
    });

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(202);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { reused: boolean; renderJobId: string; taskId: string };
    };
    expect(body.data.reused).toBe(true);
    expect(body.data.renderJobId).toBe('active-job-1');
    // 复用必须返回既有 taskId；否则 UI 虽拿到 jobId，却无法接管 SSE/轮询。
    expect(body.data.taskId).toBe('active-task-1');
    expect(serverMock.dispatchChainGenerate).not.toHaveBeenCalled();
    expect(serverMock.listShots).toHaveBeenCalledWith('proj-1', 'ep-1');
  });

  it('R7: delegates the final create-or-reuse decision with complete filmMeta', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7 active job check
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    expect(serverMock.dispatchChainGenerateOnce).toHaveBeenCalledTimes(1);
    expect(serverMock.dispatchChainGenerateOnce.mock.calls[0][2]).toMatchObject({
      filmMeta: { projectId: 'proj-1', episodeId: 'ep-1', shotCount: 1 },
    });
  });

  it('approved 锁定的组即使 STALE 也跳过 LLM 重写、只用锁定提示词', async () => {
    serverMock.callAI.mockReset();
    const approvedShot = {
      ...shotsFixture[0],
      id: 'shot-1',
      visualPrompt: '镜头一',
      durationSeconds: 5,
      sortOrder: 0,
      metadata: {
        seedanceGroupPrompt: 'LOCKED PROMPT 正文',
        seedanceGroupPromptVersion: 1, // 故意错版本 → STALE（正常应触发重写）
        seedanceGroupPromptShotIds: ['shot-1'],
        seedanceGroupPromptContextHash: 'stale-hash',
        seedanceGroupPromptSource: 'user',
        seedanceGroupPromptRewritten: true,
        seedanceGroupPromptApproved: true, // 用户已认可锁定
      },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7 active job check
    serverMock.listShots.mockResolvedValue([approvedShot]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    // approved 锁定 → 不调 LLM 重写（不要反复花 LLM）
    expect(serverMock.callAI).not.toHaveBeenCalled();
    // 派发的提示词用的是锁定的 LOCKED PROMPT（而非现算的 prepared）
    const input = serverMock.dispatchChainGenerateOnce.mock.calls[0][2] as never as {
      groupResults: Array<{ params: { prompt: string } }>;
    };
    expect(input.groupResults[0].params.prompt).toContain('LOCKED PROMPT 正文');
  });

  it('未认可且 STALE 的组照常调 LLM 重写（向后兼容）', async () => {
    serverMock.callAI.mockReset();
    const staleShot = {
      ...shotsFixture[0],
      id: 'shot-1',
      visualPrompt: '镜头一',
      durationSeconds: 5,
      sortOrder: 0,
      metadata: {
        seedanceGroupPrompt: '旧提示词',
        seedanceGroupPromptVersion: 1, // STALE
        seedanceGroupPromptShotIds: ['shot-1'],
        seedanceGroupPromptContextHash: 'stale-hash',
        seedanceGroupPromptSource: 'auto',
        seedanceGroupPromptRewritten: true,
        seedanceGroupPromptApproved: false, // 未认可
      },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([staleShot]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    // 未认可 + STALE → 照常调 LLM 重写（行为不变）
    expect(serverMock.callAI).toHaveBeenCalled();
  });

  it('shotIds 子集只派发目标镜头，并按服务端顺序记录计费范围', async () => {
    const scopedShots = [
      { ...shotsFixture[0], id: 'shot-1', visualPrompt: '镜头一', durationSeconds: 5, sortOrder: 0 },
      { ...shotsFixture[0], id: 'shot-2', visualPrompt: '镜头二', durationSeconds: 6, sortOrder: 1 },
      { ...shotsFixture[0], id: 'shot-3', visualPrompt: '镜头三', durationSeconds: 8, sortOrder: 2 },
    ];
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue(scopedShots);
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      // 客户端顺序故意反转；route 必须恢复该集权威 sortOrder 顺序。
      body: { shotIds: ['shot-3', 'shot-1'] },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{
        shotIds: string[];
        params: { prompt: string; duration: number };
      }>;
      filmMeta: {
        shotIds?: string[];
        shotCount: number;
        totalDuration: number;
      };
    };
    expect(input.groupResults).toHaveLength(1);
    expect(input.groupResults[0].params.prompt).toContain('### 当前生成组分镜');
    expect(input.groupResults[0].params.prompt).toContain('镜头一');
    expect(input.groupResults[0].params.prompt).toContain('镜头三');
    // C/S 客户端必须拿到服务器权威分组范围，完成后才能把组片映射回正确镜头。
    expect(input.groupResults.map((group) => group.shotIds)).toEqual([
      ['shot-1', 'shot-3'],
    ]);
    expect(input.filmMeta).toMatchObject({
      shotIds: ['shot-1', 'shot-3'],
      shotCount: 2,
      totalDuration: 13,
    });
    const responseBody = (await readJson(res)) as { data: { groupCount: number } };
    expect(responseBody.data.groupCount).toBe(1);
  });

  it('拒绝空、非字符串或重复的 shotIds，不查询任务也不派发', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());

    for (const shotIds of [[], ['shot-1', 42], ['shot-1', 'shot-1']]) {
      const req = makeRequest({
        method: 'POST',
        url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
        body: { shotIds },
      });
      const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
      expect(res.status).toBe(400);
      const body = (await readJson(res)) as { code: string };
      expect(body.code).toBe('INVALID_SHOT_IDS');
    }

    expect(serverMock.listShots).not.toHaveBeenCalled();
    expect(serverMock.query).not.toHaveBeenCalled();
    expect(serverMock.dispatchChainGenerate).not.toHaveBeenCalled();
  });

  it('拒绝不属于当前项目分集的镜头 ID，且不进入计费派发', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue(shotsFixture);

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: { shotIds: ['shot-from-another-episode'] },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { code: string };
    expect(body.code).toBe('INVALID_SHOT_IDS');
    expect(serverMock.query).not.toHaveBeenCalled();
    expect(serverMock.listAssets).not.toHaveBeenCalled();
    expect(serverMock.dispatchChainGenerate).not.toHaveBeenCalled();
  });

  it('接受 force/parallel 参数并固化客户端执行策略', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: { force: true, parallelMode: 'fast', parallelConcurrency: 4 },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.dispatchChainGenerate.mock.calls[0][2]).toMatchObject({
      execution: { mode: 'parallel', concurrency: 4 },
    });
  });

  it('拒绝非法并行模式与并发数', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    for (const [bodyValue, code] of [
      [{ parallelMode: 'turbo' }, 'INVALID_PARALLEL_MODE'],
      [{ parallelConcurrency: 0 }, 'INVALID_PARALLEL_CONCURRENCY'],
      [{ parallelConcurrency: 13 }, 'INVALID_PARALLEL_CONCURRENCY'],
    ] as const) {
      const res = await POST(makeRequest({ method: 'POST', body: bodyValue }), makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
      expect(res.status).toBe(400);
      expect(((await readJson(res)) as { code: string }).code).toBe(code);
    }
  });

  it('R6: dispatchChainGenerate called with filmMeta in input', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7 active job check
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.listAssets.mockResolvedValue([]); // P7.6 happy path: no CHARACTER assets
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    expect(serverMock.dispatchChainGenerate).toHaveBeenCalledTimes(1);
    const callArgs = serverMock.dispatchChainGenerate.mock.calls[0];
    // dispatchChainGenerate(taskId, userId, input)
    const input = callArgs[2] as {
      filmMeta?: Record<string, unknown>;
      groupResults: Array<{ params?: Record<string, unknown> }>;
    };
    expect(input.filmMeta).toBeDefined();
    expect(input.filmMeta?.projectId).toBe('proj-1');
    expect(input.filmMeta?.episodeId).toBe('ep-1');
    expect(input.filmMeta?.episodeNumber).toBe(1);
    expect(input.filmMeta?.episodeTitle).toBe('第 1 集');
    expect(input.filmMeta?.projectTitle).toBe('我的剧');
    expect(input.filmMeta?.shotCount).toBe(1);
    expect(input.filmMeta?.totalDuration).toBe(5);
    expect(input.filmMeta?.shotIds).toBeUndefined();
    // 已安装的旧 1.1.6 客户端会原样转发 params；服务器派发时必须预埋累计计费标识，
    // 不能要求用户为了正确扣费重新安装同版本客户端。
    expect(input.groupResults[0].params).toMatchObject({
      billingTaskId: callArgs[0],
      billingUnitId: '0',
    });
  });

  it('R6: totalDuration sums shot durations', async () => {
    const multiShots = [
      { ...shotsFixture[0], id: 'shot-1', durationSeconds: 5 },
      { ...shotsFixture[0], id: 'shot-2', durationSeconds: 10 },
      { ...shotsFixture[0], id: 'shot-3', durationSeconds: 15 },
    ];
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7
    serverMock.listShots.mockResolvedValue(multiShots);
    serverMock.listAssets.mockResolvedValue([]); // P7.6 happy path: no CHARACTER assets
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      filmMeta: { totalDuration: number; shotCount: number };
    };
    expect(input.filmMeta.totalDuration).toBe(30);
    expect(input.filmMeta.shotCount).toBe(3);
  });

  // ============================================================
  // 批8 P7.6：网格叠加端到端激活 — characterReferenceImageUrls + gridEnabled 注入
  // ============================================================
  //
  // 覆盖：
  //   - 命中：shot.referencedAssets.characters 里的角色名匹配 listAssets('CHARACTER')
  //     返回的、gridOverlayEnabled=true 且 imageUrl 非空的资产 → 该组 params 注入
  //     characterReferenceImageUrls=[sf-asset://...] + gridEnabled:true。
  //   - 去重：同一 imageUrl 只出现一次（即便多个角色名命中同一资产）。
  //   - 归一化匹配：忽略大小写/分隔符。
  //   - 默认路径保护：无 gridOverlayEnabled 资产 → params 不出现这两字段。
  //   - null imageUrl 跳过：gridOverlayEnabled=true 但 imageUrl=null 不混入。
  //   - 镜头无 referencedAssets：默认路径不变。
  //   - 安全失败：listAssets 抛错且镜头声明人物 → 阻止派发，避免丢失角色一致性。
  // ============================================================

  it('P7.6: listAssets reads all reference asset kinds in one query', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    expect(serverMock.listAssets).toHaveBeenCalledWith('proj-1');
  });

  it('P7.6: shot referencing a grid-overlay CHARACTER asset injects urls + gridEnabled', async () => {
    const shotWithChars = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林夏'] },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7
    serverMock.listShots.mockResolvedValue([shotWithChars]);
    serverMock.listAssets.mockResolvedValue([
      {
        id: 'asset-1',
        projectId: 'proj-1',
        kind: 'CHARACTER',
        name: '林夏',
        description: null,
        imageUrl: 'sf-asset://linxia-design.png',
        metadata: null,
        tags: null,
        folderId: null,
        version: 1,
        assetType: null,
        basePrompt: null,
        isConfirmed: true,
        characterId: null,
        regenLocked: false,
        background: null,
        identityLock: null,
        significance: null,
        intExt: null,
        mood: null,
        baseAmbience: null,
        coverageScenes: null,
        costumes: null,
        relationships: null,
        voiceTrait: null,
        gridOverlayEnabled: true,
        pencilPaintEnabled: null,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
      },
    ]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ shotIds: string[]; params: Record<string, unknown> }>;
    };
    expect(input.groupResults.length).toBe(1);
    expect(input.groupResults[0].params.characterReferenceImageUrls).toEqual([
      'sf-asset://linxia-design.png',
    ]);
    expect(input.groupResults[0].params.gridEnabled).toBe(true);
  });

  it('binds a speaking character confirmed voice to Seedance reference_audio order', async () => {
    const shotWithVoice = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['Martha'], speakingCharacters: ['Martha'] },
      metadata: { dialogue: 'Give me the key.' },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject({ category: 'OVERSEAS' }));
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shotWithVoice]);
    serverMock.listAssets.mockResolvedValue([{
      id: 'asset-martha',
      projectId: 'proj-1',
      kind: 'CHARACTER',
      name: 'Martha',
      imageUrl: 'sf-asset://martha.png',
      metadata: {
        confirmed_voice: {
          file: 'female_001_warm.wav',
          desc: 'warm mature voice',
          gender: 'female',
        },
      },
      voiceId: null,
      gridOverlayEnabled: false,
      pencilPaintEnabled: false,
    }]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.referenceAudioFiles).toEqual([
      'female_001_warm.wav',
    ]);
    expect(input.groupResults[0].params.characterReferenceImageUrls).toEqual([
      'sf-asset://martha.png',
    ]);
    expect(input.groupResults[0].params.prompt).toContain('### 当前生成组分镜');
  });

  it('binds a non-human ENTITY speaker voice without treating it as a human character image', async () => {
    const shotWithEntityVoice = {
      ...shotsFixture[0],
      referencedAssets: { speakingCharacters: ['星舰主控'] },
      metadata: { dialogue: '航线已经锁定。' },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shotWithEntityVoice]);
    serverMock.listAssets.mockResolvedValue([{
      id: 'entity-core',
      projectId: 'proj-1',
      kind: 'ENTITY',
      name: '星舰主控',
      imageUrl: 'sf-asset://ship-core.png',
      metadata: {
        confirmed_voice: {
          file: 'neutral_ai.wav',
          desc: '冷静电子音',
          gender: 'neutral',
        },
      },
      voiceId: null,
      gridOverlayEnabled: false,
      pencilPaintEnabled: false,
    }]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.referenceAudioFiles).toEqual([
      'neutral_ai.wav',
    ]);
    expect(input.groupResults[0].params.characterReferenceImageUrls).toBeUndefined();
    expect(input.groupResults[0].params.prompt).toContain('### 当前生成组分镜');
  });

  it('P7.6: name match is normalize-insensitive (case + separators)', async () => {
    // shot 引用 "林 夏"（带空格），资产名是 "林夏" — 归一化后应命中
    const shotWithChars = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林 夏'] },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shotWithChars]);
    serverMock.listAssets.mockResolvedValue([
      {
        ...({} as Record<string, unknown>),
        id: 'asset-1',
        projectId: 'proj-1',
        kind: 'CHARACTER',
        name: '林夏',
        imageUrl: 'sf-asset://linxia.png',
        gridOverlayEnabled: true,
        isConfirmed: true,
        regenLocked: false,
        version: 1,
      },
    ]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.characterReferenceImageUrls).toEqual([
      'sf-asset://linxia.png',
    ]);
  });

  it('P7.6: dedupes same imageUrl when multiple character names hit one asset', async () => {
    // 两个名字归一化后都命中同一资产 → 只输出一次 imageUrl
    const shotWithChars = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林夏', '林 夏'] },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shotWithChars]);
    serverMock.listAssets.mockResolvedValue([
      {
        id: 'asset-1',
        projectId: 'proj-1',
        kind: 'CHARACTER',
        name: '林夏',
        imageUrl: 'sf-asset://linxia.png',
        gridOverlayEnabled: true,
        isConfirmed: true,
        regenLocked: false,
        version: 1,
      },
    ]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.characterReferenceImageUrls).toEqual([
      'sf-asset://linxia.png',
    ]);
  });

  it('restores cached pencil references to photorealism instead of leaking the pencil style', async () => {
    const shotWithChars = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林夏'] },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shotWithChars]);
    serverMock.listAssets.mockResolvedValue([{
      id: 'asset-1',
      projectId: 'proj-1',
      kind: 'CHARACTER',
      name: '林夏',
      imageUrl: 'sf-asset://linxia.png',
      pencilImageUrl: 'sf-asset://linxia-pencil.png',
      pencilPaintEnabled: true,
      gridOverlayEnabled: true,
      isConfirmed: true,
      regenLocked: false,
      version: 1,
    }]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.characterReferenceImageUrls).toEqual([
      'sf-asset://linxia-pencil.png',
    ]);
    expect(input.groupResults[0].params.prompt).toContain('所有资产需还原为写实照片风格');
  });

  it('P7.6: CHARACTER always forces grid even when its legacy toggle is false', async () => {
    const shotWithChars = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林夏'] },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shotWithChars]);
    serverMock.listAssets.mockResolvedValue([
      {
        id: 'asset-1',
        projectId: 'proj-1',
        kind: 'CHARACTER',
        name: '林夏',
        imageUrl: 'sf-asset://linxia.png',
        gridOverlayEnabled: false,
        isConfirmed: true,
        regenLocked: false,
        version: 1,
      },
    ]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.characterReferenceImageUrls).toEqual([
      'sf-asset://linxia.png',
    ]);
    expect(input.groupResults[0].params.gridEnabled).toBe(true);
    expect(input.groupResults[0].params.gridCells).toBe(100);
  });

  it('automatically splits a group before its combined character references exceed the model limit', async () => {
    // 角色动态上限 = MAX_REFERENCE_IMAGES(9) − 环境保底 − 物品保底；无环境/物品声明时
    // cap = min(MAX_REFERENCE_CHARACTERS=4, 9) = 4。分组器按 4 拆：4+4=8 > 4 → 两组。
    const characterNames = ['角色一', '角色二', '角色三', '角色四', '角色五', '角色六', '角色七', '角色八'];
    const shotsWithManyCharacters = [
      {
        ...shotsFixture[0],
        id: 'shot-1',
        durationSeconds: 2,
        sortOrder: 0,
        referencedAssets: { characters: characterNames.slice(0, 4) },
      },
      {
        ...shotsFixture[0],
        id: 'shot-2',
        durationSeconds: 2,
        sortOrder: 1,
        referencedAssets: { characters: characterNames.slice(4) },
      },
    ];
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue(shotsWithManyCharacters);
    serverMock.listAssets.mockResolvedValue(characterNames.map((name, index) => ({
      id: `asset-${index + 1}`,
      projectId: 'proj-1',
      kind: 'CHARACTER',
      name,
      imageUrl: `sf-asset://character-${index + 1}.png`,
      metadata: null,
      gridOverlayEnabled: true,
      pencilPaintEnabled: false,
    })));
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ shotIds: string[]; params: Record<string, unknown> }>;
    };
    expect(input.groupResults).toHaveLength(2);
    expect(input.groupResults[0].params.characterReferenceImageUrls).toHaveLength(4);
    expect(input.groupResults[1].params.characterReferenceImageUrls).toHaveLength(4);
    expect(input.groupResults.map((group) => group.shotIds)).toEqual([
      ['shot-1'],
      ['shot-2'],
    ]);
    expect(input.groupResults.every(
      (group) => String(group.params.prompt).includes('### 当前生成组分镜'),
    )).toBe(true);
  });

  it('角色超出动态上限但全部有图时不再误报，按 cap 截断后正常生成', async () => {
    // 单镜 8 角色全有图：分组器无法拆单镜 → 一组 8 角色；prepare cap=6（2026-08-12
    // 解除 4 限制）截到 6，route 校验独立判断全有图 → 不报 CHARACTER_GRID_REFERENCE_REQUIRED。
    const characterNames = ['角色一', '角色二', '角色三', '角色四', '角色五', '角色六', '角色七', '角色八'];
    const shot = {
      ...shotsFixture[0],
      id: 'shot-1',
      durationSeconds: 2,
      sortOrder: 0,
      referencedAssets: { characters: characterNames },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shot]);
    serverMock.listAssets.mockResolvedValue(characterNames.map((name, index) => ({
      id: `asset-${index + 1}`,
      projectId: 'proj-1',
      kind: 'CHARACTER',
      name,
      imageUrl: `sf-asset://character-${index + 1}.png`,
      metadata: null,
      gridOverlayEnabled: true,
      pencilPaintEnabled: false,
    })));
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.dispatchChainGenerate).toHaveBeenCalled();
    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults).toHaveLength(1);
    expect(input.groupResults[0].params.characterReferenceImageUrls).toHaveLength(6);
  });

  it('P7.6: blocks a character shot when the asset has no image', async () => {
    const shotWithChars = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林夏'] },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shotWithChars]);
    serverMock.listAssets.mockResolvedValue([
      {
        id: 'asset-1',
        projectId: 'proj-1',
        kind: 'CHARACTER',
        name: '林夏',
        imageUrl: null,
        gridOverlayEnabled: true,
        isConfirmed: true,
        regenLocked: false,
        version: 1,
      },
    ]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(400);
    expect((await readJson(res) as { code: string }).code).toBe('CHARACTER_GRID_REFERENCE_REQUIRED');
    expect(serverMock.dispatchChainGenerate).not.toHaveBeenCalled();
  });

  it('P7.6: shot without referencedAssets → params unchanged (default path)', async () => {
    // shotsFixture 没有 referencedAssets 字段 → 默认路径
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.listAssets.mockResolvedValue([
      {
        id: 'asset-1',
        projectId: 'proj-1',
        kind: 'CHARACTER',
        name: '林夏',
        imageUrl: 'sf-asset://linxia.png',
        gridOverlayEnabled: true,
        isConfirmed: true,
        regenLocked: false,
        version: 1,
      },
    ]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.characterReferenceImageUrls).toBeUndefined();
    expect(input.groupResults[0].params.gridEnabled).toBeUndefined();
    // 核心字段仍在
    expect(input.groupResults[0].params.model).toBe('ark/doubao-seedance-2-0-260128');
    expect(input.groupResults[0].params.resolution).toBe('720p');
    expect(input.groupResults[0].params.generateAudio).toBe(true);
  });

  it('uses the scene costume variant image selected by costumeMap in downstream generation', async () => {
    const shotWithCostume = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林夏'] },
      metadata: { sceneId: 'scene-7' },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject({
      scriptData: {
        // Legacy project rows reuse S1/S2 across episodes and must not override
        // the current episode's authoritative selection below.
        costumeMap: [{ sceneId: 'scene-7', character: '林夏', costumeLabel: '便装' }],
      },
    }));
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode({
      scriptData: {
        costumeMap: [{ sceneId: 'scene-7', character: '林夏', costumeLabel: '礼服' }],
      },
    }));
    serverMock.listShots.mockResolvedValue([shotWithCostume]);
    serverMock.listAssets.mockResolvedValue([{
      id: 'asset-linxia',
      projectId: 'proj-1',
      kind: 'CHARACTER',
      name: '林夏',
      imageUrl: 'sf-asset://linxia-default.png',
      pencilImageUrl: 'sf-asset://linxia-pencil.png',
      costumes: [
        { key: 'default', label: '便装', imageUrl: 'sf-asset://linxia-default.png' },
        { key: 'formal', label: '礼服', imageUrl: 'sf-asset://linxia-formal.png' },
      ],
      metadata: null,
      gridOverlayEnabled: true,
      pencilPaintEnabled: true,
    }]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.characterReferenceImageUrls).toEqual([
      'sf-asset://linxia-formal.png',
    ]);
    expect(input.groupResults[0].params.prompt).toContain('林夏');
    expect(input.groupResults[0].params.prompt).not.toContain('所有资产需还原为写实照片风格');
  });

  it('falls back to the default image when a script-selected costume variant has no persisted image', async () => {
    const shotWithCostume = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林夏'] },
      metadata: { sceneId: 'scene-7' },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode({
      scriptData: {
        costumeMap: [{ sceneId: 'scene-7', character: '林夏', costumeLabel: '礼服' }],
      },
    }));
    serverMock.listShots.mockResolvedValue([shotWithCostume]);
    serverMock.listAssets.mockResolvedValue([{
      id: 'asset-linxia',
      projectId: 'proj-1',
      kind: 'CHARACTER',
      name: '林夏',
      imageUrl: 'sf-asset://linxia-default.png',
      costumes: [{ key: 'formal', label: '礼服', imageUrl: null }],
      metadata: null,
      gridOverlayEnabled: true,
      pencilPaintEnabled: false,
    }]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    // 对齐 app1 group-prompt.ts：礼服变体图缺失时回退到角色默认图继续生成，不再 409 拦截。
    expect(res.status).toBe(200);
    expect(serverMock.dispatchChainGenerate).toHaveBeenCalled();
    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params.characterReferenceImageUrls).toEqual([
      'sf-asset://linxia-default.png',
    ]);
  });

  it('persists a missing group prompt before dispatching the render job', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.updateShot.mockResolvedValue(undefined);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.updateShot).toHaveBeenCalledTimes(1);
    expect(serverMock.updateShot.mock.invocationCallOrder[0]).toBeLessThan(
      serverMock.dispatchChainGenerateOnce.mock.invocationCallOrder[0],
    );

    const metadata = serverMock.updateShot.mock.calls[0][1].metadata as Record<string, unknown>;
    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: { prompt: string } }>;
    };
    expect(serverMock.updateShot.mock.calls[0][0]).toBe('shot-1');
    expect(metadata.seedanceGroupPrompt).toBe(input.groupResults[0].params.prompt);
    expect(metadata.seedanceGroupPromptVersion).toBe(4);
    expect(metadata.seedanceGroupPromptShotIds).toEqual(['shot-1']);
    expect(metadata.seedanceGroupPromptContextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.seedanceGroupPromptSource).toBe('auto');
  });

  it('respects a stale user-edited group prompt verbatim and dispatches (user version is authoritative, never silently rewritten)', async () => {
    const shotWithStaleCustomPrompt = {
      ...shotsFixture[0],
      metadata: {
        seedanceGroupPrompt: '用户手动编辑的提示词',
        seedanceGroupPromptVersion: 2,
        seedanceGroupPromptShotIds: ['shot-1'],
        seedanceGroupPromptContextHash: 'stale-context',
        seedanceGroupPromptSource: 'user',
      },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue([shotWithStaleCustomPrompt]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.updateShot.mockResolvedValue(undefined);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    // source='user'（用户手改）即使 contextHash 漂移（stale）也原样尊重：不 LLM 重写、
    // 不 updateShot 覆盖用户版本，直接用用户提示词派发渲染任务（兑现「生成时不要再改提示词了」）。
    expect(res.status).toBe(200);
    expect(serverMock.dispatchChainGenerate).toHaveBeenCalled();
    // 关键：不调 updateShot 覆盖——用户版本是权威，不因过期被偷偷重生成（source 回不到 auto）。
    expect(serverMock.updateShot).not.toHaveBeenCalled();
    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: { prompt: string } }>;
    };
    expect(input.groupResults[0].params.prompt).toBe('用户手动编辑的提示词');
  });

  it('forwards enhancement, grid and transition parameters exactly', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {
        enhancementPrompt: '雨夜电影质感',
        gridEnabled: true,
        gridCells: 144,
        gridOpacity: 0.35,
        gridStrokeWidth: 2.5,
        transition: 'match cut',
      },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(200);

    const input = serverMock.dispatchChainGenerate.mock.calls[0][2] as {
      groupResults: Array<{ params: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].params).toMatchObject({
      gridEnabled: true,
      gridCells: 144,
      gridOpacity: 0.35,
      gridStrokeWidth: 2.5,
      transition: 'match cut',
      pencilPaintingMode: false,
    });
    expect(input.groupResults[0].params.prompt).toContain('用户增强要求：雨夜电影质感');
  });

  it('rejects the unimplemented pencil pipeline instead of generating the opposite visual style', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.listShots.mockResolvedValue(shotsFixture);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {
        enhancementPrompt: '雨夜电影质感',
        gridEnabled: true,
        gridCells: 144,
        gridOpacity: 0.35,
        gridStrokeWidth: 2.5,
        transition: 'match cut',
        pencilPaintingMode: true,
      },
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      success: false,
      code: 'PENCIL_PIPELINE_UNAVAILABLE',
    });
    expect(serverMock.dispatchChainGenerateOnce).not.toHaveBeenCalled();
    expect(serverMock.dispatchChainGenerate).not.toHaveBeenCalled();
  });

  it('P7.6: listAssets failure blocks a declared character shot', async () => {
    const shotWithChars = {
      ...shotsFixture[0],
      referencedAssets: { characters: ['林夏'] },
    };
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] });
    serverMock.listShots.mockResolvedValue([shotWithChars]);
    serverMock.listAssets.mockRejectedValue(new Error('db down'));
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));
    expect(res.status).toBe(400);
    expect((await readJson(res) as { code: string }).code).toBe('CHARACTER_GRID_REFERENCE_REQUIRED');
    expect(serverMock.dispatchChainGenerate).not.toHaveBeenCalled();
  });

  it('Ep24/25 403 回归：ARK 临时签名 URL 不得复用，强制重新生成', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7 active job check
    const arkShot = {
      ...shotsFixture[0],
      videoStatus: 'COMPLETED',
      currentMaterialUrl:
        'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0/expired-signature.mp4?X-Amz-Expires=3600',
      metadata: { seedanceGroupPromptVersion: 4 },
    };
    serverMock.listShots.mockResolvedValue([arkShot]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    expect(res.status).toBe(200);
    const input = serverMock.dispatchChainGenerateOnce.mock.calls[0][2] as {
      groupResults: Array<{ url: string; params?: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].url).toBe('');
    expect(input.groupResults[0].params).toBeDefined();
  });

  it('sf-asset:// 本地成片 URL 可复用（不重新生成）', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.episodeRepo.getById.mockResolvedValue(makeEpisode());
    serverMock.query.mockResolvedValueOnce({ rows: [] }); // R7 active job check
    const localShot = {
      ...shotsFixture[0],
      videoStatus: 'COMPLETED',
      currentMaterialUrl: 'sf-asset://job-1-group-1.mp4',
      metadata: {
        seedanceGroupPrompt: '本组已锁定台词',
        seedanceGroupPromptVersion: 4,
      },
    };
    serverMock.listShots.mockResolvedValue([localShot]);
    serverMock.listAssets.mockResolvedValue([]);
    serverMock.dispatchChainGenerate.mockResolvedValue(makeJob());

    const req = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/proj-1/episodes/ep-1/chain-generate',
      body: {},
    });
    const res = await POST(req, makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1' }));

    expect(res.status).toBe(200);
    const input = serverMock.dispatchChainGenerateOnce.mock.calls[0][2] as {
      groupResults: Array<{ url: string; params?: Record<string, unknown> }>;
    };
    expect(input.groupResults[0].url).toBe('sf-asset://job-1-group-1.mp4');
    expect(input.groupResults[0].params).toBeUndefined();
  });
});
