// video-upload-store 单测：验证导航无关单例的状态机。
// 环境是 node（非 jsdom）；store 的 window.sessionStorage 分支用 typeof window 守卫，
// 这里临时给 globalThis.window 挂内存 storage 覆盖 sessionStorage 路径。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startVideoUpload,
  getVideoUploadState,
  markVideoUploadTerminal,
  reportVideoUploadError,
  seedFromStorage,
  clearVideoUpload,
  subscribeVideoUpload,
} from '../lib/video-upload-store';

const PROJECT = 'p1';
const EPISODE = 'e1';
const EPISODE_2 = 'e2';

/** File-like 最小对象（避免依赖全局 File；store 只读 name/type/size + 透传 body）。 */
function fakeFile(): File {
  return { name: 'v.mp4', type: 'video/mp4', size: 10 } as unknown as File;
}

function makeMemStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
}

describe('video-upload-store', () => {
  let savedWindowDescriptor:PropertyDescriptor | undefined;
  let memStorage: ReturnType<typeof makeMemStorage>;

  beforeEach(() => {
    memStorage = makeMemStorage();
    // 备份原 window 属性描述符，挂内存 storage 让 store 的 sessionStorage 分支生效。
    savedWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    (globalThis as { window?: unknown }).window = { sessionStorage: memStorage };
    clearVideoUpload(PROJECT, EPISODE);
    clearVideoUpload(PROJECT, EPISODE_2);
  });

  afterEach(() => {
    // 还原 window（原本未定义则删除）。
    if (savedWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', savedWindowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('startVideoUpload 标记 uploading 并生成 UUID taskId，写 sessionStorage 指针', () => {
    const api = async () => null;
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api, { sourceDurationSeconds: null });
    const s = getVideoUploadState(PROJECT, EPISODE);
    expect(s.uploading).toBe(true);
    expect(s.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(s.handledTerminal).toBe(false);
    expect(memStorage.getItem('sf:video-to-script:p1:e1')).toContain(s.taskId);
  });

  it('传 model 时上传 URL 带 model= 查询参数，不传时不含', async () => {
    let capturedUrl = '';
    const api = async (url: string) => {
      capturedUrl = url;
      return null;
    };
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api, {
      sourceDurationSeconds: null,
      model: 'kimi/kimi-k3',
    });
    await flushMicrotasks();
    // / 被 URLSearchParams 编码为 %2F。
    expect(capturedUrl).toContain('model=kimi%2Fkimi-k3');

    // 不传 model：URL 不应带 model=（route 走默认值）。
    let capturedUrl2 = '';
    const api2 = async (url: string) => {
      capturedUrl2 = url;
      return null;
    };
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api2, { sourceDurationSeconds: null });
    await flushMicrotasks();
    expect(capturedUrl2).not.toContain('model=');
  });

  it('api 返回 script → uploading=false 且 script 回填', async () => {
    let resolveApi!: (v: unknown) => void;
    const api = () =>
      new Promise((r) => {
        resolveApi = r as (v: unknown) => void;
      });
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api as (url: string, o?: RequestInit) => Promise<unknown>, {
      sourceDurationSeconds: 12,
    });
    expect(getVideoUploadState(PROJECT, EPISODE).uploading).toBe(true);
    resolveApi({ script: 'hello script' });
    await flushMicrotasks();
    const s = getVideoUploadState(PROJECT, EPISODE);
    expect(s.uploading).toBe(false);
    expect(s.script).toBe('hello script');
  });

  it('api 返回 null（连接中断）→ uploading=false + 中性 transportNotice，指针仍留', async () => {
    let resolveApi!: (v: unknown) => void;
    const api = () =>
      new Promise((r) => {
        resolveApi = r as (v: unknown) => void;
      });
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api as (url: string, o?: RequestInit) => Promise<unknown>, {
      sourceDurationSeconds: null,
    });
    resolveApi(null);
    await flushMicrotasks();
    const s = getVideoUploadState(PROJECT, EPISODE);
    expect(s.uploading).toBe(false);
    expect(s.script).toBeNull();
    expect(s.transportNotice).not.toBeNull();
    expect(memStorage.getItem('sf:video-to-script:p1:e1')).not.toBeNull();
  });

  it('markVideoUploadTerminal completed → handledTerminal=true 且清指针', () => {
    const api = async () => null;
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api, { sourceDurationSeconds: null });
    markVideoUploadTerminal(PROJECT, EPISODE, { status: 'completed' });
    const s = getVideoUploadState(PROJECT, EPISODE);
    expect(s.handledTerminal).toBe(true);
    expect(memStorage.getItem('sf:video-to-script:p1:e1')).toBeNull();
  });

  it('markVideoUploadTerminal failed → 落 error + handledTerminal + 清指针', () => {
    const api = async () => null;
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api, { sourceDurationSeconds: null });
    markVideoUploadTerminal(PROJECT, EPISODE, { status: 'failed', error: 'Kimi 挂了' });
    const s = getVideoUploadState(PROJECT, EPISODE);
    expect(s.handledTerminal).toBe(true);
    expect(s.error).toBe('Kimi 挂了');
    expect(memStorage.getItem('sf:video-to-script:p1:e1')).toBeNull();
  });

  it('reportVideoUploadError 设置/清空 error', () => {
    reportVideoUploadError(PROJECT, EPISODE, '文件太大');
    expect(getVideoUploadState(PROJECT, EPISODE).error).toBe('文件太大');
    reportVideoUploadError(PROJECT, EPISODE, null);
    expect(getVideoUploadState(PROJECT, EPISODE).error).toBeNull();
  });

  it('seedFromStorage 从 sessionStorage 恢复 taskId，且不覆盖已有内存任务', () => {
    const tid = '11111111-1111-4111-8111-111111111111';
    memStorage.setItem(
      'sf:video-to-script:p1:e1',
      JSON.stringify({ taskId: tid, startedAt: Date.now() }),
    );
    seedFromStorage(PROJECT, EPISODE);
    const s = getVideoUploadState(PROJECT, EPISODE);
    expect(s.taskId).toBe(tid);
    expect(s.uploading).toBe(true);
    // 已有内存任务时 seed 不覆盖
    seedFromStorage(PROJECT, EPISODE);
    expect(getVideoUploadState(PROJECT, EPISODE).taskId).toBe(tid);
  });

  it('快照引用稳定：未变更时同一引用，patch 后换新', () => {
    const api = async () => null;
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api, { sourceDurationSeconds: null });
    const a = getVideoUploadState(PROJECT, EPISODE);
    const b = getVideoUploadState(PROJECT, EPISODE);
    expect(a).toBe(b);
    reportVideoUploadError(PROJECT, EPISODE, 'x');
    const c = getVideoUploadState(PROJECT, EPISODE);
    expect(c).not.toBe(a);
  });

  it('subscribe 在 patch 时通知，取消后不再通知', () => {
    let calls = 0;
    const unsub = subscribeVideoUpload(() => {
      calls += 1;
    });
    const api = async () => null;
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api, { sourceDurationSeconds: null });
    expect(calls).toBeGreaterThan(0);
    unsub();
    const before = calls;
    reportVideoUploadError(PROJECT, EPISODE, 'y');
    expect(calls).toBe(before);
  });

  it('不同 episode 隔离', () => {
    const api = async () => null;
    startVideoUpload(PROJECT, EPISODE, fakeFile(), api, { sourceDurationSeconds: null });
    startVideoUpload(PROJECT, EPISODE_2, fakeFile(), api, { sourceDurationSeconds: null });
    const a = getVideoUploadState(PROJECT, EPISODE).taskId;
    const b = getVideoUploadState(PROJECT, EPISODE_2).taskId;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
