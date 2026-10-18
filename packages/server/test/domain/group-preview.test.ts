// ============================================================
// ③ server/domain/prompt — 成组提示词预览纯函数测试
// ============================================================
// 验证时间排序、向上对齐时长、富 metadata/基础字段兜底，以及 15 秒硬边界。
// 测试不 mock 数据库或外部服务，确保该能力确实是零 I/O 的纯文本组合。
// ============================================================

import { describe, expect, it } from 'vitest';
import {
  buildGroupPreviewPrompt,
  buildShotNarrative,
  combineGroupPrompts,
  collectReferenceAssets,
  parseShotSoundDesign,
  SEEDANCE_MOTION_CALIBRATION,
  splitShotsByAssetLimit,
  type GroupPreviewShot,
} from '../../src/domain/prompt';

/** 构造纯函数测试所需的最小镜头。 */
function makeShot(
  id: string,
  overrides: Partial<GroupPreviewShot> = {},
): GroupPreviewShot {
  return {
    id,
    sortOrder: 1,
    shotIndex: 1,
    shotSeq: id.toUpperCase(),
    durationSeconds: 4,
    visualPrompt: `${id} 的基础画面`,
    purposeTag: null,
    referencedAssets: null,
    metadata: null,
    ...overrides,
  };
}

describe('buildGroupPreviewPrompt', () => {
  it('按分段场景选择角色造型图，并让 assetRefs 与实际参考图顺序严格一致', () => {
    const shot = makeShot('shot-costume', {
      referencedAssets: {
        characters: ['林晚'],
        environments: ['旧宅门厅'],
        items: ['银色钥匙'],
      },
      metadata: { sceneId: 'S3-1' },
    });
    const references = collectReferenceAssets(
      [shot],
      [
        {
          id: 'character-1',
          kind: 'CHARACTER',
          name: '林晚',
          imageUrl: '/assets/lin-wan-default.png',
          costumes: [
            {
              key: 'default',
              label: '便装',
              description: '白衬衫',
              identityLock: [],
              imageUrl: '/assets/lin-wan-default.png',
              coverageScenes: ['S1'],
            },
            {
              key: 'battle',
              label: '战损',
              description: '破损风衣',
              identityLock: [],
              imageUrl: '/assets/lin-wan-battle.png',
              coverageScenes: ['S3'],
            },
          ],
        },
        {
          id: 'location-1',
          kind: 'LOCATION',
          name: '旧宅门厅',
          imageUrl: '/assets/foyer.png',
        },
        {
          id: 'prop-1',
          kind: 'PROP',
          name: '银色钥匙',
          imageUrl: '/assets/key.png',
        },
      ],
      [{ sceneId: 'S3', character: '林晚', costumeLabel: '战损' }],
    );

    expect(references.characterImageUrls).toEqual(['/assets/lin-wan-battle.png']);
    expect(references.imageUrls).toEqual(['/assets/foyer.png', '/assets/key.png']);
    expect(references.assetRefs).toEqual([
      { name: '林晚', kind: 'CHARACTER' },
      { name: '旧宅门厅', kind: 'LOCATION' },
      { name: '银色钥匙', kind: 'PROP' },
    ]);
  });

  it('道具/环境变体：按镜头 itemCostumes/environmentCostumes 选变体图并标注变体名', () => {
    // 整剧提取的变体只有 coverageEpisodes、coverageScenes 为空——过去 selectVariantByScene
    // 永远命中不到，分镜只用基准图。现在靠镜头显式 costumeKey 选中变体图。
    const variantAssets = [
      {
        id: 'prop-1',
        kind: 'PROP',
        name: '圣骑士身份令牌',
        imageUrl: '/assets/token-default.png',
        costumes: [
          { key: 'default', label: '完好', description: '完整令牌', identityLock: [], imageUrl: '/assets/token-default.png', coverageScenes: [] },
          { key: 'crushed', label: '破损', description: '被踩碎', identityLock: [], imageUrl: '/assets/token-crushed.png', coverageScenes: [], coverageEpisodes: [8] },
        ],
      },
      {
        id: 'loc-1',
        kind: 'LOCATION',
        name: '边境军营',
        imageUrl: '/assets/camp-default.png',
        costumes: [
          { key: 'default', label: '正常', description: '驻军营地', identityLock: [], imageUrl: '/assets/camp-default.png', coverageScenes: [] },
          { key: 'goblin-occupied', label: '哥布林占据', description: '被占领', identityLock: [], imageUrl: '/assets/camp-goblin.png', coverageScenes: [], coverageEpisodes: [15, 17] },
        ],
      },
    ];
    const shot = makeShot('shot-variants', {
      referencedAssets: {
        items: ['圣骑士身份令牌'],
        environments: ['边境军营'],
        itemCostumes: [{ name: '圣骑士身份令牌', costumeKey: 'crushed' }],
        environmentCostumes: [{ name: '边境军营', costumeKey: 'goblin-occupied' }],
      },
      metadata: { sceneId: 'S8-1' },
    });

    const references = collectReferenceAssets([shot], variantAssets);
    // LOCATION 先于 PROP 收集 → 变体图（非基准）
    expect(references.imageUrls).toEqual(['/assets/camp-goblin.png', '/assets/token-crushed.png']);
    expect(references.assetRefs).toEqual([
      { name: '边境军营', kind: 'LOCATION', variantLabel: '哥布林占据', variantCode: 'custom-02' },
      { name: '圣骑士身份令牌', kind: 'PROP', variantLabel: '破损', variantCode: 'custom-02' },
    ]);

    const prompt = combineGroupPrompts([shot], { allAssets: variantAssets, assetRefs: references.assetRefs });
    // 变体编号（code）已落 binding → 标注带编号：`（custom-02 哥布林占据）`。
    expect(prompt.combinedPrompt).toContain('（custom-02 哥布林占据）');
    expect(prompt.combinedPrompt).toContain('（custom-02 破损）');
  });

  it('无 itemCostumes 或 costumeKey=default 时回退基准图且不标变体', () => {
    const baselineAssets = [
      {
        id: 'prop-1',
        kind: 'PROP',
        name: '圣骑士身份令牌',
        imageUrl: '/assets/token-default.png',
        costumes: [
          { key: 'default', label: '完好', identityLock: [], imageUrl: '/assets/token-default.png', coverageScenes: [] },
          { key: 'crushed', label: '破损', identityLock: [], imageUrl: '/assets/token-crushed.png', coverageScenes: [], coverageEpisodes: [8] },
        ],
      },
    ];
    // 无 itemCostumes
    const shotNoRef = makeShot('shot-no-ref', {
      referencedAssets: { items: ['圣骑士身份令牌'] },
      metadata: { sceneId: 'S8-2' },
    });
    expect(collectReferenceAssets([shotNoRef], baselineAssets).imageUrls).toEqual(['/assets/token-default.png']);
    expect(collectReferenceAssets([shotNoRef], baselineAssets).assetRefs).toEqual([
      { name: '圣骑士身份令牌', kind: 'PROP' },
    ]);

    // 显式 default
    const shotDefault = makeShot('shot-default', {
      referencedAssets: {
        items: ['圣骑士身份令牌'],
        itemCostumes: [{ name: '圣骑士身份令牌', costumeKey: 'default' }],
      },
      metadata: { sceneId: 'S8-3' },
    });
    expect(collectReferenceAssets([shotDefault], baselineAssets).imageUrls).toEqual(['/assets/token-default.png']);
  });

  it('用 metadata.sourceNames 匹配中文展示的场景和道具资产', () => {
    const shot = makeShot('shot-localized-assets', {
      referencedAssets: {
        environments: ['Abandoned Boathouse'],
        items: ['Silver Binding Shackles'],
      },
      metadata: {
        sceneLocation: 'Abandoned Boathouse',
        storyboardTable: { visualContent: '主角走进废弃船屋' },
      },
    });
    const localizedAssets = [
      {
        id: 'location-cn',
        kind: 'LOCATION',
        name: '废弃船屋',
        imageUrl: '/assets/boathouse.png',
        intExt: '外',
        mood: '冷色阴雨',
        metadata: { sourceNames: ['Abandoned Boathouse'] },
      },
      {
        id: 'prop-cn',
        kind: 'PROP',
        name: '银色束缚镐铐',
        imageUrl: '/assets/shackles.png',
        metadata: { sourceNames: ['Silver Binding Shackles'] },
      },
    ];

    const references = collectReferenceAssets([shot], localizedAssets);
    expect(references.imageUrls).toEqual([
      '/assets/boathouse.png',
      '/assets/shackles.png',
    ]);
    expect(references.assetRefs).toEqual([
      { name: '废弃船屋', kind: 'LOCATION' },
      { name: '银色束缚镐铐', kind: 'PROP' },
    ]);

    const prompt = combineGroupPrompts([shot], { allAssets: localizedAssets });
    expect(prompt.combinedPrompt).toContain('场景：Abandoned Boathouse；外景');
    expect(prompt.combinedPrompt).toContain('冷调');
  });

  it('按主角优先收集最多三条音色，并保持 audioRefs 与 URL 同序', () => {
    const shot = makeShot('shot-voices', {
      referencedAssets: {
        characters: ['配角甲', '主角', '配角乙', '配角丙'],
        speakingCharacters: ['配角甲', '主角', '配角乙', '配角丙'],
      },
    });
    const references = collectReferenceAssets(
      [shot],
      [
        { id: 'a', kind: 'CHARACTER', name: '配角甲', imageUrl: '/a.png' },
        {
          id: 'main',
          kind: 'CHARACTER',
          name: '主角',
          imageUrl: '/main.png',
          assetType: '主角',
          metadata: { confirmed_voice: { file: 'main voice.wav' } },
        },
        {
          id: 'b',
          kind: 'CHARACTER',
          name: '配角乙',
          imageUrl: '/b.png',
          metadata: { audioUrl: '/voices/b.wav' },
        },
        {
          id: 'c',
          kind: 'CHARACTER',
          name: '配角丙',
          imageUrl: '/c.png',
          voiceId: 'c voice.wav',
        },
        { id: 'voice-a', kind: 'VOICE', name: '配角甲', imageUrl: '/voices/a.wav' },
      ],
    );

    expect(references.audioUrls).toEqual([
      '/api/reference-audio/main%20voice.wav',
      '/voices/a.wav',
      '/voices/b.wav',
    ]);
    expect(references.audioRefs).toEqual([
      { name: '主角' },
      { name: '配角甲' },
      { name: '配角乙' },
    ]);
    expect(references.clientAudioFiles).toEqual([
      'main voice.wav',
      null,
      null,
    ]);
  });

  it('未显式声明说话角色时，从分镜对白中识别并收集音色', () => {
    const references = collectReferenceAssets(
      [
        makeShot('shot-inferred-voice', {
          referencedAssets: { characters: ['林晚'] },
          metadata: {
            storyboardTable: {
              characters: ['林晚'],
              visualContent: '林晚转身看向门口',
              soundCue: '门轴声；林晚低声说“你终于来了”',
            },
          },
        }),
      ],
      [
        {
          id: 'lin-wan',
          kind: 'CHARACTER',
          name: '林晚',
          imageUrl: '/lin-wan.png',
          voiceId: 'lin-wan.wav',
        },
      ],
    );

    expect(references.audioUrls).toEqual(['/api/reference-audio/lin-wan.wav']);
    expect(references.audioRefs).toEqual([{ name: '林晚' }]);
  });

  it('明确造型图优先于默认彩铅缓存，并把开启网格的场景资产放入人物参考通道', () => {
    const shot = makeShot('shot-grid', {
      referencedAssets: {
        characters: ['林晚'],
        environments: ['旧宅门厅'],
        items: ['银色钥匙'],
      },
      metadata: { sceneId: 'S3' },
    });
    const references = collectReferenceAssets(
      [shot],
      [
        {
          id: 'character-1',
          kind: 'CHARACTER',
          name: '林晚',
          imageUrl: '/assets/lin-wan.png',
          pencilPaintEnabled: true,
          pencilImageUrl: '/assets/lin-wan-pencil.png',
          costumes: [{ label: '战损', imageUrl: '/assets/lin-wan-battle.png' }],
        },
        {
          id: 'location-1',
          kind: 'LOCATION',
          name: '旧宅门厅',
          imageUrl: '/assets/foyer.png',
          gridOverlayEnabled: true,
        },
        {
          id: 'prop-1',
          kind: 'PROP',
          name: '银色钥匙',
          imageUrl: '/assets/key.png',
          pencilPaintEnabled: true,
          metadata: { pencilPaintingUrl: '/assets/key-pencil.png' },
        },
      ],
      [{ sceneId: 'S3', character: '林晚', costumeLabel: '战损' }],
    );

    expect(references.characterImageUrls).toEqual([
      '/assets/lin-wan-battle.png',
      '/assets/foyer.png',
    ]);
    expect(references.imageUrls).toEqual(['/assets/key-pencil.png']);
    expect(references.assetRefs).toEqual([
      { name: '林晚', kind: 'CHARACTER' },
      { name: '旧宅门厅', kind: 'LOCATION' },
      { name: '银色钥匙', kind: 'PROP' },
    ]);
  });

  it('指定造型不存在或缺图时回退默认图（对齐 app1），仍收集未解析明细供诊断', () => {
    const shot = makeShot('shot-missing-costume', {
      referencedAssets: { characters: ['林晚', '周宁'] },
      metadata: { sceneId: 'S4' },
    });
    const references = collectReferenceAssets(
      [shot],
      [
        {
          id: 'lin-wan',
          kind: 'CHARACTER',
          name: '林晚',
          imageUrl: '/assets/lin-wan-default.png',
          costumes: [{ key: 'formal', label: '礼服', imageUrl: null }],
        },
        {
          id: 'zhou-ning',
          kind: 'CHARACTER',
          name: '周宁',
          imageUrl: '/assets/zhou-ning-default.png',
          costumes: [{ key: 'default', label: '便装', imageUrl: '/assets/zhou-ning-default.png' }],
        },
      ],
      [
        { sceneId: 'S4', character: '林晚', costumeLabel: '礼服' },
        { sceneId: 'S4', character: '周宁', costumeLabel: '战损' },
      ],
    );

    // 对齐 app1：造型缺图/不存在时回退到角色默认图，characterImageUrls 非空。
    expect(references.characterImageUrls).toEqual([
      '/assets/lin-wan-default.png',
      '/assets/zhou-ning-default.png',
    ]);
    // unresolvedCostumes 仍收集（供诊断/前端提示），但不再阻断生成。
    expect(references.unresolvedCostumes).toEqual([
      {
        assetId: 'lin-wan',
        assetName: '林晚',
        character: '林晚',
        sceneId: 'S4',
        costumeLabel: '礼服',
        reason: 'IMAGE_MISSING',
      },
      {
        assetId: 'zhou-ning',
        assetName: '周宁',
        character: '周宁',
        sceneId: 'S4',
        costumeLabel: '战损',
        reason: 'COSTUME_NOT_FOUND',
      },
    ]);
  });

  it('分镜 characterCostumes 覆盖优先于脚本 costumeMap：换的角色变体真正进参考图', () => {
    // 修复 E：group-preview 过去只读脚本级 costumeMap，分镜里 setCharacterCostume 写的
    // characterCostumes 被忽略 → 换装只是前端变化，没进 Seedance。现在 characterCostumes 优先。
    const asset = {
      id: 'lin-wan',
      kind: 'CHARACTER',
      name: '林晚',
      imageUrl: '/assets/lin-wan-default.png',
      costumes: [
        { key: 'default', label: '便装', description: '白衬衫', identityLock: [] as string[], imageUrl: '/assets/lin-wan-default.png', coverageScenes: ['S1'] },
        { key: 'battle', label: '战损', description: '破损风衣', identityLock: [], imageUrl: '/assets/lin-wan-battle.png', coverageScenes: ['S3'] },
        { key: 'formal', label: '礼服', description: '黑色礼服', identityLock: [], imageUrl: '/assets/lin-wan-formal.png', coverageScenes: ['S5'] },
      ],
    };
    // 脚本 costumeMap 在 S3 把林晚指向「礼服」——用来证明 characterCostumes 能盖过它。
    const costumeMap = [{ sceneId: 'S3', character: '林晚', costumeLabel: '礼服' }];

    // 镜头显式 battle → 即便 costumeMap 指向礼服，也用 battle 变体图，并标变体名。
    const overrideShot = makeShot('shot-override', {
      referencedAssets: {
        characters: ['林晚'],
        characterCostumes: [{ name: '林晚', costumeKey: 'battle' }],
      },
      metadata: { sceneId: 'S3-1' },
    });
    const overrideRefs = collectReferenceAssets([overrideShot], [asset], costumeMap);
    expect(overrideRefs.characterImageUrls).toEqual(['/assets/lin-wan-battle.png']);
    // 变体编号：battle 是 costumes[1] → ordinal 2；资产名"林晚"非 ASCII → 前缀 custom。
    expect(overrideRefs.assetRefs).toEqual([
      { name: '林晚', kind: 'CHARACTER', variantLabel: '战损', variantCode: 'custom-02' },
    ]);

    // 无 characterCostumes → 维持 costumeMap（S3 → 礼服），不标 variantLabel。
    const mapShot = makeShot('shot-map', {
      referencedAssets: { characters: ['林晚'] },
      metadata: { sceneId: 'S3-1' },
    });
    const mapRefs = collectReferenceAssets([mapShot], [asset], costumeMap);
    expect(mapRefs.characterImageUrls).toEqual(['/assets/lin-wan-formal.png']);
    expect(mapRefs.assetRefs).toEqual([{ name: '林晚', kind: 'CHARACTER' }]);

    // characterCostumes=default → 不覆盖，走 costumeMap/基准（不标 variantLabel）。
    const defaultOverrideShot = makeShot('shot-default-override', {
      referencedAssets: {
        characters: ['林晚'],
        characterCostumes: [{ name: '林晚', costumeKey: 'default' }],
      },
      metadata: { sceneId: 'S3-1' },
    });
    expect(collectReferenceAssets([defaultOverrideShot], [asset], costumeMap).characterImageUrls).toEqual(['/assets/lin-wan-formal.png']);
  });

  it('characterCostumes 指定的角色变体缺图时记 IMAGE_MISSING 并回退基准图（不阻断）', () => {
    const asset = {
      id: 'lin-wan',
      kind: 'CHARACTER',
      name: '林晚',
      imageUrl: '/assets/lin-wan-default.png',
      costumes: [
        { key: 'default', label: '便装', identityLock: [] as string[], imageUrl: '/assets/lin-wan-default.png', coverageScenes: [] },
        { key: 'battle', label: '战损', identityLock: [], imageUrl: null, coverageScenes: [] },
      ],
    };
    const shot = makeShot('shot-missing-char-variant', {
      referencedAssets: {
        characters: ['林晚'],
        characterCostumes: [{ name: '林晚', costumeKey: 'battle' }],
      },
      metadata: { sceneId: 'S3-1' },
    });
    const refs = collectReferenceAssets([shot], [asset]);
    // battle 变体无图 → 回退基准图，characterImageUrls 非空。
    expect(refs.characterImageUrls).toEqual(['/assets/lin-wan-default.png']);
    expect(refs.unresolvedCostumes).toEqual([
      { assetId: 'lin-wan', assetName: '林晚', character: '林晚', sceneId: 'S3', costumeLabel: 'battle', reason: 'IMAGE_MISSING' },
    ]);
  });

  it('uses the top-level character image for a legacy default costume row without imageUrl', () => {
    const shot = makeShot('shot-default-costume', {
      referencedAssets: { characters: ['Lin Wan'] },
      metadata: { sceneId: 'S5' },
    });
    const references = collectReferenceAssets(
      [shot],
      [{
        id: 'lin-wan',
        kind: 'CHARACTER',
        name: 'Lin Wan',
        imageUrl: '/assets/lin-wan-default.png',
        costumes: [{ key: 'default', label: 'Casual', imageUrl: null }],
      }],
      [{ sceneId: 'S5', character: 'Lin Wan', costumeLabel: 'Casual' }],
    );

    expect(references.characterImageUrls).toEqual(['/assets/lin-wan-default.png']);
    expect(references.unresolvedCostumes).toEqual([]);
  });

  it('在参考图或人物图达到上限前贪心拆组，并保持镜头原顺序', () => {
    const characterAssets = Array.from({ length: 5 }, (_, index) => ({
      id: `character-${index + 1}`,
      kind: 'CHARACTER',
      name: `角色${index + 1}`,
      imageUrl: `/characters/${index + 1}.png`,
    }));
    const characterShots = characterAssets.map((asset, index) =>
      makeShot(`shot-${index + 1}`, {
        sortOrder: index + 1,
        shotIndex: index + 1,
        referencedAssets: { characters: [asset.name] },
      }),
    );

    const characterGroups = splitShotsByAssetLimit(
      characterShots,
      characterAssets,
      9,
      4,
    );
    expect(characterGroups.map((group) => group.map((shot) => shot.id))).toEqual([
      ['shot-1', 'shot-2', 'shot-3', 'shot-4'],
      ['shot-5'],
    ]);

    const propAssets = Array.from({ length: 10 }, (_, index) => ({
      id: `prop-${index + 1}`,
      kind: 'PROP',
      name: `道具${index + 1}`,
      imageUrl: `/props/${index + 1}.png`,
    }));
    const propShots = propAssets.map((asset, index) =>
      makeShot(`prop-shot-${index + 1}`, {
        sortOrder: index + 1,
        shotIndex: index + 1,
        referencedAssets: { items: [asset.name] },
      }),
    );
    expect(
      splitShotsByAssetLimit(propShots, propAssets).map((group) => group.length),
    ).toEqual([9, 1]);
  });

  it('组合生产级提示词时同时锁定风格、声画、动作与本地化语言', () => {
    const result = combineGroupPrompts(
      [
        makeShot('shot-1', {
          sortOrder: 1,
          shotIndex: 1,
          durationSeconds: 3,
          visualPrompt: '画风：旧写实 | 画幅：9:16 | 视角：第三人称视角',
          purposeTag: '冲突建立',
          referencedAssets: {
            characters: ['林晚'],
            speakingCharacters: ['林晚'],
            environments: ['医院走廊'],
            items: ['银色钥匙'],
          },
          metadata: {
            sceneId: 'S1',
            sceneLocation: '医院走廊',
            storyboardTable: {
              groupLabel: '雨夜重逢',
              shotSize: '近景',
              cameraAngle: '低机位',
              action: '林晚悲伤地伸手接住银色钥匙',
              visualContent: '林晚站在门边，伸手接住银色钥匙',
              soundCue: '雨声；林晚低声说“别走”',
              globalPrompt: '冷蓝色夜景',
              detailEnhancement: '顶灯在湿地面形成反光',
            },
          },
        }),
        makeShot('shot-2', {
          sortOrder: 2,
          shotIndex: 2,
          durationSeconds: 4,
          purposeTag: '关系落点',
          referencedAssets: { characters: ['林晚'] },
          metadata: {
            storyboardTable: {
              shotSize: '中景',
              cameraAngle: '平视',
              action: '林晚收紧手指，缓慢抬头',
              visualContent: '钥匙停在林晚掌心，林晚缓慢抬头',
            },
          },
        }),
      ],
      {
        prevLastFrameHint: true,
        assetRefs: [
          { name: '林晚', kind: 'CHARACTER', variantLabel: '幼年形态' },
          { name: '医院走廊', kind: 'LOCATION' },
          { name: '银色钥匙', kind: 'PROP' },
        ],
        audioRefs: [{ name: '林晚' }],
        projectArtStyle: '2d_anime',
        language: 'zh',
        aspectRatio: '16:9',
        localizationProfile: {
          stylePrompt: 'English localization',
          targetLanguage: {
            code: 'en',
            native: 'English',
            zh: '英语',
            en: 'English',
            region: 'Global',
            cultureHint: 'natural English dialogue',
          },
        },
      },
    );

    expect(result.validDuration).toBe(8);
    expect(result.totalDuration).toBe(8);
    expect(result.combinedPrompt).toContain('## 项目风格锁定：2D动漫风');
    expect(result.combinedPrompt).toContain('所有生成内容必须严格遵循以下约束');
    expect(result.combinedPrompt).toContain('参考 图片1 中的角色形象（幼年形态），保持林晚特征一致');
    expect(result.combinedPrompt).toContain('场景设定参考 图片2 中的医院走廊');
    expect(result.combinedPrompt).toContain('道具参考 图片3 中的银色钥匙');
    expect(result.combinedPrompt).toContain('参考音频1的林晚音色');
    expect(result.combinedPrompt).toContain('当前动作：林晚悲伤地伸手接住银色钥匙。');
    expect(result.combinedPrompt).toContain('声音：{林晚低声说“别走”}；<雨声>。');
    expect(result.combinedPrompt).toContain('情绪外化：低头');
    expect(result.combinedPrompt).toContain('Shot 2 [00:03-00:08]（5.0秒）');
    expect(result.combinedPrompt).toContain('画幅：16:9');
    expect(result.combinedPrompt).toContain('【视频语言硬约束：英语 / English（en）】');
    expect(result.combinedPrompt).toContain(SEEDANCE_MOTION_CALIBRATION);
    // 首尾衔接行：prevLastFrameHint:true → 注入，并指明「参考图最后一张」是上一组末帧，
    // 且带精确编号（assetRefs=3 → 末帧=图片4），模型按官方图片N 引用而非靠位置猜。
    expect(result.combinedPrompt).toContain('首尾衔接');
    expect(result.combinedPrompt).toContain('上一组末帧（参考图最后一张，图片4）');
    // 层1：砍掉纯编排/QA 样板与创作语境声明（创作语境已上移到 LLM system prompt）
    expect(result.combinedPrompt).not.toContain('创作语境与镜头规范');
    expect(result.combinedPrompt).not.toContain('【全局基础设定】');
    expect(result.combinedPrompt).not.toContain('画面规则');
    expect(result.combinedPrompt).not.toContain('生成验收');
    expect(result.combinedPrompt).not.toContain('声音验收');
    expect(result.combinedPrompt).not.toContain('连续性验收');
    expect(result.combinedPrompt).not.toContain('本组任务');
    expect(result.combinedPrompt).not.toContain('镜头职责');
    // 注：app1 的「首尾衔接」散文行曾作为样板被砍；现已按 prevLastFrameHint 重新注入
    // （见上方 toContain 断言），故不再列入「已砍样板」否定清单。
  });

  it('prevLastFrameHint 缺省/为 false 时不输出首尾衔接行（不回归；仅 strict 串行 groupIndex>0 才注入）', () => {
    const shots = [
      makeShot('shot-1', {
        sortOrder: 1,
        shotIndex: 1,
        durationSeconds: 4,
        visualPrompt: '林晚走入大厅',
        referencedAssets: { characters: ['林晚'] },
        metadata: {
          sceneId: 'S1',
          sceneLocation: '大厅',
          storyboardTable: { shotSize: '中景', cameraAngle: '平视', visualContent: '林晚走入大厅' },
        },
      }),
    ];
    const absent = combineGroupPrompts(shots, { assetRefs: [{ name: '林晚', kind: 'CHARACTER' }] });
    expect(absent.combinedPrompt).not.toContain('首尾衔接');
    expect(absent.combinedPrompt).not.toContain('参考图的最后一张');
    const falseHint = combineGroupPrompts(shots, {
      assetRefs: [{ name: '林晚', kind: 'CHARACTER' }],
      prevLastFrameHint: false,
    });
    expect(falseHint.combinedPrompt).not.toContain('首尾衔接');
  });

  it('C/S 预览包装器复用生产组合器，不降级项目风格和动作约束', () => {
    const result = buildGroupPreviewPrompt(
      [
        makeShot('shot-wrapper', {
          metadata: {
            storyboardTable: {
              action: '林晚缓慢抬手触碰门把手',
              visualContent: '林晚站在旧门前',
            },
          },
        }),
      ],
      undefined,
      [],
      [],
      '2d_anime',
      true,
    );

    expect(result.combinedPrompt).toContain('所有生成内容必须严格遵循以下约束');
    expect(result.combinedPrompt).toContain('当前动作：林晚缓慢抬手触碰门把手。');
    expect(result.combinedPrompt).toContain(SEEDANCE_MOTION_CALIBRATION);
  });

  it('按 sortOrder 排序并输出连续时间码、角色、道具与向上对齐时长', () => {
    const result = buildGroupPreviewPrompt([
      makeShot('shot-2', {
        sortOrder: 2,
        shotIndex: 2,
        durationSeconds: 4,
        visualPrompt: '林夏推开门走入雨夜',
        purposeTag: '转折',
        referencedAssets: { characters: ['林夏'], items: ['旧雨伞'] },
      }),
      makeShot('shot-1', {
        sortOrder: 1,
        durationSeconds: 3,
        referencedAssets: { characters: ['林夏'] },
        metadata: {
          sceneId: 'S1',
          sceneLocation: '老宅门厅',
          storyboardTable: {
            groupLabel: '雨夜归来',
            shotSize: '近景',
            cameraAngle: '低机位',
            cameraMovement: '缓慢推进',
            visualContent: '林夏握住冰冷门把手',
            soundCue: '雨声；林夏低声说“我回来了”',
          },
        },
      }),
    ]);

    // 7 秒必须向上对齐到 8 秒，不能使用旧 nearest 算法压缩到 6 秒。
    expect(result.totalDuration).toBe(7);
    expect(result.validDuration).toBe(8);
    expect(result.combinedPrompt).toContain('# 雨夜归来 | 8秒');
    expect(result.combinedPrompt).toContain('场景：老宅门厅');
    expect(result.combinedPrompt).toContain('角色：林夏');
    expect(result.combinedPrompt).toContain('道具：旧雨伞');
    expect(result.combinedPrompt).toContain('Shot 1 [00:00-00:03]（3.0秒）');
    expect(result.combinedPrompt).toContain('Shot 2 [00:03-00:08]（5.0秒）');
    expect(result.combinedPrompt).toContain('声音：{林夏低声说“我回来了”}；<雨声>。');
    expect(result.combinedPrompt.indexOf('Shot 1')).toBeLessThan(
      result.combinedPrompt.indexOf('Shot 2'),
    );
  });

  it('缺失富 metadata 时使用 visualPrompt 与默认镜头参数', () => {
    const result = buildGroupPreviewPrompt([
      makeShot('shot-1', {
        shotSeq: null,
        durationSeconds: null,
        visualPrompt: '[00:00-00:02] 主角抬头看向天空',
      }),
    ]);

    // 非法时长回退 2 秒，再向上对齐到最小有效档 4 秒。
    expect(result.totalDuration).toBe(2);
    expect(result.validDuration).toBe(4);
    expect(result.combinedPrompt).toContain('Shot 1 [00:00-00:04]（4.0秒）');
    expect(result.combinedPrompt).toContain('镜头：中景、平视，缓慢拉');
    expect(result.combinedPrompt).toContain('画面：主角抬头看向天空');
  });

  it('按 Seedance 图片N格式绑定人物与场景参考图', () => {
    const result = buildGroupPreviewPrompt(
      [makeShot('shot-1')],
      undefined,
      [
        { name: 'Martha Hale', kind: 'CHARACTER' },
        { name: 'Appalachian kitchen', kind: 'LOCATION' },
      ],
      [{ name: 'Martha Hale' }],
    );
    expect(result.combinedPrompt).toContain('参考 图片1 中的角色形象，保持Martha Hale特征一致');
    expect(result.combinedPrompt).toContain('场景设定参考 图片2 中的Appalachian kitchen');
    expect(result.combinedPrompt).toContain('每张图只读取自己的维度，勿互相叠加');
    expect(result.combinedPrompt).toContain('参考音频1的Martha Hale音色');
  });

  it('空组或总时长超过 15 秒时拒绝生成误导性预览', () => {
    expect(() => buildGroupPreviewPrompt([])).toThrow(RangeError);
    expect(() =>
      buildGroupPreviewPrompt([
        makeShot('shot-1', { durationSeconds: 8 }),
        makeShot('shot-2', { durationSeconds: 8, sortOrder: 2 }),
      ]),
    ).toThrow('超过 Seedance 15秒上限');

    // 对齐 app1 分组器：15 秒边界保留 0.05 秒浮点容差，超过后仍按原始精度拒绝。
    expect(
      buildGroupPreviewPrompt([
        makeShot('shot-1', { durationSeconds: 10 }),
        makeShot('shot-2', { durationSeconds: 5.04, sortOrder: 2 }),
      ]).validDuration,
    ).toBe(15);
    expect(() =>
      buildGroupPreviewPrompt([
        makeShot('shot-1', { durationSeconds: 10 }),
        makeShot('shot-2', { durationSeconds: 5.051, sortOrder: 2 }),
      ]),
    ).toThrow('超过 Seedance 15秒上限');
  });

  it('复合体 visualPrompt 拆解：画面正文只出现一次、运镜用列不串正文、主体开场状态无 [voice:]', () => {
    // 生产里 visualContent 列未落库，回退到完整 visualPrompt 复合体（4928 实况）：
    //   【首帧】\n[MM:SS],景别,机位,运镜,[主体]+…,可见动作正文（含逗号）,[voice:…]\n【落点】
    // 正文里的逗号会让旧版 fields[2] split 错位，把正文串进运镜；旧版还把整个复合体
    // dump 进「画面：」又在「当前动作/镜头/首末」重复 → 同一正文出现 4 次。
    const composite = [
      '【Aerial establishing shot of border military camp】',
      '[00:00-00:03],Extreme Wide Shot,top-down aerial,slow forward push,[Marcus]+[camp]+[front]+[standing],fortified camp with rows of tents, wyverns glide overhead,[voice: distant horns, wind, wyvern wing beats]',
      '【The camp recedes as the camera dips toward a corner of the camp】',
    ].join('\n');
    const result = combineGroupPrompts(
      [
        makeShot('shot-1', {
          sortOrder: 1,
          shotIndex: 1,
          durationSeconds: 4,
          visualPrompt: composite,
          referencedAssets: { characters: ['Marcus'] },
          metadata: {
            sceneId: 'S1',
            sceneLocation: '边境军营',
            storyboardTable: {
              shotSize: 'Extreme Wide Shot',
              cameraAngle: 'top-down aerial',
              cameraMovement: 'slow forward push',
              action: 'Aerial push over the camp, wyverns glide past',
            },
          },
        }),
        makeShot('shot-2', {
          sortOrder: 2,
          shotIndex: 2,
          durationSeconds: 4,
          referencedAssets: { characters: ['Marcus'] },
          metadata: {
            sceneId: 'S1',
            storyboardTable: { visualContent: 'Marcus 转身走向营帐' },
          },
        }),
      ],
      { assetRefs: [{ name: 'Marcus', kind: 'CHARACTER' }] },
    );

    // ① 画面正文只出现一次（旧实现 dump 复合体 + 重复片段会出现 4 次）。
    expect(result.combinedPrompt.split('fortified camp with rows of tents').length).toBe(2);
    // ② 画面是干净正文：不含时间码、[voice:]、行外 【…】 首末 bracket（那些进镜头/声音行）。
    const pictureLine = result.combinedPrompt.split('\n').find((line) => line.startsWith('画面：')) ?? '';
    expect(pictureLine).toContain('fortified camp with rows of tents');
    expect(pictureLine).not.toContain('[00:00-00:03]');
    expect(pictureLine).not.toContain('[voice:');
    expect(pictureLine).not.toContain('【');
    // ③ 运镜用 storyboard 列，不串入正文（旧实现 fields[2] 吃进 "slow forward push. A fortified camp…"）。
    const lensLine = result.combinedPrompt.split('\n').find((line) => line.startsWith('镜头：')) ?? '';
    expect(lensLine).toContain('slow forward push');
    expect(lensLine).not.toContain('fortified camp');
    // ④ 主体开场状态不再混入 [voice:]（lockingParts 已过滤音频标签）。
    const lockingLine = result.combinedPrompt.split('\n').find((line) => line.startsWith('主体开场状态：')) ?? '';
    expect(lockingLine).not.toMatch(/voice/i);
  });

  it('英文台词缩写撇号(you\'ll/I\'m/don\'t)不再截断：完整台词进 {对白}、后半截不漏进 <音效>', () => {
    // 旧 quotedSpans `'([^'\n]+)'` 在 you'll 的撇号处闭合，把
    // "Kael, you'll definitely awaken!" 截成 "Kael, you"，后半截 "ll definitely awaken…"
    // 漏进 <音效>。视频成片里角色就丢了台词（4928 实况）。
    const result = combineGroupPrompts(
      [
        makeShot('shot-apostrophe', {
          sortOrder: 1,
          shotIndex: 1,
          durationSeconds: 4,
          referencedAssets: { characters: ['伊莱'], speakingCharacters: ['伊莱'] },
          metadata: {
            sceneId: 'S1',
            storyboardTable: {
              shotSize: '中景',
              cameraAngle: '平视',
              action: '伊莱兴奋地拍上凯伦肩膀',
              soundCue: "伊莱对白：'Kael, you'll definitely awaken as a Priest! Then we'll team up—I'll tank, you heal!'；环境底声持续",
            },
          },
        }),
      ],
      { assetRefs: [{ name: '伊莱', kind: 'CHARACTER' }] },
    );

    // 完整台词（含缩写）必须在 {对白} 里连续出现——旧版会把 you'll 截断，这串不连续。
    expect(result.combinedPrompt).toContain("Kael, you'll definitely awaken as a Priest!");
    expect(result.combinedPrompt).toContain("we'll team up—I'll tank, you heal!");
    const soundLine = result.combinedPrompt.split('\n').find((l) => l.startsWith('声音：')) ?? '';
    expect(soundLine).toContain("{伊莱对白：'Kael, you'll definitely awaken as a Priest!");
    // 后半截台词不能裸露在 <音效> 里。
    expect(soundLine).not.toMatch(/<[^>]*definitely awaken/);
    expect(soundLine).not.toMatch(/<[^>]*tank, you heal/);
  });

  it('道具/环境变体按场景选择：命中 coverageScenes 用变体图，未命中回退默认', () => {
    // 手动 MVP：PROP/LOCATION 复用 costumes JSONB，变体自带 coverageScenes，生成期按场景匹配。
    const propAsset = {
      id: 'prop-sword',
      kind: 'PROP' as const,
      name: '骑士剑',
      imageUrl: '/assets/sword-sheathed.png',
      costumes: [
        { key: 'default', label: '鞘内', imageUrl: '/assets/sword-sheathed.png', coverageScenes: [] as string[], identityLock: [] as string[], description: '剑在鞘内' },
        { key: 'drawn', label: '拔出', imageUrl: '/assets/sword-drawn.png', coverageScenes: ['S3'], identityLock: [], description: '剑拔出挥砍' },
      ],
    };
    const locationAsset = {
      id: 'loc-camp',
      kind: 'LOCATION' as const,
      name: '边境军营',
      imageUrl: '/assets/camp-day.png',
      costumes: [
        { key: 'default', label: '白昼', imageUrl: '/assets/camp-day.png', coverageScenes: [] as string[], identityLock: [] as string[], description: '白昼' },
        { key: 'night', label: '深夜', imageUrl: '/assets/camp-night.png', coverageScenes: ['S3'], identityLock: [], description: '深夜火把' },
      ],
    };

    // 命中 S3：剑用拔出变体、军营用深夜变体。
    const hitRefs = collectReferenceAssets(
      [makeShot('shot-s3', {
        referencedAssets: { environments: ['边境军营'], items: ['骑士剑'] },
        metadata: { sceneId: 'S3-1' },
      })],
      [propAsset, locationAsset],
    );
    expect(hitRefs.imageUrls).toEqual(['/assets/camp-night.png', '/assets/sword-drawn.png']);

    // 未命中（S1 不在任一变体 coverageScenes）：回退默认图。
    const missRefs = collectReferenceAssets(
      [makeShot('shot-s1', {
        referencedAssets: { environments: ['边境军营'], items: ['骑士剑'] },
        metadata: { sceneId: 'S1-1' },
      })],
      [propAsset, locationAsset],
    );
    expect(missRefs.imageUrls).toEqual(['/assets/camp-day.png', '/assets/sword-sheathed.png']);
  });
});

describe('parseShotSoundDesign — 新对白格式「角色名（通道）：台词」', () => {
  it('「角色（OS）：台词」→ 抽纯台词 + 说话人，声音行不再含标签', () => {
    const r = parseShotSoundDesign({
      soundCue: '林夏（OS）：放开我！',
      characterNames: ['林夏', '赵默'],
    });
    expect(r.dialogue).toBe('放开我！');
    expect(r.hasDialogue).toBe(true);
    expect(r.speakingCharacters).toContain('林夏');
  });

  it('裸「角色：台词」（已知角色）→ 抽纯台词 + 说话人', () => {
    const r = parseShotSoundDesign({
      soundCue: '林夏：我没事。',
      characterNames: ['林夏'],
    });
    expect(r.dialogue).toBe('我没事。');
    expect(r.speakingCharacters).toContain('林夏');
  });

  it('多人同镜「；」分隔 → 各句独立剥离，说话人齐全', () => {
    const r = parseShotSoundDesign({
      soundCue: '林夏：放开我！；赵默（OS）：你冷静点。',
      characterNames: ['林夏', '赵默'],
    });
    expect(r.dialogue).toBe('放开我！；你冷静点。');
    expect(r.speakingCharacters).toEqual(expect.arrayContaining(['林夏', '赵默']));
  });

  it('回归：老格式「伊莱对白：…」不走新路径（精确匹配不命中「伊莱对白」），保留前缀', () => {
    // 「伊莱对白」≠ 已知角色「伊莱」（精确匹配），裸探测器不命中 → 落回旧 explicitPayload 逻辑，
    // 保留「伊莱对白：」前缀进对白层（既有契约，不得 regress）。
    const r = parseShotSoundDesign({
      soundCue: "伊莱对白：'Kael, awaken!'",
      characterNames: ['伊莱'],
    });
    expect(r.dialogue).toContain("伊莱对白：'Kael, awaken!'");
    expect(r.hasDialogue).toBe(true);
  });

  it('回归：老格式「林晚低声说"别走"」无冒号，不走新路径，引号台词照常抽取', () => {
    const r = parseShotSoundDesign({
      soundCue: '林晚低声说“别走”',
      characterNames: ['林晚'],
    });
    expect(r.dialogue).toContain('“别走”');
    expect(r.speakingCharacters).toContain('林晚');
  });

  it('「环境：雨声」不被误判为对白（裸探测器要求精确命中已知角色）', () => {
    const r = parseShotSoundDesign({
      soundCue: '环境：雨声',
      characterNames: ['林夏'],
    });
    expect(r.hasDialogue).toBe(false);
    expect(r.effects).toContain('雨声');
  });
});

// ============================================================
// buildShotNarrative：台词（metadata.dialogue）必须注入 {…} 块
// 回归 bug：soundCue 用 `?? metadata.dialogue`，抽象 soundCue 非空时遮蔽真实台词，
// 成片「声音：」行只剩抽象音效、Seedance 无字可说 → 台词完全对不上。
// ============================================================
describe('buildShotNarrative 台词注入', () => {
  it('metadata.dialogue 权威：抽象 soundCue 非空也不遮蔽，台词进 {…} 块', () => {
    const shot = makeShot('shot-dlg', {
      audioType: '对白',
      metadata: {
        dialogue: 'Maya: My mom passed away a long time ago.',
        storyboardTable: {
          soundCue: 'Maya的声音通过音响系统传出，带礼堂混响',
          action: 'Maya对着话筒说话',
          shotSize: '近景',
          cameraAngle: '平视',
          cameraMovement: '固定',
        },
      },
    });
    const out = buildShotNarrative(shot, 0, 1, '00:00', '00:05', 5, true, false);
    // 真实台词逐字进 {…}，Seedance 才有字可念
    expect(out).toContain('{Maya: My mom passed away a long time ago.}');
    // 抽象 soundCue 降级为 <…> 声场提示，仍在，但不能取代台词
    expect(out).toContain('<Maya的声音通过音响系统传出');
  });

  it('无 metadata.dialogue 时回退解析，不产生空 {…} 块（不回归老数据）', () => {
    const shot = makeShot('shot-nodlg', {
      audioType: '环境音',
      metadata: {
        storyboardTable: { soundCue: '雨声', action: '走路', shotSize: '中景', cameraAngle: '平视' },
      },
    });
    const out = buildShotNarrative(shot, 0, 1, '00:00', '00:04', 4, true, false);
    expect(out).not.toMatch(/\{\s*\}/);
    expect(out).toContain('<雨声');
  });
});

// ============================================================
// structuredPrompt（分镜结构化提示词）注入：用户改分镜后生成必须生效
// 回归：structuredPrompt 只落库不消费 → "分镜和生产对应不上"（2026-08-03）
// ============================================================
describe('structuredPrompt 注入（分镜→生产对应）', () => {
  it('buildShotNarrative：visualInfo 进画面规则行', () => {
    const shot = makeShot('shot-sp', {
      metadata: {
        structuredPrompt: {
          scene: '内景@教室 压抑基调',
          sceneDesign: '冷调，顶光，空间层次分明',
          visualInfo: '人物必须朝向镜头左侧',
        },
        storyboardTable: {
          visualContent: '教室里老师讲课',
          shotSize: '中景',
          cameraAngle: '平视',
          cameraMovement: '固定',
        },
      },
    });
    const out = buildShotNarrative(shot, 0, 1, '00:00', '00:05', 5, true, false);
    expect(out).toContain('画面规则（分镜指定）：人物必须朝向镜头左侧');
  });

  it('combineGroupPrompts：scene 并入场景描述 + sceneDesign 进场景设计行', () => {
    const shot = makeShot('shot-sp2', {
      metadata: {
        structuredPrompt: {
          scene: '内景@教室 压抑基调',
          sceneDesign: '冷调，顶光，空间层次分明',
          visualInfo: '人物必须朝向镜头左侧',
        },
        storyboardTable: {
          visualContent: '教室',
          shotSize: '中景',
          cameraAngle: '平视',
          cameraMovement: '固定',
        },
      },
    });
    const result = combineGroupPrompts([shot], {});
    expect(result.combinedPrompt).toContain('场景设计（分镜指定）：冷调，顶光，空间层次分明');
    expect(result.combinedPrompt).toContain('内景@教室 压抑基调');
  });
});
