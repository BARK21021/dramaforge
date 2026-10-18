import { beforeEach, describe, expect, it, vi } from 'vitest';

// 捕获 updateAsset 发出的 UPDATE SQL,断言 metadata 走 jsonb || 合并而非替换。
const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@server/infra', () => ({ query: queryMock, tx: vi.fn() }));
vi.mock('@shared/utils', () => ({ genId: vi.fn(() => 'asset-id') }));

import { updateAsset } from '../../src/domain/asset/service';

const ASSET_ROW = {
  id: 'a1',
  projectId: 'p1',
  kind: 'CHARACTER',
  name: 'James',
  description: '',
  imageUrl: null,
  metadata: { confirmed_voice: { file: 'male_126.wav' }, suggested_voices: [] },
  tags: null,
  version: 1,
  assetType: null,
  baseAmbience: null,
  basePrompt: null,
  isConfirmed: false,
  regenLocked: false,
  costumes: null,
  voiceTrait: 'low male voice',
  voiceId: null,
  voiceSource: 'library',
  auditionStatus: 'idle',
  identityLock: null,
  coverageScenes: null,
  createdAt: new Date('2026-08-07T03:00:00.000Z'),
  updatedAt: new Date('2026-08-07T05:00:00.000Z'),
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('updateAsset metadata merge（防确认资产擦掉提取的语音/变体元数据）', () => {
  it('部分 metadata PATCH 走 jsonb || 合并,不替换', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('UPDATE assets SET')) {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [], rowCount: 0 };
      }
      // getAsset(UPDATE 后回读)
      return { rows: [ASSET_ROW], rowCount: 1 };
    });

    // 复现生产场景:确认资产只传 {confirmed,confirmedAt}
    await updateAsset('a1', {
      isConfirmed: true,
      regenLocked: true,
      metadata: { confirmed: true, confirmedAt: '2026-08-07T05:24:53.000Z' },
    });

    // 关键:metadata 必须用 COALESCE + || 合并,而非裸 metadata = $N 替换
    expect(capturedSql).toContain('COALESCE(metadata');
    expect(capturedSql).toMatch(/\|\|/);
    // 合并对象作为 jsonb 参数传入
    const metaParam = capturedParams.find(
      (p) => typeof p === 'string' && p.includes('confirmedAt'),
    );
    expect(metaParam).toBeDefined();
  });

  it('显式 null 仍可清空 metadata(保留清空能力)', async () => {
    let capturedSql = '';
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE assets SET')) {
        capturedSql = sql;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...ASSET_ROW, metadata: null }], rowCount: 1 };
    });

    await updateAsset('a1', { metadata: null });

    // null 走裸赋值(无 COALESCE/||)
    expect(capturedSql).not.toContain('COALESCE(metadata');
    expect(capturedSql).toMatch(/metadata = \$\d+/);
  });

  it('只更新列字段时不碰 metadata', async () => {
    let capturedSql = '';
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE assets SET')) {
        capturedSql = sql;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [ASSET_ROW], rowCount: 1 };
    });

    await updateAsset('a1', { isConfirmed: true, regenLocked: true });

    expect(capturedSql).not.toMatch(/metadata/i);
    expect(capturedSql).toContain('"isConfirmed"');
    expect(capturedSql).toContain('"regenLocked"');
  });
});
