// Unit tests for ⑪ client/shell — preload contextBridge surface.
//
// Mocks `electron` so `contextBridge.exposeInMainWorld` and `ipcRenderer.invoke`
// are vi.fn spies. Importing the preload module triggers the top-level
// `exposeInMainWorld('sfShell', bridge)` call — the spy captures the bridge
// object, whose shape we then assert against.
//
// Phase-1 rule under test: the renderer gets ONLY three invoke helpers — no
// ffmpeg, fs, node, require, process, etc.

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn((file: { name?: string }) => `/mock/path/${file?.name ?? 'file'}`) },
}));

import { contextBridge, ipcRenderer, webUtils } from 'electron';
// Importing for side effect: the module calls contextBridge.exposeInMainWorld.
import '../../main/preload';

function getBridge(): Record<string, (...args: unknown[]) => unknown> {
  const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const [, bridge] = calls[0];
  return bridge as Record<string, (...args: unknown[]) => unknown>;
}

describe('preload', () => {
  it('exposes the surface under the "sfShell" name', () => {
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [name] = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0];
    expect(name).toBe('sfShell');
  });

  it('exposes exactly twenty-two audited functions plus the isElectron flag', () => {
    const bridge = getBridge();
    const keys = Object.keys(bridge).sort();
    expect(keys).toEqual(
      [
        'checkForUpdate',
        'cutReferenceVideo',
        'downloadAsset',
        'exportProjectBundle',
        'getAppVersion',
        'getMachineId',
        'importProjectBundle',
        'isElectron',
        'listPresetVoices',
        'onCutReferenceVideoProgress',
        'onUploadReferenceClipsProgress',
        'openExternal',
        'preprocessVideoForUpload',
        'readAssetToBaseUrl',
        'readPresetVoice',
        'removeFilm',
        'saveAsset',
        'saveFilm',
        'saveLocalAsset',
        'stageOriginalVideo',
        'triggerUpdateCheck',
        'uploadReferenceClips',
      ],
    );

    // Twenty-two functions + one boolean flag。
    for (const key of [
      'checkForUpdate',
      'cutReferenceVideo',
      'downloadAsset',
      'exportProjectBundle',
      'getAppVersion',
      'getMachineId',
      'importProjectBundle',
      'listPresetVoices',
      'onCutReferenceVideoProgress',
      'onUploadReferenceClipsProgress',
      'openExternal',
      'preprocessVideoForUpload',
      'readAssetToBaseUrl',
      'readPresetVoice',
      'removeFilm',
      'saveAsset',
      'saveFilm',
      'saveLocalAsset',
      'stageOriginalVideo',
      'triggerUpdateCheck',
      'uploadReferenceClips',
    ]) {
      expect(typeof bridge[key]).toBe('function');
    }
    expect(bridge.isElectron).toBe(true);
  });

  it('cutReferenceVideo invokes the sf:cut-reference-video channel with input', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    vi.mocked(ipcRenderer.invoke).mockResolvedValue({
      ok: true,
      clips: [
        {
          path: 'C:\\x\\original-uploads\\v\\clips\\clip-0.mp4',
          startSec: 0,
          endSec: 8.4,
          durationSec: 8.4,
          height: 720,
        },
      ],
      sourceDurationSec: 60,
    });

    const result = await bridge.cutReferenceVideo({
      videoPath: 'C:\\x\\original-uploads\\v\\video.mp4',
      maxHeight: 720,
    });

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('sf:cut-reference-video', {
      videoPath: 'C:\\x\\original-uploads\\v\\video.mp4',
      maxHeight: 720,
    });
    expect(result).toEqual({
      ok: true,
      clips: [expect.objectContaining({ path: expect.any(String), durationSec: 8.4 })],
      sourceDurationSec: 60,
    });
  });

  it('onCutReferenceVideoProgress subscribes to the progress channel and returns unsubscribe', () => {
    const bridge = getBridge();
    const cb = vi.fn();
    const unsubscribe = bridge.onCutReferenceVideoProgress(cb);

    // 模拟 main → renderer 推送：找到 ipcRenderer.on 注册的监听器并触发。
    const onCalls = vi.mocked(ipcRenderer.on).mock.calls;
    const reg = onCalls.find(([channel]) => channel === 'sf:cut-reference-video-progress');
    expect(reg).toBeDefined();
    const listener = reg![1] as (event: unknown, payload: unknown) => void;
    listener({}, { stage: 'cutting', done: 2, total: 5 });

    expect(cb).toHaveBeenCalledWith({ stage: 'cutting', done: 2, total: 5 });

    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      'sf:cut-reference-video-progress',
      listener,
    );
  });

  it('openExternal invokes the sf:open-external channel with the URL (P6)', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    vi.mocked(ipcRenderer.invoke).mockResolvedValue(undefined);

    await bridge.openExternal('https://mclient.alipay.com/cashier.htm');

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'sf:open-external',
      'https://mclient.alipay.com/cashier.htm',
    );
  });

  it('each function calls ipcRenderer.invoke with the matching channel', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();

    await bridge.getAppVersion();
    await bridge.getMachineId();
    await bridge.triggerUpdateCheck();
    await bridge.checkForUpdate();

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(4);
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, 'sf:get-app-version');
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, 'sf:get-machine-id');
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, 'sf:trigger-update-check');
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(4, 'sf:check-for-update');
  });

  it('downloadAsset invokes the sf:download-asset channel with the URL (P4 Task 1)', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    vi.mocked(ipcRenderer.invoke).mockResolvedValue({
      ok: true,
      key: 'clip-uuid.mp4',
      protocolUrl: 'sf-asset://clip-uuid.mp4',
    });

    const result = await bridge.downloadAsset('https://ark.example/presigned.mp4');

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    // downloadAsset 现在向 invoke 传 (url, opts) 两个参数(opts 可选,未传时为
    // undefined)。preload.ts:71-72 在批0.5 加了 ext 推断,签名从 (url) 变 (url, opts?)。
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'sf:download-asset',
      'https://ark.example/presigned.mp4',
      undefined,
    );
    expect(result).toEqual({
      ok: true,
      key: 'clip-uuid.mp4',
      protocolUrl: 'sf-asset://clip-uuid.mp4',
    });
  });

  it('saveLocalAsset invokes the sf:save-local-asset channel with bytes + ext (批2a)', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    vi.mocked(ipcRenderer.invoke).mockResolvedValue({
      ok: true,
      key: 'clip-uuid.png',
      protocolUrl: 'sf-asset://clip-uuid.png',
    });

    const bytes = new Uint8Array([1, 2, 3]);
    const result = await bridge.saveLocalAsset(bytes, { ext: 'png' });

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('sf:save-local-asset', bytes, { ext: 'png' });
    expect(result).toEqual({
      ok: true,
      key: 'clip-uuid.png',
      protocolUrl: 'sf-asset://clip-uuid.png',
    });
  });

  it('readAssetToBaseUrl invokes the sf:read-asset-to-base-url channel with the protocolUrl (批4)', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    vi.mocked(ipcRenderer.invoke).mockResolvedValue({
      ok: true,
      dataUrl: 'data:image/png;base64,AAA',
    });

    const result = await bridge.readAssetToBaseUrl('sf-asset://clip-uuid.png');

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'sf:read-asset-to-base-url',
      'sf-asset://clip-uuid.png',
    );
    expect(result).toEqual({ ok: true, dataUrl: 'data:image/png;base64,AAA' });
  });

  it('listPresetVoices invokes the sf:list-preset-voices channel with no args (批6)', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    const voicesPayload = {
      ok: true,
      voices: [
        {
          file: 'female_001_温柔甜美少女声音音调.wav',
          gender: 'female',
          dur: 3.76,
          desc: '温柔甜美的少女声音',
          text: 'The best way to predict the future is to create it yourself.',
          lang: 'English',
        },
      ],
    };
    vi.mocked(ipcRenderer.invoke).mockResolvedValue(voicesPayload);

    const result = await bridge.listPresetVoices();

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('sf:list-preset-voices');
    expect(result).toEqual(voicesPayload);
  });

  it('readPresetVoice invokes the sf:read-preset-voice channel with the file name (批6)', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    vi.mocked(ipcRenderer.invoke).mockResolvedValue({
      ok: true,
      dataUrl: 'data:audio/wav;base64,AAAA',
    });

    const result = await bridge.readPresetVoice('female_001_温柔甜美少女声音音调.wav');

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'sf:read-preset-voice',
      'female_001_温柔甜美少女声音音调.wav',
    );
    expect(result).toEqual({ ok: true, dataUrl: 'data:audio/wav;base64,AAAA' });
  });

  it('stageOriginalVideo resolves the disk path via webUtils and sends { filePath, filename } over IPC — not the File (R1 流式落地)', async () => {
    // R1: preload 现在用 webUtils.getPathForFile 在 renderer 侧解析磁盘路径，只把路径
    // 字符串过 IPC——main 不再把 ≤3GB File 整块 arrayBuffer() 灌进堆（OOM 根因）。
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    vi.mocked(webUtils.getPathForFile).mockReturnValue('C:\\real\\disk\\pilot.mp4');
    const stagedPayload = {
      outcome: 'staged' as const,
      videoUrl: 'C:\\Users\\me\\AppData\\Roaming\\DramaForge\\original-uploads\\abc-uuid.mp4',
      totalBytes: 12345,
      totalDurationSec: 67.89,
      filename: 'pilot.mp4',
    };
    vi.mocked(ipcRenderer.invoke).mockResolvedValue(stagedPayload);

    const file = new File(['bytes'], 'pilot.mp4', { type: 'video/mp4' });
    const result = await bridge.stageOriginalVideo({ file, filename: 'pilot.mp4' });

    expect(webUtils.getPathForFile).toHaveBeenCalledWith(file);
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('sf:stage-original-video', {
      filePath: 'C:\\real\\disk\\pilot.mp4',
      filename: 'pilot.mp4',
    });
    expect(result).toEqual(stagedPayload);
  });

  it('project transfer methods invoke only their dedicated audited channels', async () => {
    const bridge = getBridge();
    vi.mocked(ipcRenderer.invoke).mockClear();
    const snapshot = { format: 'dramaforge-project', version: 1 };

    await bridge.exportProjectBundle(snapshot, '测试项目');
    await bridge.importProjectBundle();

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      'sf:export-project-bundle',
      snapshot,
      '测试项目',
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, 'sf:import-project-bundle');
  });

  it('does NOT expose dangerous APIs (no fs/ffmpeg/require/process/ipcRenderer)', () => {
    const bridge = getBridge();
    const keys = new Set(Object.keys(bridge));

    // The renderer must never see these.
    const forbidden = [
      'require',
      'process',
      'fs',
      'child_process',
      'exec',
      'spawn',
      'ffmpeg',
      'node',
      'ipcRenderer',
      'ipcMain',
      'shell',
      'contextBridge',
      'app',
      'session',
      'BrowserWindow',
    ];
    for (const name of forbidden) {
      expect(keys.has(name)).toBe(false);
    }
  });
});
