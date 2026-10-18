import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const callAIMock = vi.hoisted(() => vi.fn());
const txMock = vi.hoisted(() => vi.fn());

vi.mock('@server/gateway', () => ({
  callAI: callAIMock,
}));

vi.mock('@server/infra', () => ({
  tx: txMock,
}));

import {
  analyzeScriptEpisodeStructure,
  StaleProjectScriptError,
  splitScriptIntoEpisodes,
  styleAndSplitOriginalSeries,
} from '../../src/domain/episode/split-service';

function hashScript(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

describe('episode split persistence', () => {
  beforeEach(() => {
    callAIMock.mockReset();
    txMock.mockReset();
  });

  it('rejects a stale task before deleting or inserting any episode', async () => {
    const queuedScript = 'queued manuscript '.repeat(8).trim();
    const currentScript = 'newer manuscript '.repeat(8).trim();
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: [{ episodeNumber: 1, title: 'Episode 1', content: queuedScript }],
        }),
      },
      cost: 0.1,
    });

    const statements: string[] = [];
    const q = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM projects')) {
          return {
            rows: [{
              scriptData: {
                sourceScriptSnapshot: {
                  version: 1,
                  text: currentScript,
                  hash: hashScript(currentScript),
                  sourceProjectId: 'source-1',
                },
              },
              novelText: currentScript,
              sourceProjectId: 'source-1',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    await expect(splitScriptIntoEpisodes({
      projectId: 'project-1',
      novelText: queuedScript,
      sourceScriptHash: hashScript(queuedScript),
      userId: 'user-1',
    })).rejects.toBeInstanceOf(StaleProjectScriptError);

    expect(statements.some((sql) => sql.startsWith('DELETE FROM episodes'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('INSERT INTO episodes'))).toBe(false);
  });

  it('checks the source snapshot while atomically committing a different overseas manuscript', async () => {
    const sourceScript = 'original source manuscript '.repeat(8).trim();
    const styledScript = 'localized overseas manuscript '.repeat(8).trim();
    const storedScriptData = {
      sourceMode: 'ORIGINAL_PROJECT',
      sourceScriptSnapshot: {
        version: 1,
        text: sourceScript,
        hash: hashScript(sourceScript),
        sourceProjectId: 'source-1',
      },
      keepMe: true,
    };
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: [{ episodeNumber: 1, title: 'Episode 1', content: styledScript }],
        }),
      },
      cost: 0.2,
    });

    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const q = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('FROM projects')) {
          return {
            rows: [{
              scriptData: storedScriptData,
              novelText: sourceScript,
              sourceProjectId: 'source-1',
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM episodes')) {
          return {
            rows: [{ episodeNumber: 1, title: 'Old episode', novelText: 'old text' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    const result = await splitScriptIntoEpisodes({
      projectId: 'project-1',
      novelText: styledScript,
      sourceScriptText: sourceScript,
      sourceScriptHash: hashScript(sourceScript),
      userId: 'user-1',
      projectCommit: {
        novelText: styledScript,
        scriptData: {
          localizationProfile: { stylePrompt: 'Japanese' },
          wholeSeriesStyle: { completed: true },
        },
      },
    });

    expect(result.episodeCount).toBe(1);
    const projectUpdate = calls.find((call) => call.sql.trimStart().startsWith('UPDATE projects'));
    expect(projectUpdate?.params?.[1]).toBe(styledScript);
    expect(JSON.parse(String(projectUpdate?.params?.[0]))).toEqual({
      ...storedScriptData,
      localizationProfile: { stylePrompt: 'Japanese' },
      wholeSeriesStyle: { completed: true },
      previousEpisodes: [{ n: 1, t: 'Old episode', c: 'old text' }],
    });

    const lockIndex = calls.findIndex((call) => call.sql.includes('FROM projects'));
    const deleteIndex = calls.findIndex((call) => call.sql.startsWith('DELETE FROM episodes'));
    const insertIndex = calls.findIndex((call) => call.sql.startsWith('INSERT INTO episodes'));
    const updateIndex = calls.findIndex((call) => call.sql.trimStart().startsWith('UPDATE projects'));
    expect(lockIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(insertIndex);
    expect(insertIndex).toBeLessThan(updateIndex);
  });

  it('keeps pre-deployment queued tasks without a source hash compatible', async () => {
    const script = 'legacy queued manuscript '.repeat(8).trim();
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: [{ episodeNumber: 1, title: 'Episode 1', content: script }],
        }),
      },
      cost: 0,
    });
    const q = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM projects')) {
          return {
            rows: [{ scriptData: {}, novelText: script, sourceProjectId: null }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    await expect(splitScriptIntoEpisodes({
      projectId: 'project-legacy',
      novelText: script,
      userId: 'user-1',
    })).resolves.toMatchObject({ episodeCount: 1, coverage: 1 });
  });

  it('always asks AI to read explicit source headings and map an overseas manuscript dynamically', async () => {
    const sourceScript = [
      '第1集',
      '第一集原文。',
      '第2集',
      '第二集原文。',
      '第3集',
      '第三集原文。',
    ].join('\n');
    const parts = [
      'Episode 1\nStyled episode one.\n',
      'Episode 2\nStyled episode two.\n',
      'Episode 3\nStyled episode three.',
    ];
    const styledScript = parts.join('');
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: parts.map((content, index) => ({
            episodeNumber: index + 1,
            title: `Episode ${index + 1}`,
            content,
          })),
        }),
      },
      cost: 0.2,
    });
    const inserted: string[] = [];
    const q = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM projects')) {
          return { rows: [{ scriptData: {}, novelText: sourceScript, sourceProjectId: 'source-1' }], rowCount: 1 };
        }
        if (sql.includes('FROM episodes')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('INSERT INTO episodes')) inserted.push(String(params?.[5] ?? ''));
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    const result = await splitScriptIntoEpisodes({
      projectId: 'project-overseas',
      novelText: styledScript,
      sourceScriptText: sourceScript,
      sourceScriptHash: hashScript(sourceScript),
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      episodeCount: 3,
      coverage: 1,
      splitMode: 'ai-heading-anchored',
    });
    expect(callAIMock).toHaveBeenCalledTimes(1);
    const request = callAIMock.mock.calls[0]?.[2] as {
      input?: { messages?: Array<{ content?: string }>; contextWindow?: number };
    };
    const promptText = request.input?.messages?.map((message) => message.content).join('\n') ?? '';
    expect(promptText).toContain(sourceScript);
    expect(promptText).toContain(styledScript);
    expect(promptText).not.toContain('恰好输出 45 集');
    expect(request.input?.contextWindow).toBe(1_048_576);
    expect(inserted.join('')).toBe(styledScript);
  });

  it('retries AI once with the validation failure reason, then persists only the corrected split', async () => {
    const parts = ['第1集\n第一集正文。\n', '第2集\n第二集正文。'];
    const script = parts.join('');
    callAIMock
      .mockResolvedValueOnce({
        meta: {
          content: JSON.stringify({
            episodes: [{ episodeNumber: 1, title: '错误结果', content: `${script}${script}` }],
          }),
        },
        cost: 0.1,
      })
      .mockResolvedValueOnce({
        meta: {
          content: JSON.stringify({
            episodes: parts.map((content, index) => ({
              episodeNumber: index + 1,
              title: `第 ${index + 1} 集`,
              content,
            })),
          }),
        },
        cost: 0.25,
      });
    const inserted: string[] = [];
    const q = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM projects')) {
          return { rows: [{ scriptData: {}, novelText: script, sourceProjectId: null }], rowCount: 1 };
        }
        if (sql.includes('FROM episodes')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('INSERT INTO episodes')) inserted.push(String(params?.[5] ?? ''));
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    const result = await splitScriptIntoEpisodes({
      projectId: 'project-retry',
      novelText: script,
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      episodeCount: 2,
      coverage: 1,
      splitMode: 'ai-heading-anchored',
      cost: 0.35,
    });
    expect(callAIMock).toHaveBeenCalledTimes(2);
    const retryRequest = callAIMock.mock.calls[1]?.[2] as {
      input?: { messages?: Array<{ content?: string }> };
    };
    const retryPrompt = retryRequest.input?.messages?.map((message) => message.content).join('\n') ?? '';
    expect(retryPrompt).toContain('纠错重试');
    expect(retryPrompt).toContain('无损覆盖');
    expect(inserted.join('')).toBe(script);
  });

  it('recovers whitespace-only differences while retaining AI-selected boundaries', async () => {
    const script = 'A \nB\n\nC D';
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: [
            { episodeNumber: 1, title: 'Episode 1', content: 'AB' },
            { episodeNumber: 2, title: 'Episode 2', content: 'CD' },
          ],
        }),
      },
      cost: 0.05,
    });
    const inserted: string[] = [];
    const q = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM projects')) {
          return { rows: [{ scriptData: {}, novelText: script, sourceProjectId: null }], rowCount: 1 };
        }
        if (sql.includes('FROM episodes')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('INSERT INTO episodes')) inserted.push(String(params?.[5] ?? ''));
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    await expect(splitScriptIntoEpisodes({
      projectId: 'project-whitespace',
      novelText: script,
      userId: 'user-1',
    })).resolves.toMatchObject({
      episodeCount: 2,
      coverage: 1,
      splitMode: 'ai-whitespace-repaired',
    });
    expect(callAIMock).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(2);
    expect(inserted.join('')).toBe(script);
  });

  it('rejects after two invalid AI attempts before opening a write transaction', async () => {
    const script = '原始剧本。'.repeat(30);
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: [{ episodeNumber: 1, content: `${script}${script}` }],
        }),
      },
      cost: 0,
    });

    await expect(splitScriptIntoEpisodes({
      projectId: 'project-unknown-count',
      novelText: script,
      userId: 'user-1',
    })).rejects.toThrow('两次 AI 分集均未通过');
    expect(callAIMock).toHaveBeenCalledTimes(2);
    expect(txMock).not.toHaveBeenCalled();
  });

  it('lets AI derive a dynamic source structure losslessly without opening a transaction', async () => {
    const parts = ['第1集\n长短不同的第一集正文。\n', '第2集\n第二集。'];
    const script = parts.join('');
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: parts.map((content, index) => ({
            episodeNumber: index + 1,
            title: `第 ${index + 1} 集`,
            content,
          })),
        }),
      },
      cost: 0.12,
    });

    const analysis = await analyzeScriptEpisodeStructure({
      novelText: script,
      userId: 'user-1',
    });

    expect(analysis.episodeCount).toBe(2);
    expect(analysis.drafts.map((draft) => draft.content).join('')).toBe(script);
    expect(analysis.cost).toBe(0.12);
    expect(txMock).not.toHaveBeenCalled();
  });

  it('rejects two AI results that disagree with the current-source AI count before any write', async () => {
    const script = '第1集\n第一集正文。';
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: [{ episodeNumber: 1, title: '第 1 集', content: script }],
        }),
      },
      cost: 0,
    });

    await expect(splitScriptIntoEpisodes({
      projectId: 'project-count-contract',
      novelText: script,
      requiredAiEpisodeCount: 2,
      userId: 'user-1',
    })).rejects.toThrow('本次原文 AI 结构分析不一致');
    expect(callAIMock).toHaveBeenCalledTimes(2);
    expect(txMock).not.toHaveBeenCalled();
  });

  it('rejects a linked-original write without a frozen source hash before deleting episodes', async () => {
    const script = '第1集\n第一集正文。';
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: [{ episodeNumber: 1, title: '第 1 集', content: script }],
        }),
      },
      cost: 0,
    });
    const statements: string[] = [];
    const q = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM projects')) {
          return {
            rows: [{ scriptData: {}, novelText: script, sourceProjectId: 'source-1' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    await expect(splitScriptIntoEpisodes({
      projectId: 'project-linked-no-hash',
      novelText: script,
      userId: 'user-1',
    })).rejects.toBeInstanceOf(StaleProjectScriptError);
    expect(statements.some((sql) => sql.startsWith('DELETE FROM episodes'))).toBe(false);
  });

  it('refuses replacement under the project lock when downstream work exists', async () => {
    const script = '第1集\n第一集正文。';
    callAIMock.mockResolvedValue({
      meta: {
        content: JSON.stringify({
          episodes: [{ episodeNumber: 1, title: '第 1 集', content: script }],
        }),
      },
      cost: 0,
    });
    const statements: string[] = [];
    const q = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM projects')) {
          return {
            rows: [{ scriptData: {}, novelText: script, sourceProjectId: null }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM shots WHERE')) {
          return { rows: [{ shots: 1, materials: 2, storyboards: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    await expect(splitScriptIntoEpisodes({
      projectId: 'project-with-downstream',
      novelText: script,
      userId: 'user-1',
    })).rejects.toThrow('为防止级联删除已拒绝重新拆集');
    expect(statements.some((sql) => sql.startsWith('DELETE FROM episodes'))).toBe(false);
  });

  it('styles and dynamically splits 45 source units in one normal AI call without reading stale count metadata', async () => {
    const sourceParts = Array.from({ length: 45 }, (_, index) => {
      const number = index + 1;
      // Deliberately repeat the 第12集 heading once; the following body keeps each anchor unique.
      const heading = number === 13 ? '第12集' : `第${number}集`;
      return `${heading}\n单元${number}独有的边界正文：${`甲${number}乙丙丁戊己庚辛壬癸。`.repeat(8)}\n`;
    });
    const sourceScript = sourceParts.join('');
    const styledParts = sourceParts.map((_, index) => (
      `Episode ${index + 1}\n${`Localized complete unit ${index + 1}. `.repeat(5)}\n`
    ));
    callAIMock.mockResolvedValueOnce({
      meta: {
        content: JSON.stringify({
          detectedEpisodeCount: 45,
          episodes: sourceParts.map((sourcePart, index) => ({
            episodeNumber: index + 1,
            title: `Episode ${index + 1}`,
            content: styledParts[index],
            emotionArc: 'setup→progression→hook',
          })),
          characterNameMapping: [{ oldName: '季舒语', newName: 'EVELYN VANCE' }],
        }),
      },
      cost: 0.6,
    });

    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const inserted: string[] = [];
    const q = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('FROM projects')) {
          return {
            rows: [{
              scriptData: { expectedEpisodeCount: 70, keepMe: true },
              novelText: sourceScript,
              sourceProjectId: 'source-project',
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM episodes')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('INSERT INTO episodes')) inserted.push(String(params?.[5] ?? ''));
        return { rows: [], rowCount: 0 };
      }),
    };
    txMock.mockImplementation(async (callback: (client: typeof q) => Promise<unknown>) => callback(q));

    const result = await styleAndSplitOriginalSeries({
      projectId: 'project-overseas-45',
      sourceScriptText: sourceScript,
      sourceScriptHash: hashScript(sourceScript),
      stylePrompt: '英语 / 英语文化圈：英美加澳新等，按描述定位具体国家',
      userId: 'user-1',
      modelId: 'deepseek/deepseek-v4-pro',
      projectCommit: {
        scriptData: {
          wholeSeriesStyle: { completed: true },
        },
      },
    });

    expect(callAIMock).toHaveBeenCalledTimes(1);
    const request = callAIMock.mock.calls[0]?.[2] as {
      input?: { messages?: Array<{ content?: string }>; contextWindow?: number; maxTokens?: number };
    };
    const promptText = request.input?.messages?.map((message) => message.content).join('\n') ?? '';
    expect(promptText).toContain(sourceScript);
    expect(promptText).not.toContain('sourceStartAnchor');
    expect(promptText).not.toContain('sourceContent');
    expect(promptText).not.toContain('70');
    expect(promptText).not.toContain('expectedEpisodeCount');
    expect(request.input?.contextWindow).toBe(1_048_576);
    expect(request.input?.maxTokens).toBe(393_216);
    // split-service 现在为整剧文本注入 === EP{n} {title} === 集标记（供整剧资产提取按集标注变体）。
    const markedStyled = sourceParts.map((_, index) => (
      `=== EP${index + 1} Episode ${index + 1} ===\n${styledParts[index]}`
    )).join('\n\n');
    expect(result).toMatchObject({
      episodeCount: 45,
      coverage: 1,
      splitMode: 'ai-verbatim',
      cost: 0.6,
      styledNovelText: markedStyled,
      characterAliasMap: new Map([['季舒语', 'EVELYN VANCE']]),
    });
    expect(inserted).toHaveLength(45);
    expect(inserted.join('')).toBe(styledParts.join(''));
    const projectUpdate = calls.find((call) => call.sql.trimStart().startsWith('UPDATE projects'));
    expect(projectUpdate?.params?.[1]).toBe(markedStyled);
  });

  it.each([
    ['不是 JSON', 'not-json'],
    ['空 episodes', JSON.stringify({ detectedEpisodeCount: 0, episodes: [] })],
    ['编号不连续', JSON.stringify({ detectedEpisodeCount: 2, episodes: [
      { episodeNumber: 1, title: 'Episode 1', content: '完整正文一' },
      { episodeNumber: 3, title: 'Episode 3', content: '完整正文三' },
    ] })],
    ['正文为空', JSON.stringify({ detectedEpisodeCount: 1, episodes: [
      { episodeNumber: 1, title: 'Episode 1', content: '   ' },
    ] })],
    ['总数不一致', JSON.stringify({ detectedEpisodeCount: 2, episodes: [
      { episodeNumber: 1, title: 'Episode 1', content: '完整正文一' },
    ] })],
  ])('对%s只纠错一次，仍不合格则不写数据库', async (_label, content) => {
    const source = `第1集\n${'完整冻结原文。'.repeat(20)}`;
    callAIMock.mockResolvedValue({ meta: { content }, cost: 0.1 });

    await expect(styleAndSplitOriginalSeries({
      projectId: 'project-invalid-json',
      sourceScriptText: source,
      sourceScriptHash: hashScript(source),
      stylePrompt: 'English localization',
      userId: 'user-1',
    })).rejects.toThrow('两次 AI 整剧转风格与动态分集均未通过校验');

    expect(callAIMock).toHaveBeenCalledTimes(2);
    const retryRequest = callAIMock.mock.calls[1]?.[2] as {
      input?: { messages?: Array<{ content?: string }> };
    };
    const retryPrompt = retryRequest.input?.messages?.map((message) => message.content).join('\n') ?? '';
    expect(retryPrompt).toContain('纠错重试');
    expect(retryPrompt).toContain('不要复抄原文');
    expect(retryPrompt).not.toContain('sourceStartAnchor');
    expect(txMock).not.toHaveBeenCalled();
  });
});
