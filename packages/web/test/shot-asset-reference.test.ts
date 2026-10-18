// ============================================================
// shot-asset-reference.ts — 镜头引用资产解析单测
// ============================================================
//
// 防回归：道具/环境变体绑定后预览图必须用变体图（此前 web resolver 只处理
// CHARACTER，LOCATION/PROP 永远 fallback 基准图——与 server group-preview 分叉）。
// 镜像 server test/domain/group-preview.test.ts 的道具/环境变体用例。
// ============================================================

import { describe, it, expect } from 'vitest';
import type { AssetRecord } from '@dramaforge/server';
import { resolveShotAssetReferenceBindings } from '../app/workspace/[projectId]/components/shot-asset-reference';

const propAsset = {
  id: 'asset-token',
  kind: 'PROP',
  name: '银色令牌',
  imageUrl: 'sf-asset://token-default.png',
  costumes: [
    { key: 'default', imageUrl: 'sf-asset://token-default.png', label: '常态' },
    { key: 'broken', imageUrl: 'sf-asset://token-broken.png', label: '破损' },
  ],
} as unknown as AssetRecord;

const locAsset = {
  id: 'asset-camp',
  kind: 'LOCATION',
  name: '边境军营',
  imageUrl: 'sf-asset://camp-day.png',
  costumes: [
    { key: 'default', imageUrl: 'sf-asset://camp-day.png', label: '白昼' },
    { key: 'night', imageUrl: 'sf-asset://camp-night.png', label: '深夜' },
  ],
} as unknown as AssetRecord;

describe('resolveShotAssetReferenceBindings — 道具/环境变体预览图', () => {
  it('itemCostumes 命中非 default key → 用变体图 + 标变体名', () => {
    const bindings = resolveShotAssetReferenceBindings(
      {
        sceneId: 'S1-1',
        referencedAssets: {
          items: ['银色令牌'],
          itemCostumes: [{ name: '银色令牌', costumeKey: 'broken' }],
        },
      },
      [propAsset],
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].kind).toBe('PROP');
    expect(bindings[0].imageUrl).toBe('sf-asset://token-broken.png');
    expect(bindings[0].costumeKey).toBe('broken');
    expect(bindings[0].costumeLabel).toBe('破损');
  });

  it('无 itemCostumes → 回退基准图且不标 costumeKey', () => {
    const bindings = resolveShotAssetReferenceBindings(
      { sceneId: 'S1-1', referencedAssets: { items: ['银色令牌'] } },
      [propAsset],
    );
    expect(bindings[0].imageUrl).toBe('sf-asset://token-default.png');
    expect(bindings[0].costumeKey).toBeUndefined();
  });

  it('environmentCostumes 命中非 default key → 用变体图 + 标变体名', () => {
    const bindings = resolveShotAssetReferenceBindings(
      {
        sceneId: 'S2-1',
        referencedAssets: {
          environments: ['边境军营'],
          environmentCostumes: [{ name: '边境军营', costumeKey: 'night' }],
        },
      },
      [locAsset],
    );
    expect(bindings[0].kind).toBe('LOCATION');
    expect(bindings[0].imageUrl).toBe('sf-asset://camp-night.png');
    expect(bindings[0].costumeKey).toBe('night');
    expect(bindings[0].costumeLabel).toBe('深夜');
  });

  it('itemCostumes 指向已删变体（悬空 key）→ 静默回退基准图', () => {
    const bindings = resolveShotAssetReferenceBindings(
      {
        sceneId: 'S1-1',
        referencedAssets: {
          items: ['银色令牌'],
          itemCostumes: [{ name: '银色令牌', costumeKey: 'ghost' }],
        },
      },
      [propAsset],
    );
    expect(bindings[0].imageUrl).toBe('sf-asset://token-default.png');
    expect(bindings[0].costumeKey).toBeUndefined();
  });
});
