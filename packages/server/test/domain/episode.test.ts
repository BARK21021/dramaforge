// ============================================================
// ③ server/domain/episode — 单测（状态化 mock 模拟 episodes 表）
// ============================================================
//
// 覆盖 service 业务逻辑（非纯校验——逻辑在 SQL 里，靠状态化 query mock 验）：
//   - create：episodeNumber 自增（1→2→…）、title 缺省「第 N 集」、
//             novelText → contentKilo 同步重算
//   - getById：命中 / null
//   - listByProject：sortOrder 升序
//   - update：字段白名单、novelText→contentKilo 重算、stageStatus 单调推进
//             （前进允许、回退保留当前）、scriptData JSON 透传（写 stringify / 读 parse）、
//             不存在 id 抛错
//   - remove：删后 getById 返 null
//   - reorder：按数组顺序重写 episodeNumber/sortOrder
//
// mock 策略：vi.hoisted 持有 in-memory episodes 数组，queryMock 按 SQL 文本
// 分派（INSERT/SELECT/UPDATE/DELETE），模拟 pg RETURNING * 回填 DB DEFAULT。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, resetEpisodeState } = vi.hoisted(() => {
  const state: { episodes: Array<Record<string, unknown>> } = { episodes: [] };

  const queryMock = vi.fn(
    async (sql: string, params: unknown[]) => {
      const s = sql.trim();
      const eps = state.episodes;

      // create 的 max(episodeNumber) 查询
      if (/SELECT "episodeNumber"/.test(s)) {
        const projectId = params[0] as string;
        const mine = eps.filter((e) => e.projectId === projectId);
        if (mine.length === 0) return { rows: [], rowCount: 0 };
        const max = mine.reduce(
          (m, e) => Math.max(m, e.episodeNumber as number),
          0,
        );
        return { rows: [{ episodeNumber: max }], rowCount: 1 };
      }

      // INSERT（params 顺序见 service.create）
      if (/INSERT INTO episodes/.test(s)) {
        const [
          id,
          projectId,
          episodeNumber,
          sortOrder,
          title,
          novelText,
          content,
          contentKilo,
        ] = params as [string, string, number, number, string, string, string, number];
        const row: Record<string, unknown> = {
          id,
          projectId,
          episodeNumber,
          sortOrder,
          title,
          novelText,
          content,
          contentKilo,
          status: 'PENDING',
          stageStatus: 'input',
          defaultVisualStyle: null,
          scenes: null,
          emotionArc: null,
          videoScriptDraft: null,
          scriptData: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
        eps.push(row);
        return { rows: [row], rowCount: 1 };
      }

      // getById（SELECT * WHERE id）—— 也服务 update 的 current 加载
      if (/SELECT \* FROM episodes WHERE id = /.test(s)) {
        const id = params[0] as string;
        const row = eps.find((e) => e.id === id);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // listByProject
      if (/SELECT \* FROM episodes WHERE "projectId"/.test(s)) {
        const projectId = params[0] as string;
        const mine = eps
          .filter((e) => e.projectId === projectId)
          .sort(
            (a, b) =>
              (a.sortOrder as number) - (b.sortOrder as number) ||
              (a.episodeNumber as number) - (b.episodeNumber as number),
          );
        return { rows: mine, rowCount: mine.length };
      }

      // reorder（UPDATE 含 AND "projectId"，无 RETURNING）
      if (
        /UPDATE episodes SET "episodeNumber"/.test(s) &&
        /AND "projectId"/.test(s)
      ) {
        const [episodeNumber, sortOrder, id, projectId] = params as [
          number,
          number,
          string,
          string,
        ];
        const row = eps.find(
          (e) => e.id === id && e.projectId === projectId,
        );
        if (row) {
          row.episodeNumber = episodeNumber;
          row.sortOrder = sortOrder;
        }
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // 通用 update（UPDATE SET ... WHERE id = $K RETURNING *）
      if (/UPDATE episodes SET/.test(s) && /RETURNING \*/.test(s)) {
        const id = params[params.length - 1] as string;
        const row = eps.find((e) => e.id === id);
        if (!row) return { rows: [], rowCount: 0 };
        const setMatch = s.match(/SET (.+?) WHERE /);
        if (setMatch) {
          const frags = setMatch[1].split(', ');
          for (const frag of frags) {
            const m = frag.match(/^("?[\w]+"?) = \$(\d+)$/);
            if (m) {
              const col = m[1].replace(/"/g, '');
              row[col] = params[parseInt(m[2], 10) - 1];
            } else if (/NOW\(\)/.test(frag)) {
              const col = frag.match(/^("?[\w]+"?) /)?.[1].replace(/"/g, '');
              if (col) row[col] = '2026-01-02T00:00:00.000Z';
            }
          }
        }
        return { rows: [row], rowCount: 1 };
      }

      // remove（DELETE WHERE id）
      if (/DELETE FROM episodes WHERE id = /.test(s)) {
        const id = params[0] as string;
        const idx = eps.findIndex((e) => e.id === id);
        if (idx >= 0) eps.splice(idx, 1);
        return { rows: [], rowCount: idx >= 0 ? 1 : 0 };
      }

      return { rows: [], rowCount: 0 };
    },
  );

  return {
    queryMock,
    resetEpisodeState: () => {
      state.episodes = [];
    },
  };
});

vi.mock('@shared/utils', () => ({
  // 自增计数器 genId，保证多集 id 唯一
  genId: vi.fn((() => {
    let n = 0;
    return () => `ep-uuid-${++n}`;
  })()),
}));
vi.mock('@server/infra', () => ({ query: queryMock }));

import { episodeRepo } from '../../src/domain/episode';

beforeEach(() => {
  resetEpisodeState();
  queryMock.mockClear();
});

// ============================================================
// create
// ============================================================
describe('episode/service create', () => {
  it('auto-assigns episodeNumber=1 + default title on first episode', async () => {
    const ep = await episodeRepo.create('proj-1', {});
    expect(ep.episodeNumber).toBe(1);
    expect(ep.title).toBe('第 1 集');
    expect(ep.status).toBe('PENDING');
    expect(ep.stageStatus).toBe('input');
  });

  it('increments episodeNumber for subsequent episodes', async () => {
    await episodeRepo.create('proj-1', {});
    const second = await episodeRepo.create('proj-1', {});
    expect(second.episodeNumber).toBe(2);
    expect(second.title).toBe('第 2 集');
  });

  it('computes contentKilo from novelText (ceil kb)', async () => {
    // 2500 字 → ceil(2500/1000) = 3 千字
    const novel = '字'.repeat(2500);
    const ep = await episodeRepo.create('proj-1', { novelText: novel });
    expect(ep.contentKilo).toBe(3);
    expect(ep.novelText).toBe(novel);
  });

  it('nulls contentKilo when novelText absent', async () => {
    const ep = await episodeRepo.create('proj-1', { title: '自定义标题' });
    expect(ep.contentKilo).toBeNull();
    expect(ep.title).toBe('自定义标题');
  });

  it('rejects empty title via zod', async () => {
    await expect(episodeRepo.create('proj-1', { title: '' })).rejects.toThrow();
  });

  it('isolates episodeNumber per project', async () => {
    await episodeRepo.create('proj-1', {});
    const other = await episodeRepo.create('proj-2', {});
    expect(other.episodeNumber).toBe(1);
  });
});

// ============================================================
// getById
// ============================================================
describe('episode/service getById', () => {
  it('returns the episode when found', async () => {
    const created = await episodeRepo.create('proj-1', {});
    const got = await episodeRepo.getById(created.id);
    expect(got?.id).toBe(created.id);
  });

  it('returns null when not found', async () => {
    const got = await episodeRepo.getById('nope');
    expect(got).toBeNull();
  });
});

// ============================================================
// listByProject
// ============================================================
describe('episode/service listByProject', () => {
  it('lists episodes sorted by sortOrder asc', async () => {
    const a = await episodeRepo.create('proj-1', { title: 'A' });
    const b = await episodeRepo.create('proj-1', { title: 'B' });
    const list = await episodeRepo.listByProject('proj-1');
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(a.id);
    expect(list[1].id).toBe(b.id);
  });

  it('isolates by projectId', async () => {
    await episodeRepo.create('proj-1', {});
    await episodeRepo.create('proj-2', {});
    expect(await episodeRepo.listByProject('proj-1')).toHaveLength(1);
  });
});

// ============================================================
// update
// ============================================================
describe('episode/service update', () => {
  it('updates whitelisted fields (title + content)', async () => {
    const ep = await episodeRepo.create('proj-1', {});
    const updated = await episodeRepo.update(ep.id, {
      title: '新标题',
      content: '剧本内容',
    });
    expect(updated.title).toBe('新标题');
    expect(updated.content).toBe('剧本内容');
  });

  it('recomputes contentKilo when novelText changes', async () => {
    const ep = await episodeRepo.create('proj-1', {});
    const updated = await episodeRepo.update(ep.id, {
      novelText: '字'.repeat(1500),
    });
    expect(updated.contentKilo).toBe(2);
  });

  it('advances stageStatus forward (input → analyzing)', async () => {
    const ep = await episodeRepo.create('proj-1', {});
    expect(ep.stageStatus).toBe('input');
    const updated = await episodeRepo.update(ep.id, {
      stageStatus: 'analyzing',
    });
    expect(updated.stageStatus).toBe('analyzing');
  });

  it('blocks stageStatus regression (production → storyboard stays production)', async () => {
    const ep = await episodeRepo.create('proj-1', {});
    // 先推进到 production
    await episodeRepo.update(ep.id, { stageStatus: 'production' });
    // 尝试回退到 storyboard —— 应被拦
    const regressed = await episodeRepo.update(ep.id, {
      stageStatus: 'storyboard',
    });
    expect(regressed.stageStatus).toBe('production');
  });

  it('passes scriptData JSON through (stringify write / parse read)', async () => {
    const ep = await episodeRepo.create('proj-1', {});
    const payload = { scenes: [{ id: 's1' }], count: 1 };
    const updated = await episodeRepo.update(ep.id, { scriptData: payload });
    expect(updated.scriptData).toEqual(payload);
  });

  it('throws when episode does not exist', async () => {
    await expect(episodeRepo.update('nope', { title: 'x' })).rejects.toThrow(
      /分集不存在/,
    );
  });
});

// ============================================================
// remove
// ============================================================
describe('episode/service remove', () => {
  it('deletes the episode (getById → null after)', async () => {
    const ep = await episodeRepo.create('proj-1', {});
    await episodeRepo.remove(ep.id);
    expect(await episodeRepo.getById(ep.id)).toBeNull();
  });
});

// ============================================================
// reorder
// ============================================================
describe('episode/service reorder', () => {
  it('rewrites episodeNumber/sortOrder by array order', async () => {
    const a = await episodeRepo.create('proj-1', {}); // ep1
    const b = await episodeRepo.create('proj-1', {}); // ep2
    const c = await episodeRepo.create('proj-1', {}); // ep3

    // 反序：c, b, a
    const list = await episodeRepo.reorder('proj-1', {
      episodeIds: [c.id, b.id, a.id],
    });
    expect(list[0].id).toBe(c.id);
    expect(list[0].episodeNumber).toBe(1);
    expect(list[2].id).toBe(a.id);
    expect(list[2].episodeNumber).toBe(3);
  });

  it('rejects empty episodeIds via zod', async () => {
    await expect(
      episodeRepo.reorder('proj-1', { episodeIds: [] }),
    ).rejects.toThrow();
  });
});
