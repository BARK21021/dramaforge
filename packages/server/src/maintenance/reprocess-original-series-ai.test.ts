import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handleTaskMock = vi.hoisted(() => vi.fn());
const projectGetByIdMock = vi.hoisted(() => vi.fn());
const readLocalizationProfileMock = vi.hoisted(() => vi.fn());
const queryMock = vi.hoisted(() => vi.fn());
const txMock = vi.hoisted(() => vi.fn());

vi.mock('@server/ai-worker/handlers', () => ({ handleTask: handleTaskMock }));
vi.mock('@server/domain/project', () => ({
  projectRepo: { getById: projectGetByIdMock },
}));
vi.mock('@server/domain/prompt', () => ({
  readLocalizationProfile: readLocalizationProfileMock,
}));
vi.mock('@server/infra', () => ({ query: queryMock, tx: txMock }));

import {
  finalizeExistingValidatedSplit,
  runOriginalSeriesAiReprocessCli,
} from './reprocess-original-series-ai';

const projectId = 'project-finalize';
const sourceText = '这是冻结原稿，必须保持为只读输入。'.repeat(8);
const episodeOne = 'Episode 1\n完整的第一集转风格正文。';
const episodeTwo = 'Episode 2\n完整的第二集转风格正文。';
const styledText = episodeOne + episodeTwo;

function createLockedClient(input?: {
  episodeNumbers?: number[];
  episodeTexts?: string[];
  projectNovelText?: string;
  downstream?: { shots: number; materials: number; storyboards: number };
}) {
  const numbers = input?.episodeNumbers ?? [1, 2];
  const texts = input?.episodeTexts ?? [episodeOne, episodeTwo];
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const q = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('FROM projects')) {
        return {
          rows: [{
            sourceProjectId: 'source-project',
            category: 'OVERSEAS',
            novelText: input?.projectNovelText ?? styledText,
            scriptData: {
              expectedEpisodeCount: 21,
              previousEpisodes: [{ n: 1 }],
              sourceScriptSnapshot: {
                version: 1,
                text: sourceText,
                hash: 'source-hash',
                sourceProjectId: 'source-project',
                expectedEpisodeCount: 21,
              },
              episodeAiRepairHistory: [{ method: 'older-repair' }],
            },
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM episodes')) {
        return {
          rows: numbers.map((episodeNumber, index) => ({
            episodeNumber,
            novelText: texts[index],
          })),
          rowCount: numbers.length,
        };
      }
      if (sql.includes('FROM shots WHERE')) {
        return {
          rows: [input?.downstream ?? { shots: 0, materials: 0, storyboards: 0 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { q, calls };
}

describe('original-series --finalize-existing', () => {
  beforeEach(() => {
    handleTaskMock.mockReset();
    projectGetByIdMock.mockReset();
    readLocalizationProfileMock.mockReset();
    queryMock.mockReset();
    txMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('validates and finalizes an existing exact split without invoking AI or rewriting episodes', async () => {
    const { q, calls } = createLockedClient();
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));
    projectGetByIdMock.mockResolvedValue({
      id: projectId,
      userId: 'user-1',
      title: '海外目标项目',
      category: 'OVERSEAS',
      sourceProjectId: 'source-project',
      novelText: styledText,
      scriptData: {
        sourceScriptSnapshot: { text: sourceText },
        localizationProfile: { stylePrompt: 'English localization' },
      },
    });
    readLocalizationProfileMock.mockReturnValue({ stylePrompt: 'English localization' });
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('asset_image_revisions')) {
        return {
          rows: [{ shots: 0, materials: 0, storyboards: 0, assets: 115, assetImageRevisions: 0 }],
        };
      }
      return { rows: [{ count: 2 }] };
    });
    vi.stubEnv('REPROCESS_PROJECT_IDS', projectId);
    vi.stubEnv('REPROCESS_BACKUP_REF', '/backups/before.dump');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runOriginalSeriesAiReprocessCli(['--finalize-existing']);

    expect(handleTaskMock).not.toHaveBeenCalled();
    expect(calls[0].sql).toContain('FROM projects WHERE id = $1 FOR UPDATE');
    expect(calls[1].sql).toContain('FROM episodes');
    expect(calls[1].sql).toContain('FOR UPDATE');
    expect(calls.some(({ sql }) => /DELETE|UPDATE\s+episodes/iu.test(sql))).toBe(false);
    const update = calls.find(({ sql }) => sql.trimStart().startsWith('UPDATE projects'));
    expect(update?.sql).not.toContain('"novelText"');
    const scriptData = JSON.parse(String(update?.params?.[0])) as Record<string, unknown>;
    expect(scriptData.expectedEpisodeCount).toBeUndefined();
    expect(scriptData.sourceScriptSnapshot).toMatchObject({ text: sourceText });
    expect(scriptData.sourceScriptSnapshot).not.toHaveProperty('expectedEpisodeCount');
    expect(scriptData.episodeAiRepairHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        backupRef: '/backups/before.dump',
        previousEpisodeCount: 1,
        repairedEpisodeCount: 2,
        method: 'finalize-existing-after-validated-split',
      }),
    ]));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"finalizedExisting":true'));
  });

  it('rejects a non-contiguous or non-exact existing split before any update', async () => {
    const gap = createLockedClient({ episodeNumbers: [1, 3] });
    txMock.mockImplementationOnce(
      async (callback: (client: typeof gap.q) => Promise<unknown>) => callback(gap.q),
    );
    await expect(finalizeExistingValidatedSplit({
      projectId,
      backupRef: '/backups/before.dump',
    })).rejects.toThrow('严格连续的 1..N');
    expect(gap.calls.some(({ sql }) => sql.trimStart().startsWith('UPDATE projects'))).toBe(false);

    const mismatch = createLockedClient({ episodeTexts: [episodeOne, '错误的第二集'] });
    txMock.mockImplementationOnce(
      async (callback: (client: typeof mismatch.q) => Promise<unknown>) => callback(mismatch.q),
    );
    await expect(finalizeExistingValidatedSplit({
      projectId,
      backupRef: '/backups/before.dump',
    })).rejects.toThrow('不逐字一致');
    expect(mismatch.calls.some(({ sql }) => sql.trimStart().startsWith('UPDATE projects'))).toBe(false);
  });

  it('requires a backup reference before entering finalize mode', async () => {
    vi.stubEnv('REPROCESS_PROJECT_IDS', projectId);
    vi.stubEnv('REPROCESS_BACKUP_REF', '');

    await expect(runOriginalSeriesAiReprocessCli(['--finalize-existing']))
      .rejects.toThrow('REPROCESS_BACKUP_REF');
    expect(projectGetByIdMock).not.toHaveBeenCalled();
    expect(handleTaskMock).not.toHaveBeenCalled();
    expect(txMock).not.toHaveBeenCalled();
  });
});
