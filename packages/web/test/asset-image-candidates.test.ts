import { describe, expect, it } from 'vitest';

import {
  buildMissingAssetImageCandidates,
  buildRegenerateAssetImageCandidates,
} from '@web/lib/asset-image-candidates';

const character = {
  id: 'character-1',
  kind: 'CHARACTER',
  imageUrl: null,
  regenLocked: false,
  costumes: [
    { key: 'default', label: '默认', imageUrl: null },
    { key: 'casual', label: '便装', imageUrl: null },
    { key: 'formal', label: '礼服', imageUrl: null },
  ],
};

describe('buildMissingAssetImageCandidates', () => {
  it('queues the default image and every missing costume variant on the first click', () => {
    const candidates = buildMissingAssetImageCandidates([character], () => false);

    expect(candidates.map((candidate) => candidate.costumeKey ?? 'default')).toEqual([
      'default',
      'casual',
      'formal',
    ]);
    expect(candidates.slice(1).every((candidate) => candidate.referenceImageUrl === undefined)).toBe(true);
  });

  it('uses an existing default image as the identity reference for missing variants', () => {
    const candidates = buildMissingAssetImageCandidates([
      {
        ...character,
        imageUrl: 'sf-asset://default.png',
      },
    ], () => false);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.costumeKey)).toEqual(['casual', 'formal']);
    expect(candidates.every((candidate) => candidate.referenceImageUrl === 'sf-asset://default.png')).toBe(true);
  });

  it('skips voice, locked, already generated, and independently pending variants', () => {
    const candidates = buildMissingAssetImageCandidates([
      { id: 'voice-1', kind: 'VOICE', imageUrl: null, regenLocked: false, costumes: [] },
      { ...character, id: 'locked-1', regenLocked: true },
      {
        ...character,
        imageUrl: 'sf-asset://default.png',
        costumes: [
          { key: 'default', imageUrl: 'sf-asset://default.png' },
          { key: 'casual', imageUrl: 'sf-asset://casual.png' },
          { key: 'formal', imageUrl: null },
        ],
      },
    ], (assetId, costumeKey) => assetId === 'character-1' && costumeKey === 'formal');

    expect(candidates).toEqual([]);
  });

  it('queues variants for PROP/LOCATION too (kind-agnostic, aligns with costumes JSONB)', () => {
    const candidates = buildMissingAssetImageCandidates([
      {
        id: 'prop-1',
        kind: 'PROP',
        imageUrl: 'sf-asset://prop-default.png',
        regenLocked: false,
        costumes: [
          { key: 'default', imageUrl: 'sf-asset://prop-default.png' },
          { key: 'broken', label: '损坏', imageUrl: null },
        ],
      },
      {
        id: 'loc-1',
        kind: 'LOCATION',
        imageUrl: null,
        regenLocked: false,
        costumes: [
          { key: 'default', imageUrl: null },
          { key: 'night', label: '夜晚', imageUrl: null },
        ],
      },
    ], () => false);

    // defaults 先于 variants：loc 缺基准图 → default；prop 基准已有 → 仅 broken 变体（带基准参考）
    expect(candidates.map((c) => [c.asset.id, c.costumeKey ?? 'default'])).toEqual([
      ['loc-1', 'default'],
      ['prop-1', 'broken'],
      ['loc-1', 'night'],
    ]);
    expect(
      candidates.find((c) => c.asset.id === 'prop-1' && c.costumeKey === 'broken')?.referenceImageUrl,
    ).toBe('sf-asset://prop-default.png');
  });
});

describe('buildRegenerateAssetImageCandidates', () => {
  it('queues every baseline and all defined character variants, including existing images', () => {
    const candidates = buildRegenerateAssetImageCandidates([
      {
        ...character,
        imageUrl: 'sf-asset://default.png',
        costumes: [
          { key: 'default', imageUrl: 'sf-asset://default.png' },
          { key: 'casual', imageUrl: 'sf-asset://casual.png' },
          { key: 'formal', imageUrl: null },
        ],
      },
      { id: 'prop-1', kind: 'PROP', imageUrl: 'sf-asset://prop.png', costumes: [] },
    ], () => false);

    expect(candidates.map((candidate) => [candidate.asset.id, candidate.costumeKey ?? 'default']))
      .toEqual([
        ['character-1', 'default'],
        ['prop-1', 'default'],
        ['character-1', 'casual'],
        ['character-1', 'formal'],
      ]);
    expect(candidates.slice(2).every(
      (candidate) => candidate.referenceImageUrl === 'sf-asset://default.png',
    )).toBe(true);
  });

  it('excludes voice and locked assets while filtering pending state per costume', () => {
    const candidates = buildRegenerateAssetImageCandidates([
      character,
      { ...character, id: 'locked-1', regenLocked: true },
      { id: 'voice-1', kind: 'VOICE', imageUrl: null, costumes: [] },
    ], (assetId, costumeKey) => assetId === 'character-1' && costumeKey === 'casual');

    expect(candidates.map((candidate) => candidate.costumeKey ?? 'default')).toEqual([
      'default',
      'formal',
    ]);
  });

  it('does not duplicate malformed repeated costume keys', () => {
    const candidates = buildRegenerateAssetImageCandidates([{
      ...character,
      costumes: [
        { key: 'default' },
        { key: 'formal' },
        { key: ' formal ' },
        { key: '' },
      ],
    }], () => false);

    expect(candidates.map((candidate) => candidate.costumeKey ?? 'default'))
      .toEqual(['default', 'formal']);
  });
});
