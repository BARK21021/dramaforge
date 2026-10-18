// ============================================================
// ③ server/domain/asset — 单测（纯校验逻辑）
// ============================================================
//
// 覆盖：
//   - validateAssetCreate：合法 / projectId 空 / kind 白名单 / name 空 / assetType 白名单 / tags 类型
//   - validateAssetUpdate：合法补丁 / name 空 / voiceSource 白名单 / auditionStatus 白名单 / tags 类型
//   - ASSET_KINDS / CHARACTER_TYPES / VOICE_SOURCES / AUDITION_STATUSES 白名单完整性
// ============================================================

import { describe, it, expect, vi } from 'vitest';

// mock @shared/utils（genId）和 @server/infra（query），service.ts 间接依赖；
// vitest 无法解析 @shared/* / @server/* 别名，即使测试只测纯校验也需 mock 模块加载
vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'test-uuid-' + Math.random().toString(36).slice(2, 8)),
}));
vi.mock('@server/infra', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

import {
  validateAssetCreate,
  validateAssetUpdate,
  ASSET_KINDS,
  CHARACTER_TYPES,
  VOICE_SOURCES,
  AUDITION_STATUSES,
  replaceExtractedAssets,
  type AssetCreateInput,
  type AssetUpdatePatch,
} from '../../src/domain/asset';
import { query } from '@server/infra';

// ============================================================
// validateAssetCreate
// ============================================================
describe('asset/validation validateAssetCreate', () => {
  const validInput: AssetCreateInput = {
    projectId: 'proj-1',
    kind: 'CHARACTER',
    name: '林夏',
    description: '女主角',
    imageUrl: 'https://example.com/linxia.png',
    assetType: '主角',
    tags: ['女主角', '现代'],
  };

  it('validates a correct input', () => {
    const r = validateAssetCreate(validInput);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports empty projectId', () => {
    const r = validateAssetCreate({ ...validInput, projectId: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('projectId'))).toBe(true);
  });

  it('reports invalid kind', () => {
    const r = validateAssetCreate({ ...validInput, kind: 'INVALID' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('kind'))).toBe(true);
  });

  it('reports empty name', () => {
    const r = validateAssetCreate({ ...validInput, name: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('reports invalid assetType', () => {
    const r = validateAssetCreate({ ...validInput, assetType: '路人王' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('assetType'))).toBe(true);
  });

  it('reports non-array tags', () => {
    const r = validateAssetCreate({ ...validInput, tags: 'not array' as unknown as string[] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('tags'))).toBe(true);
  });

  it('accepts all valid kinds', () => {
    for (const kind of ASSET_KINDS) {
      const r = validateAssetCreate({ ...validInput, kind });
      expect(r.valid).toBe(true);
    }
  });

  it('accepts all valid character types', () => {
    for (const at of CHARACTER_TYPES) {
      const r = validateAssetCreate({ ...validInput, assetType: at });
      expect(r.valid).toBe(true);
    }
  });

  it('accepts null assetType', () => {
    const r = validateAssetCreate({ ...validInput, assetType: null });
    expect(r.valid).toBe(true);
  });

  it('accepts minimal input (only required fields)', () => {
    const r = validateAssetCreate({
      projectId: 'p',
      kind: 'PROP',
      name: '道具',
    });
    expect(r.valid).toBe(true);
  });
});

// ============================================================
// validateAssetUpdate
// ============================================================
describe('asset/validation validateAssetUpdate', () => {
  it('validates a correct patch', () => {
    const r = validateAssetUpdate({
      name: '新名字',
      isConfirmed: true,
      voiceId: 'voice-1',
      voiceSource: 'library',
      auditionStatus: 'completed',
    });
    expect(r.valid).toBe(true);
  });

  it('reports empty name', () => {
    const r = validateAssetUpdate({ name: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('reports invalid voiceSource', () => {
    const r = validateAssetUpdate({ voiceSource: 'invalid' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('voiceSource'))).toBe(true);
  });

  it('reports invalid auditionStatus', () => {
    const r = validateAssetUpdate({ auditionStatus: 'done' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('auditionStatus'))).toBe(true);
  });

  it('accepts all valid voice sources', () => {
    for (const vs of VOICE_SOURCES) {
      expect(validateAssetUpdate({ voiceSource: vs }).valid).toBe(true);
    }
  });

  it('accepts all valid audition statuses', () => {
    for (const s of AUDITION_STATUSES) {
      expect(validateAssetUpdate({ auditionStatus: s }).valid).toBe(true);
    }
  });

  it('accepts null voiceSource', () => {
    expect(validateAssetUpdate({ voiceSource: null }).valid).toBe(true);
  });

  it('accepts null tags', () => {
    expect(validateAssetUpdate({ tags: null }).valid).toBe(true);
  });

  it('reports non-array tags', () => {
    expect(validateAssetUpdate({ tags: 'not array' as unknown as string[] }).valid).toBe(false);
  });

  it('accepts empty patch (no fields)', () => {
    expect(validateAssetUpdate({}).valid).toBe(true);
  });

  it('accepts boolean fields', () => {
    expect(validateAssetUpdate({ isConfirmed: true, regenLocked: false }).valid).toBe(true);
  });
});

// ============================================================
// 白名单完整性
// ============================================================
describe('asset/validation whitelist constants', () => {
  it('ASSET_KINDS contains CHARACTER/PROP/LOCATION/ENTITY', () => {
    // ENTITY 由 F4/P4 加入（WorkspaceAssetKind + ASSET_KINDS），白名单含 4 类
    expect(ASSET_KINDS).toEqual(['CHARACTER', 'PROP', 'LOCATION', 'ENTITY']);
  });

  it('CHARACTER_TYPES contains 4 role types', () => {
    expect(CHARACTER_TYPES).toHaveLength(4);
    expect(CHARACTER_TYPES).toContain('主角');
    expect(CHARACTER_TYPES).toContain('群演');
  });

  it('VOICE_SOURCES contains library/upload', () => {
    expect(VOICE_SOURCES).toEqual(['library', 'upload']);
  });

  it('AUDITION_STATUSES contains 4 states', () => {
    expect(AUDITION_STATUSES).toEqual(['idle', 'pending', 'completed', 'failed']);
  });
});

describe('asset extraction persistence', () => {
  it('reuses source-language aliases and persists a Chinese PROP display name', async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    const now = new Date('2026-07-23T00:00:00.000Z');
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          id: 'prop-en', projectId: 'project-1', kind: 'PROP',
          name: 'Silver Binding Shackles', description: 'old', metadata: { source: 'ai', extracted: true },
          imageUrl: null, isConfirmed: false, regenLocked: false,
          createdAt: now, updatedAt: now,
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await replaceExtractedAssets('project-1', {
      characters: [],
      items: [{
        name: '银色镣铐',
        source_names: ['Silver Binding Shackles'],
        item_type: '核心道具',
        description: '银色金属镣铐',
        significance: '束缚主角',
        coverage_scenes: ['S1'],
      }],
      environments: [],
      entities: [],
    });

    const updateCall = queryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE assets SET name = $1'),
    );
    expect(updateCall?.[1]?.[0]).toBe('银色镣铐');
    // costumes 列插入后（索引5），meta（含 sourceNames）移到索引6
    expect(String(updateCall?.[1]?.[6])).toContain('Silver Binding Shackles');
    expect(queryMock.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes("VALUES ($1, $2, 'PROP'"),
    )).toBe(false);
  });

  it('persists non-human speakers as ENTITY assets with voice suggestions', async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockReset();
    // listAssets → INSERT → getAsset。getAsset 返空不影响落库契约断言。
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const counts = await replaceExtractedAssets('project-1', {
      characters: [],
      items: [],
      environments: [],
      entities: [{
        name: '星舰主控',
        entity_type: 'ai',
        description: '蓝色全息主控面板',
        identity_lock: ['环形蓝光', '中央波形'],
        coverage_scenes: ['S1'],
        suggested_voices: [{
          file: 'ai_calm.wav',
          desc: '冷静中性电子音',
          reason: '符合舰载 AI 身份',
          gender: 'neutral',
        }],
      }],
    });

    expect(counts).toEqual({ characters: 0, items: 0, environments: 0, entities: 1 });
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes("VALUES ($1, $2, 'ENTITY'"),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall?.[1]).toEqual(expect.arrayContaining([
      'project-1',
      '星舰主控',
      '蓝色全息主控面板',
      'ai',
      '冷静中性电子音',
    ]));
    expect(String(insertCall?.[1]?.at(-1))).toContain('ai_calm.wav');
  });
});
