// ============================================================
// ⑥ server/ai-worker/handlers — 产品范围任务单测
// ============================================================
//
// 覆盖：
//   - TEXT（8 种）：统一走 text_generation，验证 callAI 入参与 output 结构
//   - IMAGE_GENERATE / ASSET_IMAGE_GENERATE：callAI image_generation + 下载持久化
//   - VIDEO_GENERATE：callAI video_generation + 下载持久化 + shot 回写
//   - VOICE_GENERATE：callAI tts
//   - 不支持的 taskType 抛错
//   - 缺 model/prompt/text 等校验抛错
//
// mock：
//   - @server/gateway callAI：返回构造的 GatewayResult
//   - @server/domain getStorage / updateAsset：spy 上传/更新
//   - @server/infra query：spy task-repo 的 shot 回写
//   - global fetch：spy 图片/视频下载
//   - @shared/utils genId：固定 ID
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- mock 依赖 ----

const callAIMock = vi.fn();
const storageUploadMock = vi.fn();
const updateAssetMock = vi.fn();
const markAssetImageRevisionGeneratedMock = vi.fn();
const markAssetImageRevisionFailedMock = vi.fn();
const queryMock = vi.fn();
const splitScriptIntoEpisodesMock = vi.fn();
const styleAndSplitOriginalSeriesMock = vi.fn();
const extractWholeScriptAssetsMock = vi.fn();
const projectUpdateMock = vi.fn();
const updateCharacterMappingMock = vi.fn();

vi.mock('@server/gateway', () => ({
  callAI: (...args: unknown[]) => callAIMock(...args),
}));

vi.mock('@server/domain', () => ({
  getStorage: () => ({ upload: storageUploadMock }),
  updateAsset: (...args: unknown[]) => updateAssetMock(...args),
  markAssetImageRevisionGenerated: (...args: unknown[]) => markAssetImageRevisionGeneratedMock(...args),
  markAssetImageRevisionFailed: (...args: unknown[]) => markAssetImageRevisionFailedMock(...args),
}));

vi.mock('@server/domain/episode', () => ({
  splitScriptIntoEpisodes: (...args: unknown[]) => splitScriptIntoEpisodesMock(...args),
  styleAndSplitOriginalSeries: (...args: unknown[]) => styleAndSplitOriginalSeriesMock(...args),
}));

vi.mock('@server/domain/asset', () => ({
  extractWholeScriptAssets: (...args: unknown[]) => extractWholeScriptAssetsMock(...args),
}));

vi.mock('@server/domain/project', () => ({
  projectRepo: {
    update: (...args: unknown[]) => projectUpdateMock(...args),
  },
  updateCharacterMappingRoleIdentityByAliasMap: (...args: unknown[]) =>
    updateCharacterMappingMock(...args),
}));

vi.mock('@server/infra', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

vi.mock('@shared/utils', () => ({
  genId: () => 'test-uuid-1234',
}));

import { handleTask, startProgressHeartbeat } from '../../src/ai-worker/handlers';
import type { AiTaskType } from '../../src/ai-worker/types';
import { SEEDANCE_MOTION_CALIBRATION } from '../../src/domain/prompt/seedance-helpers';

beforeEach(() => {
  callAIMock.mockReset();
  storageUploadMock.mockReset();
  updateAssetMock.mockReset();
  markAssetImageRevisionGeneratedMock.mockReset();
  markAssetImageRevisionFailedMock.mockReset();
  queryMock.mockReset();
  splitScriptIntoEpisodesMock.mockReset();
  styleAndSplitOriginalSeriesMock.mockReset();
  extractWholeScriptAssetsMock.mockReset();
  projectUpdateMock.mockReset();
  updateCharacterMappingMock.mockReset();
  callAIMock.mockResolvedValue({ url: '', meta: {} });
  storageUploadMock.mockResolvedValue({ key: 'k', url: 'https://minio/uploaded.png', size: 100, mimeType: 'image/png' });
  updateAssetMock.mockResolvedValue({});
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  styleAndSplitOriginalSeriesMock.mockResolvedValue({
    episodeCount: 2,
    episodeIds: ['episode-1', 'episode-2'],
    coverage: 1,
    splitMode: 'ai-verbatim',
    cost: 0.3,
    styledNovelText: 'localized manuscript',
    characterAliasMap: new Map([['季舒语', 'EVELYN VANCE']]),
  });
  splitScriptIntoEpisodesMock.mockResolvedValue({ episodeCount: 2, coverage: { exact: true }, cost: 0.12 });
  extractWholeScriptAssetsMock.mockResolvedValue({ created: 3, totalDetected: 3, cost: 0.08 });
  projectUpdateMock.mockResolvedValue({});
  updateCharacterMappingMock.mockResolvedValue(0);
});

// ============================================================
// TEXT 任务（8 种统一走 text_generation）
// ============================================================

describe('handleTask — TEXT tasks', () => {
  const textTypes: AiTaskType[] = [
    'STORY_ANALYZE',
    'SCRIPT_CONVERT',
    'CHARACTER_PROFILE',
    'SHOT_AI',
    'STORY_EXPAND',
    'LLM_CHAT',
    'LLM_STREAM',
  ];

  for (const taskType of textTypes) {
    it(`${taskType} calls callAI with text_generation capability`, async () => {
      callAIMock.mockResolvedValueOnce({
        url: '',
        meta: { content: '生成的文本', tokensUsed: { input: 10, output: 20 } },
      });

      const result = await handleTask(
        taskType,
        { model: 'deepseek/deepseek-v4', messages: [{ role: 'user', content: 'hi' }] },
        'u1',
        't1',
      );

      expect(callAIMock).toHaveBeenCalledTimes(1);
      const [provider, model, payload] = callAIMock.mock.calls[0];
      expect(provider).toBe('deepseek');
      expect(model).toBe('deepseek/deepseek-v4');
      expect(payload).toMatchObject({
        capability: 'text_generation',
        userId: 'u1',
      });
      expect(payload.input).toMatchObject({
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.output).toEqual({
        content: '生成的文本',
        tokensUsed: { input: 10, output: 20 },
      });
      expect(result.modelProvider).toBe('deepseek');
      expect(result.modelName).toBe('deepseek/deepseek-v4');
    });
  }

  it('EPISODE_SPLIT atomically splits episodes before extracting shared assets', async () => {
    const novelText = '这是用于测试原创整剧拆分的完整文本。'.repeat(8);
    const result = await handleTask(
      'EPISODE_SPLIT',
      {
        projectId: 'project-1',
        novelText,
        modelId: 'deepseek/deepseek-v4-pro',
        category: 'DOMESTIC',
        sourceScriptHash: 'domestic-source-hash',
      },
      'u1',
      't1',
    );

    expect(splitScriptIntoEpisodesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        novelText,
        sourceScriptHash: 'domestic-source-hash',
        userId: 'u1',
        modelId: 'deepseek/deepseek-v4-pro',
      }),
    );
    expect(extractWholeScriptAssetsMock).toHaveBeenCalledWith(
      'project-1',
      novelText,
      'u1',
      'DOMESTIC',
      undefined,
      undefined,
    );
    expect(splitScriptIntoEpisodesMock.mock.invocationCallOrder[0]).toBeLessThan(
      extractWholeScriptAssetsMock.mock.invocationCallOrder[0]!,
    );
    expect(result.output).toMatchObject({
      episodeCount: 2,
      assetExtraction: { created: 3, totalDetected: 3 },
    });
    expect(result.cost).toBeCloseTo(0.2);
  });

  it('styles and dynamically splits an OVERSEAS original series in one service pass before assets', async () => {
    const sourceText = [
      '第1集',
      '这是第一段原创正文，必须先做整剧级海外本地化。'.repeat(4),
      '第2集',
      '这是第二段原创正文，边界必须来自原文。'.repeat(4),
    ].join('\n');
    const styledText = [
      '第1集',
      '场景列表',
      '这是完成海外本地化后的第一集正文。'.repeat(4),
      '第2集',
      '场景列表',
      '这是完成海外本地化后的第二集正文。'.repeat(4),
    ].join('\n');
    styleAndSplitOriginalSeriesMock.mockResolvedValueOnce({
      episodeCount: 2,
      episodeIds: ['episode-1', 'episode-2'],
      coverage: 1,
      splitMode: 'ai-verbatim',
      cost: 0.3,
      styledNovelText: styledText,
      characterAliasMap: new Map([['季舒语', 'EVELYN VANCE']]),
    });

    const result = await handleTask(
      'EPISODE_SPLIT',
      {
        projectId: 'project-overseas',
        novelText: sourceText,
        modelId: 'deepseek/deepseek-v4-pro',
        category: 'OVERSEAS',
        stylePrompt: '日语 / 日本文化与社会习俗 / 亚洲',
        sourceScriptHash: 'overseas-source-hash',
      },
      'u1',
      't-overseas',
    );

    expect(callAIMock).not.toHaveBeenCalled();
    expect(styleAndSplitOriginalSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-overseas',
        sourceScriptText: sourceText,
        sourceScriptHash: 'overseas-source-hash',
        stylePrompt: '日语 / 日本文化与社会习俗 / 亚洲',
        userId: 'u1',
        projectCommit: {
          scriptData: expect.objectContaining({
            localizationProfile: expect.any(Object),
            wholeSeriesStyle: expect.objectContaining({ completed: true }),
          }),
        },
      }),
    );
    expect(projectUpdateMock).not.toHaveBeenCalled();
    expect(extractWholeScriptAssetsMock).toHaveBeenCalledWith(
      'project-overseas',
      styledText,
      'u1',
      'OVERSEAS',
      undefined,
      expect.any(Object),
    );
    expect(splitScriptIntoEpisodesMock).not.toHaveBeenCalled();
    expect(styleAndSplitOriginalSeriesMock.mock.invocationCallOrder[0]).toBeLessThan(
      extractWholeScriptAssetsMock.mock.invocationCallOrder[0]!,
    );
    expect(updateCharacterMappingMock).toHaveBeenCalledWith(
      'project-overseas',
      new Map([['季舒语', 'EVELYN VANCE']]),
    );
    expect(result.output).toMatchObject({
      episodeCount: 2,
      wholeSeriesStyled: true,
      sourceStructureEpisodeCount: 2,
      assetExtraction: { created: 3, totalDetected: 3 },
    });
    expect(result.cost).toBeCloseTo(0.38);
  });

  it('keeps a committed OVERSEAS style/split successful when asset extraction fails', async () => {
    const sourceText = '第1集\n这是足够长的完整原创剧本正文。'.repeat(5);
    const styledText = '第1集\n这是已完成海外本地化的完整正文。'.repeat(5);
    styleAndSplitOriginalSeriesMock.mockResolvedValueOnce({
      episodeCount: 1,
      episodeIds: ['episode-1'],
      coverage: 1,
      splitMode: 'ai-verbatim',
      cost: 0.3,
      styledNovelText: styledText,
      characterAliasMap: new Map(),
    });
    extractWholeScriptAssetsMock.mockRejectedValueOnce(new Error('asset provider timeout'));

    const result = await handleTask('EPISODE_SPLIT', {
      projectId: 'project-overseas',
      novelText: sourceText,
      modelId: 'deepseek/deepseek-v4-pro',
      category: 'OVERSEAS',
      stylePrompt: '日语 / 日本文化与社会习俗 / 亚洲',
      sourceScriptHash: 'overseas-source-hash',
    }, 'u1', 't-overseas');

    expect(result.output).toMatchObject({
      episodeCount: 1,
      wholeSeriesStyled: true,
      assetExtraction: null,
      warnings: [expect.objectContaining({
        code: 'ASSET_EXTRACTION_FAILED',
        message: '整剧与分集已保存，但自动资产提取暂未完成，请稍后重试资产提取。',
      })],
    });
    expect(JSON.stringify(result.output)).not.toContain('asset provider timeout');
    expect(result.cost).toBeCloseTo(0.3);
  });

  it('falls back to prompt from text/content/script when no messages', async () => {
    callAIMock.mockResolvedValueOnce({ url: '', meta: { content: 'ok' } });
    await handleTask('STORY_ANALYZE', { model: 'kimi/kimi-k2', text: '原始文本' }, 'u1', 't1');
    const payload = callAIMock.mock.calls[0][2];
    expect(payload.input.prompt).toBe('原始文本');
  });

  it('throws when model is missing', async () => {
    await expect(
      handleTask('LLM_CHAT', { messages: [] }, 'u1', 't1'),
    ).rejects.toThrow('缺少 model');
  });

  it('throws when model has no provider prefix', async () => {
    await expect(
      handleTask('LLM_CHAT', { model: 'no-prefix' }, 'u1', 't1'),
    ).rejects.toThrow('缺少 provider 前缀');
  });
});

// ============================================================
// IMAGE_GENERATE
// ============================================================

describe('handleTask — IMAGE_GENERATE', () => {
  it('calls callAI with image_generation, downloads and persists images', async () => {
    callAIMock.mockResolvedValueOnce({
      url: 'https://ark/img1.png',
      meta: {
        images: [
          { url: 'https://ark/img1.png', width: 1024, height: 1024 },
          { url: 'https://ark/img2.png', width: 1024, height: 1024 },
        ],
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(100),
      headers: { get: () => 'image/png' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleTask(
      'IMAGE_GENERATE',
      { model: 'ark/seedream', prompt: '一只猫', width: 1024, height: 1024, projectId: 'p1' },
      'u1',
      't1',
    );

    expect(callAIMock).toHaveBeenCalledTimes(1);
    const [provider, , payload] = callAIMock.mock.calls[0];
    expect(provider).toBe('ark');
    expect(payload.capability).toBe('image_generation');
    expect(payload.input.prompt).toBe('一只猫');
    expect(payload.input.width).toBe(1024);
    expect(payload.input.aspect_ratio).toBe('1:1');

    // 两张图都下载 + 上传
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storageUploadMock).toHaveBeenCalledTimes(2);

    expect(result.output.imageUrls).toEqual([
      'https://minio/uploaded.png',
      'https://minio/uploaded.png',
    ]);
    expect(result.output.projectId).toBe('p1');
    expect(result.modelProvider).toBe('ark');
  });

  it('throws when prompt is missing', async () => {
    await expect(
      handleTask('IMAGE_GENERATE', { model: 'ark/seedream' }, 'u1', 't1'),
    ).rejects.toThrow('缺少 prompt');
  });

  it('throws when AI returns no images', async () => {
    callAIMock.mockResolvedValueOnce({ url: '', meta: {} });
    await expect(
      handleTask('IMAGE_GENERATE', { model: 'ark/seedream', prompt: 'x' }, 'u1', 't1'),
    ).rejects.toThrow('未返回图片');
  });

  it('supports base64 data URL images', async () => {
    const b64 = Buffer.from('fake-png').toString('base64');
    callAIMock.mockResolvedValueOnce({
      url: '',
      meta: { images: [`data:image/png;base64,${b64}`] },
    });
    // fetch 不应被调用（data URL 直接解码）
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleTask(
      'IMAGE_GENERATE',
      { model: 'ark/seedream', prompt: 'x' },
      'u1',
      't1',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageUploadMock).toHaveBeenCalledTimes(1);
    expect(result.output.imageUrls).toHaveLength(1);
  });
});

// ============================================================
// ASSET_IMAGE_GENERATE
// ============================================================

describe('handleTask — ASSET_IMAGE_GENERATE', () => {
  it('returns provider images for the client to persist without writing server media or changing current image', async () => {
    const reportProgress = vi.fn().mockResolvedValue(undefined);
    callAIMock.mockResolvedValueOnce({
      url: 'https://ark/asset.png',
      meta: { images: [{ url: 'https://ark/asset.png', width: 768, height: 1024 }] },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(50),
      headers: { get: () => 'image/png' },
    })));

    const result = await handleTask(
      'ASSET_IMAGE_GENERATE',
      {
        model: 'ark/seedream',
        prompt: '角色设计',
        assetId: 'asset-1',
        width: 768,
        height: 1024,
        projectId: 'p1',
        revisionId: 'revision-1',
      },
      'u1',
      't1',
      reportProgress,
    );

    expect(callAIMock).toHaveBeenCalledTimes(1);
    // C/S 边界：worker 只返回临时供应商地址，桌面客户端负责下载与提交版本。
    expect(storageUploadMock).not.toHaveBeenCalled();
    expect(updateAssetMock).not.toHaveBeenCalled();
    expect(result.output.assetId).toBe('asset-1');
    expect(result.output.imageUrl).toBe('https://ark/asset.png');
    expect(markAssetImageRevisionGeneratedMock).toHaveBeenCalledWith(
      'revision-1',
      'https://ark/asset.png',
    );
    expect(reportProgress.mock.calls.map(([progress, stage]) => [progress, stage])).toEqual([
      [5, '任务已接收'],
      [15, '准备生成请求'],
      [25, 'AI生成图片中'],
      [70, '处理生成结果'],
      [95, '等待客户端保存'],
    ]);
  });

  it('throws when assetId is missing', async () => {
    await expect(
      handleTask('ASSET_IMAGE_GENERATE', { model: 'ark/seedream', prompt: 'x' }, 'u1', 't1'),
    ).rejects.toThrow('缺少 assetId');
  });
});

// ============================================================
// VIDEO_GENERATE
// ============================================================

describe('handleTask — VIDEO_GENERATE', () => {
  it('calls callAI with video_generation, persists video, updates shot', async () => {
    callAIMock.mockResolvedValueOnce({
      url: 'https://ark-tos/video.mp4',
      meta: { duration: 5, taskId: 'ark-task-1' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1000),
      headers: { get: () => 'video/mp4' },
    })));

    const result = await handleTask(
      'VIDEO_GENERATE',
      {
        model: 'ark/doubao-seedance',
        prompt: '猫在跑',
        duration: 5,
        aspectRatio: '9:16',
        shotId: 'shot-1',
        characterReferenceImageUrls: ['https://ref/char.png'],
        seed: 42,
      },
      'u1',
      't1',
    );

    expect(callAIMock).toHaveBeenCalledTimes(1);
    const [provider, , payload] = callAIMock.mock.calls[0];
    expect(provider).toBe('ark');
    expect(payload.capability).toBe('video_generation');
    // handlers 透传 prompt，motion 校准由上游 combineGroupPrompts 末尾 append + 层2 LLM 重写后补 append 保证
    expect(payload.input.prompt).toBe('猫在跑');
    expect(payload.input.duration).toBe(5);
    expect(payload.input.aspectRatio).toBe('9:16');
    expect(payload.input.characterReferenceImageUrls).toEqual(['https://ref/char.png']);
    expect(payload.input.seed).toBe(42);

    // 视频下载 + 上传
    expect(fetch).toHaveBeenCalledWith('https://ark-tos/video.mp4', expect.any(Object));
    expect(storageUploadMock).toHaveBeenCalledTimes(1);

    // shot 回写：updateShotMaterial 先 SELECT 旧 currentMaterialUrl（防覆盖丢老视频）再 UPDATE；
    // 过滤出 UPDATE 那条断言。
    const updateCalls = queryMock.mock.calls.filter(
      ([s]) => String(s).includes('UPDATE shots'),
    );
    expect(updateCalls).toHaveLength(1);
    const [sql, params] = updateCalls[0] as [string, unknown[]];
    expect(sql).toContain('"currentMaterialUrl"');
    expect(params[2]).toBe('shot-1');

    expect(result.output.videoUrl).toBe('https://minio/uploaded.png');
    expect(result.output.duration).toBe(5);
  });

  it('keeps an already calibrated final prompt to exactly one calibration suffix', async () => {
    const calibratedPrompt = `猫在跑\n\n${SEEDANCE_MOTION_CALIBRATION}`;
    callAIMock.mockResolvedValueOnce({ url: 'https://ark-tos/video.mp4', meta: {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(10),
      headers: { get: () => 'video/mp4' },
    })));

    await handleTask(
      'VIDEO_GENERATE',
      { model: 'ark/doubao-seedance', prompt: calibratedPrompt },
      'u1',
      't-calibrated',
    );

    const finalPrompt = callAIMock.mock.calls[0][2].input.prompt as string;
    expect(finalPrompt).toBe(calibratedPrompt);
    expect(finalPrompt.split(SEEDANCE_MOTION_CALIBRATION)).toHaveLength(2);
  });

  it('handles groupShotIds (batch shot update)', async () => {
    callAIMock.mockResolvedValueOnce({ url: 'https://v', meta: { duration: 3 } });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, arrayBuffer: async () => new ArrayBuffer(10), headers: { get: () => 'video/mp4' },
    })));

    await handleTask(
      'VIDEO_GENERATE',
      { model: 'ark/seedance', prompt: 'x', groupShotIds: ['s1', 's2'] },
      'u1',
      't1',
    );

    // 两个 shot 都回写：每个先 SELECT 旧值再 UPDATE，过滤出 UPDATE 调用看 shotId
    const updateCalls = queryMock.mock.calls.filter(
      ([s]) => String(s).includes('UPDATE shots'),
    );
    expect(updateCalls).toHaveLength(2);
    expect((updateCalls[0][1] as unknown[])[2]).toBe('s1');
    expect((updateCalls[1][1] as unknown[])[2]).toBe('s2');
  });

  it('marks shots FAILED when callAI throws', async () => {
    callAIMock.mockRejectedValueOnce(new Error('ARK 内容审核失败'));

    await expect(
      handleTask(
        'VIDEO_GENERATE',
        { model: 'ark/seedance', prompt: 'x', shotId: 'shot-9' },
        'u1',
        't1',
      ),
    ).rejects.toThrow('ARK 内容审核失败');

    // 失败时 shot videoStatus 置 FAILED
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('"videoStatus"=$1');
    expect(params[0]).toBe('FAILED');
    expect(params[1]).toBe('shot-9');
  });

  it('falls back to original URL when persist download fails', async () => {
    callAIMock.mockResolvedValueOnce({ url: 'https://ark-tos/v.mp4', meta: {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    const result = await handleTask(
      'VIDEO_GENERATE',
      { model: 'ark/seedance', prompt: 'x' },
      'u1',
      't1',
    );

    // 下载失败 → 回退原 URL（不上传）
    expect(storageUploadMock).not.toHaveBeenCalled();
    expect(result.output.videoUrl).toBe('https://ark-tos/v.mp4');
  });

  it('throws when AI returns no video URL', async () => {
    callAIMock.mockResolvedValueOnce({ url: '', meta: {} });
    await expect(
      handleTask('VIDEO_GENERATE', { model: 'ark/seedance', prompt: 'x' }, 'u1', 't1'),
    ).rejects.toThrow('未返回视频 URL');
  });

  it('chainMode: skips server-side persistVideo + shot write (dramaforge-assets-client-local)', async () => {
    callAIMock.mockResolvedValueOnce({ url: 'https://ark-tos/v.mp4', meta: { duration: 5 } });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(10),
      headers: { get: () => 'video/mp4' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await handleTask(
      'VIDEO_GENERATE',
      {
        model: 'ark/seedance',
        prompt: 'x',
        groupShotIds: ['s1', 's2'],
        chainMode: true,
      },
      'u1',
      't1',
    );

    // chain 模式：返回 ark 原始 URL（客户端立即 downloadClips 落盘本地）
    expect(result.output.videoUrl).toBe('https://ark-tos/v.mp4');
    // 不下载视频字节（跳过 persistVideo）
    expect(fetchSpy).not.toHaveBeenCalled();
    // 不上传到服务端 storage（dramaforge-assets-client-local：服务器零媒体字节）
    expect(storageUploadMock).not.toHaveBeenCalled();
    // 不回写 shots（归 CHAIN_COMPILE render_job G3 体系，用客户端 concat 后的本地组片）
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('chainMode: skips markShotsVideoStatus on failure (FAILED by render_job G3-1)', async () => {
    callAIMock.mockRejectedValueOnce(new Error('ARK 内容审核失败'));

    await expect(
      handleTask(
        'VIDEO_GENERATE',
        { model: 'ark/seedance', prompt: 'x', shotId: 'shot-9', chainMode: true },
        'u1',
        't1',
      ),
    ).rejects.toThrow('ARK 内容审核失败');

    // chain 模式：失败不回写 shots（FAILED 由 CHAIN_COMPILE render_job markFailed 统一处理）
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// VOICE_GENERATE (TTS)
// ============================================================

describe('handleTask — VOICE_GENERATE', () => {
  it('calls callAI with tts capability', async () => {
    callAIMock.mockResolvedValueOnce({
      url: 'data:audio/mpeg;base64,AAAA',
      meta: { duration: 0 },
    });

    const result = await handleTask(
      'VOICE_GENERATE',
      { model: 'ark/tts', text: '你好世界', voiceId: 'v1', speed: 1.2 },
      'u1',
      't1',
    );

    expect(callAIMock).toHaveBeenCalledTimes(1);
    const [provider, , payload] = callAIMock.mock.calls[0];
    expect(provider).toBe('ark');
    expect(payload.capability).toBe('tts');
    expect(payload.input.text).toBe('你好世界');
    expect(payload.input.voiceId).toBe('v1');
    expect(payload.input.speed).toBe(1.2);

    expect(result.output.audioUrl).toBe('data:audio/mpeg;base64,AAAA');
    expect(result.modelProvider).toBe('ark');
  });

  it('defaults to ARK when model and provider are absent', async () => {
    callAIMock.mockResolvedValueOnce({ url: 'data:audio/mpeg;base64,', meta: {} });
    await handleTask(
      'VOICE_GENERATE',
      { text: 'hi' },
      'u1',
      't1',
    );
    const [provider, model] = callAIMock.mock.calls[0];
    expect(provider).toBe('ark');
    expect(model).toBe('ark/tts-default');
  });

  it('throws when text is missing', async () => {
    await expect(
      handleTask('VOICE_GENERATE', { model: 'ark/tts' }, 'u1', 't1'),
    ).rejects.toThrow('缺少 text');
  });
});

// ============================================================
// 默认分支
// ============================================================

describe('handleTask — unsupported type', () => {
  it('throws for unknown task type', async () => {
    await expect(
      handleTask('FILM_EXPORT' as AiTaskType, { model: 'x' }, 'u1', 't1'),
    ).rejects.toThrow('不支持的 AI 任务类型');
  });
});

// ============================================================
// startProgressHeartbeat — 长 AI 调用期间的心跳进度
// ============================================================

describe('startProgressHeartbeat', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('report 为 undefined 时返回 no-op stop，不抛、不计时（handler 无 reportProgress 时安全）', () => {
    const stop = startProgressHeartbeat(undefined, 12, 60, 'AI 拆分整剧中');
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('随时间在 [start, end) 内缓慢推进，封顶 end-1，留真完成跳变空间', () => {
    vi.useFakeTimers();
    const report = vi.fn().mockResolvedValue(undefined);
    const stop = startProgressHeartbeat(report, 12, 60, 'AI 拆分整剧中', 20_000, 2);

    // 初始不应立即上报（setInterval 首次在 intervalMs 后）
    expect(report).not.toHaveBeenCalled();

    // 推进 3 个心跳周期（60s）→ 应有 3 次上报，值在 (12, 60) 内递增
    vi.advanceTimersByTime(20_000);
    vi.advanceTimersByTime(20_000);
    vi.advanceTimersByTime(20_000);

    const values = report.mock.calls.map((c) => c[0] as number);
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(values.every((v) => v > 12 && v < 60)).toBe(true);
    // 递增
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
    // stage 透传
    expect(report.mock.calls[0][1]).toBe('AI 拆分整剧中');
    stop();
  });

  it('到 cap 后停着不再涨，直到 stop（长任务超过预期时长也不超 end-1）', () => {
    vi.useFakeTimers();
    const report = vi.fn().mockResolvedValue(undefined);
    const stop = startProgressHeartbeat(report, 12, 60, 's', 20_000, 2);

    // 推进很久（cap=59，从 12 每 20s +2，约 470s 到顶）
    vi.advanceTimersByTime(600_000);
    const values = report.mock.calls.map((c) => c[0] as number);
    expect(Math.max(...values)).toBe(59); // 封顶 end-1，绝不触及 60
    expect(values.every((v) => v <= 59)).toBe(true);
    stop();
  });

  it('stop 后不再上报（无定时器泄漏）', () => {
    vi.useFakeTimers();
    const report = vi.fn().mockResolvedValue(undefined);
    const stop = startProgressHeartbeat(report, 12, 60, 's', 20_000, 2);
    vi.advanceTimersByTime(40_000);
    const countBefore = report.mock.calls.length;
    stop();
    vi.advanceTimersByTime(120_000); // stop 后再推进很久
    expect(report.mock.calls.length).toBe(countBefore); // 无新上报
  });
});
