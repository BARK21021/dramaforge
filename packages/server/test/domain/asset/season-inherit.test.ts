// season-inherit 单测：验证跨项目资产外观继承计划的核心不变量。
// - 只继承重复+源有图的资产；目标独有 / 源无图 → skipped，绝不新增
// - 变体按 key 继承源图，源独有变体不新增到目标
// - 跨项目角色跳过 characterId，走姓名别名匹配
// - identityLock 并集
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/domain/asset/service', () => ({
  listAssets: vi.fn(),
}));

import { listAssets } from '../../../src/domain/asset/service';
import { planSeasonInheritance, isWholeScriptProject } from '../../../src/domain/asset/season-inherit';
import type { AssetRecord } from '../../../src/domain/asset/service';

function mk(partial: Partial<AssetRecord> & { id: string; kind: string; name: string }): AssetRecord {
  return {
    projectId: 'p',
    description: null,
    imageUrl: null,
    metadata: null,
    tags: null,
    folderId: null,
    version: 1,
    assetType: null,
    basePrompt: null,
    isConfirmed: false,
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
    voiceId: null,
    voiceSource: null,
    gridOverlayEnabled: null,
    pencilPaintEnabled: null,
    pencilImageUrl: null,
    gridImageUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as AssetRecord;
}

beforeEach(() => {
  vi.mocked(listAssets).mockReset();
});

describe('planSeasonInheritance', () => {
  it('同名角色(源有图)继承完整外观：主图 + identityLock 并集 + 变体图', async () => {
    vi.mocked(listAssets).mockImplementation(async (pid) => {
      if (pid === 'target') {
        return [
          mk({
            id: 't-leo',
            projectId: 'target',
            kind: 'CHARACTER',
            name: 'Leo',
            identityLock: ['a'],
            costumes: [{ key: 'default', imageUrl: 'sf-asset://t-old.png', identityLock: ['x'] }],
          }),
        ];
      }
      return [
        mk({
          id: 's-leo',
          projectId: 'source',
          kind: 'CHARACTER',
          name: 'Leo',
          imageUrl: 'sf-asset://s-leo.png',
          identityLock: ['b', 'c'],
          costumes: [{ key: 'default', imageUrl: 'sf-asset://s-default.png', identityLock: ['y'] }],
        }),
      ];
    });

    const plan = await planSeasonInheritance('target', 'source');
    expect(plan.items).toHaveLength(1);
    const it0 = plan.items[0];
    expect(it0.targetAssetId).toBe('t-leo');
    expect(it0.imageUrl).toBe('sf-asset://s-leo.png');
    // identityLock 并集（目标 a + 源 b,c）
    expect(it0.identityLock.sort()).toEqual(['a', 'b', 'c']);
    // 变体同 key 继承源图 + identityLock 并集
    expect(it0.costumes[0].imageUrl).toBe('sf-asset://s-default.png');
    expect(((it0.costumes[0].identityLock as string[]) ?? []).sort()).toEqual(['x', 'y']);
  });

  it('目标独有资产不新增：只出现在 skipped(no-match)，items 为空', async () => {
    vi.mocked(listAssets).mockImplementation(async (pid) => {
      if (pid === 'target') return [mk({ id: 't-new', projectId: 'target', kind: 'CHARACTER', name: 'Newcomer' })];
      return [];
    });

    const plan = await planSeasonInheritance('target', 'source');
    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toContainEqual({
      targetName: 'Newcomer',
      targetKind: 'CHARACTER',
      reason: 'no-match',
    });
  });

  it('源资产无本地图(非 sf-asset)跳过：reason=source-no-image', async () => {
    vi.mocked(listAssets).mockImplementation(async (pid) => {
      if (pid === 'target') return [mk({ id: 't-leo', projectId: 'target', kind: 'CHARACTER', name: 'Leo' })];
      return [mk({ id: 's-leo', projectId: 'source', kind: 'CHARACTER', name: 'Leo', imageUrl: 'https://ark.tmp/x.png' })];
    });

    const plan = await planSeasonInheritance('target', 'source');
    expect(plan.items).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('source-no-image');
  });

  it('变体只继承目标已有 key：源独有变体不新增到目标', async () => {
    vi.mocked(listAssets).mockImplementation(async (pid) => {
      if (pid === 'target') {
        return [
          mk({
            id: 't-leo',
            projectId: 'target',
            kind: 'CHARACTER',
            name: 'Leo',
            imageUrl: 'sf-asset://t.png',
            costumes: [{ key: 'default', imageUrl: null }],
          }),
        ];
      }
      return [
        mk({
          id: 's-leo',
          projectId: 'source',
          kind: 'CHARACTER',
          name: 'Leo',
          imageUrl: 'sf-asset://s.png',
          costumes: [
            { key: 'default', imageUrl: 'sf-asset://s-d.png' },
            { key: 'armor', imageUrl: 'sf-asset://s-a.png' },
          ],
        }),
      ];
    });

    const plan = await planSeasonInheritance('target', 'source');
    const costumes = plan.items[0].costumes;
    // 目标只有 default → 继承后仍只有 default，不新增 armor
    expect(costumes).toHaveLength(1);
    expect(costumes.find((c) => c.key === 'default')?.imageUrl).toBe('sf-asset://s-d.png');
    expect(costumes.find((c) => c.key === 'armor')).toBeUndefined();
  });

  it('跨项目不同 characterId 同名仍匹配（跳过 cid，走姓名别名）', async () => {
    vi.mocked(listAssets).mockImplementation(async (pid) => {
      if (pid === 'target') {
        return [mk({ id: 't-leo', projectId: 'target', kind: 'CHARACTER', name: 'Leo', characterId: 'cid-target' })];
      }
      return [
        mk({
          id: 's-leo',
          projectId: 'source',
          kind: 'CHARACTER',
          name: 'Leo',
          characterId: 'cid-source',
          imageUrl: 'sf-asset://s.png',
        }),
      ];
    });

    const plan = await planSeasonInheritance('target', 'source');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].sourceName).toBe('Leo');
  });

  it('PROP 按 name + metadata.sourceNames 跨语言匹配', async () => {
    vi.mocked(listAssets).mockImplementation(async (pid) => {
      if (pid === 'target') {
        return [
          mk({
            id: 't-sword',
            projectId: 'target',
            kind: 'PROP',
            name: '魔剑',
            metadata: { sourceNames: ['Dark Sword'] },
          }),
        ];
      }
      return [mk({ id: 's-sword', projectId: 'source', kind: 'PROP', name: 'Dark Sword', imageUrl: 'sf-asset://s.png' })];
    });

    const plan = await planSeasonInheritance('target', 'source');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].sourceName).toBe('Dark Sword');
  });

  it('派生图 pencilImageUrl/gridImageUrl 继承（白名单已开放）', async () => {
    vi.mocked(listAssets).mockImplementation(async (pid) => {
      if (pid === 'target') return [mk({ id: 't-leo', projectId: 'target', kind: 'CHARACTER', name: 'Leo' })];
      return [
        mk({
          id: 's-leo',
          projectId: 'source',
          kind: 'CHARACTER',
          name: 'Leo',
          imageUrl: 'sf-asset://s.png',
          pencilImageUrl: 'sf-asset://s-pencil.png',
          gridImageUrl: 'sf-asset://s-grid.png',
        }),
      ];
    });

    const plan = await planSeasonInheritance('target', 'source');
    expect(plan.items[0].pencilImageUrl).toBe('sf-asset://s-pencil.png');
    expect(plan.items[0].gridImageUrl).toBe('sf-asset://s-grid.png');
  });
});

describe('isWholeScriptProject', () => {
  it('整剧 sourceMode（VIDEO_REWRITE/LOCAL_SCRIPT/ORIGINAL_PROJECT）通过', () => {
    expect(isWholeScriptProject({ scriptData: { sourceMode: 'ORIGINAL_PROJECT' } })).toBe(true);
    expect(isWholeScriptProject({ scriptData: { sourceMode: 'LOCAL_SCRIPT' } })).toBe(true);
    expect(isWholeScriptProject({ scriptData: { sourceMode: 'VIDEO_REWRITE' } })).toBe(true);
  });
  it('逐集/参考视频/缺失/非法 拒绝', () => {
    expect(isWholeScriptProject({ scriptData: { sourceMode: 'EPISODE_INPUT' } })).toBe(false);
    expect(isWholeScriptProject({ scriptData: { sourceMode: 'REFERENCE_VIDEO' } })).toBe(false);
    expect(isWholeScriptProject({ scriptData: {} })).toBe(false);
    expect(isWholeScriptProject({ scriptData: null })).toBe(false);
    expect(isWholeScriptProject({ scriptData: { sourceMode: 123 } })).toBe(false);
  });
});
