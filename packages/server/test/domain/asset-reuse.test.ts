import { describe, expect, it } from 'vitest';
import {
  getAssetNameAliases,
  mergeCostumes,
  mergeNumberArray,
  normalizeAssetName,
  shouldProtectAssetFromDeletion,
} from '../../src/domain/asset';

describe('project asset reuse helpers', () => {
  it('matches bilingual and formatting variants of the same character', () => {
    expect(getAssetNameAliases('林夏 (Lina)')).toEqual(['林夏 (Lina)', '林夏', 'Lina']);
    expect(normalizeAssetName(' Lina ')).toBe(normalizeAssetName('Li-na'));
  });

  it('preserves generated costume images while merging later episode coverage', () => {
    const result = mergeCostumes(
      [{ key: 'daily', imageUrl: '/existing.png', coverageScenes: ['EP01-S01'] }],
      [{ key: 'daily', imageUrl: null, description: 'winter coat', coverageScenes: ['EP02-S03'] }],
    );
    expect(result[0]).toMatchObject({
      key: 'daily',
      imageUrl: '/existing.png',
      description: 'winter coat',
      coverageScenes: ['EP01-S01', 'EP02-S03'],
    });
  });

  it('unions coverage_episodes (episode numbers) when merging costumes', () => {
    expect(mergeNumberArray([3, 1], [2])).toEqual([1, 2, 3]);
    expect(mergeNumberArray(undefined, [5])).toEqual([5]);
    const result = mergeCostumes(
      [{ key: 'default', coverageEpisodes: [1, 2] }],
      [{ key: 'default', coverageEpisodes: [2, 3] }],
    );
    expect(result[0].coverageEpisodes).toEqual([1, 2, 3]);
  });

  it('protects confirmed, locked, or already generated assets from cleanup', () => {
    expect(shouldProtectAssetFromDeletion({ isConfirmed: true })).toBe(true);
    expect(shouldProtectAssetFromDeletion({ regenLocked: true })).toBe(true);
    expect(shouldProtectAssetFromDeletion({ imageUrl: '/asset.png' })).toBe(true);
    expect(shouldProtectAssetFromDeletion({ costumes: [{ imageUrl: '/costume.png' }] })).toBe(true);
    expect(shouldProtectAssetFromDeletion({})).toBe(false);
  });
});
