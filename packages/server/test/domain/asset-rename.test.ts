// ============================================================
// ③ server/domain/asset/rename-service — 单测
// ============================================================
//
// 覆盖：
//   - replaceNameDeep：移植自 app1 同名单测的纯函数契约
//     （字符串/对象/数组/denylist/无变化引用稳定）
//   - renameAsset：
//     * 校验路径（空名/超长/不存在/非 CHARACTER/同名冲突/与原名相同）
//     * 事务级联路径（mock tx + 状态化 query 验证 UPDATE 命中正确表/行/列）
//     * counts.{assets,episodes,shots,storyboards,tasks} 计数
//
// mock 策略：
//   - @server/infra 的 query（顶层预检 / getAsset 间接调）+ tx（事务注入 mock q）
//   - @shared/utils 的 genId（service.ts 间接依赖，必须 mock 以解析别名）
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock 装配 ----
// rename-service.ts 经 service.ts 的 getAsset 间接 import @server/infra 的 query，
// 自身直接 import { query, tx } from '@server/infra'。统一 mock 两者。
// service.ts 经 @shared/utils 的 genId（虽然 rename 路径不调 genId，但模块加载需要）。

const { queryMock, txMock, getAssetMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  txMock: vi.fn(),
  getAssetMock: vi.fn(),
}));

vi.mock('@server/infra', () => ({
  query: queryMock,
  tx: txMock,
}));
vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'test-uuid'),
}));
// service.ts 自身 export getAsset 被 rename-service.ts 静态 import，用 spy 不太好操作；
// 这里通过让 queryMock 返回正确 SELECT * FROM assets WHERE id 来驱动真实 getAsset。

import {
  replaceNameDeep,
  renameAsset,
  RenameValidationError,
  RENAME_NAME_MAX_LENGTH,
} from '../../src/domain/asset/rename-service';

// ============================================================
// replaceNameDeep — 纯函数契约（移植自 app1 单测）
// ============================================================
describe('replaceNameDeep', () => {
  const OLD = '林夏';
  const NEW = '纪云深';

  it('字符串精确等值替换', () => {
    expect(replaceNameDeep('林夏', OLD, NEW)).toBe('纪云深');
  });

  it('字符串中子串替换（含多次出现）', () => {
    expect(replaceNameDeep('林夏走进来，林夏笑了', OLD, NEW)).toBe('纪云深走进来，纪云深笑了');
  });

  it('嵌套对象：替换 name / roleIdentity，保留 characterId', () => {
    const input = {
      characterId: '角色a',
      roleIdentity: '男主角林夏',
      name: '林夏',
      appearance: '林夏穿白裙',
    };
    expect(replaceNameDeep(input, OLD, NEW)).toEqual({
      characterId: '角色a',
      roleIdentity: '男主角纪云深',
      name: '纪云深',
      appearance: '纪云深穿白裙',
    });
  });

  it('数组：逐项替换（精确与子串）', () => {
    expect(replaceNameDeep(['林夏', '林夏与白药', '旁白'], OLD, NEW)).toEqual([
      '纪云深',
      '纪云深与白药',
      '旁白',
    ]);
  });

  it('referencedAssets.characters 名字数组替换', () => {
    const input = { characters: ['林夏', '白药'], speakingCharacters: ['林夏'] };
    expect(replaceNameDeep(input, OLD, NEW)).toEqual({
      characters: ['纪云深', '白药'],
      speakingCharacters: ['纪云深'],
    });
  });

  it('denylist：imageUrl 含旧名也不替换（保护图片地址）', () => {
    const input = { name: '林夏', imageUrl: '/uploads/林夏-abc.png' };
    const out = replaceNameDeep(input, OLD, NEW) as Record<string, unknown>;
    expect(out.name).toBe('纪云深');
    expect(out.imageUrl).toBe('/uploads/林夏-abc.png');
  });

  it('denylist：assetReferenceBindings 只换 name，不动 assetId/promptRef/imageUrl/costumeKey', () => {
    const input = {
      assetReferenceBindings: [
        {
          assetId: 'ast-1',
          kind: 'CHARACTER',
          sourceField: 'characters',
          name: '林夏',
          promptRef: '图片1',
          costumeKey: 'default',
          imageUrl: '/x/林夏.png',
          costumeLabel: '林夏-便装',
        },
      ],
    };
    const out = (
      replaceNameDeep(input, OLD, NEW) as { assetReferenceBindings: Array<Record<string, unknown>> }
    ).assetReferenceBindings[0];
    expect(out.name).toBe('纪云深');
    expect(out.costumeLabel).toBe('纪云深-便装');
    expect(out.assetId).toBe('ast-1');
    expect(out.promptRef).toBe('图片1');
    expect(out.costumeKey).toBe('default');
    expect(out.imageUrl).toBe('/x/林夏.png');
  });

  it('denylist：costume 变体只换 label/description，不动 key/imageUrl', () => {
    const input = {
      costumes: [
        {
          key: 'formal',
          label: '林夏-正装',
          description: '林夏穿西装',
          imageUrl: '/c/林夏.png',
          coverageScenes: ['s1'],
        },
      ],
    };
    const out = (
      replaceNameDeep(input, OLD, NEW) as { costumes: Array<Record<string, unknown>> }
    ).costumes[0];
    expect(out.label).toBe('纪云深-正装');
    expect(out.description).toBe('纪云深穿西装');
    expect(out.key).toBe('formal');
    expect(out.imageUrl).toBe('/c/林夏.png');
    expect(out.coverageScenes).toEqual(['s1']);
  });

  it('原始类型与 null/undefined 透传', () => {
    expect(replaceNameDeep(null, OLD, NEW)).toBeNull();
    expect(replaceNameDeep(undefined, OLD, NEW)).toBeUndefined();
    expect(replaceNameDeep(123, OLD, NEW)).toBe(123);
    expect(replaceNameDeep(true, OLD, NEW)).toBe(true);
  });

  it('字符串不含旧名时返回原引用（无拷贝）', () => {
    const s = '白药的独白';
    expect(replaceNameDeep(s, OLD, NEW)).toBe(s);
  });

  it('对象无任何变化时返回原引用（无拷贝）', () => {
    const obj = { name: '白药', id: 'x' };
    expect(replaceNameDeep(obj, OLD, NEW)).toBe(obj);
  });

  it('新名包含旧名时单次替换不无限循环', () => {
    expect(replaceNameDeep('云深来了', '云深', '纪云深')).toBe('纪云深来了');
  });

  it('任务 input：prompt 台词替换，参考资源 URL（含名字路径）不动', () => {
    const input = {
      prompt: '林夏说：你好',
      model: 'ark/seedance',
      referenceImageUrls: ['/uploads/林夏.png'],
      referenceAudioUrls: ['/api/reference-audio/林夏'],
      characterReferenceImageUrls: ['/x/林夏.png'],
      shotId: 'shot-1',
      projectId: 'p-1',
    };
    const out = replaceNameDeep(input, OLD, NEW) as Record<string, unknown>;
    expect(out.prompt).toBe('纪云深说：你好');
    expect(out.referenceImageUrls).toEqual(['/uploads/林夏.png']);
    expect(out.referenceAudioUrls).toEqual(['/api/reference-audio/林夏']);
    expect(out.characterReferenceImageUrls).toEqual(['/x/林夏.png']);
    expect(out.shotId).toBe('shot-1');
    expect(out.model).toBe('ark/seedance');
  });
});

// ============================================================
// renameAsset — 校验路径
// ============================================================
describe('renameAsset — validation', () => {
  beforeEach(() => {
    queryMock.mockReset();
    txMock.mockReset();
  });

  it('空名（trim 后）抛 RenameValidationError', async () => {
    await expect(renameAsset('p-1', 'a-1', '   ')).rejects.toMatchObject({
      name: 'RenameValidationError',
      message: expect.stringContaining('新名字'),
    });
    expect(txMock).not.toHaveBeenCalled();
  });

  it(`超长名（>${RENAME_NAME_MAX_LENGTH}）抛 RenameValidationError`, async () => {
    const long = 'x'.repeat(RENAME_NAME_MAX_LENGTH + 1);
    await expect(renameAsset('p-1', 'a-1', long)).rejects.toMatchObject({
      name: 'RenameValidationError',
    });
    expect(txMock).not.toHaveBeenCalled();
  });

  it('资产不存在（getAsset→null）抛错', async () => {
    // getAsset 内部走 query('SELECT * FROM assets WHERE id = $1')
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(renameAsset('p-1', 'missing', '新名')).rejects.toMatchObject({
      name: 'RenameValidationError',
      message: expect.stringContaining('资产不存在'),
    });
    expect(txMock).not.toHaveBeenCalled();
  });

  it('资产不属于项目抛错', async () => {
    queryMock.mockResolvedValue({
      rows: [{ id: 'a-1', projectId: 'other', kind: 'CHARACTER', name: '林夏' }],
      rowCount: 1,
    });
    await expect(renameAsset('p-1', 'a-1', '新名')).rejects.toMatchObject({
      name: 'RenameValidationError',
    });
    expect(txMock).not.toHaveBeenCalled();
  });

  it('未知资产类型抛错（四种生产资产均可改名）', async () => {
    queryMock.mockResolvedValue({
      rows: [{ id: 'a-1', projectId: 'p-1', kind: 'AUDIO', name: '林夏的剑' }],
      rowCount: 1,
    });
    await expect(renameAsset('p-1', 'a-1', '新名')).rejects.toMatchObject({
      name: 'RenameValidationError',
      message: expect.stringContaining('AUDIO'),
    });
    expect(txMock).not.toHaveBeenCalled();
  });

  it('新名与原名相同抛错', async () => {
    queryMock.mockResolvedValue({
      rows: [{ id: 'a-1', projectId: 'p-1', kind: 'CHARACTER', name: '林夏' }],
      rowCount: 1,
    });
    await expect(renameAsset('p-1', 'a-1', '林夏')).rejects.toMatchObject({
      name: 'RenameValidationError',
      message: expect.stringContaining('相同'),
    });
    expect(txMock).not.toHaveBeenCalled();
  });

  it('同项目存在同名 CHARACTER 抛错', async () => {
    // 第一次 query: getAsset SELECT * FROM assets WHERE id
    // 第二次 query: 同名冲突 SELECT id FROM assets WHERE projectId AND kind AND name
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'a-1', projectId: 'p-1', kind: 'CHARACTER', name: '林夏' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'a-other' }], // 同名冲突
        rowCount: 1,
      });
    await expect(renameAsset('p-1', 'a-1', '纪云深')).rejects.toMatchObject({
      name: 'RenameValidationError',
      message: expect.stringContaining('同名'),
    });
    expect(txMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// renameAsset — 事务级联路径（mock tx + 状态化 q 验 UPDATE 命中表/行/列）
// ============================================================
describe('renameAsset — transaction cascade', () => {
  /** 记录事务体内所有 q.query 调用（SQL + params），供断言 */
  let qQueries: Array<{ sql: string; params: unknown[] }>;
  /** 事务 mock：直接同步执行 fn，把 mock q 传进去 */
  beforeEach(() => {
    queryMock.mockReset();
    txMock.mockReset();
    qQueries = [];
    txMock.mockImplementation(async (fn: (q: { query: typeof queryMock }) => Promise<unknown>) => {
      const q = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          qQueries.push({ sql, params });
          // 默认返回空结果；具体测试用 mockResolvedValueOnce 覆盖 SELECT
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(q);
    });
  });

  it('事务内对 assets/projects/episodes/shots/storyboards/tasks 都发起级联 UPDATE', async () => {
    // 预检阶段 query 调用：
    //   1) getAsset 的 SELECT * FROM assets WHERE id（返回目标资产）
    //   2) 同名冲突 SELECT id FROM assets WHERE projectId AND name（返回空）
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'a-1', projectId: 'p-1', kind: 'CHARACTER', name: '林夏' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // 事务内的 SELECT 返回各表的样本行
    txMock.mockImplementationOnce(async (fn: (q: { query: typeof queryMock }) => Promise<unknown>) => {
      const q = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          qQueries.push({ sql, params });
          const s = sql.trim();
          if (/SELECT \* FROM projects WHERE id/.test(s)) {
            return {
              rows: [
                {
                  id: 'p-1',
                  scriptData: { characters: [{ name: '林夏' }] },
                  characterMapping: null,
                  voiceprintMapping: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (/SELECT \* FROM assets WHERE/.test(s)) {
            return {
              rows: [
                { id: 'a-1', projectId: 'p-1', kind: 'CHARACTER', name: '林夏', description: '林夏登场' },
              ],
              rowCount: 1,
            };
          }
          if (/SELECT \* FROM episodes WHERE/.test(s)) {
            return {
              rows: [{ id: 'e-1', projectId: 'p-1', content: '林夏来了', scenes: null, scriptData: null, characterAnalysis: null, voiceprintAnalysis: null }],
              rowCount: 1,
            };
          }
          if (/SELECT \* FROM shots WHERE/.test(s)) {
            return {
              rows: [{ id: 's-1', projectId: 'p-1', visualPrompt: '林夏走进', referencedAssets: { characters: ['林夏'] }, metadata: null }],
              rowCount: 1,
            };
          }
          if (/SELECT \* FROM storyboards WHERE/.test(s)) {
            return {
              rows: [{ id: 'sb-1', projectId: 'p-1', description: '林夏的镜头', dialogue: '林夏：你好', metadata: null }],
              rowCount: 1,
            };
          }
          if (/SELECT \* FROM tasks WHERE/.test(s)) {
            return {
              rows: [{ id: 't-1', projectId: 'p-1', input: { prompt: '林夏说' }, output: null }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(q);
    });

    const result = await renameAsset('p-1', 'a-1', '纪云深');

    // 1. 主名字 UPDATE 永远发生
    const nameUpdate = qQueries.find(
      (q) => /UPDATE assets SET name = \$1/.test(q.sql) && /WHERE id = \$2/.test(q.sql),
    );
    expect(nameUpdate).toBeDefined();
    expect(nameUpdate!.params).toEqual(['纪云深', 'a-1']);

    // 2. 各表至少 1 条 UPDATE（含旧名的样本行触发改名）
    const updateTables = (sql: string): string | null => {
      const m = sql.match(/UPDATE (\w+) SET/);
      return m ? m[1] : null;
    };
    const touchedTables = new Set(qQueries.map((q) => updateTables(q.sql)).filter(Boolean) as string[]);
    for (const table of ['assets', 'projects', 'episodes', 'shots', 'storyboards', 'tasks']) {
      expect(touchedTables.has(table)).toBe(true);
    }

    // 3. counts.{episodes,shots,storyboards,tasks} 各 ≥1（assets 至少 ≥1，因目标资产改名 +1）
    expect(result.counts.episodes).toBeGreaterThanOrEqual(1);
    expect(result.counts.shots).toBeGreaterThanOrEqual(1);
    expect(result.counts.storyboards).toBeGreaterThanOrEqual(1);
    expect(result.counts.tasks).toBeGreaterThanOrEqual(1);
    expect(result.counts.assets).toBeGreaterThanOrEqual(1);
  });

  it('事务内对 costumes JSONB 字段正确 stringify 写回（含 manualStringify）', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'a-1', projectId: 'p-1', kind: 'CHARACTER', name: '林夏' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    txMock.mockImplementationOnce(async (fn: (q: { query: typeof queryMock }) => Promise<unknown>) => {
      const q = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          qQueries.push({ sql, params });
          const s = sql.trim();
          if (/SELECT \* FROM projects WHERE id/.test(s)) return { rows: [{ id: 'p-1' }], rowCount: 1 };
          if (/SELECT \* FROM assets WHERE/.test(s)) {
            return {
              rows: [
                {
                  id: 'a-1',
                  projectId: 'p-1',
                  kind: 'CHARACTER',
                  name: '林夏',
                  costumes: [{ key: 'formal', label: '林夏-正装' }],
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(q);
    });

    await renameAsset('p-1', 'a-1', '纪云深');

    // 找一条 UPDATE assets SET ... 含 costumes 列
    const assetUpdate = qQueries.find(
      (q) => /UPDATE assets SET/.test(q.sql) && q.sql.includes('"costumes"'),
    );
    expect(assetUpdate).toBeDefined();
    // 该 UPDATE 的 params 中，costumes 列对应的值必须是字符串（JSON.stringify 后）
    // 而不是对象（PostgreSQL 不会自动序列化）
    const costumesParam = assetUpdate!.params.find(
      (p) => typeof p === 'string' && p.includes('纪云深-正装'),
    );
    expect(costumesParam).toBeDefined();
    expect(typeof costumesParam).toBe('string');
    // 反序列化校验：label 已替换为「纪云深-正装」，key 保留
    expect(JSON.parse(costumesParam as string)).toEqual([{ key: 'formal', label: '纪云深-正装' }]);
  });

  it('字段无变化时该行不触发 UPDATE（counts 不增）', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'a-1', projectId: 'p-1', kind: 'CHARACTER', name: '林夏' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    txMock.mockImplementationOnce(async (fn: (q: { query: typeof queryMock }) => Promise<unknown>) => {
      const q = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          qQueries.push({ sql, params });
          const s = sql.trim();
          if (/SELECT \* FROM projects WHERE id/.test(s)) return { rows: [{ id: 'p-1' }], rowCount: 1 };
          if (/SELECT \* FROM assets WHERE/.test(s)) {
            // 只返回目标资产，描述字段都不含「林夏」
            return {
              rows: [{ id: 'a-1', projectId: 'p-1', kind: 'CHARACTER', name: '林夏', description: '一段无关描述' }],
              rowCount: 1,
            };
          }
          // 其余表空
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(q);
    });

    const result = await renameAsset('p-1', 'a-1', '纪云深');
    // 目标资产改名那条 UPDATE 仍发生
    const nameUpdate = qQueries.find((q) => /UPDATE assets SET name = \$1/.test(q.sql));
    expect(nameUpdate).toBeDefined();
    // 但描述性字段 UPDATE 不应发生（描述里没旧名）
    const descUpdate = qQueries.find(
      (q) => /UPDATE assets SET/.test(q.sql) && q.sql.includes('"description"'),
    );
    expect(descUpdate).toBeUndefined();
    // counts.assets 仅来自目标资产改名（=1），描述性 UPDATE 计数为 0
    expect(result.counts.assets).toBe(1);
    expect(result.counts.episodes).toBe(0);
    expect(result.counts.shots).toBe(0);
    expect(result.counts.storyboards).toBe(0);
    expect(result.counts.tasks).toBe(0);
  });

  it('事务体内 q.query 失败时整体抛错（tx 的 ROLLBACK 由 infra 保证，此处只验抛错透传）', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'a-1', projectId: 'p-1', kind: 'CHARACTER', name: '林夏' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    txMock.mockImplementationOnce(async (fn: (q: { query: typeof queryMock }) => Promise<unknown>) => {
      const q = {
        query: vi.fn(async () => {
          throw new Error('connection lost');
        }),
      };
      return fn(q);
    });

    await expect(renameAsset('p-1', 'a-1', '纪云深')).rejects.toThrow('connection lost');
  });
});
