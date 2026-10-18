// ============================================================
// ③ server/domain/project — getById / update 单测（P7.1 T2）
// ============================================================
//
// listByUser / create 已由 P3 web 路由测试覆盖；本文件补 P7.1 新增的：
//   - getById：命中 / null
//   - update：title/description/status/category 白名单、空标题抛错、
//             不存在 id 抛错
//
// 状态化 mock 模拟 projects 表（对齐 episode.test.ts 风格：hoisted 持有
// state + seedProject 注入钩子）。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, seedProject, resetProjectState } = vi.hoisted(() => {
  const state: { projects: Array<Record<string, unknown>> } = { projects: [] };

  const queryMock = vi.fn(async (sql: string, params: unknown[]) => {
    const s = sql.trim();
    const ps = state.projects;

    // getById（SELECT * WHERE id）
    if (/SELECT \* FROM projects WHERE id = /.test(s)) {
      const id = params[0] as string;
      const row = ps.find((p) => p.id === id);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // update（UPDATE SET ... WHERE id = $K RETURNING *）
    if (/UPDATE projects SET/.test(s) && /RETURNING \*/.test(s)) {
      const id = params[params.length - 1] as string;
      const row = ps.find((p) => p.id === id);
      if (!row) return { rows: [], rowCount: 0 };
      const setMatch = s.match(/SET (.+?) WHERE /);
      if (setMatch) {
        for (const frag of setMatch[1].split(', ')) {
          const m = frag.match(/^("?[\w]+"?) = \$(\d+)$/);
          if (m) {
            row[m[1].replace(/"/g, '')] = params[parseInt(m[2], 10) - 1];
          } else if (/NOW\(\)/.test(frag)) {
            row.updatedAt = '2026-01-02T00:00:00.000Z';
          }
        }
      }
      return { rows: [row], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });

  const seedProject = (over: Partial<Record<string, unknown>> = {}) => {
    state.projects.push({
      id: 'proj-1',
      userId: 'user-1',
      title: '原标题',
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
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    });
  };

  return {
    queryMock,
    seedProject,
    resetProjectState: () => { state.projects = []; },
  };
});

vi.mock('@shared/utils', () => ({ genId: vi.fn(() => 'proj-uuid-1') }));
vi.mock('@server/infra', () => ({ query: queryMock }));

import { projectRepo } from '../../src/domain/project';

beforeEach(() => {
  resetProjectState();
  queryMock.mockClear();
});

describe('project/service getById', () => {
  it('returns the project when found', async () => {
    seedProject();
    const got = await projectRepo.getById('proj-1');
    expect(got?.id).toBe('proj-1');
    expect(got?.title).toBe('原标题');
  });

  it('returns null when not found', async () => {
    const got = await projectRepo.getById('nope');
    expect(got).toBeNull();
  });
});

describe('project/service update', () => {
  it('updates title + description', async () => {
    seedProject();
    const updated = await projectRepo.update('proj-1', {
      title: '新标题',
      description: '描述',
    });
    expect(updated.title).toBe('新标题');
    expect(updated.description).toBe('描述');
  });

  it('updates status + category', async () => {
    seedProject();
    const updated = await projectRepo.update('proj-1', {
      status: 'SCREENWRITING',
      category: 'OVERSEAS',
    });
    expect(updated.status).toBe('SCREENWRITING');
    expect(updated.category).toBe('OVERSEAS');
  });

  it('rejects empty title', async () => {
    seedProject();
    await expect(
      projectRepo.update('proj-1', { title: '   ' }),
    ).rejects.toThrow(/不能为空/);
  });

  it('throws when project does not exist', async () => {
    await expect(projectRepo.update('nope', { title: 'x' })).rejects.toThrow(
      /项目不存在/,
    );
  });
});
