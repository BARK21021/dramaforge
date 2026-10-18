// ============================================================
// ③ server/domain/asset/whole-script-extraction — 单测（转绘 X4.4）
// ============================================================
// 覆盖（移植自 app1 whole-script-asset-extraction.test.ts + 扩展 AI/dedup 路径）：
//   - shouldDeferWholeScriptAssetExtraction：所有分类都不延后（海外整剧已先完成本地化）
//   - extractWholeScriptAssets：
//     * OVERSEAS 最终整剧 → 正常调 callAI
//     * DOMESTIC happy：callAI 返 JSON → createAsset 去重新增 + 计数
//     * 已有同名资产去重（不重复 createAsset）
//     * callAI 返 markdown 代码块包裹的 JSON → 仍能解析
//     * callAI 返非法 JSON → 抛 "整剧资产提取返回格式无效"
//     * callAI 抛 GatewayError → 透传
// mock：@server/gateway（callAI）+ ./service（listAssets/createAsset）
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  callAIMock,
  listAssetsMock,
  createAssetMock,
  updateAssetMock,
  deleteAssetMock,
  txMock,
  transactionQueryMock,
} = vi.hoisted(() => ({
  callAIMock: vi.fn(),
  listAssetsMock: vi.fn(),
  createAssetMock: vi.fn(),
  updateAssetMock: vi.fn(),
  deleteAssetMock: vi.fn(),
  txMock: vi.fn(),
  transactionQueryMock: vi.fn(),
}));

vi.mock('@server/gateway', () => ({ callAI: callAIMock }));
vi.mock('@server/infra', () => ({ tx: txMock }));
vi.mock('../../src/domain/asset/service', async (importOriginal) => {
  // 保留真实 mergeCostumeMetadataPreservingImages（纯函数，测试需验证其合并行为），
  // 仅 mock 落库相关函数。
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    listAssets: listAssetsMock,
    createAsset: createAssetMock,
    updateAsset: updateAssetMock,
    deleteAsset: deleteAssetMock,
  };
});

import {
  extractWholeScriptAssets,
  shouldDeferWholeScriptAssetExtraction,
} from '../../src/domain/asset/whole-script-extraction';
import { loadPresetVoiceManifest } from '../../src/domain/prompt';

const GOOD_JSON = JSON.stringify({
  characters: [
    { name: '张三', description: '酒馆老板' },
    { name: '李四', description: '侠客' },
  ],
  locations: [{ name: '老酒馆', description: '主线场景' }],
  props: [{ name: '青锋剑', description: '李四佩剑' }],
});

describe('shouldDeferWholeScriptAssetExtraction', () => {
  it('整剧任务传入最终文本，所有分类都立即提取', () => {
    expect(shouldDeferWholeScriptAssetExtraction('OVERSEAS')).toBe(false);
    expect(shouldDeferWholeScriptAssetExtraction('overseas')).toBe(false);
    expect(shouldDeferWholeScriptAssetExtraction('DOMESTIC')).toBe(false);
    expect(shouldDeferWholeScriptAssetExtraction('ORIGINAL')).toBe(false);
  });
});

describe('extractWholeScriptAssets', () => {
  beforeEach(() => {
    callAIMock.mockReset();
    listAssetsMock.mockReset();
    createAssetMock.mockReset();
    updateAssetMock.mockReset();
    deleteAssetMock.mockReset();
    txMock.mockReset();
    transactionQueryMock.mockReset();
    callAIMock.mockResolvedValue({ meta: { content: GOOD_JSON } });
    listAssetsMock.mockResolvedValue([]);
    createAssetMock.mockResolvedValue({ id: 'asset-new' });
    updateAssetMock.mockResolvedValue({ id: 'asset-updated' });
    transactionQueryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/^\s*INSERT\s+INTO\s+assets/iu.test(sql)) {
        await createAssetMock({
          projectId: params[1],
          kind: params[2],
          name: params[3],
          description: params[4],
          metadata: typeof params[6] === 'string' ? JSON.parse(params[6]) : null,
        });
      } else if (/^\s*UPDATE\s+assets\s+SET\s+name\s*=/iu.test(sql)) {
        await updateAssetMock(params[2], {
          name: params[0],
          metadata: typeof params[1] === 'string' ? JSON.parse(params[1]) : null,
        });
      }
      return { rows: [], rowCount: 1 };
    });
    txMock.mockImplementation(async (callback: (q: { query: typeof transactionQueryMock }) => Promise<unknown>) =>
      callback({ query: transactionQueryMock }));
  });

  it('OVERSEAS 最终整剧正常提取，不再等待逐集本地化', async () => {
    const out = await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'OVERSEAS');
    expect(out.deferred).toBeUndefined();
    expect(out.created).toBe(4);
    expect(callAIMock).toHaveBeenCalledTimes(1);
    expect(createAssetMock).toHaveBeenCalledTimes(4);
  });

  it('OVERSEAS 注入海外改编段（族裔/服饰改写到目标文化），DOMESTIC 不注入', async () => {
    await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'OVERSEAS');
    const overseasPrompt = callAIMock.mock.calls[0][2].input.messages[0].content as string;
    expect(overseasPrompt).toContain('海外本地化改编');
    expect(overseasPrompt).toContain('欧洲/白人');   // 目标族裔示例
    expect(overseasPrompt).toContain('长袍');         // 须改写的源文化服饰示例

    callAIMock.mockReset();
    callAIMock.mockResolvedValue({ meta: { content: GOOD_JSON } });

    await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC');
    const domesticPrompt = callAIMock.mock.calls[0][2].input.messages[0].content as string;
    expect(domesticPrompt).not.toContain('海外本地化改编');
  });

  it('forces prop/location display names to Chinese and preserves source-language aliases', async () => {
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          characters: [],
          locations: [{ name: '废弃船屋', source_names: ['Abandoned Boathouse'], description: '临海木屋' }],
          props: [{ name: '银色镣铐', source_names: ['Silver Binding Shackles'], description: '束缚道具' }],
        }),
      },
    });

    await extractWholeScriptAssets('p1', 'English source script'.repeat(20), 'u1', 'OVERSEAS');

    const systemPrompt = callAIMock.mock.calls[0][2].input.messages[0].content as string;
    expect(systemPrompt).toContain('locations 和 props 的 name 必须使用简体中文');
    expect(callAIMock.mock.calls[0][2].input).toMatchObject({
      maxTokens: 393_216,
      contextWindow: 1_048_576,
    });
    expect(createAssetMock.mock.calls[0][0]).toMatchObject({
      name: '废弃船屋',
      metadata: { sourceNames: ['Abandoned Boathouse'] },
    });
    expect(createAssetMock.mock.calls[1][0]).toMatchObject({
      name: '银色镣铐',
      metadata: { sourceNames: ['Silver Binding Shackles'] },
    });
  });

  it('kimi 模型走 kimi provider 且 maxTokens 钳制到 262144', async () => {
    await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'OVERSEAS', 'kimi/kimi-k2.6');
    expect(callAIMock).toHaveBeenCalledTimes(1);
    expect(callAIMock.mock.calls[0][0]).toBe('kimi'); // provider 按前缀路由
    expect(callAIMock.mock.calls[0][1]).toBe('kimi/kimi-k2.6');
    expect(callAIMock.mock.calls[0][2].input).toMatchObject({
      maxTokens: 262_144, // kimi.ts KIMI_MAX_OUTPUT_TOKENS，防越限
    });
  });

  it('为道具/环境提取并写入 costumes 变体（含 coverage_episodes，对齐角色）', async () => {
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          characters: [],
          locations: [{
            name: '神殿', description: '一座神殿',
            costumes: [
              { key: 'default', label: '白昼', description: '明亮', coverage_episodes: [1] },
              { key: 'night', label: '深夜', description: '幽暗', coverage_episodes: [2] },
            ],
          }],
          props: [{
            name: '魔剑', description: '一把剑',
            costumes: [
              { key: 'default', label: '完好', description: '锋利', coverage_episodes: [1, 2] },
              { key: 'broken', label: '断剑', description: '断裂', coverage_episodes: [3] },
            ],
          }],
        }),
      },
    });

    await extractWholeScriptAssets('p1', '=== EP1 ===\n剧本正文一。'.repeat(10), 'u1', 'ORIGINAL');

    // system prompt 现要求三类资产都输出 costumes + coverage_episodes，并依 === EP{n} === 标注集号
    const systemPrompt = callAIMock.mock.calls[0][2].input.messages[0].content as string;
    expect(systemPrompt).toContain('coverage_episodes');
    expect(systemPrompt).toContain('=== EP{n} ===');
    // INSERT 的 costumes 列（params[11]）应含变体 + 集号
    const inserts = transactionQueryMock.mock.calls.filter(([sql]) =>
      /^\s*INSERT\s+INTO\s+assets/iu.test(String(sql)));
    const propCostumes = JSON.parse(inserts.find(([, p]) => p?.[2] === 'PROP' && p?.[3] === '魔剑')?.[1]?.[11]);
    const locCostumes = JSON.parse(inserts.find(([, p]) => p?.[2] === 'LOCATION' && p?.[3] === '神殿')?.[1]?.[11]);
    expect(propCostumes).toHaveLength(2);
    expect(propCostumes[0]).toMatchObject({ key: 'default', coverage_episodes: [1, 2] });
    expect(propCostumes[1]).toMatchObject({ key: 'broken', coverage_episodes: [3] });
    expect(locCostumes[1]).toMatchObject({ key: 'night', coverage_episodes: [2] });
  });

  it('DOMESTIC happy：4 个新资产去重新增 + 计数正确', async () => {
    const out = await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC');
    expect(out.created).toBe(4);
    expect(out.totalDetected).toBe(4);
    expect(createAssetMock).toHaveBeenCalledTimes(4);
    // 第一个 createAsset 入参：CHARACTER 张三 + metadata 标 wholeScript
    const first = createAssetMock.mock.calls[0][0];
    expect(first.kind).toBe('CHARACTER');
    expect(first.name).toBe('张三');
    expect(first.metadata).toMatchObject({ wholeScript: true });
  });

  it('第 N 条数据库写入异常时回滚整批资产，不留下前面已执行的半套结果', async () => {
    const committedNames: string[] = [];
    createAssetMock
      .mockResolvedValueOnce({ id: 'legacy-first-write' })
      .mockRejectedValueOnce(new Error('第二条资产写入失败'));
    txMock.mockImplementationOnce(async (
      callback: (q: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>,
    ) => {
      const stagedNames: string[] = [];
      let writeIndex = 0;
      const q = {
        query: async (sql: string, params: unknown[] = []) => {
          if (/^\s*INSERT\s+INTO\s+assets/iu.test(sql)) {
            writeIndex += 1;
            stagedNames.push(String(params[3]));
            if (writeIndex === 2) throw new Error('第二条资产写入失败');
          }
          return { rows: [], rowCount: 1 };
        },
      };
      try {
        const result = await callback(q);
        committedNames.push(...stagedNames);
        return result;
      } catch (error) {
        // 模拟 PostgreSQL ROLLBACK：事务内已执行但未提交的首条写入被丢弃。
        throw error;
      }
    });

    await expect(
      extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC'),
    ).rejects.toThrow('第二条资产写入失败');

    expect(txMock).toHaveBeenCalledTimes(1);
    expect(committedNames).toEqual([]);
  });

  it('已有同名资产去重（不重复 createAsset）', async () => {
    listAssetsMock.mockResolvedValue([
      { kind: 'CHARACTER', name: '张三' },
    ]);
    const out = await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC');
    // 张三已存在 → 只新建 3 个（李四 + 老酒馆 + 青锋剑）
    expect(out.created).toBe(3);
    expect(out.totalDetected).toBe(4);
    expect(createAssetMock).toHaveBeenCalledTimes(3);
    const createdNames = createAssetMock.mock.calls.map((c) => c[0].name);
    expect(createdNames).not.toContain('张三');
  });

  it('角色服装变体随新建资产落库（INSERT 写入 costumes 列）', async () => {
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          characters: [{
            name: '瓦莱莉娅',
            description: '女骑士',
            costumes: [
              { key: 'default', label: '骑士装', description: '银白板甲、红色披风、黑色长靴', identity_lock: ['银白板甲'] },
              { key: 'disheveled', label: '失态', description: '衣衫褴褛、赤足、披散长发', identity_lock: ['破损衣物'] },
            ],
          }],
          locations: [],
          props: [],
        }),
      },
    });

    const out = await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC');

    expect(out.created).toBe(1);
    const insertCalls = transactionQueryMock.mock.calls.filter(
      ([sql]) => /INSERT\s+INTO\s+assets/iu.test(String(sql)),
    );
    expect(insertCalls).toHaveLength(1);
    // costumes 是 INSERT 的第 12 个绑定参数（下标 11）
    const costumesParam = insertCalls[0][1][11];
    expect(typeof costumesParam).toBe('string');
    const costumes = JSON.parse(costumesParam as string) as Array<{ key: string }>;
    expect(costumes).toHaveLength(2);
    expect(costumes.map((c) => c.key)).toEqual(['default', 'disheveled']);
  });

  it('角色音色随新建资产落库（voiceTrait 列 + metadata.suggested_voices/confirmed_voice）', async () => {
    // 用真实 manifest 条目，确保 validateSuggestedVoices 三级匹配能命中（不会被过滤）。
    const manifest = loadPresetVoiceManifest();
    const sample = manifest.find((v) => v.gender === 'female') ?? manifest[0];
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          characters: [{
            name: '瓦莱莉娅',
            description: '女骑士',
            suggested_voices: [
              { file: sample.file, desc: sample.desc, reason: '匹配骑士气质', gender: sample.gender },
            ],
          }],
          locations: [],
          props: [],
        }),
      },
    });

    const out = await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC');
    expect(out.created).toBe(1);
    const created = createAssetMock.mock.calls[0][0];
    expect(created.metadata.suggested_voices).toEqual([
      { file: sample.file, desc: sample.desc, gender: sample.gender },
    ]);
    expect(created.metadata.confirmed_voice).toMatchObject({ file: sample.file });
    // INSERT 的 voiceTrait 绑定参数（下标 12）= 首个音色 desc
    const insertCall = transactionQueryMock.mock.calls.find(
      ([sql]) => /INSERT\s+INTO\s+assets/iu.test(String(sql)),
    );
    expect(insertCall![1][12]).toBe(sample.desc);
  });

  it('重跑整剧提取：已有角色合并新变体，保留已有变体图片', async () => {
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          characters: [{
            name: '瓦莱莉娅',
            description: '女骑士',
            costumes: [
              { key: 'default', label: '骑士装', description: '银白板甲、红色披风、黑色长靴', identity_lock: ['银白板甲'] },
              { key: 'disheveled', label: '失态', description: '衣衫褴褛、赤足、披散长发', identity_lock: [] },
            ],
          }],
          locations: [],
          props: [],
        }),
      },
    });
    listAssetsMock.mockResolvedValue([{
      id: 'asset-val',
      kind: 'CHARACTER',
      name: '瓦莱莉娅',
      metadata: {},
      isConfirmed: false,
      imageUrl: 'sf-asset://val.png',
      regenLocked: false,
      costumes: [
        { key: 'default', label: '骑士装', imageUrl: 'sf-asset://val-default.png', description: '旧描述' },
      ],
    }]);

    const out = await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC');

    expect(out.created).toBe(0); // 命中已有别名 → 不新建，走合并
    const costumeUpdate = transactionQueryMock.mock.calls.find(
      ([sql]) => /UPDATE\s+assets\s+SET\s+costumes/iu.test(String(sql)),
    );
    expect(costumeUpdate).toBeTruthy();
    const merged = JSON.parse(costumeUpdate![1][0] as string) as Array<{ key: string; imageUrl?: string }>;
    expect(merged).toHaveLength(2);
    const def = merged.find((c) => c.key === 'default');
    expect(def?.imageUrl).toBe('sf-asset://val-default.png'); // 保留已有变体图片
    const dis = merged.find((c) => c.key === 'disheveled');
    expect(dis?.imageUrl).toBeUndefined(); // 新增变体不带图
  });

  it('合并同一中英文资产并把原文名持久化为别名', async () => {
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          characters: [],
          locations: [{
            name: '废弃船屋',
            source_names: ['Abandoned Boathouse'],
            description: '临海木屋',
          }],
          props: [],
        }),
      },
    });
    listAssetsMock.mockResolvedValue([
      {
        id: 'asset-cn', kind: 'LOCATION', name: '废弃船屋', metadata: {},
        isConfirmed: false, imageUrl: null, regenLocked: false, costumes: null,
      },
      {
        id: 'asset-en', kind: 'LOCATION', name: 'Abandoned Boathouse', metadata: {},
        isConfirmed: false, imageUrl: null, regenLocked: false, costumes: null,
      },
    ]);

    const out = await extractWholeScriptAssets('p1', 'English source'.repeat(30), 'u1', 'OVERSEAS');

    expect(out).toMatchObject({ created: 0, normalized: 0, merged: 0 });
    expect(updateAssetMock).toHaveBeenCalledWith('asset-cn', expect.objectContaining({
      metadata: expect.objectContaining({ sourceNames: ['Abandoned Boathouse'] }),
    }));
    expect(deleteAssetMock).not.toHaveBeenCalled();
  });

  it('保留已有生图资产，安全改中文展示名且不删除重复项', async () => {
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          characters: [],
          locations: [],
          props: [{
            name: '银色镣铐',
            source_names: ['Silver Binding Shackles'],
            description: '束缚道具',
          }],
        }),
      },
    });
    listAssetsMock.mockResolvedValue([
      {
        id: 'asset-cn', kind: 'PROP', name: '银色镣铐', metadata: {},
        isConfirmed: false, imageUrl: null, regenLocked: false, costumes: null,
      },
      {
        id: 'asset-en-with-image', kind: 'PROP', name: 'Silver Binding Shackles', metadata: {},
        isConfirmed: false, imageUrl: 'sf-asset://shackles.png', regenLocked: false, costumes: null,
      },
    ]);

    const out = await extractWholeScriptAssets('p1', 'English source'.repeat(30), 'u1', 'OVERSEAS');

    expect(out).toMatchObject({ created: 0, normalized: 1, merged: 0 });
    expect(updateAssetMock).toHaveBeenCalledWith('asset-en-with-image', expect.objectContaining({
      name: '银色镣铐',
      metadata: expect.objectContaining({ sourceNames: ['Silver Binding Shackles'] }),
    }));
    const writeSql = transactionQueryMock.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(writeSql).toContain('UPDATE assets SET name = $1, metadata = $2');
    // 道具/环境现也走 costumes 合并（对齐角色）；mergeCostumeMetadataPreservingImages 保留已有
    // 生图、不删除重复项、不触及图片版本表。允许 costumes 列更新，但禁止 DELETE / asset_image_revisions。
    expect(writeSql).not.toMatch(/asset_image_revisions|\bDELETE\b/iu);
    expect(deleteAssetMock).not.toHaveBeenCalled();
    // 合并后的 costumes 仍保留已有生图（不抹掉用户成果）。
    const costumesUpdate = transactionQueryMock.mock.calls.find((call) =>
      String(call[0]).includes('UPDATE assets SET costumes'));
    expect(costumesUpdate?.[1]?.[0]).toContain('sf-asset://shackles.png');
  });

  it('识别并规范化历史中英混排展示名', async () => {
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          characters: [], locations: [],
          props: [{ name: '法力封锁药剂瓶', source_names: ['Mana-Block Potion'], description: '关键药剂' }],
        }),
      },
    });
    listAssetsMock.mockResolvedValue([{
      id: 'asset-mixed', kind: 'PROP', name: 'Mana-Block Potion 药水瓶', metadata: {},
      isConfirmed: false, imageUrl: null, regenLocked: false, costumes: null,
    }]);

    const out = await extractWholeScriptAssets('p1', 'English source'.repeat(30), 'u1', 'OVERSEAS');

    expect(out).toMatchObject({ created: 0, normalized: 1 });
    expect(callAIMock.mock.calls[0][2].input.messages[1].content).toContain(
      'PROP:Mana-Block Potion 药水瓶',
    );
    expect(updateAssetMock).toHaveBeenCalledWith('asset-mixed', expect.objectContaining({
      name: '法力封锁药剂瓶',
      metadata: expect.objectContaining({
        sourceNames: expect.arrayContaining(['Mana-Block Potion', 'Mana-Block Potion 药水瓶']),
      }),
    }));
  });

  it('callAI 返 markdown 代码块包裹 JSON → 仍解析', async () => {
    callAIMock.mockResolvedValue({
      meta: { content: `\`\`\`json\n${GOOD_JSON}\n\`\`\`` },
    });
    const out = await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC');
    expect(out.created).toBe(4);
  });

  it('callAI 返非法 JSON → 抛 "整剧资产提取返回格式无效"', async () => {
    callAIMock.mockResolvedValue({ meta: { content: '这不是 JSON' } });
    await expect(
      extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC'),
    ).rejects.toThrow('整剧资产提取返回格式无效');
    expect(createAssetMock).not.toHaveBeenCalled();
  });

  it('callAI 抛错 → 透传', async () => {
    const err = new Error('上游限流');
    callAIMock.mockRejectedValue(err);
    await expect(
      extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC'),
    ).rejects.toBe(err);
  });

  it('显式 model 透传给 callAI', async () => {
    await extractWholeScriptAssets('p1', '剧本'.repeat(30), 'u1', 'DOMESTIC', 'deepseek/r1');
    const [, model] = callAIMock.mock.calls[0];
    expect(model).toBe('deepseek/r1');
  });

  it('does not call the display-name normalizer when every location and prop name is Chinese', async () => {
    callAIMock.mockResolvedValueOnce({
      meta: {
        content: JSON.stringify({
          characters: [],
          locations: [{ name: '\u5e9f\u5f03\u8239\u5c4b', description: '\u4e34\u6d77\u6728\u5c4b' }],
          props: [{ name: '\u94f6\u8272\u957f\u5251', description: '\u4e3b\u89d2\u4f69\u5251' }],
        }),
      },
    });

    await extractWholeScriptAssets('p1', '\u6574\u90e8\u5267\u672c'.repeat(20), 'u1', 'DOMESTIC');

    expect(callAIMock).toHaveBeenCalledTimes(1);
    expect(createAssetMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes invalid location and prop display names once and preserves the originals as aliases', async () => {
    const longScript = 'UNIQUE_FULL_SCRIPT_TEXT_'.repeat(20);
    callAIMock
      .mockResolvedValueOnce({
        cost: 1.25,
        meta: {
          content: JSON.stringify({
            characters: [],
            locations: [{
              name: 'Abandoned Boathouse',
              source_names: ['Old Pier'],
              description: '\u4e34\u6d77\u6728\u5c4b',
            }],
            props: [{
              name: 'Mana-Block Potion \u836f\u6c34\u74f6',
              source_names: ['Mana-Block Potion'],
              description: '\u5173\u952e\u836f\u5242',
            }],
          }),
        },
      })
      .mockResolvedValueOnce({
        cost: 0.2,
        meta: {
          content: JSON.stringify({
            assets: [
              { id: 'LOCATION:0', name: '\u5e9f\u5f03\u8239\u5c4b' },
              { id: 'PROP:0', name: '\u6cd5\u529b\u5c01\u9501\u836f\u5242\u74f6' },
            ],
          }),
        },
      });

    const out = await extractWholeScriptAssets('p1', longScript, 'u1', 'OVERSEAS');

    expect(callAIMock).toHaveBeenCalledTimes(2);
    const normalizationInput = callAIMock.mock.calls[1][2].input;
    expect(normalizationInput.temperature).toBe(0);
    expect(normalizationInput.maxTokens).toBeGreaterThanOrEqual(512);
    expect(normalizationInput.maxTokens).toBeLessThanOrEqual(4096);
    expect(normalizationInput.messages[1].content).toContain('Abandoned Boathouse');
    expect(normalizationInput.messages[1].content).toContain('Mana-Block Potion \u836f\u6c34\u74f6');
    expect(normalizationInput.messages[1].content).not.toContain(longScript);
    expect(createAssetMock.mock.calls[0][0]).toMatchObject({
      kind: 'LOCATION',
      name: '\u5e9f\u5f03\u8239\u5c4b',
      metadata: {
        sourceNames: expect.arrayContaining(['Old Pier', 'Abandoned Boathouse']),
      },
    });
    expect(createAssetMock.mock.calls[1][0]).toMatchObject({
      kind: 'PROP',
      name: '\u6cd5\u529b\u5c01\u9501\u836f\u5242\u74f6',
      metadata: {
        sourceNames: expect.arrayContaining(['Mana-Block Potion', 'Mana-Block Potion \u836f\u6c34\u74f6']),
      },
    });
    expect(out.cost).toBe(1.45);
  });

  it('accepts the normalizer JSON payload as a root array', async () => {
    callAIMock
      .mockResolvedValueOnce({
        meta: {
          content: JSON.stringify({
            characters: [],
            locations: [{ name: 'Abandoned Boathouse', description: '临海木屋' }],
            props: [],
          }),
        },
      })
      .mockResolvedValueOnce({
        meta: {
          content: JSON.stringify([
            { id: 'LOCATION:0', name: '废弃船屋' },
          ]),
        },
      });

    await extractWholeScriptAssets('p1', 'English source'.repeat(30), 'u1', 'OVERSEAS');

    expect(createAssetMock).toHaveBeenCalledTimes(1);
    expect(createAssetMock.mock.calls[0][0]).toMatchObject({
      kind: 'LOCATION',
      name: '废弃船屋',
      metadata: { sourceNames: ['Abandoned Boathouse'] },
    });
  });

  it('repairs a code-fenced normalizer response with common JSON defects', async () => {
    callAIMock
      .mockResolvedValueOnce({
        meta: {
          content: JSON.stringify({
            characters: [],
            locations: [],
            props: [{ name: 'Mana-Block Potion', description: '关键药剂' }],
          }),
        },
      })
      .mockResolvedValueOnce({
        meta: {
          content: "```json\n{'assets':[{'id':'PROP:0','name':'法力封锁药剂瓶'},],}\n```",
        },
      });

    await extractWholeScriptAssets('p1', 'English source'.repeat(30), 'u1', 'OVERSEAS');

    expect(createAssetMock).toHaveBeenCalledTimes(1);
    expect(createAssetMock.mock.calls[0][0]).toMatchObject({
      kind: 'PROP',
      name: '法力封锁药剂瓶',
      metadata: { sourceNames: ['Mana-Block Potion'] },
    });
  });

  it('fails before any asset write when the second response still contains a Latin display name', async () => {
    callAIMock
      .mockResolvedValueOnce({
        meta: {
          content: JSON.stringify({
            characters: [],
            locations: [{ name: 'Abandoned Boathouse' }],
            props: [],
          }),
        },
      })
      .mockResolvedValueOnce({
        meta: {
          content: JSON.stringify({
            assets: [{ id: 'LOCATION:0', name: 'Boathouse \u8239\u5c4b' }],
          }),
        },
      });

    await expect(
      extractWholeScriptAssets('p1', '\u6574\u90e8\u5267\u672c'.repeat(20), 'u1', 'OVERSEAS'),
    ).rejects.toThrow('\u6574\u5267\u8d44\u4ea7\u4e2d\u6587\u5c55\u793a\u540d\u89c4\u8303\u5316\u5931\u8d25');

    expect(callAIMock).toHaveBeenCalledTimes(2);
    expect(createAssetMock).not.toHaveBeenCalled();
    expect(updateAssetMock).not.toHaveBeenCalled();
    expect(deleteAssetMock).not.toHaveBeenCalled();
  });
});
