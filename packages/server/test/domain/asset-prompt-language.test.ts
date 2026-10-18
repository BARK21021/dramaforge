import { describe, expect, it } from 'vitest';

import {
  buildAssetExtractionPrompt,
  parseAssetExtraction,
} from '../../src/domain/prompt';

describe('asset extraction display-language contract', () => {
  it('keeps character names locked but always requests Chinese prop/location display names', () => {
    const { system } = buildAssetExtractionPrompt(
      'EXT. ABANDONED BOATHOUSE - NIGHT\nCorin picks up the Silver Binding Shackles.',
      [],
      {},
      'en',
    );

    expect(system).toContain('PROP and LOCATION `name` must be Simplified Chinese');
    expect(system).toContain('CHARACTER.name must remain exactly as locked in the script');
    expect(system).toContain('"source_names"');
  });

  it('retains source-language aliases returned for Chinese prop/location names', () => {
    const parsed = parseAssetExtraction(JSON.stringify({
      characters: [],
      items: [{
        name: '银色镣铐', source_names: ['Silver Binding Shackles'],
        item_type: '核心道具', description: '银色金属镣铐', significance: '', coverage_scenes: ['S1'],
      }],
      environments: [{
        name: '废弃船屋', source_names: ['Abandoned Boathouse'], int_ext: '内',
        description: '临海木屋', mood: '阴冷', base_ambience: '海浪', coverage_scenes: ['S1'],
      }],
      entities: [],
    }));

    expect(parsed.items[0].source_names).toEqual(['Silver Binding Shackles']);
    expect(parsed.environments[0].source_names).toEqual(['Abandoned Boathouse']);
  });
});
