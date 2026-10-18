import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@server/infra', () => ({ query: queryMock }));

import { updateShotMaterial } from '../../src/ai-worker/task-repo';

beforeEach(() => {
  queryMock.mockReset();
});

describe('updateShotMaterial 视频代次历史保留（重生不覆盖老视频）', () => {
  it('重生时把旧 currentMaterialUrl 记进 videoGenerations，新代在前（时间倒序）', async () => {
    // 旧状态：currentMaterialUrl=OLD，已有 1 条历史
    queryMock.mockImplementationOnce(async () => ({
      rows: [{
        currentMaterialUrl: 'sf-asset://old.mp4',
        metadata: {
          materialUpdatedAt: '2026-08-01T03:00:00.000Z',
          videoGenerations: [{ url: 'sf-asset://ancient.mp4', generatedAt: '2026-07-30T01:00:00.000Z' }],
        },
      }],
    }));
    let captured: { sql: string; params: unknown[] } | null = null;
    queryMock.mockImplementationOnce(async (sql: string, params: unknown[]) => {
      captured = { sql, params };
      return { rows: [], rowCount: 0 };
    });

    await updateShotMaterial('shot-1', 'sf-asset://new.mp4', 'COMPLETED');

    // currentMaterialUrl = 新的
    expect(captured!.params[0]).toBe('sf-asset://new.mp4');
    // videoGenerations：新 → 旧(被覆盖) → 历史，去重，时间倒序
    const gens = JSON.parse(String(captured!.params[4])) as Array<{ url: string }>;
    expect(gens.map((g) => g.url)).toEqual([
      'sf-asset://new.mp4',
      'sf-asset://old.mp4',
      'sf-asset://ancient.mp4',
    ]);
    // 新代时间戳 ≈ now
    expect(gens[0].generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('旧 URL 重复出现时去重（不堆重复代次）', async () => {
    queryMock.mockImplementationOnce(async () => ({
      rows: [{
        currentMaterialUrl: 'sf-asset://old.mp4',
        metadata: {
          videoGenerations: [
            { url: 'sf-asset://old.mp4', generatedAt: '2026-08-01T00:00:00.000Z' },
            { url: 'sf-asset://older.mp4', generatedAt: '2026-07-01T00:00:00.000Z' },
          ],
        },
      }],
    }));
    let captured: { params: unknown[] } | null = null;
    queryMock.mockImplementationOnce(async (_sql: string, params: unknown[]) => {
      captured = { params };
      return { rows: [], rowCount: 0 };
    });

    await updateShotMaterial('shot-1', 'sf-asset://new.mp4', 'COMPLETED');

    const gens = JSON.parse(String(captured!.params[4])) as Array<{ url: string }>;
    expect(gens.map((g) => g.url)).toEqual([
      'sf-asset://new.mp4',
      'sf-asset://old.mp4',
      'sf-asset://older.mp4',
    ]);
  });

  it('首次生成（无旧 URL）也正常：只记本次', async () => {
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ currentMaterialUrl: null, metadata: {} }],
    }));
    let captured: { params: unknown[] } | null = null;
    queryMock.mockImplementationOnce(async (_sql: string, params: unknown[]) => {
      captured = { params };
      return { rows: [], rowCount: 0 };
    });

    await updateShotMaterial('shot-1', 'sf-asset://first.mp4', 'COMPLETED');

    const gens = JSON.parse(String(captured!.params[4])) as Array<{ url: string }>;
    expect(gens.map((g) => g.url)).toEqual(['sf-asset://first.mp4']);
  });
});
