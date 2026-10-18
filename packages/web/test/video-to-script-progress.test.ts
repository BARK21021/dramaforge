import { describe, expect, it } from 'vitest';
import {
  buildVideoStreamHeaders,
  clearRecoveredVideoTask,
  loadRecoveredVideoTask,
  resolveVideoTransportFailure,
  resolveVideoTaskProgress,
  saveRecoverableVideoTask,
} from '../lib/video-to-script-progress';

describe('InputStage 视频转剧本真实进度', () => {
  it('raw File 请求携带预生成 taskId，并直接显示服务端任务阶段', () => {
    const headers = buildVideoStreamHeaders(
      { name: '被偷走的春天.mp4', type: 'video/mp4', size: 74_750_620 },
      '1323838f-4388-4531-b86d-b67ac1412b61',
    );
    expect(headers).toEqual({
      'Content-Type': 'video/mp4',
      'X-SF-Video-Stream': '1',
      'X-SF-Video-Name': encodeURIComponent('被偷走的春天.mp4'),
      'X-SF-Video-Size': '74750620',
      'X-SF-Task-Id': '1323838f-4388-4531-b86d-b67ac1412b61',
    });

    expect(resolveVideoTaskProgress({
      status: 'RUNNING',
      progress: 65,
      stage: '正在生成剧本',
    }, false, true)).toEqual({
      progress: 65,
      stage: '正在生成剧本',
      completed: false,
      // 浏览器上传连接已结束/报错时，只要服务端任务仍活跃就不能隐藏进度条。
      busy: true,
    });
  });

  it('按项目和分集恢复 30 分钟内的 taskId，终态可主动清理', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const taskId = '1323838f-4388-4531-b86d-b67ac1412b61';

    saveRecoverableVideoTask(storage, 'project-1', 'episode-1', taskId, 1_000);
    expect(loadRecoveredVideoTask(storage, 'project-1', 'episode-1', 1_000 + 29 * 60_000))
      .toBe(taskId);
    expect(loadRecoveredVideoTask(storage, 'project-1', 'episode-1', 1_000 + 31 * 60_000))
      .toBeNull();

    saveRecoverableVideoTask(storage, 'project-1', 'episode-1', taskId, 2_000);
    clearRecoveredVideoTask(storage, 'project-1', 'episode-1');
    expect(loadRecoveredVideoTask(storage, 'project-1', 'episode-1', 2_001)).toBeNull();
  });

  it('HTTP 断开不把已经提交的后台任务误报为失败', () => {
    const taskId = '1323838f-4388-4531-b86d-b67ac1412b61';
    expect(resolveVideoTransportFailure(taskId)).toEqual({
      error: null,
      notice: '上传连接已中断，后台任务状态仍会继续同步，请勿重复提交',
    });
    expect(resolveVideoTransportFailure(null)).toEqual({
      error: '视频转剧本失败，请重试',
      notice: null,
    });
  });
});
