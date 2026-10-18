// ============================================================
// ③ server/domain/storyboard — 单测（纯校验逻辑）
// ============================================================
//
// 覆盖：
//   - validateShotCreate：合法 / projectId 空 / shotIndex 负数 / aspectRatio 白名单 / durationSeconds 非正
//   - validateShotUpdate：合法补丁 / status 白名单 / videoStatus 白名单
//   - sanitizeSeedanceParams：合法 / 非法字段过滤 / null / 非对象
//   - readParamsHistory：从 metadata 读取历史栈
// ============================================================

import { describe, it, expect, vi } from 'vitest';

const infraMocks = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  transactionQuery: vi.fn(async () => ({ rows: [], rowCount: 1 })),
}));

// mock @shared/utils（genId）和 @server/infra（query），service.ts 间接依赖；
// vitest 无法解析 @shared/* / @server/* 别名，即使测试只测纯校验也需 mock 模块加载
vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'test-uuid-' + Math.random().toString(36).slice(2, 8)),
}));
vi.mock('@server/infra', () => ({
  query: infraMocks.query,
  // 测试事务回调时复用同一个 query spy，便于断言先删旧镜头、再写新镜头。
  tx: vi.fn(async (fn: (client: { query: typeof infraMocks.transactionQuery }) => unknown) =>
    fn({ query: infraMocks.transactionQuery })),
}));

import {
  validateShotCreate,
  validateShotUpdate,
  sanitizeSeedanceParams,
  readParamsHistory,
  MAX_HISTORY_LENGTH,
  SHOT_ASPECT_RATIOS,
  SHOT_RESOLUTIONS,
  SHOT_STATUSES,
  SHOT_VIDEO_STATUSES,
  replaceEpisodeShots,
  getEpisodesCompletionMap,
  buildStoryboardPrompt,
  parseStoryboardShots,
  postprocessStoryboardShots,
  type ShotCreateInput,
  type ShotUpdatePatch,
} from '../../src/domain/storyboard';

describe('storyboard/service episode completion', () => {
  it('marks only episodes whose every shot has a completed video as complete', async () => {
    infraMocks.query.mockResolvedValueOnce({
      rows: [
        { episodeId: 'episode-complete', total: 3, completed: 3 },
        { episodeId: 'episode-incomplete', total: 3, completed: 2 },
      ],
      rowCount: 2,
    });

    const completion = await getEpisodesCompletionMap([
      'episode-complete',
      'episode-incomplete',
      // 重复 ID 不应扩大数据库参数或改变聚合结果。
      'episode-complete',
    ]);

    expect(completion.get('episode-complete')).toEqual({
      total: 3,
      completed: 3,
      complete: true,
    });
    expect(completion.get('episode-incomplete')).toEqual({
      total: 3,
      completed: 2,
      complete: false,
    });
    expect(infraMocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FROM shots'),
      [['episode-complete', 'episode-incomplete']],
    );
    const completionSql = String(infraMocks.query.mock.calls.at(-1)?.[0]);
    // 完成数必须同时核验状态与非空素材地址，和 app1 的 isShotDone 判据一致。
    expect(completionSql).toContain(`"videoStatus" = 'COMPLETED'`);
    expect(completionSql).toContain('"currentMaterialUrl"');
  });
});

describe('storyboard/postprocess advanced parity', () => {
  it('keeps Chinese display names while exposing source aliases to the prompt', () => {
    const { system, user } = buildStoryboardPrompt(
      [{
        id: 'S1',
        location: 'Abandoned Boathouse',
        content: 'Marcus enters the Abandoned Boathouse with Silver Binding Shackles.',
      }],
      [
        {
          kind: 'LOCATION',
          name: '废弃船屋',
          sourceNames: ['Abandoned Boathouse'],
          description: '临海的老旧木屋',
        },
        {
          kind: 'PROP',
          name: '银色镣铐',
          sourceNames: ['Silver Binding Shackles'],
          description: '银色束缚道具',
        },
      ],
    );

    expect(system).toContain('原文别名仅用于识别');
    expect(user).toContain('- 废弃船屋（原文别名：Abandoned Boathouse）');
    expect(user).toContain('- 银色镣铐（原文别名：Silver Binding Shackles）');
  });

  it('keeps app1 tension, dialogue-speed and physical-action planning rules', () => {
    const { system } = buildStoryboardPrompt(
      [{ id: 'S1', content: '甲推门进屋，对乙说出真相。' }],
      [],
    );

    expect(system).toContain('铺垫不得连续超过 3-4 镜');
    expect(system).toContain('每 15-25 秒至少有一次攻击');
    expect(system).toContain('中文约 4 字/秒');
    expect(system).toContain('英文及其他拉丁语系');
    expect(system).toContain('2.5 词/秒');
    expect(system).toContain('J-cut/L-cut');
    expect(system).toContain('复杂动作需 4-8 秒并按动作落点拆镜');
  });

  it('includes the function-mapped cinematic camera-movement vocabulary (video-shotcraft)', () => {
    const { system } = buildStoryboardPrompt([{ id: 'S1', content: '甲推门进屋。' }], []);
    // 按 purposeTag 选镜的功能映射
    expect(system).toContain('按叙事功能选镜');
    expect(system).toContain('钩子（点名冲击）');
    expect(system).toContain('反应/情绪蓄力');
    // Seedance 可渲染运镜词库（替代裸「推拉摇移」自由发挥）
    expect(system).toContain('快速推近');
    expect(system).toContain('轨道环绕');
    expect(system).toContain('俯冲推进');
    expect(system).toContain('推拉变焦');
    // 大动作频次节制，避免廉价感与重复
    expect(system).toContain('全片各 ≤2 次');
    expect(system).toContain('推拉变焦 ≤1 次');
    // 反重复：第 6 条把运镜纳入"避免连续相同"
    expect(system).toContain('相同景别、机位或运镜');
  });

  it('normalizes original-language location and prop aliases to one Chinese asset', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: 'Marcus enters the boathouse.',
      durationSeconds: 4,
      environments: ['Abandoned Boathouse'],
      items: ['silver-binding shackles', '银色镣铐'],
    }] }));

    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', location: 'Abandoned Boathouse', content: 'Marcus enters.' }],
      [
        {
          kind: 'LOCATION',
          name: '废弃船屋',
          sourceNames: ['Abandoned Boathouse'],
        },
        {
          kind: 'PROP',
          name: '银色镣铐',
          sourceNames: ['Silver Binding Shackles'],
        },
      ],
    );

    expect(result.shots[0].environments).toEqual(['废弃船屋']);
    expect(result.shots[0].items).toEqual(['银色镣铐']);
    expect(result.warnings).not.toContain(expect.stringContaining('未定义资产'));
  });

  it('台词提及但未登场的角色不补入 characters（8/11 修复：台词提及≠登场）', () => {
    // Dean 台词提到 Arthur（"little Artie will be joining us"），但 Arthur 本镜未出镜——
    // 画面里只有 Dean。此前守卫把台词命中的 Arthur 也补入 characters → 生成时乱入。
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: 'Dean站在讲台前，目光扫过台下学员，温和开口。',
      durationSeconds: 4,
      characters: ['Dean'],
      dialogue: 'Dean（温和）：Alright everyone, starting today, little Artie will be joining our class.',
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: 'Dean：Alright everyone, starting today, little Artie will be joining our class.' }],
      [
        { kind: 'CHARACTER', name: 'Dean' },
        { kind: 'CHARACTER', name: 'Arthur', sourceNames: ['Artie'] },
      ],
    );
    // 只保留画面登场的 Dean；台词里的 Arthur/Artie 不得补入
    expect(result.shots[0].characters).toEqual(['Dean']);
    expect(result.shots[0].warnings?.some?.((w) => w.includes('补入') && w.includes('Arthur')) ?? false).toBe(false);
  });

  it('AI 误把台词提及角色写进 characters → 未登场角色被移除（8/11 修复）', () => {
    // AI 把只出现在台词里的 Arthur 写进了 characters；画面实际登场的只有 Murphy
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: 'Murphy从课桌后猛地起身，声音拔高质疑。',
      durationSeconds: 4,
      characters: ['Murphy', 'Arthur'],
      dialogue: 'Murphy（难以置信）：Wait, seriously? Little Artie is not even half my size!',
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: 'Murphy：Wait, seriously? Little Artie is not even half my size!' }],
      [
        { kind: 'CHARACTER', name: 'Murphy' },
        { kind: 'CHARACTER', name: 'Arthur', sourceNames: ['Artie'] },
      ],
    );
    // Arthur 只出现在台词（Artie）未登场 → 从 characters 移除（Murphy 保留）
    expect(result.shots[0].characters).toEqual(['Murphy']);
  });

  it('画面明确出现的角色仍正常补入（回归：守卫不误伤）', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: 'Dean站在讲台前，一手轻拍Arthur肩头。',
      durationSeconds: 4,
      characters: ['Dean'],
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: 'Dean：Artie will join us.' }],
      [
        { kind: 'CHARACTER', name: 'Dean' },
        { kind: 'CHARACTER', name: 'Arthur', sourceNames: ['Artie'] },
      ],
    );
    // Arthur 在画面描述中 → 补入
    expect(result.shots[0].characters).toEqual(['Dean', 'Arthur']);
  });

  it('解析并归一角色变体引用 characterCostumes（成年/幼年时期变体）', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: '幼年时期的Artie站在教室里。',
      durationSeconds: 4,
      characters: ['Artie'],
      // 含一条引用未出现资产的条目（unknown）
      characterCostumes: [
        { name: 'Artie', costumeKey: 'child-artie' },
        { name: 'unknown', costumeKey: 'x' },
      ],
    }] }));

    // parse 容错：保留合法条目
    expect(shots[0].characterCostumes).toEqual([
      { name: 'Artie', costumeKey: 'child-artie' },
      { name: 'unknown', costumeKey: 'x' },
    ]);

    // postprocess：name 归一到展示名（Artie→Arthur）、丢弃未出现资产的条目；
    // 不做自动推断（角色变体仅由 AI 输出决定，场景线索不可靠）
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: '幼年Artie。' }],
      [
        { kind: 'CHARACTER', name: 'Arthur', sourceNames: ['Artie'], variants: [
          { key: 'default', label: '首席制服' },
          { key: 'child-artie', label: '幼年形态' },
        ] },
      ],
    );
    expect(result.shots[0].characterCostumes).toEqual([{ name: 'Arthur', costumeKey: 'child-artie' }]);
    expect(result.shots[0].characters).toEqual(['Arthur']);
  });

  it('角色变体的非法 costumeKey 回退 default 并记 warning', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: 'Arthur在教室里。',
      durationSeconds: 4,
      characters: ['Arthur'],
      // grown-up 不在该角色声明的变体集 {default, child-artie} 内 → 非法
      characterCostumes: [{ name: 'Arthur', costumeKey: 'grown-up' }],
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: 'Arthur。' }],
      [
        { kind: 'CHARACTER', name: 'Arthur', variants: [
          { key: 'default', label: '首席制服' },
          { key: 'child-artie', label: '幼年形态' },
        ] },
      ],
    );
    expect(result.shots[0].characterCostumes).toEqual([{ name: 'Arthur', costumeKey: 'default' }]);
    expect(result.warnings.some((w) => w.includes('变体引用非法') && w.includes('grown-up'))).toBe(true);
  });

  it('解析并归一道具/环境变体引用 itemCostumes/environmentCostumes', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S8',
      visualPrompt: '令牌被踩碎，军营被哥布林占据。',
      durationSeconds: 4,
      items: ['silver token'],
      environments: ['border camp'],
      // 含一条非法条目（无 name）和一条引用未出现资产的条目（unknown）
      itemCostumes: [
        { name: 'silver token', costumeKey: 'crushed' },
        { name: 'unknown', costumeKey: 'x' },
        { bad: 'entry' },
      ],
      environmentCostumes: [{ name: 'border camp', costumeKey: 'goblin-occupied' }],
    }] }));

    // parse 容错：丢掉非法条目（无 name/costumeKey），保留两条合法
    expect(shots[0].itemCostumes).toEqual([
      { name: 'silver token', costumeKey: 'crushed' },
      { name: 'unknown', costumeKey: 'x' },
    ]);
    expect(shots[0].environmentCostumes).toEqual([{ name: 'border camp', costumeKey: 'goblin-occupied' }]);

    // postprocess 把 name 归一到展示名，并丢弃引用未出现资产的条目
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S8', content: '令牌被踩碎。' }],
      [
        { kind: 'PROP', name: '银色令牌', sourceNames: ['silver token'] },
        { kind: 'LOCATION', name: '边境军营', sourceNames: ['border camp'] },
      ],
    );
    expect(result.shots[0].itemCostumes).toEqual([{ name: '银色令牌', costumeKey: 'crushed' }]);
    expect(result.shots[0].environmentCostumes).toEqual([{ name: '边境军营', costumeKey: 'goblin-occupied' }]);
  });

  it('多态资产的非法 costumeKey 回退 default 并记 warning（分镜阶段严格化）', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: '令牌被毁。',
      durationSeconds: 4,
      items: ['silver token'],
      // vaporized 不在该资产声明的变体集 {default, crushed} 内 → 非法
      itemCostumes: [{ name: 'silver token', costumeKey: 'vaporized' }],
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: '令牌被毁。' }],
      [
        { kind: 'PROP', name: '银色令牌', sourceNames: ['silver token'], variants: [
          { key: 'default', label: '完好' },
          { key: 'crushed', label: '破碎' },
        ] },
      ],
    );
    expect(result.shots[0].itemCostumes).toEqual([{ name: '银色令牌', costumeKey: 'default' }]);
    expect(result.warnings.some((w) => w.includes('变体引用非法') && w.includes('vaporized'))).toBe(true);
  });

  it('变体推理：default + 对白含状态词 → 补成对应变体（防 AI 一律 default 穿帮）', () => {
    // 实测 AI 99% 写 default，状态变体（云合并/手环碎裂等）几乎从不被引用 → 穿帮。
    // 推理据本镜文本里的状态线索把 default 补成对应变体。EP1 蒲公英云合并 case。
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: '两朵蒲公英云在空中靠近。',
      dialogue: 'My Dandelion Clouds... they merged?',
      durationSeconds: 4,
      items: ['dandelion cloud'],
      itemCostumes: [{ name: 'dandelion cloud', costumeKey: 'default' }],
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: 'they merged' }],
      [{ kind: 'PROP', name: '蒲公英云', sourceNames: ['dandelion cloud'], variants: [
        { key: 'default', label: '漂浮云朵' },
        { key: 'merged', label: '双云合并' },
        { key: 'tornado', label: '绿色风暴龙卷' },
      ] }],
    );
    expect(result.shots[0].itemCostumes?.[0].costumeKey).toBe('merged');
    expect(result.warnings.some((w) => w.includes('default→merged'))).toBe(true);
  });

  it('变体推理：中文 label 去尾部通用词后命中 → 补成对应变体', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: '令牌破碎，碎片散落一地。',
      durationSeconds: 4,
      items: ['silver token'],
      itemCostumes: [{ name: 'silver token', costumeKey: 'default' }],
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: '令牌破碎' }],
      [{ kind: 'PROP', name: '银色令牌', sourceNames: ['silver token'], variants: [
        { key: 'default', label: '完好' },
        { key: 'crushed', label: '破碎状态' },
      ] }],
    );
    // label「破碎状态」去尾部「状态」→「破碎」(w2)，命中 visualPrompt「令牌破碎」
    expect(result.shots[0].itemCostumes?.[0].costumeKey).toBe('crushed');
  });

  it('变体推理：多变体同时命中且并列 → 不改（避免歧义误判制造新穿帮）', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: '云合并成龙卷风暴。',
      durationSeconds: 4,
      items: ['dandelion cloud'],
      itemCostumes: [{ name: 'dandelion cloud', costumeKey: 'default' }],
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: '云合并成龙卷' }],
      [{ kind: 'PROP', name: '蒲公英云', sourceNames: ['dandelion cloud'], variants: [
        { key: 'default', label: '漂浮云朵' },
        { key: 'merged', label: '合并形态' },
        { key: 'tornado', label: '龙卷形态' },
      ] }],
    );
    // merged（「合并」w2）与 tornado（「龙卷」w2）同时命中且同权重 → 并列，不改
    expect(result.shots[0].itemCostumes?.[0].costumeKey).toBe('default');
  });

  it('变体推理：AI 已指定非 default → 尊重不改', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: '两朵云合并。',
      durationSeconds: 4,
      items: ['dandelion cloud'],
      itemCostumes: [{ name: 'dandelion cloud', costumeKey: 'tornado' }],
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: '云合并' }],
      [{ kind: 'PROP', name: '蒲公英云', sourceNames: ['dandelion cloud'], variants: [
        { key: 'default', label: '漂浮云朵' },
        { key: 'merged', label: '双云合并' },
        { key: 'tornado', label: '绿色风暴龙卷' },
      ] }],
    );
    expect(result.shots[0].itemCostumes?.[0].costumeKey).toBe('tornado');
  });

  it('变体补入：引用了多态资产但无 costume 条目 + 文本有状态线索 → 补一条', () => {
    // AI 常把道具列进 items 却忘了在 itemCostumes 指定变体——生成时静默落 default。
    // 若本镜文本有明确状态线索，推理应补一条对应非默认变体（不是 default，补 default 等于没补）。
    const shots = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      visualPrompt: '两朵蒲公英云靠近。',
      dialogue: 'My Dandelion Clouds merged?',
      durationSeconds: 4,
      items: ['dandelion cloud'],
    }] }));
    const result = postprocessStoryboardShots(
      shots,
      [{ id: 'S1', content: 'clouds merged' }],
      [{ kind: 'PROP', name: '蒲公英云', sourceNames: ['dandelion cloud'], variants: [
        { key: 'default', label: '漂浮云朵' },
        { key: 'merged', label: '双云合并' },
      ] }],
    );
    expect(result.shots[0].itemCostumes?.[0]).toEqual({ name: '蒲公英云', costumeKey: 'merged' });
    expect(result.warnings.some((w) => w.includes('变体补入') && w.includes('merged'))).toBe(true);
  });

  it('parses app1 rich fields and splits multi-timecode prompts', () => {
    const parsed = parseStoryboardShots(JSON.stringify({ shots: [{
      sceneId: 'S1',
      shotNumber: 1,
      duration: 6,
      videoPrompt: '[00:00-00:03] 中景，平视，推进，角色走近\n[00:03-00:06] 特写，平视，固定，角色开口',
      characters: ['Alice'],
      speakingCharacters: ['Alice'],
      environments: ['Room'],
      items: ['Letter'],
      soundCue: 'Alice：“Hello”｜脚步声',
    }] }));
    const result = postprocessStoryboardShots(parsed, [{
      id: 'S1',
      location: 'Room',
      content: 'Alice（calm）：Hello',
    }], [
      { kind: 'CHARACTER', name: 'Alice' },
      { kind: 'LOCATION', name: 'Room' },
      { kind: 'PROP', name: 'Letter' },
    ]);

    expect(result.shots).toHaveLength(2);
    expect(result.shots.map((shot) => shot.durationSeconds)).toEqual([3, 3]);
    expect(result.shots[0]).toMatchObject({ groupIndex: 0, audioType: '对白' });
  });

  it('normalizes assets, groups at 15 seconds and auto-fills missing dialogue', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [
      { sceneId: 'S1', visualPrompt: '镜头一', durationSeconds: 8, characters: ['alice'] },
      { sceneId: 'S1', visualPrompt: '镜头二', durationSeconds: 8, characters: ['Alic'] },
    ] }));
    const result = postprocessStoryboardShots(shots, [{
      id: 'S1',
      location: 'Room',
      content: 'Alice（calm）：Do not forget this line',
    }], [
      { kind: 'CHARACTER', name: 'Alice' },
      { kind: 'LOCATION', name: 'Room' },
    ]);

    expect(result.shots.map((shot) => shot.characters)).toEqual([['Alice'], ['Alice']]);
    expect(result.shots.map((shot) => shot.groupIndex)).toEqual([0, 1]);
    // 漏分到镜头的台词由 postprocess 自动补入（不丢台词），补入后覆盖率为 1
    expect(result.dialogueCoverage[0]).toMatchObject({ total: 1, covered: 1 });
    expect(result.warnings.some((warning) => warning.includes('台词补全'))).toBe(true);
  });

  it('audits generated dialogue against the locked target writing system', () => {
    const shots = parseStoryboardShots(JSON.stringify({ shots: [
      { sceneId: 'S1', visualPrompt: '人物开口', dialogue: '你好', durationSeconds: 4 },
    ] }));
    const result = postprocessStoryboardShots(shots, [{ id: 'S1', content: '你好' }], [], 'en');

    expect(result.languageAudit).toHaveLength(1);
    expect(result.languageAudit[0]).toMatchObject({
      languageCode: 'en',
      matches: false,
      unexpectedCharacters: 2,
    });
    expect(result.warnings.some((warning) => warning.includes('目标语种'))).toBe(true);
  });

  it('新对白格式「角色（OS）：台词」的 OS 拉丁通道不污染中文语种审核（剥标签后审核）', () => {
    // dialogue 现按「角色名（OS）：台词」标注说话人。OS 是拉丁字母，若不剥就直接送审，
    // 中文项目会把 O/S 当混入的西文字符 → 假阳性"不符合目标语种"。剥成纯台词后审核应通过。
    const shots = parseStoryboardShots(JSON.stringify({ shots: [
      { sceneId: 'S1', visualPrompt: '人物开口', dialogue: '林夏（OS）：放开我！', durationSeconds: 4 },
    ] }));
    const result = postprocessStoryboardShots(shots, [{ id: 'S1', content: '放开我！' }], [], 'zh');

    expect(result.languageAudit).toHaveLength(1);
    expect(result.languageAudit[0]).toMatchObject({ languageCode: 'zh', matches: true });
    expect(result.warnings.some((warning) => warning.includes('目标语种'))).toBe(false);
  });
});

describe('storyboard/service replaceEpisodeShots', () => {
  it('validates all inputs before deleting old shots', async () => {
    infraMocks.transactionQuery.mockClear();

    await expect(replaceEpisodeShots('episode-1', [{
      projectId: 'project-1',
      episodeId: 'another-episode',
      shotIndex: 1,
    }])).rejects.toThrow('episodeId');

    expect(infraMocks.transactionQuery).not.toHaveBeenCalled();
  });

  it('deletes and inserts inside one transaction（首生：archive 空集 no-op）', async () => {
    infraMocks.transactionQuery.mockClear();

    await replaceEpisodeShots('episode-1', [{
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotIndex: 1,
      visualPrompt: '近景，角色转身',
      sortOrder: 1,
    }]);

    const sqls = infraMocks.transactionQuery.mock.calls.map((c) => String(c[0]));
    // 首个事务 call：episodes 串行锁
    expect(sqls[0]).toContain('FOR UPDATE');
    // 首生（archive SELECT 返空）不应产生历史版本
    expect(sqls.some((s) => s.includes('INSERT INTO storyboard_versions'))).toBe(false);
    // 仍 DELETE 旧 + INSERT 新
    expect(sqls.some((s) => s.includes('DELETE FROM shots'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO shots'))).toBe(true);
  });

  it('重生前把当前整集快照归档为历史版本（不删旧镜头）', async () => {
    infraMocks.transactionQuery.mockClear();
    // 1. SELECT episodes FOR UPDATE → 1 行（锁成功）
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [{}] });
    // 2. archive SELECT shots → 当前有 1 条旧镜头
    infraMocks.transactionQuery.mockResolvedValueOnce({
      rows: [{
        id: 'old', projectId: 'project-1', episodeId: 'episode-1', shotIndex: 0, sortOrder: 0,
        createdAt: new Date(), updatedAt: new Date(),
      }],
    });
    // 3. archive SELECT MAX(ordinal)+1 → next 1
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [{ next: 1 }] });
    // 4. archive INSERT storyboard_versions
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] });
    // 5. DELETE shots
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] });
    // 6. INSERT 新镜头
    infraMocks.transactionQuery.mockResolvedValueOnce({ rows: [] });

    await replaceEpisodeShots('episode-1', [{
      projectId: 'project-1',
      episodeId: 'episode-1',
      shotIndex: 1,
      visualPrompt: '近景，角色转身',
      sortOrder: 1,
    }]);

    const sqls = infraMocks.transactionQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO storyboard_versions'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM shots'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO shots'))).toBe(true);
  });
});

// ============================================================
// validateShotCreate
// ============================================================
describe('storyboard/validation validateShotCreate', () => {
  const validInput: ShotCreateInput = {
    projectId: 'proj-1',
    shotIndex: 0,
    durationSeconds: 5.5,
    aspectRatio: '9:16',
  };

  it('validates a correct input', () => {
    const r = validateShotCreate(validInput);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports empty projectId', () => {
    const r = validateShotCreate({ ...validInput, projectId: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('projectId'))).toBe(true);
  });

  it('reports negative shotIndex', () => {
    const r = validateShotCreate({ ...validInput, shotIndex: -1 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('shotIndex'))).toBe(true);
  });

  it('reports non-integer shotIndex', () => {
    const r = validateShotCreate({ ...validInput, shotIndex: 1.5 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('shotIndex'))).toBe(true);
  });

  it('reports non-positive durationSeconds', () => {
    const r = validateShotCreate({ ...validInput, durationSeconds: 0 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('durationSeconds'))).toBe(true);
  });

  it('reports invalid aspectRatio', () => {
    const r = validateShotCreate({ ...validInput, aspectRatio: '5:4' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('aspectRatio'))).toBe(true);
  });

  it('reports invalid resolution', () => {
    const r = validateShotCreate({ ...validInput, resolution: '8k' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('resolution'))).toBe(true);
  });

  it('accepts all valid aspect ratios', () => {
    for (const ar of SHOT_ASPECT_RATIOS) {
      const r = validateShotCreate({ ...validInput, aspectRatio: ar });
      expect(r.valid).toBe(true);
    }
  });

  it('accepts null optional fields', () => {
    const r = validateShotCreate({
      projectId: 'p',
      shotIndex: 0,
      durationSeconds: null,
      aspectRatio: null,
      resolution: null,
    });
    expect(r.valid).toBe(true);
  });

  it('reports negative sortOrder', () => {
    const r = validateShotCreate({ ...validInput, sortOrder: -1 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('sortOrder'))).toBe(true);
  });
});

// ============================================================
// validateShotUpdate
// ============================================================
describe('storyboard/validation validateShotUpdate', () => {
  it('validates a correct patch', () => {
    const r = validateShotUpdate({ status: 'CONFIRMED', videoStatus: 'COMPLETED' });
    expect(r.valid).toBe(true);
  });

  it('reports invalid status', () => {
    const r = validateShotUpdate({ status: 'INVALID' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('reports invalid videoStatus', () => {
    const r = validateShotUpdate({ videoStatus: 'DONE' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('videoStatus'))).toBe(true);
  });

  it('accepts all valid statuses', () => {
    for (const s of SHOT_STATUSES) {
      expect(validateShotUpdate({ status: s }).valid).toBe(true);
    }
    for (const s of SHOT_VIDEO_STATUSES) {
      expect(validateShotUpdate({ videoStatus: s }).valid).toBe(true);
    }
  });

  it('accepts null aspectRatio in patch', () => {
    expect(validateShotUpdate({ aspectRatio: null }).valid).toBe(true);
  });

  it('reports invalid aspectRatio in patch', () => {
    expect(validateShotUpdate({ aspectRatio: '5:4' }).valid).toBe(false);
  });

  it('accepts empty patch (no fields)', () => {
    expect(validateShotUpdate({}).valid).toBe(true);
  });
});

// ============================================================
// sanitizeSeedanceParams
// ============================================================
describe('storyboard/seedance-params sanitizeSeedanceParams', () => {
  it('keeps valid fields', () => {
    const r = sanitizeSeedanceParams({
      seed: 42.7,
      resolution: '1080p',
      aspectRatio: '16:9',
      generateAudio: true,
      watermark: false,
      returnLastFrame: true,
    });
    expect(r).toEqual({
      seed: 42, // trunc
      resolution: '1080p',
      aspectRatio: '16:9',
      generateAudio: true,
      watermark: false,
      returnLastFrame: true,
    });
  });

  it('drops invalid enum values', () => {
    const r = sanitizeSeedanceParams({
      resolution: '8k', // 非法
      aspectRatio: '5:4', // 非法
      seed: 1,
    });
    expect(r).toEqual({ seed: 1 });
  });

  it('drops wrong-type fields', () => {
    const r = sanitizeSeedanceParams({
      seed: 'not a number',
      generateAudio: 'not a boolean',
      resolution: 123,
    });
    expect(r).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(sanitizeSeedanceParams(null)).toBeNull();
    expect(sanitizeSeedanceParams('string')).toBeNull();
    expect(sanitizeSeedanceParams([1, 2, 3])).toBeNull();
    expect(sanitizeSeedanceParams(undefined)).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(sanitizeSeedanceParams({})).toBeNull();
  });

  it('truncates seed to integer', () => {
    expect(sanitizeSeedanceParams({ seed: 99.999 })).toEqual({ seed: 99 });
    expect(sanitizeSeedanceParams({ seed: -3.2 })).toEqual({ seed: -3 });
  });
});

// ============================================================
// readParamsHistory
// ============================================================
describe('storyboard/seedance-params readParamsHistory', () => {
  it('reads history array from metadata', () => {
    const history = [
      { params: { seed: 1 }, savedAt: '2026-01-01' },
      { params: { seed: 2 }, savedAt: '2026-01-02' },
    ];
    const r = readParamsHistory({ seedanceGroupParamsHistory: history });
    expect(r).toEqual(history);
  });

  it('returns empty array when metadata is null', () => {
    expect(readParamsHistory(null)).toEqual([]);
  });

  it('returns empty array when metadata has no history field', () => {
    expect(readParamsHistory({ otherField: 1 })).toEqual([]);
  });

  it('returns empty array when history is not an array', () => {
    expect(readParamsHistory({ seedanceGroupParamsHistory: 'not array' })).toEqual([]);
  });

  it('MAX_HISTORY_LENGTH is 20', () => {
    expect(MAX_HISTORY_LENGTH).toBe(20);
  });
});
