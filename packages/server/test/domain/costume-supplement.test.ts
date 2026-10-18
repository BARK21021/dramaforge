import { describe, expect, it } from 'vitest';

import { supplementExtractedCostumes } from '../../src/domain/asset/costume-supplement';

describe('supplementExtractedCostumes', () => {
  it('deterministically restores costume variants omitted by the extraction model', () => {
    const extracted = {
      characters: [{
        name: '林夏',
        role_type: 'lead',
        description: '女主角',
        background: '',
        identity_lock: ['黑色长发'],
        relationships: [],
        coverage_scenes: ['S1', 'S2'],
        costumes: [{
          key: 'default', label: '便装', description: '米色针织衫',
          identity_lock: [], coverage_scenes: ['S1'],
        }],
        suggested_voices: [],
      }],
      items: [],
      environments: [],
      entities: [],
    };

    const supplemented = supplementExtractedCostumes(extracted, [
      { sceneId: 'S1', character: '林夏', costumeLabel: '便装', costumeDesc: '米色针织衫', isNew: false },
      { sceneId: 'S2', character: '林夏', costumeLabel: '礼服', costumeDesc: '黑色丝绒晚礼服、银色耳坠、高跟鞋', isNew: true },
      { sceneId: 'S3', character: '林夏', costumeLabel: '礼服', costumeDesc: '黑色丝绒晚礼服', isNew: false },
    ]);

    expect(supplemented).toBe(1);
    expect(extracted.characters[0].costumes).toEqual([
      expect.objectContaining({ key: 'default', label: '便装' }),
      expect.objectContaining({
        key: 'gown',
        label: '礼服',
        description: '黑色丝绒晚礼服、银色耳坠、高跟鞋',
        coverage_scenes: ['S2', 'S3'],
      }),
    ]);
  });
});
