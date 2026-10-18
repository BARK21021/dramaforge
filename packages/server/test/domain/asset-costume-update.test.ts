import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  imageUrl: 'sf-asset://default-latest.png',
  costumes: [] as Array<Record<string, unknown>>,
}));
const txMock = vi.hoisted(() => vi.fn());

vi.mock('@shared/utils', () => ({ genId: vi.fn(() => 'asset-id') }));
vi.mock('@server/infra', () => ({ query: vi.fn(), tx: txMock }));

import { updateAssetCostumesPreservingImages } from '../../src/domain/asset/service';

function assetRow(): Record<string, unknown> {
  return {
    id: 'asset-1',
    projectId: 'project-1',
    kind: 'CHARACTER',
    name: 'Lin Wan',
    imageUrl: state.imageUrl,
    costumes: state.costumes.map((item) => ({ ...item })),
    createdAt: new Date('2026-07-23T00:00:00.000Z'),
    updatedAt: new Date('2026-07-23T00:01:00.000Z'),
  };
}

beforeEach(() => {
  state.imageUrl = 'sf-asset://default-latest.png';
  state.costumes = [
    { key: 'default', label: 'Casual', imageUrl: 'sf-asset://default-latest.png' },
    { key: 'formal', label: 'Formal', imageUrl: 'sf-asset://formal-latest.png' },
    { key: 'battle', label: 'Battle', imageUrl: 'sf-asset://battle-latest.png' },
  ];
  txMock.mockReset();
  txMock.mockImplementation(async (fn: (q: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT * FROM assets') && sql.includes('FOR UPDATE')) {
        return { rows: [assetRow()], rowCount: 1 };
      }
      if (sql.includes('UPDATE assets SET costumes')) {
        state.costumes = params[0] === null
          ? []
          : JSON.parse(String(params[0])) as Array<Record<string, unknown>>;
        return { rows: [assetRow()], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  }));
});

describe('updateAssetCostumesPreservingImages', () => {
  it('preserves the latest locked image pointers while applying metadata edits and deletions', async () => {
    const updated = await updateAssetCostumesPreservingImages('asset-1', 'project-1', [
      { key: 'default', label: 'Daily', imageUrl: 'sf-asset://default-stale.png' },
      { key: 'formal', label: 'Gala', description: 'black suit', imageUrl: null },
      { key: 'custom', label: 'Custom', imageUrl: 'sf-asset://untrusted-client.png' },
    ]);

    expect(updated.costumes).toEqual([
      { key: 'default', label: 'Daily', imageUrl: 'sf-asset://default-latest.png' },
      {
        key: 'formal',
        label: 'Gala',
        description: 'black suit',
        imageUrl: 'sf-asset://formal-latest.png',
      },
      { key: 'custom', label: 'Custom' },
    ]);
    expect(updated.costumes?.some((costume) => costume.key === 'battle')).toBe(false);
  });

  it('uses the top-level default image for legacy default rows without their own pointer', async () => {
    state.costumes = [{ key: 'default', label: 'Casual', imageUrl: null }];

    const updated = await updateAssetCostumesPreservingImages('asset-1', 'project-1', [
      { key: 'default', label: 'Daily' },
    ]);

    expect(updated.costumes).toEqual([
      { key: 'default', label: 'Daily', imageUrl: 'sf-asset://default-latest.png' },
    ]);
  });
});
