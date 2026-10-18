// ============================================================
// ③ server/domain/prompt — 单测（纯函数）
// ============================================================
//
// 覆盖从 app1 group-prompt.ts / asset-prompt.ts / script-prompt.ts 抽取的纯函数：
//   - fmtTime / snapToValidDuration（时间码与时长档位）
//   - externalizeEmotion / appendSeedanceMotionCalibration（情绪外化与校准）
//   - validateSavedPromptAssetRefs / extractBaseSceneId（图片N 引用校验）
//   - slugifyCostumeKey / isAnonymousCharacterName（key 归一化与路人过滤）
//   - sanitizePromptForModeration（敏感词委婉化）
//   - cleanAiOutput / parseCharacterAliasMap / extractDialoguesFromContent（剧本清理与解析）
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  fmtTime,
  snapToValidDuration,
  VALID_DURATIONS,
  durationLadderFor,
  externalizeEmotion,
  appendSeedanceMotionCalibration,
  SEEDANCE_MOTION_CALIBRATION,
  extractBaseSceneId,
  validateSavedPromptAssetRefs,
  slugifyCostumeKey,
  dedupCostumes,
  parseAssetExtraction,
  isAnonymousCharacterName,
  sanitizePromptForModeration,
  buildAssetImagePrompt,
  buildAssetExtractionPrompt,
  getResolutionByKey,
  getStyleNegativePrompt,
  getDeliveryComplianceNegativePrompt,
  cleanAiOutput,
  buildWholeSeriesTextStylePrompt,
  extractCharacterAliasMapAndManuscript,
  parseScriptResult,
  validateAnalysisConsistency,
  parseCharacterAliasMap,
  extractDialoguesFromContent,
  stripDialogueTags,
  computeGroupsForChain,
} from '../../src/domain/prompt';
import { sanitizeOverseasCulturalProps } from '../../src/domain/prompt/asset-helpers';

describe('prompt/whole-series text style', () => {
  it('makes the AI discover and preserve the source unit structure dynamically', () => {
    const source = [
      '第九集 雨夜来客',
      '这一集的完整正文。',
      '第十集 旧案重启',
      '下一集的完整正文。',
    ].join('\n');
    const prompt = buildWholeSeriesTextStylePrompt(
      source,
      '日语 / 日本文化与社会习俗 / 亚洲',
      'zh',
    );

    expect(prompt.system).toContain('从原文第一个字符完整读到结尾');
    expect(prompt.system).toContain('依据正文自身建立实际叙事单元清单');
    expect(prompt.system).toContain('输出必须与原文每个单元一一对应');
    expect(prompt.system).toContain('标题编号重复、跳号或书写异常');
    expect(prompt.system).toContain('同号标题连续出现且中间没有实质正文时，只算同一个边界');
    expect(prompt.system).toContain('若两个同号标题后各自拥有实质正文，则属于两个真实单元');
    expect(prompt.system).toContain('不得按字数、token 数、段落数、时长或等长区块人为造集');
    expect(prompt.system).toContain('每个单元分别拥有自己的「场景列表」');
    expect(prompt.system).toContain('场景号在每个单元内从 S1 重新开始');
    expect(prompt.system).not.toContain('第一行必须是"场景列表"');
    expect(prompt.system).not.toMatch(/45|50|70/);
    expect(prompt.user).toContain(source);
  });

  it('does not invent episode boundaries when the source has no explicit units', () => {
    const prompt = buildWholeSeriesTextStylePrompt(
      '雨停后，人物沿着河岸继续前行。全文保持自然段结构。',
      '保持剧情，只调整为冷峻现实主义风格',
      'zh',
    );

    expect(prompt.system).toContain('原文没有明确分集或章节结构时');
    expect(prompt.system).toContain('只执行目标风格改写并保持原有自然结构');
    expect(prompt.system).not.toContain('预设集数：');
  });

  it('uses the minimal one-pass episode JSON schema without source-copy evidence', () => {
    const prompt = buildWholeSeriesTextStylePrompt(
      '第1集\n完整原文正文。'.repeat(8),
      '英语 / 英语文化圈',
      'zh',
      undefined,
      'episode-json',
    );

    expect(prompt.system).toContain('sourceHeading');
    expect(prompt.system).toContain('detectedEpisodeCount');
    expect(prompt.system).not.toContain('sourceContent');
    expect(prompt.system).not.toContain('sourceStartAnchor');
    expect(prompt.system).toContain('集数和边界必须完全由当前完整原文决定');
  });
});

describe('prompt/asset-image costume identity', () => {
  it('uses the default costume description without mislabelling a human-readable default row as a variant', () => {
    const prompt = buildAssetImagePrompt('CHARACTER', '林夏', '二十多岁，黑色长发', {
      language: 'zh',
      costume: {
        label: '便装',
        description: '白色棉质衬衫、深蓝牛仔裤、黑色短靴',
        isDefault: true,
      },
    });

    expect(prompt).toContain('白色棉质衬衫');
    expect(prompt).not.toContain('本图为该角色「便装」造型变体');
    expect(prompt).not.toContain('【造型变体服装指导】');
  });

  it('keeps non-default costumes under the strict variant identity contract', () => {
    const prompt = buildAssetImagePrompt('CHARACTER', '林夏', '二十多岁，黑色长发', {
      language: 'zh',
      costume: {
        label: '礼服',
        description: '金色刺绣礼服',
        isDefault: false,
      },
    });

    expect(prompt).toContain('本图为该角色「礼服」造型变体');
    expect(prompt).toContain('【造型变体服装指导】');
  });
});

describe('prompt/asset-image overseas ethnicity adaptation', () => {
  it('overseas: injects target-locale ethnicity/attire and drops the contradicting "do-not-invent-ethnicity" line', () => {
    const prompt = buildAssetImagePrompt('CHARACTER', 'Adrian', 'Prince in embroidered robes', {
      language: 'en',
      overseasAdaptation: true,
      localizationProfile: {
        stylePrompt: '英语 / 英语文化圈',
        targetLanguage: {
          code: 'en', native: 'English', zh: '英语', en: 'English',
          region: '欧洲', cultureHint: '英语文化圈：英美加澳新等',
        },
      },
    });
    expect(prompt).toContain('Overseas-localization identity lock');
    expect(prompt).toContain('European/Caucasian');
    // 海外时移除与身份锁矛盾的"不得臆造族裔"行，避免模型退回源(东亚)面孔
    expect(prompt).not.toContain('Do NOT invent or force any specific nationality');
  });

  it('domestic (en): keeps the "do-not-invent-ethnicity" line, no overseas lock', () => {
    const prompt = buildAssetImagePrompt('CHARACTER', 'Lin Xia', 'young man', { language: 'en' });
    expect(prompt).toContain('Do NOT invent or force any specific nationality');
    expect(prompt).not.toContain('Overseas-localization identity lock');
  });
});

// 海外转绘「重新提取」走 buildAssetExtractionPrompt 的 ZH 分支（languageFromCategory('OVERSEAS')==='zh'）。
// 历史 bug：ZH 分支没有海外改编覆盖段，且第 2/14 条"不得臆造族裔/以剧本原文为准"与海外改编矛盾，
// 导致模型退回源（东亚/中国古风）外貌。本测试锁定 ZH 海外分支的修复。
describe('prompt/asset-extraction overseas adaptation (ZH branch)', () => {
  const profile = {
    stylePrompt: '英语 / 英语文化圈：英美加澳新等，按描述定位具体国家',
    targetLanguage: {
      code: 'en', native: 'English', zh: '英语', en: 'English',
      region: '欧洲', cultureHint: '英语文化圈：英美加澳新等',
    },
  };

  it('overseas (zh): injects the target-locale override and drops the contradicting domestic rules', () => {
    const { system } = buildAssetExtractionPrompt(
      '=== EP1 ===\n王子 Adrian 走进大殿。',
      '',
      { overseasAdaptation: true, localizationProfile: profile, canonicalCharacterNames: ['Adrian'] },
      'zh',
    );
    // 强海外改编覆盖段（正面写目标文化外貌 + 服饰替换 + 覆盖声明）
    expect(system).toContain('角色资产·海外本地化改编');
    expect(system).toContain('欧洲/白人');
    expect(system).toContain('严禁东亚长袍/汉服');
    // 海外时移除与改编矛盾的"不得臆造族裔""以剧本原文为准"原文条款
    expect(system).not.toContain('不得凭空附会族裔偏置');
    expect(system).not.toContain('必须以剧本原文为准修正');
  });

  it('domestic (zh): keeps the source-following rules, no overseas override', () => {
    const { system } = buildAssetExtractionPrompt(
      '=== EP1 ===\n林夏走进大殿。',
      '',
      { canonicalCharacterNames: ['林夏'] },
      'zh',
    );
    expect(system).toContain('不得凭空附会族裔偏置');
    expect(system).toContain('必须以剧本原文为准修正');
    expect(system).not.toContain('角色资产·海外本地化改编');
  });
});

// ============================================================
// fmtTime / snapToValidDuration
// ============================================================
describe('prompt/seedance-helpers', () => {
  describe('fmtTime', () => {
    it('formats integer seconds as MM:SS', () => {
      expect(fmtTime(0)).toBe('00:00');
      expect(fmtTime(5)).toBe('00:05');
      expect(fmtTime(65)).toBe('01:05');
      expect(fmtTime(120)).toBe('02:00');
    });

    it('formats fractional seconds as MM:SS.s', () => {
      expect(fmtTime(65.5)).toBe('01:05.5');
      expect(fmtTime(0.5)).toBe('00:00.5');
    });
  });

  describe('computeGroupsForChain (model-aware maxDuration)', () => {
    const mk = (i: number, dur: number) => ({
      id: `s${i}`, sortOrder: i, shotIndex: i, durationSeconds: dur,
    });

    it('默认 15s：5×5s=25s 场景拆成 2 组（3镜15s + 2镜10s），2.0 行为不回归', () => {
      const shots = [0, 1, 2, 3, 4].map((i) => mk(i, 5));
      const groups = computeGroupsForChain(shots);
      expect(groups.length).toBe(2);
      expect(groups[0].shotIds).toHaveLength(3);
      expect(groups[1].shotIds).toHaveLength(2);
    });

    it('2.5 maxDuration=30：5×5s=25s 场景并成 1 组（5镜），validDuration=25', () => {
      const shots = [0, 1, 2, 3, 4].map((i) => mk(i, 5));
      const groups = computeGroupsForChain(shots, 30);
      expect(groups.length).toBe(1);
      expect(groups[0].shotIds).toHaveLength(5);
      expect(groups[0].validDuration).toBe(25);
    });
  });

  describe('durationLadderFor + model-aware snap', () => {
    it('2.0 默认(maxDuration≤15)：阶梯不变，>15s 仍抛 RangeError，原行为不回归', () => {
      expect(durationLadderFor(15)).toBe(VALID_DURATIONS);
      expect(durationLadderFor(10)).toBe(VALID_DURATIONS);
      expect(snapToValidDuration(7)).toBe(8);
      expect(() => snapToValidDuration(25)).toThrow('超过 Seedance 15秒上限');
    });

    it('2.5(maxDuration=30)：阶梯扩到 [4,5,6,8,10,15,20,25,30]，长组对齐不抛错', () => {
      const ladder = durationLadderFor(30);
      expect(ladder).toEqual([4, 5, 6, 8, 10, 15, 20, 25, 30]);
      expect(snapToValidDuration(25, ladder)).toBe(25);
      expect(snapToValidDuration(22, ladder)).toBe(25);
      expect(snapToValidDuration(28, ladder)).toBe(30);
      expect(snapToValidDuration(30.04, ladder)).toBe(30);
      expect(() => snapToValidDuration(31, ladder)).toThrow('超过 Seedance 30秒上限');
    });
  });

  describe('snapToValidDuration', () => {
    it('向上对齐合法档位，并只在 15 秒边界保留 0.05 秒浮点容差', () => {
      // VALID_DURATIONS = [4, 5, 6, 8, 10, 15]
      expect(VALID_DURATIONS).toEqual([4, 5, 6, 8, 10, 15]);
      expect(snapToValidDuration(7)).toBe(8);
      expect(snapToValidDuration(14)).toBe(15);
      expect(snapToValidDuration(9)).toBe(10);
      expect(snapToValidDuration(4)).toBe(4);
      expect(snapToValidDuration(15.04)).toBe(15);
      expect(() => snapToValidDuration(15.051)).toThrow('超过 Seedance 15秒上限');
      expect(() => snapToValidDuration(100)).toThrow('超过 Seedance 15秒上限');
      expect(() => snapToValidDuration(Number.NaN)).toThrow('无效的镜头组时长');
    });
  });

  describe('externalizeEmotion', () => {
    it('returns cues for abstract emotion keyword', () => {
      const r = externalizeEmotion('她很悲伤地看着远方');
      expect(r).toBeTruthy();
      expect(r).toContain('低头');
    });

    it('returns null when text already has physical cue', () => {
      // "低头" is a physical cue word
      expect(externalizeEmotion('她低头哭泣，很悲伤')).toBeNull();
    });

    it('returns null when no emotion keyword', () => {
      expect(externalizeEmotion('她走在路上')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(externalizeEmotion('')).toBeNull();
    });
  });

  describe('appendSeedanceMotionCalibration', () => {
    it('appends calibration suffix when not present', () => {
      const r = appendSeedanceMotionCalibration('镜头内容');
      expect(r).toContain(SEEDANCE_MOTION_CALIBRATION);
      expect(r).toBe('镜头内容\n\n' + SEEDANCE_MOTION_CALIBRATION);
    });

    it('is idempotent (does not append twice)', () => {
      const once = appendSeedanceMotionCalibration('镜头内容');
      const twice = appendSeedanceMotionCalibration(once);
      expect(twice).toBe(once);
    });

    it('returns empty string as-is', () => {
      expect(appendSeedanceMotionCalibration('')).toBe('');
    });
  });

  describe('extractBaseSceneId', () => {
    it('extracts base id from segmented scene id', () => {
      expect(extractBaseSceneId('S1-1')).toBe('S1');
      expect(extractBaseSceneId('S1-2')).toBe('S1');
      expect(extractBaseSceneId('S10-3')).toBe('S10');
    });

    it('returns base id as-is for non-segmented', () => {
      expect(extractBaseSceneId('S1')).toBe('S1');
    });

    it('returns empty for non-string', () => {
      expect(extractBaseSceneId(null)).toBe('');
      expect(extractBaseSceneId(undefined)).toBe('');
      expect(extractBaseSceneId(123)).toBe('');
    });
  });

  describe('validateSavedPromptAssetRefs', () => {
    it('returns true when indices exactly cover 1..M', () => {
      const refs = [{ name: 'A', kind: 'CHARACTER' as const }, { name: 'B', kind: 'LOCATION' as const }];
      const prompt = '参考 图片1 的A，参考 图片2 的B';
      expect(validateSavedPromptAssetRefs(prompt, refs)).toBe(true);
    });

    it('returns false for legacy @{name} format', () => {
      const refs = [{ name: 'A', kind: 'CHARACTER' as const }];
      expect(validateSavedPromptAssetRefs('参考 @{A}', refs)).toBe(false);
    });

    it('returns false when indices do not cover 1..M', () => {
      const refs = [{ name: 'A', kind: 'CHARACTER' as const }, { name: 'B', kind: 'LOCATION' as const }];
      expect(validateSavedPromptAssetRefs('参考 图片1', refs)).toBe(false); // 缺 图片2
    });

    it('returns false when no 图片N references', () => {
      const refs = [{ name: 'A', kind: 'CHARACTER' as const }];
      expect(validateSavedPromptAssetRefs('无引用', refs)).toBe(false);
    });

    it('returns true for empty assetRefs', () => {
      expect(validateSavedPromptAssetRefs('任意文本', [])).toBe(true);
    });
  });
});

// ============================================================
// asset-helpers
// ============================================================
describe('prompt/asset-helpers', () => {
  describe('slugifyCostumeKey', () => {
    it('returns default for empty/default/默认', () => {
      expect(slugifyCostumeKey('')).toBe('default');
      expect(slugifyCostumeKey('default')).toBe('default');
      expect(slugifyCostumeKey('默认')).toBe('default');
    });

    it('maps known labels to slugs', () => {
      expect(slugifyCostumeKey('便装')).toBe('casual');
      expect(slugifyCostumeKey('正装')).toBe('formal');
      expect(slugifyCostumeKey('casual')).toBe('casual');
      expect(slugifyCostumeKey('Formal')).toBe('formal');
    });

    it('slugifies pure ASCII', () => {
      expect(slugifyCostumeKey('Night Op')).toBe('night-op');
      expect(slugifyCostumeKey('battle_damaged')).toBe('battle-damaged');
    });

    it('falls back to custom-{idx} for non-ASCII not in map', () => {
      expect(slugifyCostumeKey('自定义造型', 3)).toBe('custom-3');
    });
  });

  describe('isAnonymousCharacterName', () => {
    it('returns true for Chinese group generics', () => {
      expect(isAnonymousCharacterName('众人')).toBe(true);
      expect(isAnonymousCharacterName('路人')).toBe(true);
      expect(isAnonymousCharacterName('群众')).toBe(true);
    });

    it('returns true for Chinese 身份+天干 generics', () => {
      expect(isAnonymousCharacterName('路人甲')).toBe(true);
      expect(isAnonymousCharacterName('长老乙')).toBe(true);
      expect(isAnonymousCharacterName('士兵丙')).toBe(true);
    });

    it('returns true for English generics', () => {
      expect(isAnonymousCharacterName('Extra A')).toBe(true);
      expect(isAnonymousCharacterName('Passerby B')).toBe(true);
      expect(isAnonymousCharacterName('the crowd')).toBe(true);
    });

    it('returns false for specific names', () => {
      expect(isAnonymousCharacterName('林夏')).toBe(false);
      expect(isAnonymousCharacterName('EVELYN VANCE')).toBe(false);
      expect(isAnonymousCharacterName('阿灵')).toBe(false);
    });

    it('returns true for empty', () => {
      expect(isAnonymousCharacterName('')).toBe(true);
      expect(isAnonymousCharacterName('  ')).toBe(true);
    });
  });

  describe('sanitizePromptForModeration', () => {
    it('replaces blood-related sensitive words', () => {
      const r = sanitizePromptForModeration('掌心有旧血痕，袖口有血迹');
      expect(r.sanitized).toBe('掌心有旧伤痕，袖口有污渍');
      expect(r.replacements).toContain('旧血痕 → 旧伤痕');
      expect(r.replacements).toContain('血迹 → 污渍');
    });

    it('returns unchanged when no sensitive words', () => {
      const r = sanitizePromptForModeration('正常的描述文本');
      expect(r.sanitized).toBe('正常的描述文本');
      expect(r.replacements).toHaveLength(0);
    });

    it('replaces funeral-related words', () => {
      const r = sanitizePromptForModeration('灵堂里很安静');
      expect(r.sanitized).toBe('旧堂里很安静');
    });

    it('replaces banned political word 帝国 → 王国', () => {
      const r = sanitizePromptForModeration('帝国骑士身份令牌 插在帝国军旗旁');
      expect(r.sanitized).toBe('王国骑士身份令牌 插在王国军旗旁');
      expect(r.replacements).toContain('帝国 → 王国');
    });
  });

  describe('getResolutionByKey', () => {
    it('returns matching resolution', () => {
      expect(getResolutionByKey('2K').width).toBe(1920);
      expect(getResolutionByKey('4K').height).toBe(2160);
    });

    it('falls back to 1K for unknown key', () => {
      expect(getResolutionByKey('unknown').key).toBe('1K');
    });
  });

  describe('getStyleNegativePrompt', () => {
    it('returns empty for all styles（用户需求：除水印/logo 外负面提示词全部移除）', () => {
      expect(getStyleNegativePrompt('铅笔彩绘风格')).toBe('');
      expect(getStyleNegativePrompt('写实真人风格')).toBe('');
      expect(getStyleNegativePrompt(undefined)).toBe('');
    });
  });

  describe('getDeliveryComplianceNegativePrompt', () => {
    it('returns only watermark/logo（用户需求：负面提示词只保留水印/logo）', () => {
      const r = getDeliveryComplianceNegativePrompt();
      expect(r).toContain('watermark');
      expect(r).toContain('logo');
      // 除水印/logo 外的负面词（QR code/AI badge/glasses/裁脸/瞳色等）全部移除：
      // ARK 文本审核对 negativePrompt 同样送审，冗余词易触发敏感。
      expect(r).not.toContain('QR code');
      expect(r).not.toContain('AI generated badge');
      expect(r).not.toContain('glasses');
      expect(r).not.toContain('国旗');
      expect(r).not.toContain('national flag');
    });
  });
});

// ============================================================
// script-helpers
// ============================================================
describe('prompt/script-helpers', () => {
  describe('cleanAiOutput', () => {
    it('strips Chinese preamble before 场景列表', () => {
      const raw = '好的，作为您的专业影视编剧，我来为您分析。\n\n场景列表\nS1\n地点·时间';
      const cleaned = cleanAiOutput(raw);
      expect(cleaned.startsWith('场景列表')).toBe(true);
      expect(cleaned).not.toContain('好的');
    });

    it('strips English preamble before Scene List', () => {
      const raw = 'Sure, here is the screenplay.\n\nScene List\nS1\nLocation·Time';
      const cleaned = cleanAiOutput(raw);
      expect(cleaned.startsWith('Scene List')).toBe(true);
      expect(cleaned).not.toContain('Sure');
    });

    it('returns content as-is when no preamble', () => {
      const raw = '场景列表\nS1\n地点';
      expect(cleanAiOutput(raw).startsWith('场景列表')).toBe(true);
    });

    it('strips long-video planning preamble before Lingshi screenplay markers', () => {
      const raw = [
        'AI思考：我需要无缝续写上一批。',
        '本次只生成第001集，剩余场次后续拼接。',
        '《测试剧》第1集正式剧本',
        '第001集：开门',
        '[1-1 门厅 夜 内 人物：甲]',
        '▲ 甲推开门。',
      ].join('\n');

      const cleaned = cleanAiOutput(raw);
      expect(cleaned).toMatch(/^《测试剧》/);
      expect(cleaned).not.toMatch(/AI思考|本次只生成|后续拼接/);
    });
  });

  describe('parseScriptResult Lingshi format', () => {
    it('filters internal meta lines and recognizes new and legacy progression labels', () => {
      const parsed = parseScriptResult([
        '《测试剧》第1集正式剧本',
        '第001集：开门',
        '本集钩子：钥匙在门后响了一声。',
        '本集推进：甲为救人承担暴露身份的代价。',
        '本集爽点：旧版稿件仍可解析。',
        '本次只生成当前批次，下一批续写剩余场次。',
        '[1-1 门厅 夜 内 人物：甲、乙]',
        '▲ 甲把钥匙插进锁孔，却没有转动。',
        '甲：你先退后。',
        '续写计划：接下来补完第二场。',
      ].join('\n'));

      expect(parsed.scenes).toHaveLength(1);
      expect(parsed.scenes[0].content).not.toMatch(/本次只生成|续写计划|批次/);
      expect(parsed.infoPoints).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: '本集推进' }),
        expect.objectContaining({ type: '本集爽点' }),
      ]));
    });
  });

  describe('parseCharacterAliasMap', () => {
    it('parses valid JSON mapping block', () => {
      const text = `剧本正文

角色名映射表
\`\`\`json
[
  { "oldName": "季舒语", "newName": "EVELYN VANCE" },
  { "oldName": "乔野", "newName": "LEO CROSS" }
]
\`\`\``;
      const map = parseCharacterAliasMap(text);
      expect(map.size).toBe(2);
      expect(map.get('季舒语')).toBe('EVELYN VANCE');
      expect(map.get('乔野')).toBe('LEO CROSS');
    });

    it('excludes unchanged entries (oldName === newName)', () => {
      const text = `角色名映射表
\`\`\`json
[{ "oldName": "A", "newName": "A" }, { "oldName": "B", "newName": "C" }]
\`\`\``;
      const map = parseCharacterAliasMap(text);
      expect(map.size).toBe(1);
      expect(map.get('B')).toBe('C');
    });

    it('returns empty map when no mapping section', () => {
      expect(parseCharacterAliasMap('无映射表的文本').size).toBe(0);
    });

    it('returns empty map for invalid JSON', () => {
      const text = `角色名映射表
\`\`\`json
not valid json
\`\`\``;
      expect(parseCharacterAliasMap(text).size).toBe(0);
    });

    it('returns empty map for empty string', () => {
      expect(parseCharacterAliasMap('').size).toBe(0);
    });

    it('parses bare JSON and strips the metadata appendix from screenplay content', () => {
      const result = extractCharacterAliasMapAndManuscript([
        '第2集',
        '最后一集完整正文。',
        '',
        '### 角色名映射表',
        '[{"oldName":"季舒语","newName":"EVELYN VANCE"}]',
      ].join('\n'));

      expect(result.mappingSectionFound).toBe(true);
      expect(result.manuscript).toBe('第2集\n最后一集完整正文。');
      expect(result.manuscript).not.toContain('角色名映射表');
      expect(result.aliasMap.get('季舒语')).toBe('EVELYN VANCE');
    });
  });

  describe('extractDialoguesFromContent', () => {
    it('extracts Chinese dialogue with emotion', () => {
      const content = `## S1 [地点 · 时间 · 内外景] 角色：林夏

△林夏推门走入

林夏（愤怒）：你怎么在这里？
赵默（平静）：我一直在。`;
      const dialogues = extractDialoguesFromContent(content);
      expect(dialogues).toHaveLength(2);
      expect(dialogues[0].character).toBe('林夏');
      expect(dialogues[0].emotion).toBe('愤怒');
      expect(dialogues[0].lines).toBe('你怎么在这里？');
      expect(dialogues[0].type).toBe('dialogue');
    });

    it('extracts English dialogue', () => {
      const content = `EVELYN (angry): What are you doing here?
LEO (calm): I never left.`;
      const dialogues = extractDialoguesFromContent(content);
      expect(dialogues).toHaveLength(2);
      expect(dialogues[0].character).toBe('EVELYN');
      expect(dialogues[0].emotion).toBe('angry');
    });

    it('extracts voiceover (OS) lines', () => {
      const content = `林夏OS：内心独白内容`;
      const dialogues = extractDialoguesFromContent(content);
      expect(dialogues).toHaveLength(1);
      expect(dialogues[0].type).toBe('voiceover');
      expect(dialogues[0].character).toBe('林夏');
    });

    it('skips action lines (△) and scene headers (##)', () => {
      const content = `## S1 [地点]
△动作描述
林夏（平静）：台词`;
      const dialogues = extractDialoguesFromContent(content);
      expect(dialogues).toHaveLength(1);
      expect(dialogues[0].character).toBe('林夏');
    });

    it('returns empty for content with no dialogue', () => {
      expect(extractDialoguesFromContent('△纯动作描述')).toEqual([]);
    });
  });

  describe('stripDialogueTags', () => {
    it('剥离「角色名（OS）：台词」的说话人/通道标签，留纯台词', () => {
      expect(stripDialogueTags('林夏（OS）：放开我！')).toBe('放开我！');
      expect(stripDialogueTags('林夏（VO）：又是这个梦。')).toBe('又是这个梦。');
    });

    it('多句用；分隔，逐句剥离后用；接回', () => {
      expect(stripDialogueTags('林夏（OS）：放开我！；赵默（OS）：你冷静点。'))
        .toBe('放开我！；你冷静点。');
    });

    it('裸「角色名：台词」不剥（角色名与项目语种同文，不污染语种审核）', () => {
      expect(stripDialogueTags('林夏：放开我！')).toBe('林夏：放开我！');
    });

    it('无标签的纯台词原样返回', () => {
      expect(stripDialogueTags('放开我！')).toBe('放开我！');
      expect(stripDialogueTags('Help!')).toBe('Help!');
    });

    it('空值安全', () => {
      expect(stripDialogueTags('')).toBe('');
      expect(stripDialogueTags(undefined)).toBe('');
      expect(stripDialogueTags('   ')).toBe('');
    });
  });
});

describe('dedupCostumes', () => {
  const variant = (key: string, label: string, description = ''): {
    key: string; label: string; description: string;
    identity_lock: string[]; coverage_scenes: string[];
  } => ({ key, label, description, identity_lock: [], coverage_scenes: [] });

  it('合并完全相同的 label（同一套服装被反复识别两次）', () => {
    const out = dedupCostumes([
      variant('default', '骑士装', '银白板甲'),
      variant('custom-1', '骑士装', '银白板甲、红色披风'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('骑士装');
    expect(out[0].description).toBe('银白板甲、红色披风'); // 取更丰富描述
  });

  it('合并仅结尾括号后缀不同的 label（贵族校服 vs 贵族校服（基准））', () => {
    const out = dedupCostumes([
      variant('custom-0', '贵族校服（基准）'),
      variant('custom-1', '贵族校服'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('相同 key 强制合并，不同 label 各自保留', () => {
    const out = dedupCostumes([
      variant('default', '便装'),
      variant('default', '正装'),
      variant('formal', '礼服'),
    ]);
    // default 合并成 1 条；formal 单独 1 条
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.key).sort()).toEqual(['default', 'formal']);
  });

  it('互不相同的变体全部保留，description/identity_lock/coverage_scenes 取并集或更丰富值', () => {
    const out = dedupCostumes([
      { key: 'casual', label: '便装', description: '白T', identity_lock: ['白T'], coverage_scenes: ['S1'] },
      { key: 'formal', label: '正装', description: '黑西装', identity_lock: ['黑西装'], coverage_scenes: ['S3'] },
    ]);
    expect(out).toHaveLength(2);
  });

  it('合并同 key 变体时 coverage_episodes（集号）取并集并升序', () => {
    const out = dedupCostumes([
      { key: 'default', label: '便装', description: '', identity_lock: [], coverage_scenes: [], coverage_episodes: [3, 1] },
      { key: 'default', label: '便装', description: '', identity_lock: [], coverage_scenes: [], coverage_episodes: [2] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].coverage_episodes).toEqual([1, 2, 3]);
  });
});

describe('parseAssetExtraction — 全类型变体 + 集号', () => {
  it('为物品/环境解析 costumes 变体并透传 coverage_episodes', () => {
    const out = parseAssetExtraction(JSON.stringify({
      characters: [],
      items: [{
        name: '魔剑',
        description: '一把剑',
        coverage_scenes: ['S1'],
        costumes: [
          { key: 'default', label: '完好', description: '锋利', coverage_episodes: [1, 2] },
          { key: 'broken', label: '断剑', description: '断裂', coverage_episodes: [3] },
        ],
      }],
      environments: [{
        name: '神殿',
        description: '一座神殿',
        coverage_scenes: ['S1'],
        costumes: [
          { key: 'default', label: '白昼', description: '明亮', coverage_episodes: [1] },
          { key: 'night', label: '深夜', description: '幽暗', coverage_episodes: [2] },
        ],
      }],
      entities: [],
    }));
    expect(out.items[0].costumes).toHaveLength(2);
    expect(out.items[0].costumes?.[0]).toMatchObject({ key: 'default', coverage_episodes: [1, 2] });
    expect(out.items[0].costumes?.[1]?.coverage_episodes).toEqual([3]);
    expect(out.environments[0].costumes?.[1]).toMatchObject({ key: 'night', coverage_episodes: [2] });
  });

  it('物品/环境未输出 costumes 时兜底合成 default 基准（与角色对齐：vcnt≥1）', () => {
    const out = parseAssetExtraction(JSON.stringify({
      characters: [],
      items: [{ name: '茶杯', description: '一只茶杯', coverage_scenes: ['S1'] }],
      environments: [{ name: '茶馆', description: '一间茶馆', coverage_scenes: ['S1'] }],
      entities: [],
    }));
    expect(out.items[0].costumes).toEqual([
      expect.objectContaining({ key: 'default', label: '默认' }),
    ]);
    expect(out.environments[0].costumes).toEqual([
      expect.objectContaining({ key: 'default', label: '默认' }),
    ]);
  });
});

describe('prompt/dedupCostumes', () => {
  const costume = (overrides: Partial<{ key: string; label: string; description: string; coverage_episodes?: number[] }> = {}) => ({
    key: 'default',
    label: '默认',
    description: '',
    identity_lock: [],
    coverage_scenes: [],
    coverage_episodes: [] as number[],
    ...overrides,
  });

  it('合并 key 相同的变体（取更丰富描述、并集集号）', () => {
    const out = dedupCostumes([
      costume({ key: 'casual', label: '便装', description: '白衬衫', coverage_episodes: [1] }),
      costume({ key: 'casual', label: '便装', description: '白色棉质衬衫，牛仔裤', coverage_episodes: [3] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe('白色棉质衬衫，牛仔裤');
    expect(out[0].coverage_episodes).toEqual([1, 3]);
  });

  it('按 description 相似度合并同一次提取里的重复（不同 key/label、近同描述）', () => {
    // AI 对同一套"恢复便装"产出了两条：英文 key 与中文 key，描述几乎一致。
    const out = dedupCostumes([
      costume({ key: 'light-armor', label: '轻型骑士铠甲', description: '银色胸甲搭配蓝色武装衣，腰间佩剑' }),
      costume({ key: 'recovered-casual', label: '康复便装', description: '简洁的浅蓝色长裙，面料柔软，长发自然披散' }),
      costume({ key: 'recovery-casual', label: '恢复便装', description: '简洁的浅蓝色长裙，面料柔软，长发自然披散，面容恢复红润' }),
    ]);
    // 两条近同的"恢复便装"应合并成一条；不同铠甲保留。
    expect(out).toHaveLength(2);
    const labels = out.map((c) => c.label);
    expect(labels).toContain('轻型骑士铠甲');
    expect(labels.some((l) => l.includes('便装'))).toBe(true);
  });

  it('不误并描述 merely-similar 的不同变体', () => {
    const out = dedupCostumes([
      costume({ key: 'armor', label: '骑士铠甲', description: '全套银色板甲，护肩与胸甲抛光，佩长剑' }),
      costume({ key: 'battered', label: '战损铠甲', description: '银色板甲凹陷布满裂痕，胸口染血，剑刃崩口' }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('sanitizeOverseasCulturalProps (海外文化道具本地化)', () => {
  it('replaces Chinese-specific food/utensils with Western equivalents', () => {
    const r = sanitizeOverseasCulturalProps('老人用筷子夹起包子，桌上还有馒头和饺子');
    expect(r.sanitized).toBe('老人用刀叉夹起面包卷，桌上还有面包和馅饼');
    expect(r.replacements).toContain('筷子 → 刀叉');
    expect(r.replacements).toContain('包子 → 面包卷');
  });

  it('replaces clothing / architecture / object cultural props', () => {
    const r = sanitizeOverseasCulturalProps('她穿汉服走过牌坊，墙上挂着匾额');
    expect(r.sanitized).toBe('她穿正装走过拱门，墙上挂着招牌');
  });

  it('leaves prompts without Chinese cultural props unchanged', () => {
    const r = sanitizeOverseasCulturalProps('She eats a sandwich with a fork at the cafe');
    expect(r.sanitized).toBe('She eats a sandwich with a fork at the cafe');
    expect(r.replacements).toHaveLength(0);
  });
});

describe('validateAnalysisConsistency — 分析产物一致性守卫', () => {
  // EP34 case：DeepSeek 对英文原文返回整套中文仙侠分析（李墨渊/魅颜环），
  // 内容系统里不存在，纯幻觉。守卫须在落库前拦下，避免错分析固化进分镜。

  it('语种不一致（英文原文 + 中文分析）→ 拒绝', () => {
    const parsed = {
      rawText: '',
      scenes: [{ id: 'S1', location: '太医院', time: '白天', intExt: '内', content: '李墨渊走进太医院，沈修文在一旁。' }],
      infoPoints: [], sceneMeta: [],
      characters: ['李墨渊', '沈修文', '楚灵儿'],
      costumeMap: [],
    };
    const r = validateAnalysisConsistency(parsed as never, 'Leo meets Owen at the Infirmary. The Glamour Bracelet glows.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/不一致/);
  });

  it('同语种但角色命中率过低（AI 编造原文里不存在的角色）→ 拒绝', () => {
    const parsed = {
      rawText: '',
      scenes: [{ id: 'S1', location: 'Room', time: 'day', intExt: 'int', content: 'Alice and Bob talk in the room.' }],
      infoPoints: [], sceneMeta: [],
      // 原文只有 Alice/Bob，AI 却编造了 Carol/Dave/Eve/Frank → 命中 2/6=33%？不，
      // 这里只让 Alice 命中（Bob 不在 characters），Carol/Dave/Eve/Frank/Gale 全编造 → 1/6≈17%
      characters: ['Alice', 'Carol', 'Dave', 'Eve', 'Frank', 'Gale'],
      costumeMap: [],
    };
    const r = validateAnalysisConsistency(parsed as never, 'Alice talks in the room alone.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/命中率过低/);
  });

  it('同语种、零星角色不在原文 → 局部瑕疵(kind:characters)，给名单过滤即可，不整体重试', () => {
    // 多数角色在原文（Alice/Bob/Carol/Dave），只 Eve 编造 → 4/5=80% 命中、零星瑕疵。
    // 守卫应判 kind:'characters' 给出 hallucinated 名单，调用方过滤即可——不必整体重跑。
    const parsed = {
      rawText: '',
      scenes: [{ id: 'S1', location: 'Room', time: 'day', intExt: 'int', content: 'Alice and Bob talk, then Carol and Dave appear.' }],
      infoPoints: [], sceneMeta: [],
      characters: ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'],
      costumeMap: [],
    };
    const r = validateAnalysisConsistency(parsed as never, 'Alice and Bob talk, then Carol and Dave appear in the room.');
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === 'characters') {
      expect(r.hallucinated).toEqual(['Eve']);
    } else if (!r.ok) {
      throw new Error(`期望 kind:'characters'，实际 ${r.kind}`);
    }
  });

  it('语种一致且角色都在原文 → 通过', () => {
    const parsed = {
      rawText: '',
      scenes: [{ id: 'S1', location: 'Room', time: 'day', intExt: 'int', content: 'Alice and Bob talk.' }],
      infoPoints: [], sceneMeta: [],
      characters: ['Alice', 'Bob'],
      costumeMap: [],
    };
    const r = validateAnalysisConsistency(parsed as never, 'Alice and Bob talk in the room about the Glamour Bracelet.');
    expect(r.ok).toBe(true);
  });

  it('空 novelText 或无场景 → 放行（交上层 scenes-empty 检查）', () => {
    const parsed = { rawText: '', scenes: [], infoPoints: [], sceneMeta: [], characters: [], costumeMap: [] };
    expect(validateAnalysisConsistency(parsed as never, '').ok).toBe(true);
  });
});
