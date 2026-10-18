// 项目画风契约测试：创建入口、服务端校验和五大流程必须共用同一套预设。
import { describe, expect, it } from 'vitest';
import { createProjectSchema, getProjectArtStylePreset } from '../src/project';

describe('project art style contract', () => {
  it.each([
    ['realistic', '电影级写实', '摄影级画质'],
    ['2d_anime', '2D 动漫', '赛璐璐上色'],
    ['3d_anime', '3D 动漫', '次表面散射皮肤'],
  ] as const)('keeps a concrete prompt for %s', (key, label, promptMarker) => {
    const preset = getProjectArtStylePreset(key);

    expect(preset?.label).toBe(label);
    expect(preset?.promptZh).toContain(promptMarker);
    expect(preset?.promptEn.length).toBeGreaterThan(80);
  });

  it('requires a locked style for domestic and overseas production projects', () => {
    expect(createProjectSchema.safeParse({
      title: '国内项目',
      category: 'DOMESTIC',
      artStyle: 'realistic',
    }).success).toBe(true);
    expect(createProjectSchema.safeParse({
      title: '海外项目',
      category: 'OVERSEAS',
      artStyle: '2d_anime',
    }).success).toBe(true);
    expect(createProjectSchema.safeParse({
      title: '缺少风格',
      category: 'DOMESTIC',
    }).success).toBe(false);
  });

  it('rejects a visual style on script-only original projects', () => {
    expect(createProjectSchema.safeParse({
      title: '原创剧本',
      category: 'ORIGINAL',
      sourceMode: 'LOCAL_SCRIPT',
      artStyle: '3d_anime',
    }).success).toBe(false);
  });
});
