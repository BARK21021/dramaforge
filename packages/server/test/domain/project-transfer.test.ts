import { beforeEach, describe, expect, it, vi } from 'vitest';

const idState = vi.hoisted(() => ({ value: 0 }));
const queryMock = vi.hoisted(() => vi.fn());
const txMock = vi.hoisted(() => vi.fn());
vi.mock('@shared/utils', () => ({ genId: () => `new-${++idState.value}` }));
vi.mock('@server/infra', () => ({ query: queryMock, tx: txMock }));

import {
  exportProjectSnapshot,
  importProjectSnapshot,
} from '../../src/domain/project/transfer';

beforeEach(() => {
  idState.value = 0;
  queryMock.mockReset();
  txMock.mockReset();
});

describe('project transfer', () => {
  it('exports only the owned project and its portable business records', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM projects')) return { rows: [{ id: 'old-project', userId: 'user-1', title: '剧集' }], rowCount: 1 };
      if (sql.includes('FROM episodes')) return { rows: [{ id: 'old-episode', projectId: 'old-project' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const snapshot = await exportProjectSnapshot('user-1', 'old-project');
    expect(snapshot).toMatchObject({ format: 'dramaforge-project', version: 1 });
    expect(snapshot.records.episodes).toHaveLength(1);
    expect(queryMock.mock.calls[0][1]).toEqual(['old-project', 'user-1']);
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });

  it('clones IDs, ownership and nested cross references in one transaction', async () => {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    const jsonbCols = new Set(['scriptData', 'metadata', 'params', 'input', 'result', 'shots_snapshot']);
    const columns: Record<string, string[]> = {
      projects: ['id', 'userId', 'title', 'sourceProjectId', 'scriptData', 'createdAt', 'updatedAt'],
      episodes: ['id', 'projectId', 'title', 'scriptData'],
      assets: ['id', 'projectId', 'kind', 'name'],
      storyboards: ['id', 'projectId'],
      shots: ['id', 'projectId', 'episodeId', 'metadata'],
      storyboard_versions: ['id', 'projectId', 'episodeId', 'ordinal', 'shots_snapshot', 'shot_count'],
      materials: ['id', 'projectId', 'shotId'],
      asset_image_revisions: ['id', 'projectId', 'assetId'],
      render_jobs: ['id', 'task_id', 'user_id', 'input', 'result', 'status', 'claimed_by', 'claim_token'],
      seedance_presets: ['id', 'userId', 'name', 'params', 'isDefault', 'createdAt', 'updatedAt'],
    };
    const q = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('information_schema.columns')) {
          return { rows: columns[String(params[0])].map((column_name) => ({ column_name, data_type: jsonbCols.has(column_name) ? 'jsonb' : 'text' })), rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO')) {
          inserts.push({ sql, params });
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
    txMock.mockImplementation(async (fn: (client: typeof q) => Promise<unknown>) => fn(q));
    const empty = {
      storyboards: [],
      storyboard_versions: [],
      materials: [],
      asset_image_revisions: [],
      render_jobs: [],
      seedance_presets: [{
        id: 'old-preset', userId: 'old-owner', name: '电影感',
        params: { model: 'ark/doubao-seedance-2-0', resolution: '720p' },
        isDefault: true, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
      }],
    };
    const result = await importProjectSnapshot('new-owner', {
      format: 'dramaforge-project',
      version: 1,
      exportedAt: '2026-07-21T00:00:00.000Z',
      project: { id: 'old-project', userId: 'old-owner', title: '剧集', sourceProjectId: null, scriptData: {} },
      records: {
        episodes: [{ id: 'old-episode', projectId: 'old-project', title: '第一集', scriptData: {} }],
        assets: [{ id: 'old-asset', projectId: 'old-project', kind: 'CHARACTER', name: '阿星' }],
        shots: [{
          id: 'old-shot', projectId: 'old-project', episodeId: 'old-episode',
          metadata: { assetId: 'old-asset', names: ['阿星'] },
        }],
        ...empty,
      },
    });

    expect(result.projectId).toBe('new-1');
    expect(result.title).toBe('剧集（导入）');
    expect(result.importedCounts).toMatchObject({ episodes: 1, assets: 1, shots: 1 });
    expect(inserts).toHaveLength(5);
    expect(inserts.some((i) => i.sql.includes('seedance_presets'))).toBe(true);
    expect(JSON.stringify(inserts)).not.toContain('old-owner');
    expect(JSON.stringify(inserts)).not.toContain('old-project');
    expect(JSON.stringify(inserts)).not.toContain('old-episode');
    expect(JSON.stringify(inserts)).not.toContain('old-asset');
    expect(JSON.stringify(inserts)).toContain('new-owner');
    // jsonb 列必须 ::jsonb 强转 + 值 JSON.stringify（数组值若不 stringify，node-postgres 发 PG 数组字面量→22P02）
    const shotsInsert = inserts.find((i) => i.sql.includes('INSERT INTO "shots"'));
    expect(shotsInsert).toBeDefined();
    expect(shotsInsert!.sql).toMatch(/::jsonb/);
    const metaParam = shotsInsert!.params.find((p) => typeof p === 'string' && p.includes('阿星'));
    expect(metaParam).toBeDefined();
  });

  it('accepts old bundles missing the storyboard_versions table (forward compat)', async () => {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    const jsonbCols = new Set(['input', 'scriptData', 'metadata']);
    const columns: Record<string, string[]> = {
      projects: ['id', 'userId', 'title'],
      episodes: ['id', 'projectId'],
      assets: ['id', 'projectId'],
      storyboards: ['id', 'projectId'],
      shots: ['id', 'projectId', 'episodeId'],
      storyboard_versions: ['id', 'projectId', 'episodeId', 'ordinal'],
      materials: ['id', 'projectId'],
      asset_image_revisions: ['id', 'projectId'],
      render_jobs: ['id', 'task_id', 'user_id', 'input', 'status'],
    };
    const q = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('information_schema.columns')) {
          return { rows: columns[String(params[0])].map((column_name) => ({ column_name, data_type: jsonbCols.has(column_name) ? 'jsonb' : 'text' })), rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO')) {
          inserts.push({ sql, params });
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
    txMock.mockImplementation(async (fn: (client: typeof q) => Promise<unknown>) => fn(q));
    // 旧包：records 里没有 storyboard_versions 键
    const result = await importProjectSnapshot('user-1', {
      format: 'dramaforge-project',
      version: 1,
      exportedAt: '2026-07-01T00:00:00.000Z',
      project: { id: 'p-old', userId: 'u-old', title: '旧包' },
      records: {
        episodes: [],
        assets: [],
        storyboards: [],
        shots: [],
        materials: [],
        asset_image_revisions: [],
        render_jobs: [],
      },
    });
    expect(result.projectId).toBe('new-1');
    expect(inserts.some((i) => i.sql.includes('storyboard_versions'))).toBe(false);
  });

  it('rejects unknown bundle versions before opening a transaction', async () => {
    await expect(importProjectSnapshot('user-1', {
      format: 'dramaforge-project', version: 99, project: {}, records: {},
    })).rejects.toThrow('不支持的项目迁移包格式或版本');
    expect(txMock).not.toHaveBeenCalled();
  });
});
