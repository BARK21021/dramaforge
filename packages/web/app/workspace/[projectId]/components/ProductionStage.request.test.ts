import { describe, expect, it } from 'vitest';
import { callApi } from '../../../../lib/api';
import {
  buildProductionGenerationParameters,
  buildChainGenerateRequestBody,
  buildApproveGroupPromptMetadata,
  buildResetGroupPromptMetadata,
  buildUserGroupPromptMetadata,
  formatGenerationFailure,
  getGroupPromptUiStatus,
  pollRenderTask,
  refreshShotsAfterSuccessfulRender,
} from './ProductionStage';

describe('formatGenerationFailure', () => {
  it('把 nginx HTML 502 页面压缩成可行动的中文提示', () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><center>nginx/1.20.1</center><!-- a padding to disable MSIE and Chrome friendly error page --></body></html>';
    const message = formatGenerationFailure(html);

    expect(message).toBe('云端服务暂时不可用，请稍后重试。');
    expect(message).not.toContain('<html>');
    expect(message).not.toContain('padding');
  });
});

describe('buildChainGenerateRequestBody', () => {
  it('整集生成不写 shotIds，并清理 undefined 参数', () => {
    expect(
      buildChainGenerateRequestBody({
        model: 'ark/doubao-seedance-2-0',
        seed: undefined,
        watermark: false,
      }),
    ).toEqual({
      model: 'ark/doubao-seedance-2-0',
      watermark: false,
    });
  });

  it('单镜和组选中都精确复制目标 shotIds', () => {
    const single = ['shot-1'];
    const group = ['shot-2', 'shot-3'];
    const groupBody = buildChainGenerateRequestBody({ model: 'video-model' }, group);

    expect(buildChainGenerateRequestBody({ model: 'video-model' }, single)).toEqual({
      model: 'video-model',
      shotIds: ['shot-1'],
    });
    expect(groupBody).toEqual({
      model: 'video-model',
      shotIds: ['shot-2', 'shot-3'],
    });

    // 请求体持有副本，后续 UI 选择变化不能扩大已经准备提交的范围。
    group.push('shot-4');
    expect(groupBody.shotIds).toEqual(['shot-2', 'shot-3']);
  });

  it('空子集不会静默降级成整集，并透传 C/S 执行策略', () => {
    expect(buildChainGenerateRequestBody({}, [])).toEqual({ shotIds: [] });
    expect(buildChainGenerateRequestBody({
      force: true,
      parallelMode: 'fast',
      parallelConcurrency: 3,
    })).toEqual({
      force: true,
      parallelMode: 'fast',
      parallelConcurrency: 3,
    });
  });
});

describe('production generation parameters', () => {
  it('把增强、网格和转场参数完整写入共用 body，并安全忽略未实现的彩铅模式', () => {
    expect(
      buildProductionGenerationParameters({
        useFixedSeed: true,
        seed: '86.9',
        resolution: '480p',
        aspectRatio: '9:16',
        watermark: false,
        returnLastFrame: true,
        enhancementPrompt: '  保持角色服装连续  ',
        gridEnabled: true,
        gridCells: '64',
        gridOpacity: '0.45',
        gridStrokeWidth: '1.5',
        transition: '  动作匹配剪辑  ',
        pencilPaintingMode: true,
      }),
    ).toEqual({
      seed: 86,
      resolution: '480p',
      aspectRatio: '9:16',
      watermark: false,
      returnLastFrame: true,
      enhancementPrompt: '保持角色服装连续',
      gridEnabled: true,
      gridCells: 64,
      gridOpacity: 0.45,
      gridStrokeWidth: 1.5,
      transition: '动作匹配剪辑',
    });
  });
});

describe('group prompt metadata', () => {
  it('用户保存时标记 user，重置时清理整套提示词快照', () => {
    expect(buildUserGroupPromptMetadata('自定义提示词')).toEqual({
      seedanceGroupPrompt: '自定义提示词',
      seedanceGroupPromptSource: 'user',
    });
    expect(buildResetGroupPromptMetadata()).toEqual({
      seedanceGroupPrompt: '',
      seedanceGroupPromptVersion: null,
      seedanceGroupPromptShotIds: [],
      seedanceGroupPromptContextHash: '',
      seedanceGroupPromptSource: null,
      seedanceGroupPromptRewritten: null,
      seedanceGroupPromptApproved: false,
      seedanceGroupPromptApprovedAt: null,
      seedanceGroupPromptUpdatedAt: null,
    });
    expect(buildApproveGroupPromptMetadata(true).seedanceGroupPromptApproved).toBe(true);
    expect(buildApproveGroupPromptMetadata(false).seedanceGroupPromptApproved).toBe(false);
    expect(buildApproveGroupPromptMetadata(false).seedanceGroupPromptApprovedAt).toBeNull();
  });

  it('区分 READY、STALE 和 MISSING，最终新鲜度由 prepare 路由复核', () => {
    expect(getGroupPromptUiStatus({}, ['shot-1'])).toBe('MISSING');
    expect(
      getGroupPromptUiStatus(
        { seedanceGroupPrompt: '旧提示词' },
        ['shot-1'],
      ),
    ).toBe('STALE');
    expect(
      getGroupPromptUiStatus(
        {
          seedanceGroupPrompt: '已准备提示词',
          seedanceGroupPromptVersion: 2,
          seedanceGroupPromptShotIds: ['shot-1', 'shot-2'],
          seedanceGroupPromptContextHash: 'hash-1',
        },
        ['shot-1', 'shot-2'],
      ),
    ).toBe('READY');
  });
});

describe('pollRenderTask', () => {
  it('通过 UI envelope 任务端点轮询，不把 render-job 裸响应误报为请求失败', async () => {
    const requestedUrls: string[] = [];
    const toasts: string[] = [];
    const updates: Array<{ status: string; progress: number; stage: string }> = [];

    // 使用生产相同的 callApi 契约构造反馈回路；旧实现请求 M2M render-job 端点时，
    // 200 裸 JSON 会被 callApi 判成 success=false 并弹出“请求失败”。
    const request = async <T,>(url: string): Promise<T | null> => {
      requestedUrls.push(url);
      const result = await callApi<T>(url, undefined, {
        fetcher: async () => new Response(JSON.stringify({
          success: true,
          data: {
            status: 'COMPLETED',
            progress: 100,
            stage: '已完成',
            result: { outputUrl: 'sf-asset://film.mp4' },
          },
        }), { status: 200 }),
        onToast: (message) => toasts.push(message),
      });
      return result.ok ? result.data : null;
    };

    await pollRenderTask(
      'task-1',
      request,
      (status, progress, stage) => updates.push({ status, progress, stage }),
      { maxAttempts: 1, intervalMs: 0 },
    );

    expect(requestedUrls).toEqual(['/api/tasks/task-1']);
    expect(toasts).toEqual([]);
    expect(updates).toEqual([{ status: 'COMPLETED', progress: 100, stage: '已完成' }]);
  });

  it('把失败原因传给生产页，而不是只传 FAILED 状态', async () => {
    const updates: Array<{ status: string; error?: string | null }> = [];
    const request = async <T,>(): Promise<T | null> => ({
      status: 'FAILED',
      progress: 0,
      stage: '客户端处理中',
      error: 'chainCompile: AI 生成失败 [provider=ark]: 输入参考图疑似包含真人',
    }) as T;

    await pollRenderTask(
      'task-failed',
      request,
      (status, _progress, _stage, _result, error) => updates.push({ status, error }),
      { maxAttempts: 1, intervalMs: 0 },
    );

    expect(updates).toEqual([{
      status: 'FAILED',
      error: 'chainCompile: AI 生成失败 [provider=ark]: 输入参考图疑似包含真人',
    }]);
  });

  it('默认轮询窗口覆盖超过五分钟才进入终态的视频任务', async () => {
    let calls = 0;
    const request = async <T,>(): Promise<T | null> => {
      calls += 1;
      return {
        status: calls <= 75 ? 'RUNNING' : 'FAILED',
        progress: 0,
        stage: calls <= 75 ? '供应商生成中' : '生成失败',
        error: calls <= 75 ? null : 'provider rejected input',
      } as T;
    };
    const updates: string[] = [];

    // intervalMs=0 保留真实轮询次数但不让测试等待；旧默认上限75次会在终态前退出。
    await pollRenderTask(
      'task-long-running',
      request,
      (status) => updates.push(status),
      { intervalMs: 0 },
    );

    expect(calls).toBe(76);
    expect(updates.at(-1)).toBe('FAILED');
  });
});

describe('refreshShotsAfterSuccessfulRender', () => {
  it('完成事件刷新持久化镜头，失败事件不伪装生成成功', () => {
    let refreshCount = 0;
    const refresh = () => {
      // 计数模拟 EpisodeWorkspace.loadShots，验证终态只在成功时重新读取服务器状态。
      refreshCount += 1;
    };

    expect(refreshShotsAfterSuccessfulRender('RUNNING', refresh)).toBe(false);
    expect(refreshShotsAfterSuccessfulRender('FAILED', refresh)).toBe(false);
    expect(refreshShotsAfterSuccessfulRender('COMPLETED', refresh)).toBe(true);
    expect(refreshCount).toBe(1);
  });
});
