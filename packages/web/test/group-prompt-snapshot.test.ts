import { describe, expect, it } from 'vitest';

import {
  groupPromptMetadata,
  groupShotsForPreparedPrompts,
  mergeCostumeMaps,
  prepareGroupPromptSnapshot,
  readStoredGroupPrompt,
  resolveGroupExecutablePrompt,
} from '../lib/group-prompt-snapshot';

const assets = [{
  id: 'character-1', kind: 'CHARACTER', name: '林夏', imageUrl: '/default.png',
  description: '黑发、面部轮廓清晰',
  metadata: { sourceNames: ['Lin Xia'] },
  costumes: [
    { key: 'default', label: '便装', description: '', identityLock: [], imageUrl: '/default.png', coverageScenes: ['S1'] },
    { key: 'formal', label: '礼服', description: '', identityLock: [], imageUrl: '/formal.png', coverageScenes: ['S2'] },
  ],
}];

const shots = [
  {
    id: 'shot-1', sortOrder: 0, shotIndex: 0, durationSeconds: 4, sceneId: 'S2',
    visualPrompt: '林夏走入大厅', referencedAssets: { characters: ['林夏'] },
    metadata: { groupIndex: 1, storyboardTable: { characters: ['林夏'] } },
  },
  {
    id: 'shot-2', sortOrder: 1, shotIndex: 1, durationSeconds: 4, sceneId: 'S2',
    visualPrompt: '林夏停在门前', referencedAssets: { characters: ['林夏'] },
    metadata: { groupIndex: 1, storyboardTable: { characters: ['林夏'] } },
  },
];

describe('group prompt snapshots', () => {
  it('hashes the actual selected costume reference and detects stale context', () => {
    const prepared = prepareGroupPromptSnapshot({
      shots,
      assets,
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });
    expect(prepared.references.characterImageUrls).toEqual(['/formal.png']);
    const storedMetadata = groupPromptMetadata({}, prepared);
    expect(readStoredGroupPrompt(storedMetadata, prepared).status).toBe('READY');
    const rePrepared = prepareGroupPromptSnapshot({
      shots: [{ ...shots[0], metadata: { ...shots[0].metadata, ...storedMetadata } }, shots[1]],
      assets,
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });
    expect(rePrepared.contextHash).toBe(prepared.contextHash);

    const unrelatedContext = prepareGroupPromptSnapshot({
      shots,
      assets: [
        ...assets,
        { id: 'unrelated-prop', kind: 'PROP', name: '未出现的手电筒', imageUrl: '/torch.png' },
      ],
      costumeMap: [
        { sceneId: 'S2', character: '林夏', costumeLabel: '礼服' },
        { sceneId: 'S99', character: '路人甲', costumeLabel: '雨衣' },
      ],
    });
    expect(unrelatedContext.contextHash).toBe(prepared.contextHash);

    const changedAsset = prepareGroupPromptSnapshot({
      shots,
      assets: [{ ...assets[0], description: '相关角色描述已修改' }],
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });
    expect(changedAsset.contextHash).not.toBe(prepared.contextHash);

    const changedUnselectedCostume = prepareGroupPromptSnapshot({
      shots,
      assets: [{
        ...assets[0],
        costumes: assets[0].costumes.map((costume) => costume.key === 'default'
          ? { ...costume, description: '修改了未选中的便装' }
          : costume),
      }],
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });
    expect(changedUnselectedCostume.contextHash).toBe(prepared.contextHash);

    const changedSelectedCostume = prepareGroupPromptSnapshot({
      shots,
      assets: [{
        ...assets[0],
        costumes: assets[0].costumes.map((costume) => costume.key === 'formal'
          ? { ...costume, description: '金色刺绣礼服' }
          : costume),
      }],
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });
    expect(changedSelectedCostume.contextHash).not.toBe(prepared.contextHash);

    const changed = prepareGroupPromptSnapshot({
      shots: [{ ...shots[0], visualPrompt: '林夏突然转身' }, shots[1]],
      assets,
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });
    expect(readStoredGroupPrompt(groupPromptMetadata({}, prepared), changed).status).toBe('STALE');
  });

  it('tracks a selected variant before its image exists and invalidates the snapshot when it lands', () => {
    const missingAssets = [{
      ...assets[0],
      costumes: assets[0].costumes.map((costume) => costume.key === 'formal'
        ? { ...costume, imageUrl: null }
        : costume),
    }];
    const missing = prepareGroupPromptSnapshot({
      shots,
      assets: missingAssets,
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });

    // 对齐 app1：礼服变体图尚未生成时回退到 default 图，characterImageUrls 非空。
    expect(missing.references.characterImageUrls).toEqual(['/default.png']);
    expect(missing.references.unresolvedCostumes).toEqual([
      expect.objectContaining({
        character: '林夏',
        costumeLabel: '礼服',
        reason: 'IMAGE_MISSING',
      }),
    ]);

    const landed = prepareGroupPromptSnapshot({
      shots,
      assets,
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });
    expect(landed.references.characterImageUrls).toEqual(['/formal.png']);
    expect(landed.contextHash).not.toBe(missing.contextHash);
  });

  it('lets the current episode costume row override a same-scene legacy project row', () => {
    expect(mergeCostumeMaps(
      {
        costumeMap: [
          { sceneId: 'S2', character: '林夏', costumeLabel: '便装' },
          { sceneId: 'S9', character: '周宁', costumeLabel: '制服' },
        ],
      },
      { costumeMap: [{ sceneId: 'S2-1', character: '林 夏', costumeLabel: '礼服' }] },
    )).toEqual([
      { sceneId: 'S2-1', character: '林 夏', costumeLabel: '礼服' },
      { sceneId: 'S9', character: '周宁', costumeLabel: '制服' },
    ]);
  });

  it('groups by persisted groupIndex before applying reference limits', () => {
    // shot-3 与 shot-1/shot-2 的 groupIndex 不同。新 P0-6 算法（computeGroupsForChain）
    // 只在「相邻小组且合并后 ≤15s」时跨 groupIndex 合并。shot-3 时长设 12s，
    // 与前组（8s）合并后达 20s 超上限，因此保留为独立组——验证 groupIndex 分组语义。
    const grouped = groupShotsForPreparedPrompts([
      ...shots,
      {
        ...shots[1],
        id: 'shot-3',
        sortOrder: 2,
        shotIndex: 2,
        durationSeconds: 12,
        metadata: { groupIndex: 2 },
      },
    ], assets);
    expect(grouped.map((group) => group.map((shot) => shot.id))).toEqual([
      ['shot-1', 'shot-2'],
      ['shot-3'],
    ]);
  });

  it('merges small adjacent groups across groupIndex when combined ≤15s (P0-6 computeGroupsForChain)', () => {
    // 与上例相反：shot-3 时长仅 4s，与前组（8s）合并后 12s ≤15s。
    // computeGroupsForChain 阶段 3 会把 <4 镜的小组合并到相邻组，
    // 与前端 ProductionStage.tsx 同名算法一致，避免「前端一组、后端两组」的冲突。
    const grouped = groupShotsForPreparedPrompts([
      ...shots,
      {
        ...shots[1],
        id: 'shot-3',
        sortOrder: 2,
        shotIndex: 2,
        durationSeconds: 4,
        metadata: { groupIndex: 2 },
      },
    ], assets);
    expect(grouped.map((group) => group.map((shot) => shot.id))).toEqual([
      ['shot-1', 'shot-2', 'shot-3'],
    ]);
  });

  it('跨场景不合并：两个不同场景的相邻组,合计 ≤15s 也保持各自成组（杀跨场景穿帮）', () => {
    // 场景边界守卫：S1 与 S2 是不同真实场景,即使合计 12s ≤15s 也不合并,
    // 避免把两个场景塞进同一 15s 组造成内容跳切穿帮。
    const mk = (id: string, sortOrder: number, sceneId: string, groupIndex: number) => ({
      id, sortOrder, shotIndex: sortOrder, durationSeconds: 1.5, sceneId,
      visualPrompt: 'x', referencedAssets: { characters: ['林夏'] },
      metadata: { groupIndex, storyboardTable: { characters: ['林夏'] } },
    });
    const grouped = groupShotsForPreparedPrompts([
      mk('a1', 0, 'S1', 1), mk('a2', 1, 'S1', 1), mk('a3', 2, 'S1', 1), mk('a4', 3, 'S1', 1),
      mk('b1', 4, 'S2', 1), mk('b2', 5, 'S2', 1), mk('b3', 6, 'S2', 1), mk('b4', 7, 'S2', 1),
    ], assets);
    expect(grouped.map((group) => group.map((shot) => shot.id))).toEqual([
      ['a1', 'a2', 'a3', 'a4'],
      ['b1', 'b2', 'b3', 'b4'],
    ]);
  });

  it('同场景仍合并：同一场景两个相邻组,合计 ≤15s 合成 1 组', () => {
    // 与上一用例对照:同为 S1 场景的两个小组合计 12s ≤15s → 合并成 1 组。
    const mk = (id: string, sortOrder: number, sceneId: string, groupIndex: number) => ({
      id, sortOrder, shotIndex: sortOrder, durationSeconds: 1.5, sceneId,
      visualPrompt: 'x', referencedAssets: { characters: ['林夏'] },
      metadata: { groupIndex, storyboardTable: { characters: ['林夏'] } },
    });
    const grouped = groupShotsForPreparedPrompts([
      mk('a1', 0, 'S1', 1), mk('a2', 1, 'S1', 1), mk('a3', 2, 'S1', 1), mk('a4', 3, 'S1', 1),
      mk('c1', 4, 'S1', 2), mk('c2', 5, 'S1', 2), mk('c3', 6, 'S1', 2), mk('c4', 7, 'S1', 2),
    ], assets);
    expect(grouped.map((group) => group.map((shot) => shot.id))).toEqual([
      ['a1', 'a2', 'a3', 'a4', 'c1', 'c2', 'c3', 'c4'],
    ]);
  });

  it('15s 上限仍守住：两个 ≥4 镜组合计 >15s 不合并（各自成组,单组不拆）', () => {
    const mk = (id: string, sortOrder: number, sceneId: string, groupIndex: number, dur: number) => ({
      id, sortOrder, shotIndex: sortOrder, durationSeconds: dur, sceneId,
      visualPrompt: 'x', referencedAssets: { characters: ['林夏'] },
      metadata: { groupIndex, storyboardTable: { characters: ['林夏'] } },
    });
    const grouped = groupShotsForPreparedPrompts([
      mk('a1', 0, 'S1', 1, 2), mk('a2', 1, 'S1', 1, 2), mk('a3', 2, 'S1', 1, 2), mk('a4', 3, 'S1', 1, 2),
      mk('b1', 4, 'S2', 1, 2), mk('b2', 5, 'S2', 1, 2), mk('b3', 6, 'S2', 1, 2), mk('b4', 7, 'S2', 1, 2),
    ], assets);
    // 8s + 8s = 16s > 15s → 不合并。
    expect(grouped.map((group) => group.map((shot) => shot.id))).toEqual([
      ['a1', 'a2', 'a3', 'a4'],
      ['b1', 'b2', 'b3', 'b4'],
    ]);
  });

  it('通过 sourceNames 解析中文资产，别名变化会使快照过期', () => {
    const localizedShots = [{
      id: 'shot-alias', sortOrder: 0, shotIndex: 0, durationSeconds: 4,
      visualPrompt: '走进船屋并拿起镐铐',
      referencedAssets: {
        environments: ['Abandoned Boathouse'],
        items: ['Silver Binding Shackles'],
      },
      metadata: { sceneLocation: 'Abandoned Boathouse' },
    }];
    const localizedAssets = [
      {
        id: 'location-cn', kind: 'LOCATION', name: '废弃船屋', imageUrl: '/boathouse.png',
        metadata: { sourceNames: ['Abandoned Boathouse'] }, intExt: '外', mood: '冷色',
      },
      {
        id: 'prop-cn', kind: 'PROP', name: '银色束缚镐铐', imageUrl: '/shackles.png',
        metadata: { sourceNames: ['Silver Binding Shackles'] },
      },
    ];
    const prepared = prepareGroupPromptSnapshot({ shots: localizedShots, assets: localizedAssets });
    expect(prepared.references.imageUrls).toEqual(['/boathouse.png', '/shackles.png']);
    expect(prepared.prompt).toContain('场景设定参考 图片1 中的废弃船屋');
    expect(prepared.prompt).toContain('道具参考 图片2 中的银色束缚镐铐');

    const aliasRemoved = prepareGroupPromptSnapshot({
      shots: localizedShots,
      assets: localizedAssets.map((asset) => ({ ...asset, metadata: { sourceNames: [] } })),
    });
    expect(aliasRemoved.references.imageUrls).toEqual([]);
    expect(aliasRemoved.contextHash).not.toBe(prepared.contextHash);
  });

  it('区分 prompt 音频 URL 与客户端 manifest 裸 wav 文件名', () => {
    const voiceShot = [{
      id: 'voice-shot', sortOrder: 0, shotIndex: 0, durationSeconds: 4,
      visualPrompt: '林夏说“别走”',
      referencedAssets: { characters: ['林夏'], speakingCharacters: ['林夏'] },
      metadata: null,
    }];
    const prepared = prepareGroupPromptSnapshot({
      shots: voiceShot,
      assets: [{
        id: 'linxia', kind: 'CHARACTER', name: '林夏', imageUrl: '/linxia.png',
        metadata: { confirmed_voice: { file: 'female_001_warm.wav' } },
      }],
    });

    expect(prepared.references.promptAudioUrls).toEqual([
      '/api/reference-audio/female_001_warm.wav',
    ]);
    expect(prepared.references.clientAudioFiles).toEqual(['female_001_warm.wav']);
    // Backward-compatible chain route key must also be client-safe.
    expect(prepared.references.audioUrls).toEqual(['female_001_warm.wav']);
    expect(prepared.references.audioRefs).toEqual([{ name: '林夏' }]);

    const unsupportedRemote = prepareGroupPromptSnapshot({
      shots: voiceShot,
      assets: [{
        id: 'linxia', kind: 'CHARACTER', name: '林夏', imageUrl: '/linxia.png',
        metadata: { confirmed_voice: { file: 'https://cdn.example.com/voice.wav' } },
      }],
    });
    expect(unsupportedRemote.references.audioUrls).toEqual([]);
    expect(unsupportedRemote.references.clientAudioFiles).toEqual([]);
    expect(unsupportedRemote.references.promptAudioUrls).toEqual([]);
    expect(unsupportedRemote.references.audioRefs).toEqual([]);
    expect(unsupportedRemote.prompt).not.toContain('音色参考');
  });

  it('四角色上限不会错误截掉开启网格的场景与道具', () => {
    const characterNames = ['角色1', '角色2', '角色3', '角色4'];
    const prepared = prepareGroupPromptSnapshot({
      shots: [{
        id: 'grid-shot', sortOrder: 0, shotIndex: 0, durationSeconds: 4,
        visualPrompt: '四人站在门厅',
        referencedAssets: {
          characters: characterNames,
          environments: ['门厅'],
          items: ['钥匙'],
        },
        metadata: null,
      }],
      assets: [
        ...characterNames.map((name, index) => ({
          id: `character-${index}`, kind: 'CHARACTER', name, imageUrl: `/c${index}.png`,
        })),
        { id: 'location-grid', kind: 'LOCATION', name: '门厅', imageUrl: '/hall.png', gridOverlayEnabled: true },
        { id: 'prop-grid', kind: 'PROP', name: '钥匙', imageUrl: '/key.png', gridOverlayEnabled: true },
      ],
    });

    expect(prepared.references.characterImageUrls).toHaveLength(6);
    expect(prepared.references.characterImageUrls).toContain('/hall.png');
    expect(prepared.references.characterImageUrls).toContain('/key.png');
  });

  it('动态保底分配下 assetRefs 与参考图数组严格对应（人物/环境/物品图片N不漂移）', () => {
    // 混合 4 角色 + 1 环境 + 1 物品：验证 references.assetRefs 的长度/顺序与
    // characterImageUrls + imageUrls 严格对应——combineGroupPrompts 按 assetRefs 下标
    // 生成「图片N」，provider 按 characterImageUrls+imageUrls 顺序收图，两者同序才不漂移。
    const characterNames = ['主角', '配角A', '配角B', '配角C'];
    const prepared = prepareGroupPromptSnapshot({
      shots: [{
        id: 'mix-shot', sortOrder: 0, shotIndex: 0, durationSeconds: 4,
        visualPrompt: '主角与配角在教室讨论',
        referencedAssets: { characters: characterNames, environments: ['教室'], items: ['课本'] },
        metadata: null,
      }],
      assets: [
        ...characterNames.map((name, index) => ({
          id: `character-${index}`, kind: 'CHARACTER', name, imageUrl: `/char${index}.png`,
        })),
        { id: 'loc-1', kind: 'LOCATION', name: '教室', imageUrl: '/classroom.png' },
        { id: 'prop-1', kind: 'PROP', name: '课本', imageUrl: '/book.png' },
      ],
    });
    const { assetRefs, characterImageUrls, imageUrls } = prepared.references;
    // [1] 长度严格对应：assetRefs = 角色通道 + 场景通道，无错位/丢失。
    expect(assetRefs).toHaveLength(characterImageUrls.length + imageUrls.length);
    // [2] 角色通道全在 assetRefs 头部、kind 全 CHARACTER、name 顺序 = 声明顺序
    //     （= characterImageUrls 顺序 → provider charRefs 与 prompt 图片1..K 同序）。
    const charRefs = assetRefs.slice(0, characterImageUrls.length);
    expect(charRefs.every((ref) => ref.kind === 'CHARACTER')).toBe(true);
    expect(charRefs.map((ref) => ref.name)).toEqual(characterNames);
    // [3] 场景通道在尾部，环境与物品保底各 ≥1 保留。
    const sceneRefs = assetRefs.slice(characterImageUrls.length);
    expect(sceneRefs).toHaveLength(imageUrls.length);
    expect(sceneRefs.some((ref) => ref.kind === 'LOCATION')).toBe(true);
    expect(sceneRefs.some((ref) => ref.kind === 'PROP')).toBe(true);
    expect(imageUrls).toContain('/classroom.png');
    expect(imageUrls).toContain('/book.png');
  });
});

describe('group prompt approved lock', () => {
  const basePrepared = () => prepareGroupPromptSnapshot({
    shots,
    assets,
    costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
  });

  it('readStoredGroupPrompt 默认 approved=false', () => {
    const prepared = basePrepared();
    const stored = groupPromptMetadata({}, prepared);
    expect(readStoredGroupPrompt(stored, prepared).approved).toBe(false);
  });

  it('groupPromptMetadata 显式 approved=true 写键 + 时间戳', () => {
    const prepared = basePrepared();
    const stored = groupPromptMetadata({}, prepared, prepared.prompt, 'user', true, true);
    expect(stored.seedanceGroupPromptApproved).toBe(true);
    expect(typeof stored.seedanceGroupPromptApprovedAt).toBe('string');
    expect(readStoredGroupPrompt(stored, prepared).approved).toBe(true);
  });

  it('approved 保留：旁路写回（不传 approved）不误清已有锁定', () => {
    const prepared = basePrepared();
    const locked = groupPromptMetadata({}, prepared, prepared.prompt, 'user', true, true);
    // 模拟 prepare/preview 旁路再次写回（source=auto, 未传 approved）——锁定必须保留。
    const rewritten = groupPromptMetadata(locked, prepared, prepared.prompt, 'auto', true);
    expect(rewritten.seedanceGroupPromptApproved).toBe(true);
    expect(readStoredGroupPrompt(rewritten, prepared).approved).toBe(true);
  });

  it('approved 显式 false 解除锁定（重新生成新提示词场景）', () => {
    const prepared = basePrepared();
    const locked = groupPromptMetadata({}, prepared, prepared.prompt, 'user', true, true);
    const regenerated = groupPromptMetadata(locked, prepared, '新提示词正文', 'auto', true, false);
    expect(regenerated.seedanceGroupPromptApproved).toBe(false);
    expect(regenerated.seedanceGroupPromptApprovedAt).toBeNull();
    expect(readStoredGroupPrompt(regenerated, prepared).approved).toBe(false);
  });

  it('认可锁定后即使 contextHash 漂移（STALE），approved 仍为 true', () => {
    const prepared = basePrepared();
    const locked = groupPromptMetadata({}, prepared, prepared.prompt, 'user', true, true);
    const changed = prepareGroupPromptSnapshot({
      shots: [{ ...shots[0], visualPrompt: '林夏突然转身' }, shots[1]],
      assets,
      costumeMap: [{ sceneId: 'S2', character: '林夏', costumeLabel: '礼服' }],
    });
    const read = readStoredGroupPrompt(locked, changed);
    expect(read.status).toBe('STALE');
    expect(read.approved).toBe(true);
  });
});

describe('resolveGroupExecutablePrompt — 尊重用户手改版本（修复 LLM 重写覆盖）', () => {
  const userPrompt = '用户手改的提示词正文';
  const preparedPrompt = '服务端现算的 prepared 提示词';

  it('source=user（STALE 未认可）→ 原样用用户版本、不重写（修复核心）', () => {
    // 历史 bug：buildUserGroupPromptMetadata 只写 source='user' 不写 approved/contextHash，
    // 被判 STALE → LLM 重写覆盖。现 source='user' 短路，用户改的必须原样送生成。
    const d = resolveGroupExecutablePrompt({
      storedPrompt: { status: 'STALE', prompt: userPrompt, source: 'user', approved: false },
      storedRewritten: false,
      preparedPrompt,
    });
    expect(d.executablePrompt).toBe(userPrompt);
    expect(d.needsRewrite).toBe(false);
  });

  it('approved=true（STALE）→ 用锁定版本、不重写', () => {
    const d = resolveGroupExecutablePrompt({
      storedPrompt: { status: 'STALE', prompt: userPrompt, source: 'auto', approved: true },
      storedRewritten: false,
      preparedPrompt,
    });
    expect(d.executablePrompt).toBe(userPrompt);
    expect(d.needsRewrite).toBe(false);
  });

  it('source=auto 且 STALE 未认可 → 用现算 prepared、需 LLM 重写', () => {
    const d = resolveGroupExecutablePrompt({
      storedPrompt: { status: 'STALE', prompt: '旧的 auto 版本', source: 'auto', approved: false },
      storedRewritten: false,
      preparedPrompt,
    });
    expect(d.executablePrompt).toBe(preparedPrompt);
    expect(d.needsRewrite).toBe(true);
  });

  it('READY 且已重写缓存 → 复用 stored、不重写', () => {
    const d = resolveGroupExecutablePrompt({
      storedPrompt: { status: 'READY', prompt: userPrompt, source: 'auto', approved: false },
      storedRewritten: true,
      preparedPrompt,
    });
    expect(d.executablePrompt).toBe(userPrompt);
    expect(d.needsRewrite).toBe(false);
  });

  it('READY 但未重写 → 用现算 prepared、不重写（层2：prepare 旁路写回的不直接复用）', () => {
    const d = resolveGroupExecutablePrompt({
      storedPrompt: { status: 'READY', prompt: userPrompt, source: 'auto', approved: false },
      storedRewritten: false,
      preparedPrompt,
    });
    expect(d.executablePrompt).toBe(preparedPrompt);
    expect(d.needsRewrite).toBe(false);
  });

  it('MISSING → 用现算 prepared、需 LLM 重写', () => {
    const d = resolveGroupExecutablePrompt({
      storedPrompt: { status: 'MISSING', prompt: null, source: null, approved: false },
      storedRewritten: false,
      preparedPrompt,
    });
    expect(d.executablePrompt).toBe(preparedPrompt);
    expect(d.needsRewrite).toBe(true);
  });

  it('source=user 但正文为空 → 回退现算 prepared、需重写（空正文不算用户版本）', () => {
    const d = resolveGroupExecutablePrompt({
      storedPrompt: { status: 'STALE', prompt: null, source: 'user', approved: false },
      storedRewritten: false,
      preparedPrompt,
    });
    expect(d.executablePrompt).toBe(preparedPrompt);
    expect(d.needsRewrite).toBe(true);
  });
});

describe('variant audit (幼态图是否进入参考图数组)', () => {
  const auditShots = [
    {
      id: 'shot-child', sortOrder: 0, shotIndex: 0, durationSeconds: 4, sceneId: 'S1',
      visualPrompt: 'Arthur幼年坐在课桌前', referencedAssets: {
        characters: ['Arthur'],
        characterCostumes: [{ name: 'Arthur', costumeKey: 'child-artie' }],
      },
      metadata: { groupIndex: 1, storyboardTable: { characters: ['Arthur'] } },
    },
    {
      id: 'shot-adult', sortOrder: 1, shotIndex: 1, durationSeconds: 4, sceneId: 'S2',
      visualPrompt: 'Arthur坐高背椅批文件', referencedAssets: {
        characters: ['Arthur'],
        characterCostumes: [{ name: 'Arthur', costumeKey: 'missing-key' }],
      },
      metadata: { groupIndex: 1, storyboardTable: { characters: ['Arthur'] } },
    },
  ];

  const arthurAssets = [{
    id: 'arthur-1', kind: 'CHARACTER', name: 'Arthur', imageUrl: '/arthur-default.png',
    description: '银发蓝眸',
    metadata: {},
    costumes: [
      { key: 'default', label: '首席制服', description: '', identityLock: [], imageUrl: '/arthur-default.png', coverageScenes: [] },
      { key: 'child-artie', label: '幼年形态', description: '', identityLock: [], imageUrl: '/arthur-child.png', coverageScenes: [] },
    ],
  }];

  it('有变体的镜头：期望变体图进了参考图 → inRefs=true；变体图缺失 → inRefs=false', () => {
    const prepared = prepareGroupPromptSnapshot({ shots: auditShots, assets: arthurAssets });
    const audit = prepared.variantAudit;
    expect(audit).toHaveLength(2);
    const child = audit.find((entry) => entry.shotId === 'shot-child')!;
    expect(child).toMatchObject({
      character: 'Arthur',
      costumeKey: 'child-artie',
      expectedImageUrl: '/arthur-child.png',
      inRefs: true,
    });
    // 参考图数组里确实用的是幼年图（非成年默认图）
    expect(prepared.references.characterImageUrls).toContain('/arthur-child.png');
    const missing = audit.find((entry) => entry.shotId === 'shot-adult')!;
    expect(missing).toMatchObject({ costumeKey: 'missing-key', expectedImageUrl: null, inRefs: false });
    // metadata 落库带审计，事后一眼可查
    const stored = groupPromptMetadata({}, prepared);
    expect(stored.seedanceGroupPromptVariantAudit).toEqual(audit);
  });
});

