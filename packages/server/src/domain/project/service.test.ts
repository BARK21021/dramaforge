// ============================================================
// ③ server/domain/project/service — 单测
// ============================================================
//
// 覆盖：
//   - mapRow: 驼峰列名透传 / JSONB 解析（对象+字符串）/ 时间戳 Date→ISO
//   - listByUser: 空数组 / 多条映射 / 不按 status 过滤 / SQL 断言（WHERE "userId"=$1 + ORDER BY "updatedAt" DESC）
//   - create: INSERT 用 genId + 只写核心字段 / DB DEFAULT 回填（status/version/timestamps）/ category 默认 DOMESTIC
//                / 可选字段透传 / ZodError 在空 title 时抛 / projectRepo.create 委托
//   - projectRepo.listByUser 委托
//
// 风格对齐 test/task/render-job-repo.test.ts：mock @server/infra（query）+
// @shared/utils（genId），不依赖真实 PG。Zod schema 走真实模块（验证 create 真的校验）。
// ============================================================

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryFn, QueryResult } from '../../infra/pg';

// mock @server/infra（query），具体实现由每个测试注入
vi.mock('@server/infra', () => ({
  query: vi.fn(),
  tx: vi.fn(),
}));

// mock @shared/utils（genId），固定返回值便于断言
vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'gen-id-123'),
}));

import {
  projectRepo,
  listByUser,
  create,
  remove,
  mapRow,
  updateCharacterMappingRoleIdentityByAliasMap,
  ProjectValidationError,
  type ProjectRow,
} from './service';
import { query, tx } from '@server/infra';

// ============================================================
// 构造工具
// ============================================================

/** 一行 projects 表行（驼峰列名直接透传；时间戳为 Date，模拟 pg 默认行为） */
function makeRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
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
    createdAt: new Date('2026-07-18T00:00:00Z'),
    updatedAt: new Date('2026-07-19T00:00:00Z'),
    ...overrides,
  };
}

/** 构造 mock query 函数：记录所有调用，按 sql 关键字返回预设结果 */
function makeMockQuery(
  handler?: (sql: string, params?: unknown[]) => Promise<QueryResult> | QueryResult,
): {
  qf: QueryFn;
  calls: { sql: string; params?: unknown[] }[];
} {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const qf: QueryFn = {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      calls.push({ sql, params });
      if (handler) return handler(sql, params);
      return { rows: [], rowCount: 0 };
    },
  };
  return { qf, calls };
}

describe('updateCharacterMappingRoleIdentityByAliasMap', () => {
  it('locks and updates matching role identity while preserving stable character IDs', async () => {
    const { qf, calls } = makeMockQuery((sql) => {
      if (sql.includes('SELECT "characterMapping"')) {
        return {
          rows: [{
            characterMapping: {
              entries: [{
                characterId: '角色a',
                roleIdentity: '女主角季舒语',
                name: '季舒语',
                appearance: '白裙',
              }],
              lastUpdatedEpisode: 1,
            },
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    vi.mocked(tx).mockImplementation(async (callback) => callback(qf));

    const updated = await updateCharacterMappingRoleIdentityByAliasMap(
      'proj-1',
      new Map([['季舒语', 'EVELYN VANCE']]),
    );

    expect(updated).toBe(1);
    expect(calls[0].sql).toContain('FOR UPDATE');
    const persisted = JSON.parse(String(calls[1].params?.[0]));
    expect(persisted.entries[0]).toMatchObject({
      characterId: '角色a',
      roleIdentity: '女主角EVELYN VANCE',
      name: 'EVELYN VANCE',
    });
  });
});

beforeEach(() => {
  vi.mocked(query).mockReset();
});

// ============================================================
// mapRow
// ============================================================

describe('mapRow', () => {
  it('maps camelCase columns to ProjectRecord fields', () => {
    const row = makeRow();
    const p = mapRow(row);
    expect(p.id).toBe('proj-1');
    expect(p.userId).toBe('user-1');
    expect(p.title).toBe('我的项目');
    expect(p.category).toBe('DOMESTIC');
    expect(p.status).toBe('DRAFT');
    expect(p.version).toBe(1);
    expect(p.artStyle).toBeNull();
    expect(p.scriptOverride).toBe(false);
  });

  it('parses JSONB scriptData given as string', () => {
    const row = makeRow({ scriptData: '{"scenes":[]}' });
    expect(mapRow(row).scriptData).toEqual({ scenes: [] });
  });

  it('passes through JSONB characterMapping given as object', () => {
    const obj = { 'char-1': 'voice-1' };
    const row = makeRow({ characterMapping: obj });
    expect(mapRow(row).characterMapping).toEqual(obj);
  });

  it('converts Date timestamps to ISO strings', () => {
    const row = makeRow({
      createdAt: new Date('2026-07-18T01:02:03Z'),
      updatedAt: new Date('2026-07-19T04:05:06Z'),
    });
    const p = mapRow(row);
    expect(p.createdAt).toBe('2026-07-18T01:02:03.000Z');
    expect(p.updatedAt).toBe('2026-07-19T04:05:06.000Z');
  });

  it('passes through string timestamps as-is', () => {
    const row = makeRow({ updatedAt: '2026-07-19T00:00:00Z' });
    expect(mapRow(row).updatedAt).toBe('2026-07-19T00:00:00Z');
  });
});

// ============================================================
// listByUser
// ============================================================

describe('listByUser', () => {
  it('returns empty array when user has no projects', async () => {
    const { qf, calls } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);

    const result = await listByUser('user-1');
    expect(result).toEqual([]);

    // SQL 断言：项目列表一次 LEFT JOIN 聚合分集数，避免 UI N+1 查询。
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('FROM projects p');
    expect(calls[0].sql).toContain('LEFT JOIN episodes e');
    expect(calls[0].sql).toContain('WHERE p."userId" = $1');
    expect(calls[0].sql).toContain('ORDER BY p."updatedAt" DESC');
    expect(calls[0].params).toEqual(['user-1']);
  });

  it('maps the aggregated episode count returned by the list query', async () => {
    const { qf } = makeMockQuery(async () => ({
      rows: [makeRow({ episodeCount: 7 })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    const [project] = await listByUser('user-1');

    expect(project.episodeCount).toBe(7);
  });

  it('returns multiple mapped rows for user', async () => {
    const row1 = makeRow({
      id: 'p1',
      updatedAt: new Date('2026-07-19T00:00:00Z'),
    });
    const row2 = makeRow({
      id: 'p2',
      updatedAt: new Date('2026-07-18T00:00:00Z'),
    });
    const { qf } = makeMockQuery(async () => ({ rows: [row1, row2], rowCount: 2 }));
    vi.mocked(query).mockImplementation(qf.query);

    const result = await listByUser('user-1');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('p1');
    expect(result[1].id).toBe('p2');
    expect(result[0].updatedAt).toBe('2026-07-19T00:00:00.000Z');
  });

  it('does not filter by status (returns all statuses for UI to badge)', async () => {
    // SQL 应该只有 userId 过滤，不含 status =
    const { qf, calls } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);

    await listByUser('user-1');
    expect(calls[0].sql).not.toMatch(/status\s*=/i);
  });

  it('isolates by userId (only WHERE clause param is userId)', async () => {
    const { qf, calls } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);

    await listByUser('user-42');
    // 唯一参数就是 userId；query 不会拿到别人的项目
    expect(calls[0].params).toEqual(['user-42']);
  });

  it('projectRepo.listByUser delegates to listByUser', async () => {
    const { qf } = makeMockQuery(async () => ({
      rows: [makeRow({ id: 'p-delegated' })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    const result = await projectRepo.listByUser('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-delegated');
  });
});

// ============================================================
// create
// ============================================================

describe('create', () => {
  it('INSERTs with genId and returns mapped ProjectRecord with DB defaults backfilled', async () => {
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('INSERT INTO projects')) {
        // 模拟 DB DEFAULT 回填：status='DRAFT', version=1, timestamps=NOW()
        return {
          rows: [
            makeRow({
              id: 'gen-id-123',
              userId: 'user-1',
              title: '新项目',
              description: null,
              category: 'DOMESTIC',
              status: 'DRAFT',
              version: 1,
              createdAt: new Date('2026-07-19T12:00:00Z'),
              updatedAt: new Date('2026-07-19T12:00:00Z'),
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(query).mockImplementation(qf.query);

    const rec = await create('user-1', { title: '新项目', artStyle: 'realistic' });

    // 字段回填断言
    expect(rec.id).toBe('gen-id-123'); // 来自 mock genId
    expect(rec.userId).toBe('user-1'); // 来自入参（不信任 client）
    expect(rec.title).toBe('新项目');
    expect(rec.status).toBe('DRAFT'); // DB DEFAULT
    expect(rec.version).toBe(1); // DB DEFAULT
    expect(rec.category).toBe('DOMESTIC'); // input ?? 'DOMESTIC'
    expect(rec.createdAt).toBe('2026-07-19T12:00:00.000Z'); // DB DEFAULT
    expect(rec.updatedAt).toBe('2026-07-19T12:00:00.000Z'); // DB DEFAULT

    // SQL 断言：INSERT 只写核心字段，status/version/timestamps 由 DB DEFAULT
    const ins = calls.find((c) => c.sql.startsWith('INSERT INTO projects'));
    expect(ins).toBeDefined();
    expect(ins!.sql).toContain('RETURNING *');
    // 不显式插 status/version/createdAt/updatedAt
    expect(ins!.sql).not.toMatch(/\bstatus\b/i);
    expect(ins!.sql).not.toMatch(/\bversion\b/i);
    expect(ins!.sql).not.toContain('"createdAt"');
    expect(ins!.sql).not.toContain('"updatedAt"');
    // 创建来源元数据必须和核心字段在同一次 INSERT 中原子落库。
    expect(ins!.params).toEqual([
      'gen-id-123',
      'user-1',
      '新项目',
      null,
      'DOMESTIC',
      null,
      JSON.stringify({ sourceMode: 'EPISODE_INPUT' }),
      'realistic',
      null,
      null,
    ]);
  });

  it('passes through optional description and category when provided', async () => {
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('INSERT INTO projects')) {
        return {
          rows: [
            makeRow({
              id: 'gen-id-123',
              title: '海外项目',
              description: '一部出海短剧',
              category: 'OVERSEAS',
            }),
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(query).mockImplementation(qf.query);

    const rec = await create('user-1', {
      title: '海外项目',
      description: '一部出海短剧',
      category: 'OVERSEAS',
      artStyle: 'realistic',
    });

    expect(rec.title).toBe('海外项目');
    expect(rec.description).toBe('一部出海短剧');
    expect(rec.category).toBe('OVERSEAS');

    const ins = calls.find((c) => c.sql.startsWith('INSERT INTO projects'));
    expect(ins!.params).toEqual([
      'gen-id-123',
      'user-1',
      '海外项目',
      '一部出海短剧',
      'OVERSEAS',
      null,
      JSON.stringify({ sourceMode: 'EPISODE_INPUT' }),
      'realistic',
      null,
      null,
    ]);
  });

  it('defaults category to DOMESTIC when omitted', async () => {
    const { qf, calls } = makeMockQuery(async () => ({
      rows: [makeRow({ id: 'gen-id-123', category: 'DOMESTIC' })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    await create('user-1', { title: '默认分类', artStyle: 'realistic' });

    const ins = calls.find((c) => c.sql.startsWith('INSERT INTO projects'));
    // 第 5 个参数（category）= 'DOMESTIC'
    expect(ins!.params![4]).toBe('DOMESTIC');
  });

  it('throws on invalid input (empty title) and does not call query', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);

    // title 为空字符串违反 createProjectSchema 的 min(1)
    await expect(create('user-1', { title: '' })).rejects.toThrow();
    // 校验在前，query 不应被调用
    expect(query).not.toHaveBeenCalled();
  });

  it('throws on invalid category', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);

    await expect(
      create('user-1', {
        title: 'x',
        category: 'INVALID' as 'DOMESTIC',
      }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('projectRepo.create delegates to create', async () => {
    const { qf } = makeMockQuery(async () => ({
      rows: [makeRow({ id: 'gen-id-123', title: '通过 repo' })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    const rec = await projectRepo.create('user-1', {
      title: '通过 repo',
      artStyle: 'realistic',
    });
    expect(rec.id).toBe('gen-id-123');
    expect(rec.title).toBe('通过 repo');
  });

  it('persists LOCAL_SCRIPT as scriptData.sourceMode for the workspace branch', async () => {
    const { qf, calls } = makeMockQuery(async () => ({
      rows: [makeRow({ id: 'gen-id-123', category: 'ORIGINAL' })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    await create('user-1', {
      title: '原创整剧',
      category: 'ORIGINAL',
      sourceMode: 'LOCAL_SCRIPT',
    });

    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO projects'));
    expect(insert?.params?.[6]).toBe(JSON.stringify({ sourceMode: 'LOCAL_SCRIPT' }));
  });

  it('freezes the complete original script without turning a title count into an AI constraint', async () => {
    const sourceNovelText = Array.from(
      { length: 45 },
      (_, index) => `第 ${index + 1} 集\n第 ${index + 1} 集正文。`,
    ).join('\n');
    const source = makeRow({
      id: 'source-1',
      userId: 'user-1',
      category: 'ORIGINAL',
      title: '1-45集-标题数字不能决定实际集数',
      novelText: sourceNovelText,
    });
    const created = makeRow({
      id: 'gen-id-123',
      category: 'DOMESTIC',
      sourceProjectId: 'source-1',
      novelText: sourceNovelText,
    });
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('SELECT * FROM projects')) return { rows: [source], rowCount: 1 };
      if (sql.startsWith('INSERT INTO projects')) return { rows: [created], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(query).mockImplementation(qf.query);

    await create('user-1', {
      title: '国内改编',
      category: 'DOMESTIC',
      sourceMode: 'ORIGINAL_PROJECT',
      sourceProjectId: 'source-1',
      artStyle: 'realistic',
    });

    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO projects'));
    expect(insert?.params?.[5]).toBe('source-1');
    expect(insert?.params?.[6]).toBe(
      JSON.stringify({
        sourceMode: 'ORIGINAL_PROJECT',
        novelText: sourceNovelText,
        sourceScriptSnapshot: {
          version: 1,
          text: sourceNovelText,
          hash: createHash('sha256').update(sourceNovelText, 'utf8').digest('hex'),
          sourceProjectId: 'source-1',
        },
      }),
    );
    expect(JSON.parse(String(insert?.params?.[6])).sourceScriptSnapshot)
      .not.toHaveProperty('expectedEpisodeCount');
    expect(insert?.params?.[9]).toBe(sourceNovelText);
  });

  it('rejects a foreign original project before inserting', async () => {
    const { qf } = makeMockQuery(async (sql) =>
      sql.startsWith('SELECT * FROM projects')
        ? { rows: [makeRow({ id: 'source-1', userId: 'other-user', category: 'ORIGINAL' })], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    vi.mocked(query).mockImplementation(qf.query);

    await expect(
      create('user-1', {
        title: '越权引用',
        category: 'DOMESTIC',
        sourceMode: 'ORIGINAL_PROJECT',
        sourceProjectId: 'source-1',
        artStyle: 'realistic',
      }),
    ).rejects.toBeInstanceOf(ProjectValidationError);
    expect(vi.mocked(query).mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))).toBe(false);
  });
});

describe('remove', () => {
  it('deletes by id and reports whether a row was removed', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ id: 'proj-1' }], rowCount: 1 });

    await expect(remove('proj-1')).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM projects WHERE id = $1 RETURNING id',
      ['proj-1'],
    );
  });
});
