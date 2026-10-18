// ============================================================
// ③ server/domain/asset/appearance — 单测（出场集聚合）
// ============================================================
//
// 覆盖 computeAssetMaster：
//   - 基础出场集：角色被 EP1/EP2 镜头引用 → allEpisodes=[1,2]
//   - 变体 override：characterCostumes 命中非 default key → 该变体挂对应集
//   - 未分配：无任何镜头引用 → allEpisodes=[] 且计入 unassigned
//   - 名称归一化：标点/大小写差异仍能匹配
//   - statusCounts（total/imageTotal/imagePresent/unassigned）
//
// mock @server/infra（query）按 SQL 表名分支返回 assets/shots/episodes 行。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'test-uuid'),
}));
vi.mock('@server/infra', () => ({
  query: vi.fn(),
  tx: vi.fn(),
}));

import { computeAssetMaster } from '../../src/domain/asset/appearance';
import { query } from '@server/infra';

type MockResult = { rows: Record<string, unknown>[]; rowCount: number };
const q = query as unknown as (sql: string, params?: unknown[]) => Promise<MockResult>;

/** 造一个最小 assets 行（toAssetRecord 其余字段走 ?? 默认） */
function assetRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'a-1',
    projectId: 'proj-1',
    kind: 'CHARACTER',
    name: '林夏',
    description: null,
    imageUrl: 'sf-asset://x',
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function shotRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 's-1',
    projectId: 'proj-1',
    episodeId: 'ep-1',
    sceneId: null,
    shotSeq: null,
    shotIndex: 0,
    durationSeconds: null,
    visualPrompt: null,
    stylePrompt: null,
    aspectRatio: null,
    resolution: null,
    purposeTag: null,
    emotionArcPosition: null,
    montageType: null,
    audioType: null,
    referencedAssets: null,
    currentMaterialId: null,
    currentMaterialUrl: null,
    videoStatus: 'PENDING',
    status: 'PENDING',
    sortOrder: 0,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function episodeRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ep-1',
    projectId: 'proj-1',
    episodeNumber: 1,
    title: null,
    content: null,
    contentKilo: null,
    status: 'DRAFT',
    defaultVisualStyle: null,
    scenes: null,
    emotionArc: null,
    videoScriptDraft: null,
    novelText: null,
    stageStatus: 'input',
    scriptData: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** 让 query mock 按 FROM 表名分支返回行 */
function mockQueryByTable(
  assets: Record<string, unknown>[],
  shots: Record<string, unknown>[],
  episodes: Record<string, unknown>[],
) {
  q.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM assets')) return { rows: assets, rowCount: assets.length } as MockResult;
    if (sql.includes('FROM shots')) return { rows: shots, rowCount: shots.length } as MockResult;
    if (sql.includes('FROM episodes')) return { rows: episodes, rowCount: episodes.length } as MockResult;
    return { rows: [], rowCount: 0 } as MockResult;
  });
}

beforeEach(() => {
  q.mockReset();
});

describe('computeAssetMaster 出场集聚合', () => {
  it('基础：角色被 EP1/EP2 镜头引用 → allEpisodes=[1,2]', async () => {
    mockQueryByTable(
      [assetRow({ id: 'a-1', kind: 'CHARACTER', name: '林夏', imageUrl: 'sf-asset://1' })],
      [
        shotRow({ id: 's-1', episodeId: 'ep-1', referencedAssets: { characters: ['林夏'] } }),
        shotRow({ id: 's-2', episodeId: 'ep-2', referencedAssets: { characters: ['林夏'] } }),
      ],
      [episodeRow({ id: 'ep-1', episodeNumber: 1 }), episodeRow({ id: 'ep-2', episodeNumber: 2 })],
    );
    const m = await computeAssetMaster('proj-1');
    expect(m.appearance['a-1'].allEpisodes).toEqual([1, 2]);
    expect(m.appearance['a-1'].byVariant.find((v) => v.key === 'default')?.episodes).toEqual([1, 2]);
    expect(m.statusCounts.unassigned).toBe(0);
  });

  it('变体 override：characterCostumes 命中断剑态 → 该变体挂对应集，default 不挂', async () => {
    mockQueryByTable(
      [
        assetRow({
          id: 'a-1',
          kind: 'CHARACTER',
          name: '骑士剑',
          imageUrl: 'sf-asset://main',
          costumes: [
            { key: 'broken', label: '断剑态', imageUrl: 'sf-asset://broken' },
          ],
        }),
      ],
      [
        // EP1 用断剑态 override
        shotRow({ id: 's-1', episodeId: 'ep-1', referencedAssets: { characters: ['骑士剑'], characterCostumes: [{ name: '骑士剑', costumeKey: 'broken' }] } }),
        // EP2 不 override → default
        shotRow({ id: 's-2', episodeId: 'ep-2', referencedAssets: { characters: ['骑士剑'] } }),
      ],
      [episodeRow({ id: 'ep-1', episodeNumber: 1 }), episodeRow({ id: 'ep-2', episodeNumber: 2 })],
    );
    const m = await computeAssetMaster('proj-1');
    const broken = m.appearance['a-1'].byVariant.find((v) => v.key === 'broken');
    const def = m.appearance['a-1'].byVariant.find((v) => v.key === 'default');
    expect(broken?.episodes).toEqual([1]);
    expect(def?.episodes).toEqual([2]);
    expect(m.appearance['a-1'].allEpisodes).toEqual([1, 2]);
  });

  it('未分配：无镜头引用 → allEpisodes=[] 且计入 unassigned', async () => {
    mockQueryByTable(
      [assetRow({ id: 'a-1', kind: 'PROP', name: '身份令牌', imageUrl: null })],
      [shotRow({ id: 's-1', episodeId: 'ep-1', referencedAssets: { items: ['别的道具'] } })],
      [episodeRow({ id: 'ep-1', episodeNumber: 1 })],
    );
    const m = await computeAssetMaster('proj-1');
    expect(m.appearance['a-1'].allEpisodes).toEqual([]);
    expect(m.statusCounts.unassigned).toBe(1);
  });

  it('coverage_episodes 播种：资产阶段（无分镜）按集号种入变体桶', async () => {
    mockQueryByTable(
      [assetRow({
        id: 'a-1',
        kind: 'PROP',
        name: '魔剑',
        imageUrl: null,
        costumes: [
          { key: 'default', label: '完好', imageUrl: null, coverage_episodes: [1, 2] },
          { key: 'broken', label: '断剑', imageUrl: null, coverage_episodes: [3] },
        ],
      })],
      [], // 无任何分镜镜头——纯靠 coverage_episodes 播种
      [
        episodeRow({ id: 'ep-1', episodeNumber: 1 }),
        episodeRow({ id: 'ep-2', episodeNumber: 2 }),
        episodeRow({ id: 'ep-3', episodeNumber: 3 }),
      ],
    );
    const m = await computeAssetMaster('proj-1');
    expect(m.appearance['a-1'].byVariant.find((v) => v.key === 'default')?.episodes).toEqual([1, 2]);
    expect(m.appearance['a-1'].byVariant.find((v) => v.key === 'broken')?.episodes).toEqual([3]);
    expect(m.appearance['a-1'].allEpisodes).toEqual([1, 2, 3]);
    expect(m.statusCounts.unassigned).toBe(0); // 有 coverage_episodes → 非未分配
  });

  it('coverage_episodes 兼容 camelCase 命名（service.ts 写入形状）', async () => {
    mockQueryByTable(
      [assetRow({
        id: 'a-1',
        kind: 'LOCATION',
        name: '神殿',
        imageUrl: null,
        costumes: [
          { key: 'default', label: '白昼', imageUrl: null, coverageEpisodes: [2, 4] },
        ],
      })],
      [],
      [episodeRow({ id: 'ep-2', episodeNumber: 2 }), episodeRow({ id: 'ep-4', episodeNumber: 4 })],
    );
    const m = await computeAssetMaster('proj-1');
    expect(m.appearance['a-1'].byVariant.find((v) => v.key === 'default')?.episodes).toEqual([2, 4]);
    expect(m.appearance['a-1'].allEpisodes).toEqual([2, 4]);
  });

  it('名称归一化：仅空格/大小写差异仍匹配', async () => {
    mockQueryByTable(
      [assetRow({ id: 'a-1', kind: 'CHARACTER', name: '马库斯', imageUrl: 'sf-asset://m' })],
      // 镜头引用带空格 + 大写英文，归一化后应等于资产名
      [shotRow({ id: 's-1', episodeId: 'ep-1', referencedAssets: { characters: ['马 库斯'] } })],
      [episodeRow({ id: 'ep-1', episodeNumber: 1 })],
    );
    const m = await computeAssetMaster('proj-1');
    // "马 库斯" 去空格 → "马库斯" = 资产名 → 匹配
    expect(m.appearance['a-1'].allEpisodes).toEqual([1]);
    expect(m.statusCounts.unassigned).toBe(0);
  });

  it('名称归一化：实质不同名（多了字）不匹配', async () => {
    mockQueryByTable(
      [assetRow({ id: 'a-1', kind: 'CHARACTER', name: '马库斯', imageUrl: 'sf-asset://m' })],
      [shotRow({ id: 's-1', episodeId: 'ep-1', referencedAssets: { characters: ['马库斯（将军）'] } })],
      [episodeRow({ id: 'ep-1', episodeNumber: 1 })],
    );
    const m = await computeAssetMaster('proj-1');
    // "马库斯（将军）" 去括号 → "马库斯将军" ≠ "马库斯" → 不匹配
    expect(m.appearance['a-1'].allEpisodes).toEqual([]);
    expect(m.statusCounts.unassigned).toBe(1);
  });

  it('statusCounts：total/imageTotal/imagePresent 计数正确', async () => {
    mockQueryByTable(
      [
        assetRow({ id: 'a-1', kind: 'CHARACTER', name: 'A', imageUrl: 'sf-asset://a', costumes: [{ key: 'v1', label: 'V1', imageUrl: null }] }),
        assetRow({ id: 'a-2', kind: 'PROP', name: 'B', imageUrl: null }),
      ],
      [
        shotRow({ id: 's-1', episodeId: 'ep-1', referencedAssets: { characters: ['A'] } }),
      ],
      [episodeRow({ id: 'ep-1', episodeNumber: 1 })],
    );
    const m = await computeAssetMaster('proj-1');
    // a-1: default(有图) + v1(无图，但无出场不列) → imageTotal 累加 default+v1=2，imagePresent=1
    // a-2: default(无图) → imageTotal+1，imagePresent+0
    expect(m.statusCounts.total).toBe(2);
    expect(m.statusCounts.imageTotal).toBe(3); // a-1 default + v1 + a-2 default
    expect(m.statusCounts.imagePresent).toBe(1); // 仅 a-1 default 有图
  });

  it('episodes 按 episodeNumber 升序返回', async () => {
    mockQueryByTable(
      [assetRow({ id: 'a-1', kind: 'CHARACTER', name: 'A', imageUrl: 'x' })],
      [shotRow({ id: 's-1', episodeId: 'ep-3', referencedAssets: { characters: ['A'] } })],
      [
        episodeRow({ id: 'ep-3', episodeNumber: 3 }),
        episodeRow({ id: 'ep-1', episodeNumber: 1 }),
      ],
    );
    const m = await computeAssetMaster('proj-1');
    expect(m.episodes.map((e) => e.episodeNumber)).toEqual([1, 3]);
  });
});
