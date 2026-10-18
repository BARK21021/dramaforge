// ============================================================
// storyboard-versions 域单测：归档 / 列表 / 查看 / 删除 / 恢复
// ============================================================
// mock @shared/utils(genId) + @server/infra(query, tx)，与 storyboard.test.ts 同模式。
// archiveCurrentShotsIfAny 接收 q 参数，直接传本地 vi.fn()；其余函数走全局 query/tx mock。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const infraMocks = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  transactionQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'id-' + Math.random().toString(36).slice(2, 8)),
}));
vi.mock('@server/infra', () => ({
  query: infraMocks.query,
  tx: vi.fn(async (fn: (client: { query: typeof infraMocks.transactionQuery }) => unknown) =>
    fn({ query: infraMocks.transactionQuery }),
  ),
}));

import {
  archiveCurrentShotsIfAny,
  listStoryboardVersions,
  getStoryboardVersion,
  deleteStoryboardVersion,
  restoreStoryboardVersion,
} from '../../src/domain/storyboard/storyboard-versions';

const shotRow = {
  id: 'shot-1',
  projectId: 'proj-1',
  episodeId: 'ep-1',
  sceneId: 'S1',
  shotSeq: 'S01-SEG01',
  shotIndex: 1,
  durationSeconds: 5,
  visualPrompt: '近景',
  stylePrompt: null,
  aspectRatio: '9:16',
  resolution: null,
  purposeTag: null,
  emotionArcPosition: null,
  montageType: null,
  audioType: null,
  referencedAssets: null,
  currentMaterialId: 'mat-1',
  currentMaterialUrl: 'sf-asset://x.mp4',
  videoStatus: 'COMPLETED',
  status: 'CONFIRMED',
  sortOrder: 0,
  metadata: { dialogue: '林夏（OS）：放开我！' },
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-02T00:00:00Z'),
};

const snapshotShot = {
  projectId: 'proj-1',
  episodeId: 'ep-1',
  sceneId: 'S1',
  shotSeq: 'S01-SEG01',
  shotIndex: 1,
  durationSeconds: 5,
  visualPrompt: '旧版近景',
  stylePrompt: null,
  aspectRatio: '9:16',
  resolution: null,
  purposeTag: null,
  emotionArcPosition: null,
  montageType: null,
  audioType: null,
  referencedAssets: null,
  currentMaterialId: 'mat-old',
  currentMaterialUrl: 'sf-asset://old.mp4',
  videoStatus: 'COMPLETED',
  status: 'CONFIRMED',
  sortOrder: 0,
  metadata: { dialogue: '旧台词' },
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
};

beforeEach(() => {
  infraMocks.query.mockReset();
  infraMocks.transactionQuery.mockReset();
  infraMocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  infraMocks.transactionQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('archiveCurrentShotsIfAny', () => {
  it('空集 → 不归档，返回 null', async () => {
    const queryMock = vi.fn(async () => ({ rows: [] }));
    const r = await archiveCurrentShotsIfAny({ query: queryMock } as never, 'ep-1');
    expect(r).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1); // 只 SELECT shots，空集直接 return
    expect(String(queryMock.mock.calls[0]?.[0])).toContain('SELECT * FROM shots');
  });

  it('非空 → 插入版本，ordinal=MAX+1', async () => {
    const queryMock = vi.fn();
    queryMock.mockResolvedValueOnce({ rows: [shotRow] }); // SELECT shots
    queryMock.mockResolvedValueOnce({ rows: [{ next: 2 }] }); // SELECT MAX(ordinal)+1
    queryMock.mockResolvedValueOnce({ rows: [] }); // INSERT version
    const r = await archiveCurrentShotsIfAny({ query: queryMock } as never, 'ep-1');
    expect(r).toEqual({ ordinal: 2 });
    expect(queryMock).toHaveBeenCalledTimes(3);
    const insertSql = String(queryMock.mock.calls[2]?.[0]);
    expect(insertSql).toContain('INSERT INTO storyboard_versions');
    // snapshot 序列化含 currentMaterialUrl（历史保留视频 URL）
    const insertParams = queryMock.mock.calls[2]?.[1] as unknown[];
    expect(String(insertParams?.[4])).toContain('sf-asset://x.mp4');
  });
});

describe('listStoryboardVersions', () => {
  it('ORDER BY ordinal DESC，返回 summary（无 shots_snapshot）', async () => {
    infraMocks.query.mockResolvedValueOnce({
      rows: [
        { id: 'v2', episodeId: 'ep-1', projectId: 'proj-1', ordinal: 2, shot_count: 10, createdAt: new Date() },
        { id: 'v1', episodeId: 'ep-1', projectId: 'proj-1', ordinal: 1, shot_count: 8, createdAt: new Date() },
      ],
    });
    const list = await listStoryboardVersions('proj-1', 'ep-1');
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'v2', ordinal: 2, shotCount: 10 });
    expect(list[1]).toMatchObject({ id: 'v1', ordinal: 1, shotCount: 8 });
    expect(String(infraMocks.query.mock.calls[0]?.[0])).toContain('ORDER BY ordinal DESC');
  });
});

describe('getStoryboardVersion', () => {
  it('命中 → 返回含 shotsSnapshot', async () => {
    infraMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'v1', episodeId: 'ep-1', projectId: 'proj-1', ordinal: 1, shot_count: 1,
          createdAt: new Date(), shots_snapshot: [snapshotShot],
        },
      ],
    });
    const v = await getStoryboardVersion('proj-1', 'ep-1', 'v1');
    expect(v).not.toBeNull();
    expect(v?.shotsSnapshot).toHaveLength(1);
    expect(v?.shotsSnapshot[0].visualPrompt).toBe('旧版近景');
  });

  it('不命中 → 返回 null', async () => {
    infraMocks.query.mockResolvedValueOnce({ rows: [] });
    const v = await getStoryboardVersion('proj-1', 'ep-1', 'nope');
    expect(v).toBeNull();
  });
});

describe('deleteStoryboardVersion', () => {
  it('DELETE 含三元组防越权', async () => {
    await deleteStoryboardVersion('proj-1', 'ep-1', 'v1');
    const sql = String(infraMocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain('DELETE FROM storyboard_versions');
    expect(sql).toContain('"projectId" = $3');
    const params = infraMocks.query.mock.calls[0]?.[1] as unknown[];
    expect(params).toEqual(['v1', 'ep-1', 'proj-1']);
  });
});

describe('restoreStoryboardVersion', () => {
  it('恢复：归档当前→删 live→写回快照；首个事务 call 含 FOR UPDATE', async () => {
    // 1. SELECT episodes FOR UPDATE → 1 行
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [{}] });
    // 2. SELECT storyboard_versions → 目标版本快照
    infraMocks.transactionQuery.mockResolvedValueOnce({
      rows: [{ id: 'v1', episodeId: 'ep-1', projectId: 'proj-1', shots_snapshot: [snapshotShot] }],
    });
    // 3a. archive: SELECT shots（当前 live）→ 1 行
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [shotRow] });
    // 3b. archive: SELECT MAX ordinal → next 3
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [{ next: 3 }] });
    // 3c. archive: INSERT storyboard_versions
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] });
    // 4. DELETE shots
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] });
    // 5. INSERT shots（写回快照，1 条）
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] });

    const r = await restoreStoryboardVersion({ projectId: 'proj-1', episodeId: 'ep-1', versionId: 'v1' });
    expect(r.archivedOrdinal).toBe(3);

    const sqls = infraMocks.transactionQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('FOR UPDATE'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM shots'))).toBe(true);
    // 写回的 INSERT：videoStatus/currentMaterial 重置（SQL 里硬编码 NULL, NULL, 'PENDING'）
    const insertShotSql = sqls.find((s) => s.includes('INSERT INTO shots'));
    expect(insertShotSql).toContain("'PENDING'");
    expect(insertShotSql).toMatch(/NULL, NULL, 'PENDING'/);
    // 写回用了新 id（genId），不复用快照原 id
    const insertShotParams = infraMocks.transactionQuery.mock.calls
      .find((c) => String(c[0]).includes('INSERT INTO shots'))?.[1] as unknown[];
    expect(String(insertShotParams?.[0])).toMatch(/^id-/);
  });

  it('当前 live 为空 → 不归档（archivedOrdinal=null），仍写回快照', async () => {
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [{}] }); // episodes lock
    infraMocks.transactionQuery.mockResolvedValueOnce({
      rows: [{ id: 'v1', episodeId: 'ep-1', projectId: 'proj-1', shots_snapshot: [snapshotShot] }],
    });
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] }); // archive SELECT shots 空
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] }); // DELETE
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] }); // INSERT

    const r = await restoreStoryboardVersion({ projectId: 'proj-1', episodeId: 'ep-1', versionId: 'v1' });
    expect(r.archivedOrdinal).toBeNull();
    const sqls = infraMocks.transactionQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO storyboard_versions'))).toBe(false);
    expect(sqls.some((s) => s.includes('INSERT INTO shots'))).toBe(true);
  });

  it('版本不存在 → throw', async () => {
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [{}] }); // episodes lock
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] }); // 版本不命中
    await expect(
      restoreStoryboardVersion({ projectId: 'proj-1', episodeId: 'ep-1', versionId: 'nope' }),
    ).rejects.toThrow('分镜版本不存在');
  });
});
