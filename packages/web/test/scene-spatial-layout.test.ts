import { describe, expect, it } from 'vitest';

import { parseScriptResult } from '@server/domain/prompt/script-prompt';
import { convertCharacterNamesToImageRefs } from '@server/domain/prompt/group-preview';
import {
  buildSceneBlockingImageMap,
  buildSceneSpatialLayoutMap,
  buildSceneTimeOfDayMap,
  groupPromptMetadata,
  prepareGroupPromptSnapshot,
  readStoredGroupPrompt,
  shouldReuseGroupVideo,
} from '../lib/group-prompt-snapshot';

const assets = [{
  id: 'character-1', kind: 'CHARACTER', name: '林夏', imageUrl: '/default.png',
  description: '黑发、面部轮廓清晰',
  metadata: { sourceNames: ['Lin Xia'] },
  costumes: [
    { key: 'default', label: '便装', description: '', identityLock: [], imageUrl: '/default.png', coverageScenes: ['S1'] },
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

const costumeMap = [{ sceneId: 'S2', character: '林夏', costumeLabel: '便装' }];

describe('scene spatial layout (座位布局)', () => {
  it('parseScriptResult 从「座位布局：」行提取并从正文剔除', () => {
    const sample = [
      '场景列表',
      'S1',
      '车内·日·内',
      '',
      '## S1 [车内 · 日 · 内] 角色：司机 / 副驾',
      '',
      '座位布局：司机左前座、副驾右前座、后排左/中/右',
      '',
      '△司机握方向盘注视前方',
      '',
      '司机（平静）：出发了',
      '',
      '信息点',
      '冲突升级  司机与副驾产生分歧',
      '',
      'E1S1 车内',
      '时间/场景  日 / 内',
      '出场人物  司机、副驾',
      '场景画风  现代写实',
      '',
      '造型表',
      'S1 / 司机 / 便装 / 白色T恤 / 新造型',
      'S1 / 副驾 / 便装 / 蓝色衬衫',
    ].join('\n');
    const parsed = parseScriptResult(sample);
    const scene = parsed.scenes.find((s) => s.id === 'S1');
    expect(scene).toBeTruthy();
    expect(scene!.spatialLayout).toBe('司机左前座、副驾右前座、后排左/中/右');
    expect(scene!.content).not.toContain('座位布局');
    expect(scene!.content).toContain('司机握方向盘');
  });

  it('parseScriptResult 提取带角色名+位置配对的座位布局（括号/中点/顿号完整保留）', () => {
    const sample = [
      '场景列表',
      'S1',
      '车内·日·内',
      '',
      '## S1 [车内 · 日 · 内] 角色：林夏 / 赵默 / 王五 / 李四',
      '',
      '座位布局：林夏(左前·驾驶位)、赵默(右前·副驾)、王五(后排左)、李四(后排右)',
      '',
      '△林夏握方向盘注视前方',
      '',
      '信息点',
      '冲突升级  司机与副驾产生分歧',
      '',
      'E1S1 车内',
      '时间/场景  日 / 内',
      '出场人物  林夏、赵默、王五、李四',
      '场景画风  现代写实',
      '',
      '造型表',
      'S1 / 林夏 / 便装 / 白色T恤',
    ].join('\n');
    const parsed = parseScriptResult(sample);
    const scene = parsed.scenes.find((s) => s.id === 'S1');
    expect(scene).toBeTruthy();
    expect(scene!.spatialLayout).toBe('林夏(左前·驾驶位)、赵默(右前·副驾)、王五(后排左)、李四(后排右)');
    expect(scene!.content).not.toContain('座位布局');
    expect(scene!.content).not.toContain('左前');
    expect(scene!.content).toContain('林夏握方向盘');
  });

  it('parseScriptResult 无座位布局行时 spatialLayout 为 undefined（不回归）', () => {
    const sample = [
      '场景列表',
      'S1',
      '走廊·日·内',
      '',
      '## S1 [走廊 · 日 · 内] 角色：林夏',
      '',
      '△林夏独自走过走廊',
      '',
      '信息点',
      '情感推进  林夏回忆往事',
      '',
      'E1S1 走廊',
      '时间/场景  日 / 内',
      '出场人物  林夏',
      '场景画风  现代写实',
      '',
      '造型表',
      'S1 / 林夏 / 便装 / 白色T恤',
    ].join('\n');
    const parsed = parseScriptResult(sample);
    const scene = parsed.scenes.find((s) => s.id === 'S1');
    expect(scene).toBeTruthy();
    expect(scene!.spatialLayout).toBeUndefined();
  });

  it('buildSceneSpatialLayoutMap 按 extractBaseSceneId 归一化 key，跳过无 layout 场景', () => {
    expect(buildSceneSpatialLayoutMap({
      scenes: [
        { id: 'S1', spatialLayout: '司机左前座、副驾右前座' },
        { id: 'S2' },
        { id: 'S3-1', spatialLayout: '主审中座、被告左前' },
        { id: 'S4', spatialLayout: '   ' },
      ],
    })).toEqual({
      S1: '司机左前座、副驾右前座',
      S3: '主审中座、被告左前',
    });
    expect(buildSceneSpatialLayoutMap({})).toEqual({});
    expect(buildSceneSpatialLayoutMap(null)).toEqual({});
    expect(buildSceneSpatialLayoutMap({ scenes: 'nope' })).toEqual({});
  });

  it('prepareGroupPromptSnapshot 注入「站位布局」不变量行', () => {
    const withLayout = prepareGroupPromptSnapshot({
      shots, assets, costumeMap,
      sceneSpatialLayoutMap: { S2: '林夏左前、赵默右后' },
    });
    expect(withLayout.prompt).toContain('站位布局：林夏左前、赵默右后。组内镜头沿用此站位与坐/立姿态，勿换位换姿');
  });

  it('无 sceneSpatialLayoutMap 时不输出「站位布局」行（不回归）；空 map 与不传等价', () => {
    const noLayout = prepareGroupPromptSnapshot({ shots, assets, costumeMap });
    expect(noLayout.prompt).not.toContain('站位布局');
    const emptyMap = prepareGroupPromptSnapshot({ shots, assets, costumeMap, sceneSpatialLayoutMap: {} });
    expect(emptyMap.contextHash).toBe(noLayout.contextHash);
    expect(emptyMap.prompt).toBe(noLayout.prompt);
  });

  it('座位布局变化使 contextHash 过期（READY→STALE）', () => {
    const a = prepareGroupPromptSnapshot({ shots, assets, costumeMap, sceneSpatialLayoutMap: { S2: '布局A' } });
    const b = prepareGroupPromptSnapshot({ shots, assets, costumeMap, sceneSpatialLayoutMap: { S2: '布局B' } });
    expect(a.contextHash).not.toBe(b.contextHash);
    expect(readStoredGroupPrompt(groupPromptMetadata({}, a), a).status).toBe('READY');
    expect(readStoredGroupPrompt(groupPromptMetadata({}, a), b).status).toBe('STALE');
  });

  it('buildSceneTimeOfDayMap 按 extractBaseSceneId 归一化 key，跳过无 time 场景', () => {
    expect(buildSceneTimeOfDayMap({
      scenes: [
        { id: 'S1', time: '日' },
        { id: 'S2' },
        { id: 'S3-1', time: '黄昏' },
        { id: 'S4', time: '   ' },
      ],
    })).toEqual({
      S1: '日',
      S3: '黄昏',
    });
    expect(buildSceneTimeOfDayMap({})).toEqual({});
    expect(buildSceneTimeOfDayMap(null)).toEqual({});
    expect(buildSceneTimeOfDayMap({ scenes: 'nope' })).toEqual({});
  });

  it('prepareGroupPromptSnapshot 注入「时段光照」锁定行（同场景跨镜保持时段一致）', () => {
    const withTime = prepareGroupPromptSnapshot({
      shots, assets, costumeMap,
      sceneTimeOfDayMap: { S2: '黄昏' },
    });
    expect(withTime.prompt).toContain('时段光照：黄昏。');
    expect(withTime.prompt).toContain('组内统一此时段');
    expect(withTime.prompt).toContain('勿跨镜切换');
  });

  it('无 sceneTimeOfDayMap 时不输出「时段光照」行；空 map 与不传等价', () => {
    const noTime = prepareGroupPromptSnapshot({ shots, assets, costumeMap });
    expect(noTime.prompt).not.toContain('时段光照');
    const emptyMap = prepareGroupPromptSnapshot({ shots, assets, costumeMap, sceneTimeOfDayMap: {} });
    expect(emptyMap.contextHash).toBe(noTime.contextHash);
    expect(emptyMap.prompt).toBe(noTime.prompt);
  });

  it('时段变化使 contextHash 过期（READY→STALE）', () => {
    const a = prepareGroupPromptSnapshot({ shots, assets, costumeMap, sceneTimeOfDayMap: { S2: '日' } });
    const b = prepareGroupPromptSnapshot({ shots, assets, costumeMap, sceneTimeOfDayMap: { S2: '夜' } });
    expect(a.contextHash).not.toBe(b.contextHash);
    expect(readStoredGroupPrompt(groupPromptMetadata({}, a), a).status).toBe('READY');
    expect(readStoredGroupPrompt(groupPromptMetadata({}, a), b).status).toBe('STALE');
  });

  it('运镜 cameraMovement 变化使 contextHash 过期（READY→STALE）', () => {
    const base = prepareGroupPromptSnapshot({ shots, assets, costumeMap });
    const moved = prepareGroupPromptSnapshot({
      shots: [
        { ...shots[0], metadata: { ...shots[0].metadata, storyboardTable: { ...shots[0].metadata.storyboardTable, cameraMovement: '推镜头' } } },
        shots[1],
      ],
      assets, costumeMap,
    });
    expect(base.contextHash).not.toBe(moved.contextHash);
    expect(readStoredGroupPrompt(groupPromptMetadata({}, base), moved).status).toBe('STALE');
  });

  it('shouldReuseGroupVideo 复用门分支（completed-skip：已完成一律复用，除非 force）', () => {
    // READY + 整组完成同 URL → 复用
    expect(shouldReuseGroupVideo(false, 'READY', ['u', 'u'], 2)).toBe(true);
    // force → 重生成
    expect(shouldReuseGroupVideo(true, 'READY', ['u', 'u'], 2)).toBe(false);
    // STALE 但整组已完成 → 复用（已完成除非 force 不重生，避免 hash 漂移误触发全量重跑）
    expect(shouldReuseGroupVideo(false, 'STALE', ['u', 'u'], 2)).toBe(true);
    // MISSING 但整组已完成 → 复用
    expect(shouldReuseGroupVideo(false, 'MISSING', ['u', 'u'], 2)).toBe(true);
    // 混合 URL → 重生成
    expect(shouldReuseGroupVideo(false, 'READY', ['u1', 'u2'], 2)).toBe(false);
    // 未全完成 → 重生成
    expect(shouldReuseGroupVideo(false, 'READY', ['u'], 2)).toBe(false);
    // prompt 版本过期（v3→v4 台词修复）→ 即使整组已完成也禁止复用旧视频
    expect(shouldReuseGroupVideo(false, 'READY', ['u', 'u'], 2, false)).toBe(false);
    expect(shouldReuseGroupVideo(false, 'STALE', ['u', 'u'], 2, false)).toBe(false);
   // 版本一致（默认 true）→ 保持原复用行为
   expect(shouldReuseGroupVideo(false, 'STALE', ['u', 'u'], 2, true)).toBe(true);
  });

  it('referenceHash 隔离参考图变化：角色图换了 → referenceHashMatches=false → 复用门拒绝旧视频', () => {
    // 基线：默认角色图
    const snapA = prepareGroupPromptSnapshot({ shots, assets, costumeMap });
    // 变体：角色图换成 child 版本（模拟幼态图后来补齐）
    const assetsWithVariant = assets.map((a) => ({
      ...a,
      imageUrl: a.imageUrl === '/default.png' ? '/child-artie.png' : a.imageUrl,
      costumes: a.costumes?.map((c) => ({
        ...c,
        imageUrl: c.imageUrl === '/default.png' ? '/child-artie.png' : c.imageUrl,
      })),
    }));
    const snapB = prepareGroupPromptSnapshot({ shots, assets: assetsWithVariant, costumeMap });
    // 两个快照的 referenceHash 不同
    expect(snapA.referenceHash).not.toBe(snapB.referenceHash);
    // 用 snapA 的参考图存 metadata，再用 snapB 检查 → referenceHashMatches=false
    const meta = groupPromptMetadata({}, snapA);
    expect(readStoredGroupPrompt(meta, snapB).referenceHashMatches).toBe(false);
    // 一致时 → true
    expect(readStoredGroupPrompt(meta, snapA).referenceHashMatches).toBe(true);
  });

  it('旧数据无 referenceHash 字段 → referenceHashMatches=true（不阻断已有组复用）', () => {
    const snap = prepareGroupPromptSnapshot({ shots, assets, costumeMap });
    // 手动构造没有 seedanceGroupPromptReferenceHash 的旧 metadata
    const oldMeta = groupPromptMetadata({}, snap);
    delete (oldMeta as Record<string, unknown>).seedanceGroupPromptReferenceHash;
    expect(readStoredGroupPrompt(oldMeta, snap).referenceHashMatches).toBe(true);
  });

  it('prepareGroupPromptSnapshot 端到端：站位布局角色名→图片N（注入组提示词）', () => {
    const snap = prepareGroupPromptSnapshot({
      shots, assets, costumeMap,
      sceneSpatialLayoutMap: { S2: '林夏(左前·驾驶位)' },
    });
    expect(snap.prompt).toContain('站位布局：图片1(左前·驾驶位)。组内镜头沿用此站位与坐/立姿态，勿换位换姿');
    expect(snap.prompt).not.toContain('站位布局：林夏');
  });
});

describe('convertCharacterNamesToImageRefs (座位布局角色名→图片N，火山官方无容器格式)', () => {
  it('把角色名换成图片N，保留位置', () => {
    const map = new Map([['林夏', 1], ['赵默', 2], ['王五', 3], ['李四', 4]]);
    expect(convertCharacterNamesToImageRefs(
      '林夏(左前·驾驶位)、赵默(右前·副驾)、王五(后排左)、李四(后排右)', map,
    )).toBe('图片1(左前·驾驶位)、图片2(右前·副驾)、图片3(后排左)、图片4(后排右)');
  });

  it('该组没有参考图的角色保留原名（降级不破坏布局）', () => {
    const map = new Map([['林夏', 1], ['赵默', 2]]);
    expect(convertCharacterNamesToImageRefs(
      '林夏(左前)、赵默(右前)、王五(后排左)、李四(后排右)', map,
    )).toBe('图片1(左前)、图片2(右前)、王五(后排左)、李四(后排右)');
  });

  it('characterImageNumber 为空时原样返回（无参考图组不转换）', () => {
    expect(convertCharacterNamesToImageRefs('林夏(左前)、赵默(右后)', new Map()))
      .toBe('林夏(左前)、赵默(右后)');
  });

  it('asset 名带英文括号别名时按主名匹配（normalizeNameForPrompt 剥离别名）', () => {
    const map = new Map([['林夏(Lin Xia)', 1]]);
    expect(convertCharacterNamesToImageRefs('林夏(左前·驾驶位)', map)).toBe('图片1(左前·驾驶位)');
  });
});

describe('buildSceneBlockingImageMap (每场景站位图)', () => {
  const layout = '林夏(左前·驾驶位)、赵默(右前·副驾)';

  it('返回 COMMITTED 且 sourceSpatialLayout===当前的记录；baseSceneId 归一化', () => {
    const scriptData = {
      sceneBlockingImages: {
        'S1': { key: 'k1', url: 'sf-asset://k1', version: 3, sourceSpatialLayout: layout, status: 'COMMITTED' },
        'S3-1': { key: 'k3', url: 'sf-asset://k3', version: 1, sourceSpatialLayout: '主审中座', status: 'COMMITTED' },
      },
    };
    const map = buildSceneBlockingImageMap(scriptData, { S1: layout, S3: '主审中座' });
    expect(map.S1).toMatchObject({ key: 'k1', url: 'sf-asset://k1', version: 3, status: 'COMMITTED' });
    expect(map.S3).toMatchObject({ key: 'k3', url: 'sf-asset://k3' });
    // S3-1 归一化为 S3
    expect(map['S3-1']).toBeUndefined();
  });

  it('跳过非 COMMITTED / 无 url 的记录', () => {
    const scriptData = {
      sceneBlockingImages: {
        'S1': { key: 'k1', url: 'sf-asset://k1', sourceSpatialLayout: layout, status: 'GENERATING' },
        'S2': { key: 'k2', url: '', sourceSpatialLayout: layout, status: 'COMMITTED' },
        'S4': { key: 'k4', url: 'sf-asset://k4', sourceSpatialLayout: layout, status: 'FAILED' },
      },
    };
    const map = buildSceneBlockingImageMap(scriptData, { S1: layout, S2: layout, S4: layout });
    expect(Object.keys(map)).toEqual([]);
  });

  it('re-analyze 改了 spatialLayout → 该 scene 不返回（过期安全降级）', () => {
    const scriptData = {
      sceneBlockingImages: {
        'S1': { key: 'k1', url: 'sf-asset://k1', sourceSpatialLayout: '旧布局', status: 'COMMITTED' },
      },
    };
    const fresh = buildSceneBlockingImageMap(scriptData, { S1: '新布局' });
    expect(fresh).toEqual({});
    const same = buildSceneBlockingImageMap(scriptData, { S1: '旧布局' });
    expect(same.S1).toMatchObject({ url: 'sf-asset://k1' });
  });

  it('currentSpatialLayoutByKey 为空 / null / 不传 → 返回 {}（无法核验新鲜度）', () => {
    const scriptData = { sceneBlockingImages: { S1: { url: 'sf-asset://k1', sourceSpatialLayout: layout, status: 'COMMITTED' } } };
    expect(buildSceneBlockingImageMap(scriptData, {})).toEqual({});
    expect(buildSceneBlockingImageMap(scriptData, null)).toEqual({});
    expect(buildSceneBlockingImageMap(scriptData)).toEqual({});
  });

  it('无 sceneBlockingImages / 结构异常 → {}', () => {
    expect(buildSceneBlockingImageMap({}, { S1: layout })).toEqual({});
    expect(buildSceneBlockingImageMap(null, { S1: layout })).toEqual({});
    expect(buildSceneBlockingImageMap({ sceneBlockingImages: 'nope' }, { S1: layout })).toEqual({});
    expect(buildSceneBlockingImageMap({ sceneBlockingImages: [] }, { S1: layout })).toEqual({});
  });
});

describe('prepareGroupPromptSnapshot + 场景站位图注入', () => {
  it('有站位图：进场景通道 + 提示词含「场景空间布局参考 …无脸占位」行', () => {
    const snap = prepareGroupPromptSnapshot({
      shots, assets, costumeMap,
      sceneSpatialLayoutMap: { S2: '林夏左前' },
      sceneBlockingImageMap: {
        S2: { key: 'b1', url: 'sf-asset://b1', version: 1, sourceSpatialLayout: '林夏左前', status: 'COMMITTED' },
      },
    });
    expect(snap.references.imageUrls).toContain('sf-asset://b1');
    expect(snap.references.assetRefs.some((r) => r.kind === 'BLOCKING')).toBe(true);
    expect(snap.prompt).toContain('场景空间布局参考 图片');
    expect(snap.prompt).toContain('无脸占位');
  });

  it('无 sceneBlockingImageMap → 不出现站位图行/不回归', () => {
    const snap = prepareGroupPromptSnapshot({ shots, assets, costumeMap });
    expect(snap.references.assetRefs.some((r) => r.kind === 'BLOCKING')).toBe(false);
    expect(snap.references.imageUrls.every((url) => !url.startsWith('sf-asset://b'))).toBe(true);
    expect(snap.prompt).not.toContain('场景空间布局参考');
  });

  it('站位图变化使 contextHash 过期（READY→STALE，依赖 references 含 blocking url）', () => {
    const a = prepareGroupPromptSnapshot({
      shots, assets, costumeMap,
      sceneBlockingImageMap: { S2: { key: 'b1', url: 'sf-asset://b1', version: 1, sourceSpatialLayout: '', status: 'COMMITTED' } },
    });
    const b = prepareGroupPromptSnapshot({
      shots, assets, costumeMap,
      sceneBlockingImageMap: { S2: { key: 'b2', url: 'sf-asset://b2', version: 2, sourceSpatialLayout: '', status: 'COMMITTED' } },
    });
    expect(a.contextHash).not.toBe(b.contextHash);
    expect(readStoredGroupPrompt(groupPromptMetadata({}, a), b).status).toBe('STALE');
  });

  it('有站位图时普通道具参考被抑制；标 metadata.standaloneReference 的保留', () => {
    const propAssets = [
      ...assets,
      { id: 'prop-wheel', kind: 'PROP', name: '方向盘', imageUrl: '/wheel.png' },
      { id: 'prop-letter', kind: 'PROP', name: '关键信件', imageUrl: '/letter.png', metadata: { standaloneReference: true } },
    ];
    const propShots = [
      { ...shots[0], referencedAssets: { characters: ['林夏'], items: ['方向盘', '关键信件'] } },
      shots[1],
    ];
    const withBlocking = prepareGroupPromptSnapshot({
      shots: propShots, assets: propAssets, costumeMap,
      sceneBlockingImageMap: { S2: { key: 'b1', url: 'sf-asset://b1', version: 1, sourceSpatialLayout: '', status: 'COMMITTED' } },
    });
    expect(withBlocking.references.assetRefs.some((r) => r.kind === 'PROP' && r.name === '方向盘')).toBe(false);
    expect(withBlocking.references.assetRefs.some((r) => r.kind === 'PROP' && r.name === '关键信件')).toBe(true);
    expect(withBlocking.references.assetRefs.some((r) => r.kind === 'BLOCKING')).toBe(true);

    const noBlocking = prepareGroupPromptSnapshot({ shots: propShots, assets: propAssets, costumeMap });
    expect(noBlocking.references.assetRefs.some((r) => r.kind === 'PROP' && r.name === '方向盘')).toBe(true);
    expect(noBlocking.references.assetRefs.some((r) => r.kind === 'PROP' && r.name === '关键信件')).toBe(true);
    expect(noBlocking.references.assetRefs.some((r) => r.kind === 'BLOCKING')).toBe(false);
  });
});
