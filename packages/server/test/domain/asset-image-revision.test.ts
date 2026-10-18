import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  nextId: 0,
  assetExists: true,
  currentImageUrl: null as string | null,
  costumes: [
    { key: 'default', imageUrl: null },
    { key: 'casual', imageUrl: null },
    { key: 'formal', imageUrl: null },
  ] as Array<Record<string, unknown>>,
  revisions: [] as Array<Record<string, unknown>>,
}));

const queryMock = vi.hoisted(() => vi.fn());
const txMock = vi.hoisted(() => vi.fn());

vi.mock('@shared/utils', () => ({ genId: () => `revision-${++state.nextId}` }));
vi.mock('@server/infra', () => ({ query: queryMock, tx: txMock }));

import {
  activateAssetImageRevision,
  beginAssetImageRevision,
  commitAssetImageRevision,
  markAssetImageRevisionFailed,
  markAssetImageRevisionGenerated,
} from '../../src/domain/asset/image-revision';

function makeDatabaseQuery() {
  return async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT id') && sql.includes('FROM assets')) {
      return {
        rows: state.assetExists ? [{ id: 'asset-1', costumes: state.costumes.map((item) => ({ ...item })) }] : [],
        rowCount: state.assetExists ? 1 : 0,
      };
    }
    if (sql.includes('COALESCE(MAX("generationOrdinal")')) {
      const max = state.revisions.reduce((value, row) => Math.max(value, Number(row.generationOrdinal)), 0);
      return { rows: [{ next: max + 1 }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO asset_image_revisions')) {
      const isBegin = sql.includes("'GENERATING'");
      const row = {
        id: String(params[0]),
        assetId: String(params[1]),
        projectId: String(params[2]),
        generationOrdinal: Number(params[3]),
        costumeKey: String(params[4]),
        status: isBegin ? 'GENERATING' : 'GENERATED',
        source: isBegin ? 'AI' : String(params[5]),
        modelName: isBegin ? String(params[5]) : null,
        prompt: isBegin ? String(params[6]) : null,
        providerUrl: null,
        localUrl: null,
        error: null,
        createdAt: new Date('2026-07-21T00:00:00.000Z'),
        committedAt: null,
      };
      state.revisions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("SET status = 'GENERATED'")) {
      // markAssetImageRevisionGenerated — CAS: 只有 GENERATING 才翻 GENERATED。
      const [providerUrl, revisionId] = params;
      const row = state.revisions.find((item) => item.id === revisionId && item.status === 'GENERATING');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'GENERATED';
      row.providerUrl = String(providerUrl);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'FAILED'")) {
      // markAssetImageRevisionFailed — 生产实现无 CAS（与 GENERATING 竞态由 processor 收口）。
      const [error, revisionId] = params;
      const row = state.revisions.find((item) => item.id === revisionId);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'FAILED';
      row.error = String(error);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'COMMITTED'")) {
      const [localUrl, revisionId, assetId, projectId, requestedCostumeKey] = params;
      const row = state.revisions.find(
        (item) => item.id === revisionId && item.assetId === assetId && item.projectId === projectId,
      );
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, {
        status: 'COMMITTED',
        localUrl,
        committedAt: new Date('2026-07-21T00:01:00.000Z'),
        ...(row.costumeKey === 'default' && requestedCostumeKey !== 'default'
          ? { costumeKey: requestedCostumeKey }
          : {}),
      });
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM asset_image_revisions')) {
      const [revisionId, assetId, projectId] = params;
      const row = state.revisions.find(
        (item) => item.id === revisionId
          && item.assetId === assetId
          && item.projectId === projectId
          && item.status === 'COMMITTED'
          && item.localUrl,
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('"generationOrdinal" > $2')) {
      const [assetId, ordinal] = params;
      const hasNewer = state.revisions.some(
        (row) => row.assetId === assetId
          && row.costumeKey === 'default'
          && row.status === 'COMMITTED'
          && Number(row.generationOrdinal) > Number(ordinal),
      );
      return { rows: hasNewer ? [{ one: 1 }] : [], rowCount: hasNewer ? 1 : 0 };
    }
    if (sql.includes('UPDATE assets SET "imageUrl"')) {
      state.currentImageUrl = String(params[0]);
      if (sql.includes('costumes =')) {
        state.costumes = JSON.parse(String(params[1])) as Array<Record<string, unknown>>;
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE assets SET costumes')) {
      state.costumes = JSON.parse(String(params[0])) as Array<Record<string, unknown>>;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

beforeEach(() => {
  state.nextId = 0;
  state.assetExists = true;
  state.currentImageUrl = null;
  state.costumes = [
    { key: 'default', imageUrl: null },
    { key: 'casual', imageUrl: null },
    { key: 'formal', imageUrl: null },
  ];
  state.revisions.length = 0;
  const dbQuery = makeDatabaseQuery();
  txMock.mockReset();
  txMock.mockImplementation(async (fn: (q: { query: typeof dbQuery }) => Promise<unknown>) => fn({ query: dbQuery }));
  queryMock.mockReset();
  // markGenerated / markFailed 走顶层 query()（非 tx），将其接到同一份 dbQuery 以便覆盖。
  queryMock.mockImplementation(dbQuery);
});

describe('asset image revisions', () => {
  it('keeps four sequential regenerations and advances the current image without overwriting history', async () => {
    for (let index = 1; index <= 4; index += 1) {
      const revision = await beginAssetImageRevision({
        assetId: 'asset-1',
        projectId: 'project-1',
        modelName: 'ark/seedream',
        prompt: `prompt-${index}`,
      });
      const committed = await commitAssetImageRevision({
        assetId: 'asset-1',
        projectId: 'project-1',
        revisionId: revision.id,
        localUrl: `sf-asset://image-${index}.png`,
      });
      expect(revision.generationOrdinal).toBe(index);
      expect(committed.becameCurrent).toBe(true);
    }

    expect(state.revisions).toHaveLength(4);
    expect(state.revisions.map((row) => row.localUrl)).toEqual([
      'sf-asset://image-1.png',
      'sf-asset://image-2.png',
      'sf-asset://image-3.png',
      'sf-asset://image-4.png',
    ]);
    expect(state.currentImageUrl).toBe('sf-asset://image-4.png');
    expect(state.costumes.find((item) => item.key === 'default')?.imageUrl)
      .toBe('sf-asset://image-4.png');
  });

  it('does not let an older slow request roll the current image back after a newer request commits', async () => {
    const older = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'older',
    });
    const newer = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'newer',
    });
    const newCommit = await commitAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', revisionId: newer.id, localUrl: 'sf-asset://newer.png',
    });
    const oldCommit = await commitAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', revisionId: older.id, localUrl: 'sf-asset://older.png',
    });

    expect(newCommit.becameCurrent).toBe(true);
    expect(oldCommit.becameCurrent).toBe(false);
    expect(state.currentImageUrl).toBe('sf-asset://newer.png');
    expect(state.revisions).toHaveLength(2);
  });

  it('updates one costume under the asset row lock without erasing another costume image', async () => {
    await commitAssetImageRevision({
      assetId: 'asset-1',
      projectId: 'project-1',
      localUrl: 'sf-asset://casual.png',
      costumeKey: 'casual',
      activateCurrent: false,
    });
    await commitAssetImageRevision({
      assetId: 'asset-1',
      projectId: 'project-1',
      localUrl: 'sf-asset://formal.png',
      costumeKey: 'formal',
      activateCurrent: false,
    });

    // 第二次提交基于锁内最新 JSON，不能把第一次提交的 casual 图片覆盖回 null。
    expect(state.costumes.find((item) => item.key === 'casual')?.imageUrl)
      .toBe('sf-asset://casual.png');
    expect(state.costumes.find((item) => item.key === 'formal')?.imageUrl)
      .toBe('sf-asset://formal.png');
    expect(state.currentImageUrl).toBeNull();
  });

  it('persists costume identity on the revision and restores it without trusting transient UI state', async () => {
    const revision = await beginAssetImageRevision({
      assetId: 'asset-1',
      projectId: 'project-1',
      modelName: 'ark/seedream',
      prompt: 'casual variant',
      costumeKey: 'casual',
    } as Parameters<typeof beginAssetImageRevision>[0] & { costumeKey: string });

    await commitAssetImageRevision({
      assetId: 'asset-1',
      projectId: 'project-1',
      revisionId: revision.id,
      localUrl: 'sf-asset://casual-restored.png',
    });

    expect((revision as unknown as { costumeKey?: string }).costumeKey).toBe('casual');
    expect(state.costumes.find((item) => item.key === 'casual')?.imageUrl)
      .toBe('sf-asset://casual-restored.png');
    expect(state.currentImageUrl).toBeNull();
  });

  it('does not let a newer costume revision block the latest default image', async () => {
    const defaultRevision = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'default',
    });
    const variantRevision = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'formal', costumeKey: 'formal',
    } as Parameters<typeof beginAssetImageRevision>[0] & { costumeKey: string });

    await commitAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', revisionId: variantRevision.id,
      localUrl: 'sf-asset://formal-newer.png',
    });
    const committedDefault = await commitAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', revisionId: defaultRevision.id,
      localUrl: 'sf-asset://default-older.png',
    });

    expect(committedDefault.becameCurrent).toBe(true);
    expect(state.currentImageUrl).toBe('sf-asset://default-older.png');
  });

  it('activates a costume history entry back into that costume instead of the main image', async () => {
    const revision = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'formal', costumeKey: 'formal',
    } as Parameters<typeof beginAssetImageRevision>[0] & { costumeKey: string });
    await commitAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', revisionId: revision.id,
      localUrl: 'sf-asset://formal-history.png',
    });
    state.costumes = state.costumes.map((item) => item.key === 'formal' ? { ...item, imageUrl: null } : item);

    await activateAssetImageRevision({
      projectId: 'project-1', assetId: 'asset-1', revisionId: revision.id,
    });

    expect(state.costumes.find((item) => item.key === 'formal')?.imageUrl)
      .toBe('sf-asset://formal-history.png');
    expect(state.currentImageUrl).toBeNull();
  });

  it('activates a default history entry into both default image pointers', async () => {
    const revision = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'default',
    });
    await commitAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', revisionId: revision.id,
      localUrl: 'sf-asset://default-history.png',
    });
    state.currentImageUrl = null;
    state.costumes = state.costumes.map((item) => item.key === 'default' ? { ...item, imageUrl: null } : item);

    await activateAssetImageRevision({
      projectId: 'project-1', assetId: 'asset-1', revisionId: revision.id,
    });

    expect(state.currentImageUrl).toBe('sf-asset://default-history.png');
    expect(state.costumes.find((item) => item.key === 'default')?.imageUrl)
      .toBe('sf-asset://default-history.png');
  });

  it('refuses to commit a revision when the asset no longer exists', async () => {
    state.assetExists = false;
    await expect(commitAssetImageRevision({
      assetId: 'missing', projectId: 'project-1', localUrl: 'sf-asset://x.png',
    })).rejects.toThrow('资产不存在');
  });
});

// P0-4 CAS：ASSET_IMAGE_GENERATE 超时后 revision 状态一致性
describe('markAssetImageRevisionGenerated — CAS guard', () => {
  it('flips a GENERATING revision to GENERATED and reports the update applied', async () => {
    const revision = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'p',
    });

    const applied = await markAssetImageRevisionGenerated(revision.id, 'https://ark/asset.png');

    expect(applied).toBe(true);
    expect(state.revisions[0].status).toBe('GENERATED');
    expect(state.revisions[0].providerUrl).toBe('https://ark/asset.png');
  });

  it('refuses to revive a FAILED revision when late callAI completion races the timeout markFailed', async () => {
    const revision = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'p',
    });
    // processor withTimeout 先触发 → markFailed 把 revision 置为 FAILED
    await markAssetImageRevisionFailed(revision.id, '生成超时');
    // 底层 callAI 不会被真正中断，迟到完成时 handler 回写 GENERATED —— 必须被 CAS 拒绝
    const applied = await markAssetImageRevisionGenerated(revision.id, 'https://ark/late.png');

    expect(applied).toBe(false);
    expect(state.revisions[0].status).toBe('FAILED');
    expect(state.revisions[0].providerUrl).toBeNull();
    expect(state.revisions[0].error).toBe('生成超时');
  });

  it('does not overwrite a COMMITTED revision with a late GENERATED write', async () => {
    const revision = await beginAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', modelName: 'ark/seedream', prompt: 'p',
    });
    await markAssetImageRevisionGenerated(revision.id, 'https://ark/first.png');
    await commitAssetImageRevision({
      assetId: 'asset-1', projectId: 'project-1', revisionId: revision.id, localUrl: 'sf-asset://committed.png',
    });

    const applied = await markAssetImageRevisionGenerated(revision.id, 'https://ark/late.png');

    expect(applied).toBe(false);
    expect(state.revisions[0].status).toBe('COMMITTED');
    expect(state.revisions[0].localUrl).toBe('sf-asset://committed.png');
  });
});
