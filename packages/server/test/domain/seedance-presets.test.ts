// ============================================================
// ③ server/domain/seedance-presets — 用户模板 CRUD 单测
// ============================================================
// 覆盖用户隔离、字段清洗、数量/重名校验，以及默认模板事务切换。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/infra/pg';

vi.mock('@shared/utils', () => ({ genId: vi.fn(() => 'preset-new') }));
vi.mock('@server/infra', () => ({
  query: vi.fn(),
  tx: vi.fn(),
}));

import { query, tx } from '@server/infra';
import {
  MAX_SEEDANCE_PRESETS_PER_USER,
  SeedancePresetError,
  listSeedancePresets,
  createSeedancePreset,
  updateSeedancePreset,
  deleteSeedancePreset,
} from '../../src/domain/seedance-presets';

/** 构造数据库返回行，便于每个场景只覆盖关心的字段。 */
function presetRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'preset-1',
    userId: 'user-1',
    name: '默认横屏',
    params: { resolution: '1080p' },
    isDefault: false,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

/** 把 tx 装配为使用指定 mock 查询函数执行真实事务体。 */
function useTransactionQuery(transactionQuery: ReturnType<typeof vi.fn>): void {
  vi.mocked(tx).mockImplementation(async (callback) => {
    const client: QueryFn = { query: transactionQuery };
    return callback(client);
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(tx).mockReset();
});

describe('listSeedancePresets', () => {
  it('按当前 userId 查询并把时间转换为字符串', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [presetRow({ createdAt: new Date('2026-07-21T01:00:00.000Z') })],
      rowCount: 1,
    });

    const result = await listSeedancePresets('user-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE "userId" = \$1/),
      ['user-1'],
    );
    expect(result[0]).toMatchObject({
      id: 'preset-1',
      userId: 'user-1',
      createdAt: '2026-07-21T01:00:00.000Z',
    });
  });
});

describe('createSeedancePreset', () => {
  it('在同一用户锁和事务内切换默认模板后创建新模板', async () => {
    const transactionQuery = vi
      .fn()
      // 锁定用户，保护同用户并发写。
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
      // 数量未到上限。
      .mockResolvedValueOnce({ rows: [{ count: 2 }], rowCount: 1 })
      // 名称未重复。
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // 清除旧默认。
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 返回新模板。
      .mockResolvedValueOnce({
        rows: [presetRow({ id: 'preset-new', isDefault: true })],
        rowCount: 1,
      });
    useTransactionQuery(transactionQuery);

    const result = await createSeedancePreset('user-1', {
      name: '  默认横屏  ',
      params: { resolution: '1080p', ignored: '不会落库' },
      isDefault: true,
    });

    expect(result).toMatchObject({ id: 'preset-new', isDefault: true });
    expect(transactionQuery.mock.calls[0]).toEqual([
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      ['user-1'],
    ]);
    expect(transactionQuery.mock.calls[3][0]).toMatch(/"isDefault" = FALSE/);
    expect(transactionQuery.mock.calls[4][1]).toEqual([
      'preset-new',
      'user-1',
      '默认横屏',
      { resolution: '1080p' },
      true,
    ]);
  });

  it('在进入事务前拒绝空名称、无效参数和非布尔 isDefault', async () => {
    await expect(
      createSeedancePreset('user-1', { name: ' ', params: { resolution: '720p' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      createSeedancePreset('user-1', { name: '模板', params: { unknown: 1 } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      createSeedancePreset('user-1', {
        name: '模板',
        params: { resolution: '720p' },
        isDefault: 'true',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(tx).not.toHaveBeenCalled();
  });

  it('在用户模板达到上限时返回稳定错误', async () => {
    const transactionQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ count: MAX_SEEDANCE_PRESETS_PER_USER }],
        rowCount: 1,
      });
    useTransactionQuery(transactionQuery);

    await expect(
      createSeedancePreset('user-1', {
        name: '第 51 个',
        params: { resolution: '720p' },
      }),
    ).rejects.toMatchObject({ code: 'PRESET_LIMIT_REACHED', statusCode: 400 });
  });
});

describe('updateSeedancePreset', () => {
  it('使用 id + userId 锁定目标，其他用户模板按不存在处理', async () => {
    const transactionQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    useTransactionQuery(transactionQuery);

    await expect(
      updateSeedancePreset('user-1', 'other-user-preset', { name: '新名称' }),
    ).rejects.toBeInstanceOf(SeedancePresetError);
    expect(transactionQuery.mock.calls[1]).toEqual([
      'SELECT id FROM seedance_presets WHERE id = $1 AND "userId" = $2 FOR UPDATE',
      ['other-user-preset', 'user-1'],
    ]);
    expect(transactionQuery).toHaveBeenCalledTimes(2);
  });

  it('清洗 params，并在同一事务内将目标设为唯一默认模板', async () => {
    const transactionQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'preset-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [presetRow({ isDefault: true, params: { aspectRatio: '9:16' } })],
        rowCount: 1,
      });
    useTransactionQuery(transactionQuery);

    const result = await updateSeedancePreset('user-1', 'preset-1', {
      params: { aspectRatio: '9:16', ignored: true },
      isDefault: true,
    });

    expect(result.isDefault).toBe(true);
    expect(transactionQuery.mock.calls[2]).toEqual([
      expect.stringMatching(/id <> \$2 AND "isDefault" = TRUE/),
      ['user-1', 'preset-1'],
    ]);
    expect(transactionQuery.mock.calls[3][1]).toEqual([
      { aspectRatio: '9:16' },
      true,
      'preset-1',
      'user-1',
    ]);
    expect(transactionQuery.mock.calls[3][0]).toMatch(
      /WHERE id = \$3 AND "userId" = \$4/,
    );
  });

  it('拒绝没有任何受支持字段的空更新', async () => {
    await expect(updateSeedancePreset('user-1', 'preset-1', {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(tx).not.toHaveBeenCalled();
  });
});

describe('deleteSeedancePreset', () => {
  it('删除时同时匹配 id 与当前 userId', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ id: 'preset-1' }], rowCount: 1 });

    await deleteSeedancePreset('user-1', 'preset-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE id = \$1 AND "userId" = \$2/),
      ['preset-1', 'user-1'],
    );
  });

  it('其他用户的 id 不命中时返回 PRESET_NOT_FOUND', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(deleteSeedancePreset('user-1', 'other-preset')).rejects.toMatchObject({
      code: 'PRESET_NOT_FOUND',
      statusCode: 404,
    });
  });
});
