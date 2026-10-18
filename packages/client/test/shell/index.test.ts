// Unit tests for ⑪ client/shell — main entry bootstrap wiring.
//
// Mocks `electron` (app/session/ipcMain/BrowserWindow/contextBridge) and the
// four module deps (render-worker / heartbeat / updater / logger) + orchestrators
// so `bootstrapShell` runs against vi.fn spies. Asserts each service is started
// with the correct args, the authCookie getter adapts ⑨'s static string to a
// fresh-each-poll source, IPC handlers are registered, and shutdown stops all.
//
// `process.env.VITEST` is set by vitest, so the top-level `startShell()` call
// in main/index.ts is skipped — we test the exported pure functions directly.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mock electron with controllable app / session / ipcMain. ---
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.2.3'),
    getPath: vi.fn((name: string) => `/tmp/sf-test-${name}`),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  BrowserWindow: Object.assign(
    vi.fn(() => ({
      loadURL: vi.fn(),
      on: vi.fn(),
      // createShellWindow 挂 before-input-event 快捷键锁定（生产客户端禁用刷新/
      // devtools），mock 需提供 webContents。
      webContents: { on: vi.fn() },
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      focus: vi.fn(),
    })),
    {
      getFocusedWindow: vi.fn(() => null),
      getAllWindows: vi.fn(() => []),
    },
  ),
  dialog: {
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
  },
  session: {
    defaultSession: {
      cookies: { get: vi.fn(() => Promise.resolve([])) },
    },
  },
  ipcMain: { handle: vi.fn() },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
  net: {
    fetch: vi.fn(),
  },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
}));

// --- Mock the module deps so bootstrapShell runs against spies. ---
vi.mock('../../src/render-worker', () => ({
  startRenderWorker: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
}));
vi.mock('../../src/ops/heartbeat', () => ({
  startHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
  // bootstrapShell 启动时拉一次槽位提示；默认 renderJobSlots: 3（测试可控）。
  fetchHeartbeatOnce: vi.fn(),
}));
vi.mock('../../src/ops/updater', () => ({
  startUpdater: vi.fn(() => ({ stop: vi.fn(), checkNow: vi.fn(() => Promise.resolve()) })),
}));
vi.mock('../../src/ops/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  })),
}));
vi.mock('../../src/orchestrators', () => ({
  orchestrators: { chainCompile: vi.fn(), longVideoRewrite: vi.fn() },
}));

import { app, session, ipcMain, dialog, protocol } from 'electron';
import { startRenderWorker } from '../../src/render-worker';
import { startHeartbeat, fetchHeartbeatOnce } from '../../src/ops/heartbeat';
import { startUpdater } from '../../src/ops/updater';
import { createLogger } from '../../src/ops/logger';
import {
  bootstrapShell,
  resolveLoadUrl,
  mapOs,
  stopShell,
  startShell,
  registerPrivilegedSchemes,
  registerAssetProtocol,
  type ShellHandles,
} from '../../main/index';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
};

// Minimal BrowserWindow stub (bootstrapShell does `void window` — the window
// isn't used directly; the cookie is read from session.defaultSession).
const windowStub = {} as never;

beforeEach(() => {
  vi.mocked(startRenderWorker).mockClear();
  vi.mocked(startHeartbeat).mockClear();
  vi.mocked(startUpdater).mockClear();
  vi.mocked(createLogger).mockClear();
  vi.mocked(ipcMain.handle).mockClear();
  vi.mocked(session.defaultSession.cookies.get).mockClear();
  vi.mocked(session.defaultSession.cookies.get).mockResolvedValue([]);
  vi.mocked(app.quit).mockClear();
  vi.mocked(app.on).mockClear();
  vi.mocked(dialog.showMessageBox).mockClear();
  vi.mocked(protocol.registerSchemesAsPrivileged).mockClear();
  vi.mocked(protocol.handle).mockClear();
  vi.mocked(fetchHeartbeatOnce).mockClear();
  vi.mocked(fetchHeartbeatOnce).mockResolvedValue({
    status: 'ok',
    minVersion: '1.0.0',
    latestVersion: '1.0.0',
    downloadUrl: '',
    signature: '',
    sha256: '',
    renderJobSlots: 3,
  });
});

describe('resolveLoadUrl', () => {
  it('returns SF_DEV_URL when set (dev server)', () => {
    const prev = process.env.SF_DEV_URL;
    process.env.SF_DEV_URL = 'http://localhost:5173';
    try {
      expect(resolveLoadUrl()).toBe('http://localhost:5173');
    } finally {
      if (prev === undefined) delete process.env.SF_DEV_URL;
      else process.env.SF_DEV_URL = prev;
    }
  });

  it('returns the production cloud URL when SF_DEV_URL is unset', () => {
    const prev = process.env.SF_DEV_URL;
    delete process.env.SF_DEV_URL;
    try {
      expect(resolveLoadUrl()).toBe('https://your-domain.example.com');
    } finally {
      if (prev !== undefined) process.env.SF_DEV_URL = prev;
    }
  });
});

describe('mapOs', () => {
  it('maps win32 → win', () => {
    expect(mapOs('win32')).toBe('win');
  });
  it('maps darwin → mac', () => {
    expect(mapOs('darwin')).toBe('mac');
  });
  it('maps linux → linux', () => {
    expect(mapOs('linux')).toBe('linux');
  });
  it('defaults unknown platforms to linux', () => {
    expect(mapOs('aix')).toBe('linux');
    expect(mapOs('freebsd')).toBe('linux');
  });
});

describe('bootstrapShell', () => {
  it('calls startRenderWorker with apiBase, machineId, logger, orchestrators + authCookie getter', async () => {
    vi.mocked(session.defaultSession.cookies.get).mockResolvedValue([
      { name: '__Secure-next-auth.session-token', value: 'rw-tok', domain: 'your-domain.example.com' },
    ]);

    const handles = await bootstrapShell(windowStub, 'machine-1', noopLogger, 'https://api.example.com');

    // startRenderWorker was called once.
    expect(startRenderWorker).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(startRenderWorker).mock.calls[0][0];

    expect(opts.apiBase).toBe('https://api.example.com');
    expect(opts.machineId).toBe('machine-1');
    expect(opts.logger).toBe(noopLogger);
    // 启动时拉一次槽位提示 → 3 槽。
    expect(opts.slots).toBe(3);
    expect(fetchHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(opts.orchestrators).toEqual({
      chainCompile: expect.any(Function),
      longVideoRewrite: expect.any(Function),
    });

    // authCookie is a GETTER (dynamic). bootstrapShell 现在是 async（启动时 await
    // 一次拉槽位 fetch），cookie refresher 的首次刷新已随微任务完成 —— getter 已
    // 可用；refreshNow 后再读仍是最新值（fresh-each-poll 语义不变）。
    await handles.cookieRefresher.refreshNow();
    expect(opts.authCookie).toBe('__Secure-next-auth.session-token=rw-tok');

    handles.cookieRefresher.stop();
    handles.renderWorker.stop();
    handles.heartbeat.stop();
    handles.updater.stop();
  });

  it('authCookie getter picks up cookie changes (fresh-each-poll — no ⑨ modification)', async () => {
    let currentToken = 'first-tok';
    vi.mocked(session.defaultSession.cookies.get).mockImplementation(async () => [
      { name: '__Secure-next-auth.session-token', value: currentToken, domain: 'your-domain.example.com' },
    ]);

    const handles = await bootstrapShell(windowStub, 'machine-1', noopLogger);
    const opts = vi.mocked(startRenderWorker).mock.calls[0][0];

    await handles.cookieRefresher.refreshNow();
    expect(opts.authCookie).toBe('__Secure-next-auth.session-token=first-tok');

    // User re-logs in mid-job → new token. The getter reflects it on the next
    // read (the render-worker reads opts.authCookie each poll cycle).
    currentToken = 'second-tok';
    await handles.cookieRefresher.refreshNow();
    expect(opts.authCookie).toBe('__Secure-next-auth.session-token=second-tok');

    handles.cookieRefresher.stop();
    handles.renderWorker.stop();
    handles.heartbeat.stop();
    handles.updater.stop();
  });

  it('calls startHeartbeat with version (app.getVersion), machineId, apiBase, onForceUpgrade', async () => {
    const handles = await bootstrapShell(windowStub, 'machine-1', noopLogger, 'https://api.example.com');

    expect(startHeartbeat).toHaveBeenCalledTimes(1);
    const hbOpts = vi.mocked(startHeartbeat).mock.calls[0][0];

    expect(hbOpts.version).toBe('1.2.3'); // app.getVersion() mock
    expect(hbOpts.machineId).toBe('machine-1');
    expect(hbOpts.apiBase).toBe('https://api.example.com');
    expect(typeof hbOpts.onForceUpgrade).toBe('function');

    // onForceUpgrade 触发 handleForceUpgrade：block 弹窗 → 开下载页 → quit。
    // 同步调用不抛错；fire-and-forget 的 async 链 flush 后验 dialog + quit 被调一次。
    expect(() =>
      hbOpts.onForceUpgrade({
        status: 'force_upgrade',
        minVersion: '1.0.0',
        latestVersion: '1.5.0',
        downloadUrl: 'https://dl/v1.5.0',
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);

    handles.cookieRefresher.stop();
    handles.renderWorker.stop();
    handles.heartbeat.stop();
    handles.updater.stop();
  });

  it('calls startUpdater with currentVersion, os, apiBase, cacheDir, onDownloaded', async () => {
    const handles = await bootstrapShell(windowStub, 'machine-1', noopLogger, 'https://api.example.com');

    expect(startUpdater).toHaveBeenCalledTimes(1);
    const upOpts = vi.mocked(startUpdater).mock.calls[0][0];

    expect(upOpts.currentVersion).toBe('1.2.3'); // app.getVersion() mock
    expect(upOpts.apiBase).toBe('https://api.example.com');
    // cacheDir is under userData/updates (platform-agnostic path separator).
    expect(upOpts.cacheDir).toMatch(/sf-test-userData[\\/]updates$/);
    // os is derived from process.platform via mapOs.
    expect(['win', 'mac', 'linux']).toContain(upOpts.os);
    expect(typeof upOpts.onDownloaded).toBe('function');

    handles.cookieRefresher.stop();
    handles.renderWorker.stop();
    handles.heartbeat.stop();
    handles.updater.stop();
  });

  it('registers exactly 19 IPC handlers for the preload bridge channels', async () => {
    const handles = await bootstrapShell(windowStub, 'machine-1', noopLogger);

    expect(ipcMain.handle).toHaveBeenCalledTimes(19);
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0]);
    expect(channels).toContain('sf:get-app-version');
    expect(channels).toContain('sf:get-machine-id');
    expect(channels).toContain('sf:trigger-update-check');
    expect(channels).toContain('sf:check-for-update');
    expect(channels).toContain('sf:download-asset');
    expect(channels).toContain('sf:save-asset');
    expect(channels).toContain('sf:save-local-asset');
    expect(channels).toContain('sf:read-asset-to-base-url');
    expect(channels).toContain('sf:open-external');
    expect(channels).toContain('sf:save-film');
    expect(channels).toContain('sf:remove-film');
    expect(channels).toContain('sf:list-preset-voices');
    expect(channels).toContain('sf:read-preset-voice');
    expect(channels).toContain('sf:stage-original-video');
    expect(channels).toContain('sf:export-project-bundle');
    expect(channels).toContain('sf:import-project-bundle');
    expect(channels).toContain('sf:preprocess-video-for-upload');
    expect(channels).toContain('sf:cut-reference-video');
    expect(channels).toContain('sf:upload-reference-clips');

    handles.cookieRefresher.stop();
    handles.renderWorker.stop();
    handles.heartbeat.stop();
    handles.updater.stop();
  });

  it('bootstrapShell registers the sf-asset:// protocol handler (P4 Task 1)', async () => {
    const handles = await bootstrapShell(windowStub, 'machine-1', noopLogger);

    expect(protocol.handle).toHaveBeenCalledTimes(1);
    const [scheme] = vi.mocked(protocol.handle).mock.calls[0];
    expect(scheme).toBe('sf-asset');

    handles.cookieRefresher.stop();
    handles.renderWorker.stop();
    handles.heartbeat.stop();
    handles.updater.stop();
  });

  it('defaults apiBase to https://your-domain.example.com when omitted', async () => {
    const handles = await bootstrapShell(windowStub, 'machine-1', noopLogger);

    const rwOpts = vi.mocked(startRenderWorker).mock.calls[0][0];
    const hbOpts = vi.mocked(startHeartbeat).mock.calls[0][0];
    const upOpts = vi.mocked(startUpdater).mock.calls[0][0];

    expect(rwOpts.apiBase).toBe('https://your-domain.example.com');
    expect(hbOpts.apiBase).toBe('https://your-domain.example.com');
    expect(upOpts.apiBase).toBe('https://your-domain.example.com');

    handles.cookieRefresher.stop();
    handles.renderWorker.stop();
    handles.heartbeat.stop();
    handles.updater.stop();
  });

  it('拉槽位失败（fetch reject）→ 回退 1 槽（老服务器/断网安全）', async () => {
    vi.mocked(fetchHeartbeatOnce).mockRejectedValueOnce(new Error('network down'));

    const handles = await bootstrapShell(windowStub, 'machine-1', noopLogger);

    const rwOpts = vi.mocked(startRenderWorker).mock.calls[0][0];
    expect(rwOpts.slots).toBe(1);

    handles.cookieRefresher.stop();
    handles.renderWorker.stop();
    handles.heartbeat.stop();
    handles.updater.stop();
  });
});

describe('stopShell', () => {
  it('calls stop on all four service handles', async () => {
    const rwStop = vi.fn(async () => {});
    const hbStop = vi.fn();
    const upStop = vi.fn();
    const crStop = vi.fn();
    const handles: ShellHandles = {
      renderWorker: { stop: rwStop },
      heartbeat: { stop: hbStop },
      updater: { stop: upStop, checkNow: vi.fn() },
      cookieRefresher: { stop: crStop, getAuthCookie: vi.fn(), refreshNow: vi.fn() },
      logger: noopLogger,
    };

    await stopShell(handles);

    expect(rwStop).toHaveBeenCalledTimes(1);
    expect(hbStop).toHaveBeenCalledTimes(1);
    expect(upStop).toHaveBeenCalledTimes(1);
    expect(crStop).toHaveBeenCalledTimes(1);
  });

  it('is null-safe (null → no-op, no throw)', async () => {
    await expect(stopShell(null)).resolves.toBeUndefined();
  });

  it('bounds Electron shutdown if the render-worker drain never settles', async () => {
    vi.useFakeTimers();
    try {
      const rwStop = vi.fn(() => new Promise<void>(() => {}));
      const hbStop = vi.fn();
      const upStop = vi.fn();
      const crStop = vi.fn();
      const logger = { ...noopLogger, warn: vi.fn() };
      const handles: ShellHandles = {
        renderWorker: { stop: rwStop },
        heartbeat: { stop: hbStop },
        updater: { stop: upStop, checkNow: vi.fn() },
        cookieRefresher: { stop: crStop, getAuthCookie: vi.fn(), refreshNow: vi.fn() },
        logger,
      };

      let settled = false;
      const stopping = stopShell(handles, 100).then(() => {
        settled = true;
      });

      expect(rwStop).toHaveBeenCalledWith(100);
      expect(hbStop).toHaveBeenCalledTimes(1);
      expect(upStop).toHaveBeenCalledTimes(1);
      expect(crStop).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(settled).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        'shell render-worker drain timed out',
        { timeoutMs: 100 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Electron shutdown drain', () => {
  it('prevents before-quit until the render-worker drain settles', async () => {
    let finishDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const rwStop = vi.fn(() => drain);
    vi.mocked(startRenderWorker).mockReturnValueOnce({ stop: rwStop });

    startShell();
    await vi.waitFor(() => expect(startRenderWorker).toHaveBeenCalledTimes(1));

    const beforeQuitCall = vi.mocked(app.on).mock.calls.find(
      ([eventName]) => eventName === 'before-quit',
    );
    expect(beforeQuitCall).toBeDefined();
    const preventDefault = vi.fn();
    const beforeQuit = beforeQuitCall![1] as unknown as (event: {
      preventDefault: () => void;
    }) => void;
    beforeQuit({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    // SHELL_DRAIN_TIMEOUT_MS 已随多槽 worker 提升到 30s（N 执行 × 报告冲刷）。
    expect(rwStop).toHaveBeenCalledWith(30_000);
    expect(app.quit).not.toHaveBeenCalled();

    finishDrain();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
  });
});

// P4 Task 1 — sf-asset:// scheme + protocol handler wiring.

describe('registerPrivilegedSchemes', () => {
  it('registers sf-asset as privileged with secure + stream + fetchAPI flags', () => {
    registerPrivilegedSchemes();

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const [entries] = vi.mocked(protocol.registerSchemesAsPrivileged).mock.calls[0];
    expect(entries).toHaveLength(1);
    expect(entries[0].scheme).toBe('sf-asset');
    // secure: renderer on https can load it (no mixed-content block).
    // stream: protocol.handle can return a streamed body (large videos).
    // supportFetchAPI: renderer fetch(sf-asset://...) works (for future use).
    expect(entries[0].privileges.secure).toBe(true);
    expect(entries[0].privileges.stream).toBe(true);
    expect(entries[0].privileges.supportFetchAPI).toBe(true);
    expect(entries[0].privileges.standard).toBe(true);
  });
});

describe('registerAssetProtocol', () => {
  it('registers exactly one protocol.handle for sf-asset', () => {
    registerAssetProtocol('/tmp/sf-test-clips');

    expect(protocol.handle).toHaveBeenCalledTimes(1);
    const [scheme] = vi.mocked(protocol.handle).mock.calls[0];
    expect(scheme).toBe('sf-asset');
  });
});
