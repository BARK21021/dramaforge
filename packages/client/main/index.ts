// ============================================================
// ⑪ client/shell — Electron thin shell (Approach A) — main entry
// ============================================================
//
// Approach A: a BrowserWindow loads the cloud UI (https://your-domain.example.com) and
// the LOCAL render-worker + 3 ops skeletons (heartbeat / updater / logger) are
// bootstrapped in this main process. ffmpeg runs ONLY here (inside the
// render-worker) — it is NEVER exposed to the renderer (contextIsolation: true,
// nodeIntegration: false, preload exposes only three invoke helpers).
//
// Bootstrap order (on app.whenReady):
//   1. single-instance lock (quit if a second instance)
//   2. machineId = loadOrCreateMachineId()
//   3. logger = createLogger({ machineId, logDir, apiBase })
//   4. BrowserWindow loading resolveLoadUrl() (SF_DEV_URL or prod)
//   5. bootstrapShell() → cookie refresher + render-worker + heartbeat + updater
//                        + IPC handlers for the preload bridge
//
// Shutdown: on window-all-closed, stop render-worker / heartbeat / updater /
// cookie refresher, then quit (unless macOS, per Electron convention).
//
// authCookie wiring: ⑨'s `startRenderWorker` takes a STATIC `authCookie?: string`.
// To give it a fresh cookie each poll cycle (the user may log in/out mid-job)
// WITHOUT modifying ⑨'s code, we construct the opts with a property getter
// `get authCookie()` that reads the cookie refresher's sync cache on each
// access. ⑨ reads `opts.authCookie` inside its `authHeaders()` each poll, so
// the getter is evaluated per-poll → always carries the latest cookie.

import { app, BrowserWindow, session, ipcMain, dialog, shell, protocol, net, type MessageBoxOptions } from 'electron';
import { join, dirname, sep, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { copyFile, rm, writeFile, readFile, mkdtemp, stat } from 'node:fs/promises';
import { copyFileSync, existsSync, createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import os from 'node:os';
import { loadOrCreateMachineId } from './machine-id';
import {
  startCookieRefresher,
  electronCookieStore,
  type CookieRefresher,
} from './auth-cookie';
import { SF_IPC_CHANNELS } from './ipc-channels';
import {
  CLIP_PROTOCOL,
  clipsDirFrom,
  downloadAsset,
  newClipId,
  parseProtocolUrl,
  resolveClipKeyPath,
  resolveClipUrl,
  saveLocalAsset,
  copyLocalAsset,
  readAssetToBaseUrl,
  originalUploadsDirFrom,
  stageOriginalUpload,
  stageOriginalUploadFromPath,
  parseRange,
  mimeForExt,
} from './asset-store';
import {
  listPresetVoices,
  readPresetVoice,
} from './voice-store';
import { exportProjectBundle, importProjectBundle } from './project-bundle';
import { createLogger } from '../src/ops/logger';
import type { Logger } from '../src/ops/logger';
import {
  getVideoDuration,
  probeVideoHeight,
  downscaleVideoToHeight,
  cutReferenceVideo,
  exportContentDepthMap,
  type ReferenceVideoCutProgress,
  type DepthMapProgress,
} from '../src/ffmpeg';
import { startRenderWorker } from '../src/render-worker';
import type { StartRenderWorkerOptions, RenderWorkerHandle } from '../src/render-worker';
import { startHeartbeat, fetchHeartbeatOnce } from '../src/ops/heartbeat';
import type { HeartbeatHandle } from '../src/ops/heartbeat';
import { startUpdater } from '../src/ops/updater';
import type { UpdaterHandle, ManualCheckResult } from '../src/ops/updater';
import { orchestrators } from '../src/orchestrators';
import {
  isLocalMode,
  startLocalServer,
  stopLocalServer,
  getLocalServerUrl,
} from './local-mode';

const API_BASE = 'https://your-domain.example.com';
const COOKIE_DOMAIN = 'your-domain.example.com';
const SHELL_DRAIN_TIMEOUT_MS = 5_000;
/**
 * Ed25519 公钥（base64 SPKI DER），验签更新包防供应链投毒。
 * 由 scripts/gen-update-key.mjs 一次性离线生成，私钥永不进服务器/git。
 * ⚠ 生产必须填入真实公钥；空串 = dev 未配置（updater 跳过验签 + 警告，无保护）。
 */
const UPDATE_SIGNING_PUBLIC_KEY = 'MCowBQYDK2VwAyEA/AT+kH+XI8Aaf857U2vyILv77DJxRFX1qFDQB8ivQWQ=';

/**
 * I6 — scheme-allowlisted `shell.openExternal`.
 *
 * Single source of truth for "open URL in system default handler" so the
 * http(s)-only constraint can't drift between call-sites. Refuses any other
 * scheme (file://, javascript:, custom protocols...) so a compromised
 * renderer (or a tampered update manifest feeding handleForceUpgrade) cannot
 * smuggle an arbitrary URI to the OS shell.
 *
 * Same allowlist as the legacy `SF_IPC_CHANNELS.openExternal` handler below;
 * both paths now share this implementation.
 */
export async function safeOpenExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`openExternal: invalid url: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`openExternal: refused scheme ${parsed.protocol}`);
  }
  await shell.openExternal(url);
}

/** All started service handles — used for graceful shutdown. */
export interface ShellHandles {
  renderWorker: RenderWorkerHandle;
  heartbeat: HeartbeatHandle | null;
  updater: UpdaterHandle | null;
  cookieRefresher: CookieRefresher | null;
  logger: Logger;
}

/**
 * Resolve the URL the BrowserWindow loads.
 * - `SF_DEV_URL` env (local dev server) when set — for hot-reload dev.
 * - Otherwise the production cloud UI at your-domain.example.com.
 */
export function resolveLoadUrl(): string {
  // Local mode: return the local server URL
  if (isLocalMode()) {
    return getLocalServerUrl() ?? 'http://127.0.0.1:0';
  }
  return process.env.SF_DEV_URL ?? API_BASE;
}

/** Map Node's `process.platform` to the updater's os union. */
export function mapOs(p: NodeJS.Platform): 'win' | 'mac' | 'linux' {
  if (p === 'win32') return 'win';
  if (p === 'darwin') return 'mac';
  return 'linux';
}

/**
 * Force-upgrade 终端处理（heartbeat 报 status=force_upgrade）。
 * 版本过低必须升级才能用 → block 弹窗（唯一按钮）→ 打开下载页 → app.quit()。
 * 调用方（onForceUpgrade）已用本地 guard 保证一次会话只触发一次。
 */
export async function handleForceUpgrade(
  resp: { minVersion: string; downloadUrl: string },
  logger: Logger,
): Promise<void> {
  // 整段包 try：dialog/shell/BrowserWindow 任一失败都不阻断退出。
  // finally 始终 quit——force_upgrade 必须终止当前会话（版本过低不可继续用）。
  try {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: MessageBoxOptions = {
      type: 'warning',
      title: '必须升级',
      message: `您的 DramaForge 客户端版本过低，必须升级到 ${resp.minVersion} 或以上才能继续使用。`,
      buttons: ['打开下载页并退出'],
      noLink: true,
    };
    if (win) await dialog.showMessageBox(win, opts);
    else await dialog.showMessageBox(opts);
    // I6 — 走 safeOpenExternal 防 downloadUrl 被篡改成 file:// / 任意 scheme。
    // downloadUrl 来自 server update-manifest(可信度低于本地配置),用 scheme
    // 白名单兜底,失败仅记日志(不打断退出流程)。
    if (resp.downloadUrl) {
      try {
        await safeOpenExternal(resp.downloadUrl);
      } catch (err) {
        logger.error('force_upgrade: openExternal refused', {
          url: resp.downloadUrl,
          err: String(err),
        });
      }
    }
  } catch (err) {
    logger.error('force_upgrade handler failed', { err: String(err) });
  } finally {
    app.quit();
  }
}

/**
 * 提示后安装（updater 报 onDownloaded，新版本已静默下载完成）。
 * 弹非阻塞提示 → 用户确认 → copy 到 .exe（原件保留便于重试）→ spawn NSIS `/S`
 * 静默安装 → app.quit() 释放文件锁；NSIS runAfterFinish 默认重启新版本。
 * force=true 时措辞更强且默认选"立即安装"，但仍可"稍后"（真正硬拦截走 heartbeat force_upgrade）。
 */
export async function promptAndInstall(
  info: { version: string; path: string; force: boolean },
  logger: Logger,
): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const message = info.force
    ? `检测到必须升级的新版本 ${info.version}，建议立即安装并重启。`
    : `新版本 ${info.version} 已就绪，是否立即安装并重启？`;
  const opts: MessageBoxOptions = {
    type: info.force ? 'warning' : 'info',
    title: 'DramaForge 更新',
    message,
    buttons: ['立即安装并重启', '稍后'],
    defaultId: info.force ? 0 : 1,
    cancelId: 1,
    noLink: true,
  };
  let confirm = false;
  try {
    const result = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    confirm = result.response === 0;
  } catch (err) {
    logger.error('update prompt dialog failed', { err: String(err) });
    return;
  }
  if (!confirm) {
    logger.info('update deferred by user', { version: info.version });
    return;
  }
  logger.info('update install: launching NSIS installer', { version: info.version });

  // updater 把包存为 `${version}-update`（无扩展名）；Windows CreateProcess 需 .exe。
  // copy 一份到 .exe，原件保留以便安装失败重试。
  const exePath = `${info.path}.exe`;
  try {
    copyFileSync(info.path, exePath);
  } catch (err) {
    logger.error('update install: copy to .exe failed', { err: String(err) });
    return;
  }
  try {
    // /S 静默安装；detached + unref 使其在父进程退出后继续运行。
    const child = spawn(exePath, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    logger.error('update install: spawn installer failed', { err: String(err) });
    return;
  }
  // 退出当前进程释放文件锁让安装器替换；NSIS runAfterFinish 自动重启新版。
  setTimeout(() => app.quit(), 1500);
}

/**
 * Create the shell BrowserWindow loading `loadUrl`.
 *
 * webPreferences lock the renderer down: contextIsolation ON, nodeIntegration
 * OFF, preload script wired. The renderer (cloud web page) CANNOT touch
 * ffmpeg / fs / node — only the three `sfShell` invoke helpers from the preload.
 */
export function createShellWindow(loadUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.js'),
    },
  });
  void win.loadURL(loadUrl);

  // 生产客户端锁定：禁用刷新(Ctrl/Cmd+R)与开发者工具(Ctrl+Shift+I / F12)快捷键。
  // before-input-event 在菜单 accelerator 之前触发，preventDefault 即可拦截。
  // 用户改用页面内右上角圆形刷新按钮整页刷新。
  win.webContents.on('before-input-event', (event, input) => {
    const lc = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    if (
      (ctrl && lc === 'r') || // Ctrl/Cmd+R 刷新
      (ctrl && input.shift && lc === 'i') || // Ctrl/Cmd+Shift+I 开 devtools
      lc === 'f12' // F12 开 devtools
    ) {
      event.preventDefault();
    }
  });

  return win;
}

/**
 * Bootstrap the render-worker + 3 ops skeletons. Called from app.whenReady()
 * after the window exists (so `session.defaultSession` is available for cookie
 * reads).
 *
 * The render-worker's `authCookie` is a property GETTER that reads the cookie
 * refresher's sync cache on each access — ⑨'s loop reads `opts.authCookie`
 * every poll cycle, so the worker always carries the latest cookie. This
 * adapts ⑨'s static-string `authCookie` to a fresh-each-poll source WITHOUT
 * modifying ⑨'s committed code.
 *
 * @param window   The shell BrowserWindow (its session holds the auth cookie).
 * @param machineId  Stable per-machine id.
 * @param logger   Rolling local logger (also forwarded into the render-worker).
 * @param apiBase  Cloud server base URL. Defaults to your-domain.example.com.
 */
export function bootstrapShell(
  window: BrowserWindow,
  machineId: string,
  logger: Logger,
  apiBase: string = API_BASE,
  slots?: number,
): ShellHandles {
  void window; // window arg reserved for future direct-session wiring; cookie
  // read uses the defaultSession below which is the window's session in the
  // single-window Approach-A shell.

  // --- Cookie refresher: cache NextAuth session cookie for sync access. ---
  const cookieRefresher = startCookieRefresher(
    electronCookieStore(session.defaultSession),
    COOKIE_DOMAIN,
  );

  // --- Render-worker: authCookie getter adapts ⑨'s static string to fresh-each-poll. ---
  const renderWorkerOpts: StartRenderWorkerOptions = {
    apiBase,
    machineId,
    logger,
    orchestrators,
    slots,
    // P5: films are client-local — CONCAT writes to userData/clips/ and the
    // renderer plays them via sf-asset:// (same protocol/dir P4 clips use).
    filmsDir: clipsDirFrom(app.getPath('userData')),
    voicesDir: voicesRootPath(),
    toAssetUrl: resolveClipUrl,
    get authCookie(): string | undefined {
      return cookieRefresher.getAuthCookie();
    },
  };
  const renderWorker = startRenderWorker(renderWorkerOpts);

  // --- Heartbeat: 30s cadence + force_upgrade lockout callback. ---
  // force_upgrade = 版本过低必须升级。onForceUpgrade 弹 block 窗 → 开下载页 → 退出。
  // heartbeat 每 30s 触发，用本地 guard 防重复弹窗（退出前一次会话只处理一次）。
  let forceUpgradeHandled = false;
  const heartbeat = startHeartbeat({
    version: app.getVersion(),
    machineId,
    apiBase,
    onForceUpgrade: (resp) => {
      if (forceUpgradeHandled) return;
      forceUpgradeHandled = true;
      logger.error('force_upgrade received — must upgrade', {
        current: app.getVersion(),
        minVersion: resp.minVersion,
        latestVersion: resp.latestVersion,
      });
      void handleForceUpgrade(resp, logger);
    },
  });

  // --- Updater: silent download to userData/updates. ---
  const cacheDir = join(app.getPath('userData'), 'updates');
  const updater = startUpdater({
    currentVersion: app.getVersion(),
    os: mapOs(process.platform),
    apiBase,
    cacheDir,
    publicKey: UPDATE_SIGNING_PUBLIC_KEY,
    onDownloaded: (info) => {
      logger.info('update downloaded', {
        version: info.version,
        path: info.path,
        force: info.force,
      });
      // 静默下载完成 → 提示后安装（用户确认才跑 NSIS 安装器）。
      void promptAndInstall(info, logger);
    },
  });

  // --- IPC handlers for the preload bridge. ---
  registerIpcHandlers(machineId, updater);

  // --- P4 Task 1: register sf-asset:// protocol to serve local clips. ---
  // The privileged scheme itself is registered in startShell() BEFORE
  // whenReady (registerSchemesAsPrivileged freezes at app start). The handler
  // is wired here, after whenReady, against the resolved clips dir.
  registerAssetProtocol(clipsDirFrom(app.getPath('userData')));

  return { renderWorker, heartbeat, updater, cookieRefresher, logger };
}


/**
 * Bootstrap for local mode: starts render-worker + IPC + asset protocol,
 * but skips cloud-specific services (cookie refresher, heartbeat, updater).
 */
export function bootstrapShellLocal(
  window: BrowserWindow,
  machineId: string,
  logger: Logger,
  slots?: number,
): ShellHandles {
  void window;

  // In local mode, the authCookie comes from the local server's session cookie
  // which is set by the Fastify auth module. We can read it from the session.
  const localApiBase = getLocalServerUrl() ?? 'http://127.0.0.1:0';

  const renderWorkerOpts: StartRenderWorkerOptions = {
    apiBase: localApiBase,
    machineId,
    logger,
    orchestrators,
    filmsDir: clipsDirFrom(app.getPath('userData')),
    voicesDir: voicesRootPath(),
    toAssetUrl: resolveClipUrl,
    // Local mode: no authCookie needed (local server uses its own cookie)
    get authCookie(): string | undefined {
      return undefined;
    },
  };
  const renderWorker = startRenderWorker(renderWorkerOpts);

  // No cloud heartbeat/updater in local mode
  registerIpcHandlers(machineId, null);
  registerAssetProtocol(clipsDirFrom(app.getPath('userData')));

  return { renderWorker, heartbeat: null, updater: null, cookieRefresher: null, logger };
}

/**
 * 批6 音色库: 解析 resources/voices 绝对路径（dev + 打包两路径）。
 *
 * dev（未打包，esbuild bundle 后 __dirname = <client>/dist-main）：
 *   voices 根 = `<client>/resources/voices` = `path.join(__dirname, '..', 'resources', 'voices')`
 *
 * 打包后（electron-builder extraResources `to: voices`）：
 *   voices 根 = `<app>/resources/voices` = `path.join(process.resourcesPath, 'voices')`
 *
 * 与 @ffmpeg-installer/ffmpeg 的运行时路径解析模式对齐（其内部也按
 * app.isPackaged 切换），但这里我们直接拿 process.resourcesPath 而非走
 * installer 模块（wav 不是 npm 包，得自己解析）。
 */
export function voicesRootPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'voices')
    : join(__dirname, '..', 'resources', 'voices');
}

/** Path to bundled scripts dir (gen_depth.py etc.). Packaged: resources/scripts/ */
export function scriptsRootPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'scripts')
    : join(__dirname, '..', 'resources', 'scripts');
}

/** Path to bundled depth-models dir (offline model weights). Empty in cloud builds. */
export function depthModelsRootPath(): string {
  // Priority: user-selected > bundled > userData
  const cfg = readDepthEnvConfig();
  if (cfg.modelsPath && existsSync(cfg.modelsPath)) return cfg.modelsPath;
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'depth-models');
    if (existsSync(bundled)) return bundled;
  }
  return join(app.getPath('userData'), 'depth-models');
}

/** Path to a bundled python-env (Local build only). Empty string in cloud build. */
/** Read depth env config (user-selected paths). */
function readDepthEnvConfig(): { pythonPath?: string; modelsPath?: string } {
  try {
    const p = join(app.getPath('userData'), 'depth-env-config.json');
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** Write depth env config. */
function writeDepthEnvConfig(cfg: { pythonPath?: string; modelsPath?: string }): void {
  try {
    const p = join(app.getPath('userData'), 'depth-env-config.json');
    writeFileSync(p, JSON.stringify(cfg), 'utf8');
  } catch (err) {
    console.error('[shell] writeDepthEnvConfig failed:', err);
  }
}

export function bundledPythonEnvPath(): string {
  // Priority: user-selected > bundled > extracted > system
  const cfg = readDepthEnvConfig();
  if (cfg.pythonPath && existsSync(cfg.pythonPath)) return cfg.pythonPath;
  if (app.isPackaged) {
    const direct = join(process.resourcesPath, 'python-env', 'python.exe');
    if (existsSync(direct)) return direct;
    const extracted = join(app.getPath('userData'), 'python-env', 'python.exe');
    if (existsSync(extracted)) return extracted;
  }
  return '';
}

/**
 * Local build first-run: extract bundled python-env.tar.gz + depth-models.tar.gz
 * from resources/bundles/ into userData/. Skipped if already extracted or if
 * bundles are absent (cloud build). Uses tar.exe (available on Windows 10+).
 */
async function extractBundledDepthEnv(logger: Logger): Promise<void> {
  if (!app.isPackaged) return;
  const bundlesDir = join(process.resourcesPath, 'bundles');
  if (!existsSync(bundlesDir)) return; // Cloud build: no bundles

  const userData = app.getPath('userData');
  const pyEnvDir = join(userData, 'python-env');
  const modelDir = join(userData, 'depth-models');

  // Check if already extracted (python.exe exists).
  if (existsSync(join(pyEnvDir, 'python.exe')) && existsSync(modelDir)) {
    return; // Already extracted
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const pyBundle = join(bundlesDir, 'python-env.tar.gz');
  const modelBundle = join(bundlesDir, 'depth-models.tar.gz');

  // Extract python-env
  if (existsSync(pyBundle) && !existsSync(join(pyEnvDir, 'python.exe'))) {
    logger.info?.('[shell] Extracting bundled python-env (first run)...');
    try {
      await execFileAsync('tar', ['-xzf', pyBundle, '-C', userData], {
        timeout: 600_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      logger.info?.('[shell] python-env extracted');
    } catch (err) {
      logger.error?.('[shell] Failed to extract python-env', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Extract depth-models
  if (existsSync(modelBundle) && !existsSync(modelDir)) {
    logger.info?.('[shell] Extracting bundled depth-models (first run)...');
    try {
      await execFileAsync('tar', ['-xzf', modelBundle, '-C', userData], {
        timeout: 600_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      logger.info?.('[shell] depth-models extracted');
    } catch (err) {
      logger.error?.('[shell] Failed to extract depth-models', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Download a file from the first reachable mirror base URL. Tries each mirror
 * in order; reports progress (0..1) via onProgress.
 */
async function downloadFromMirrors(
  mirrors: string[],
  fileName: string,
  outPath: string,
  onProgress?: (p: number) => void,
): Promise<void> {
  let lastError: Error | null = null;
  for (const base of mirrors) {
    const url = base.replace(/[\/]+$/, '') + '/' + fileName;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = net.request(url);
        req.on('response', (res) => {
          if (res.statusCode !== 200) {
            reject(new Error('HTTP ' + res.statusCode));
            return;
          }
          const total = parseInt(String(res.headers['content-length']), 10) || 0;
          let received = 0;
          const out = require('node:fs').createWriteStream(outPath);
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (total > 0) onProgress?.(received / total);
            out.write(chunk);
          });
          res.on('end', () => {
            out.end(() => resolve());
          });
          out.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      return; // success
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error('所有镜像下载失败');
}

/** Extract a .tar.gz file to destDir using tar.exe (available on Windows 10+). */
async function extractTarGz(tarPath: string, destDir: string, onProgress?: (msg: string) => void): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  // Use verbose mode to get per-file progress to stderr; parse for progress reporting.
  // 3600s timeout (1 hour) — 2.38GB extraction on slow HDD can take 10+ minutes.
  await execFileAsync('tar', ['-xzvf', tarPath, '-C', destDir], {
    timeout: 3_600_000,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
}

/** Register ipcMain.handle handlers backing the preload's `sfShell` bridge. */
export function registerIpcHandlers(
  machineId: string,
  updater: UpdaterHandle | null,
): void {
  ipcMain.handle(SF_IPC_CHANNELS.getAppVersion, () => app.getVersion());
  ipcMain.handle(SF_IPC_CHANNELS.getMachineId, () => machineId);
  ipcMain.handle(SF_IPC_CHANNELS.triggerUpdateCheck, async () => {
    await (updater ?? null)?.checkNow();
  });
  // 手动检查更新（设置页"检查更新"按钮）。区别于 triggerUpdateCheck：
  //   - 调 manual 模式 → updater 返结构化 ManualCheckResult，renderer toast 反馈。
  //   - 新版已缓存时，updater 内部再次触发 onDownloaded → 上面的 promptAndInstall
  //     重弹"重启以安装"对话框（用户之前推迟过、现在主动重查）。
  //   - 永远 resolve（不 reject）：网络/下载错误也走 { outcome: 'network-error' }。
  ipcMain.handle(SF_IPC_CHANNELS.checkForUpdate, async (): Promise<ManualCheckResult> => {
    if (!updater) return { outcome: 'not-available' } as unknown as ManualCheckResult;
    return await updater.checkNow({ manual: true });
  });
  // P4 Task 1: download a remote asset URL to userData/clips/<clipId>.<ext>.
  // Returns the structured DownloadAssetResult envelope (never rejects) — the
  // renderer toasts on { ok: false }. localPath is stripped from the wire
  // payload (renderer only needs the protocolUrl to feed `<video>`/`<img>`).
  // `opts.ext` is optional; when absent, downloadAsset infers from URL suffix
  // / Content-Type / falls back to 'mp4' (backward-compat).
  ipcMain.handle(
    SF_IPC_CHANNELS.downloadAsset,
    async (_evt, url: unknown, opts?: { ext?: string }) => {
      if (typeof url !== 'string') {
        return {
          ok: false,
          error: { code: 'INVALID_URL', message: `downloadAsset: URL must be a string, got ${typeof url}` },
        } as const;
      }
      const clipsDir = clipsDirFrom(app.getPath('userData'));
      const result = await downloadAsset(url, {
        clipId: newClipId(),
        clipsDir,
        ext: opts?.ext,
      });
      if (!result.ok) return result; // forward { ok: false, error }
      // Strip localPath before crossing to the renderer.
      return { ok: true, key: result.key, protocolUrl: result.protocolUrl } as const;
    },
  );
  // 批2a: write renderer-supplied bytes (user-picked File / cloud-AI result) to
  // userData/clips/<clipId>.<ext>. C/S inverse of downloadAsset: the renderer
  // hands bytes across IPC once; the cloud server only sees the sf-asset://
  // key (server holds zero media bytes — dramaforge-assets-client-local).
  // Returns the structured DownloadAssetResult envelope (never rejects);
  // localPath stripped before crossing to the renderer.
  ipcMain.handle(
    SF_IPC_CHANNELS.saveLocalAsset,
    async (_evt, bytes: unknown, opts?: { ext?: string }) => {
      if (!(bytes instanceof Uint8Array)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: `saveLocalAsset: bytes must be a Uint8Array, got ${
              bytes === null ? 'null' : typeof bytes
            }`,
          },
        } as const;
      }
      const clipsDir = clipsDirFrom(app.getPath('userData'));
      const result = await saveLocalAsset(bytes, {
        clipId: newClipId(),
        clipsDir,
        ext: opts?.ext,
      });
      if (!result.ok) return result;
      return { ok: true, key: result.key, protocolUrl: result.protocolUrl } as const;
    },
  );
  // 季继承: copy a local sf-asset:// file to a fresh key (源季图 → 目标季新 key).
  // 同机 copyFile, zero network. Source must exist locally (else READ_ERROR —
  // e.g. source asset generated on another machine). Returns DownloadAssetResult
  // envelope (never rejects); localPath stripped before crossing to the renderer.
  ipcMain.handle(
    SF_IPC_CHANNELS.copyLocalAsset,
    async (_evt, srcProtocolUrl: unknown) => {
      if (typeof srcProtocolUrl !== 'string') {
        return {
          ok: false,
          error: {
            code: 'INVALID_URL',
            message: `copyLocalAsset: srcProtocolUrl must be a string, got ${
              srcProtocolUrl === null ? 'null' : typeof srcProtocolUrl
            }`,
          },
        } as const;
      }
      const clipsDir = clipsDirFrom(app.getPath('userData'));
      const result = await copyLocalAsset(srcProtocolUrl, {
        clipsDir,
        destClipId: newClipId(),
      });
      if (!result.ok) return result;
      return { ok: true, key: result.key, protocolUrl: result.protocolUrl } as const;
    },
  );
  // 批4: read a local sf-asset:// file back to base64 data URL (cloud AI i2i
  // seam — ARK/ComfyUI can't fetch client-local sf-asset://, so the renderer
  // reads bytes here and POSTs them as a data: URL the gateway passes through).
  // Returns ReadAssetResult (never rejects).
  ipcMain.handle(
    SF_IPC_CHANNELS.readAssetToBaseUrl,
    async (_evt, protocolUrl: unknown) => {
      if (typeof protocolUrl !== 'string') {
        return {
          ok: false,
          error: {
            code: 'INVALID_URL',
            message: `readAssetToBaseUrl: protocolUrl must be a string, got ${
              protocolUrl === null ? 'null' : typeof protocolUrl
            }`,
          },
        } as const;
      }
      const clipsDir = clipsDirFrom(app.getPath('userData'));
      return await readAssetToBaseUrl(protocolUrl, clipsDir);
    },
  );
  // P6: open an external URL in the system default handler (Alipay 收银台).
  // 安全力：只允许 http(s) —— 防 renderer 被攻陷后打开任意 scheme（file:// 等）。
  // 校验在 main 进程做（renderer 不可信），通过才 shell.openExternal。
  // I6 — scheme 校验集中到 safeOpenExternal,与 handleForceUpgrade 共用一套。
  ipcMain.handle(SF_IPC_CHANNELS.openExternal, async (_evt, url: unknown) => {
    if (typeof url !== 'string') {
      throw new Error(`openExternal: url must be a string, got ${typeof url}`);
    }
    await safeOpenExternal(url);
  });

  // 批8 R3: 另存成片到用户选定位。
  // sf-asset:// 是 Electron 自定义 scheme，Chromium `<a download>` 不触发 save-as
  // (R3 真 bug)。renderer 调 sfShell.saveFilm(localKey, suggestedName) → main 进程
  // 弹 showSaveDialog + fs.copyFile(clipsDir/localKey, chosenPath)。
  // localKey 走 resolveClipKeyPath 做 CLIP_KEY_RE + path-traversal 防御。
  // never rejects: 返结构化结果 envelope（{ok:true} / {ok:false,error}）。
  ipcMain.handle(
    SF_IPC_CHANNELS.saveFilm,
    async (_evt, localKey: unknown, suggestedName?: unknown) => {
      if (typeof localKey !== 'string') {
        return {
          ok: false,
          error: {
            code: 'INVALID_KEY',
            message: `saveFilm: localKey must be a string, got ${typeof localKey}`,
          },
        } as const;
      }
      const clipsDir = clipsDirFrom(app.getPath('userData'));
      const srcPath = resolveClipKeyPath(localKey, clipsDir);
      if (!srcPath) {
        return {
          ok: false,
          error: {
            code: 'INVALID_KEY',
            message: `saveFilm: localKey failed path validation: ${localKey}`,
          },
        } as const;
      }
      // 建议文件名（sanitize：去路径分隔符，强制 .mp4 扩展名）
      const safeName =
        typeof suggestedName === 'string' && suggestedName.length > 0
          ? suggestedName.replace(/[\\/:*?"<>|]/g, '_')
          : 'film';
      const defaultFileName = safeName.endsWith('.mp4') ? safeName : `${safeName}.mp4`;
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      try {
        const result = win
          ? await dialog.showSaveDialog(win, {
              defaultPath: defaultFileName,
              filters: [{ name: 'MP4', extensions: ['mp4'] }],
            })
          : await dialog.showSaveDialog({
              defaultPath: defaultFileName,
              filters: [{ name: 'MP4', extensions: ['mp4'] }],
            });
        if (result.canceled || !result.filePath) {
          return { ok: false, error: { code: 'USER_CANCELLED', message: '用户取消保存' } } as const;
        }
        await copyFile(srcPath, result.filePath);
        return { ok: true, savedPath: result.filePath } as const;
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'SAVE_FAILED',
            message: `saveFilm: copyFile failed: ${String(err)}`,
          },
        } as const;
      }
    },
  );

  // B5b: 另存资产图片到用户选定位（图片历史下载）。
  // sf-asset:// 的 <img> 不能触发 <a download> save-as（同 saveFilm R3 bug）。
  // renderer 调 sfShell.saveAsset(localKey, suggestedName) → main 弹 showSaveDialog +
  // fs.copyFile(clipsDir/localKey, chosenPath)。图片扩展名从 localKey 推断，默认 png。
  ipcMain.handle(
    SF_IPC_CHANNELS.saveAsset,
    async (_evt, localKey: unknown, suggestedName?: unknown) => {
      if (typeof localKey !== 'string') {
        return {
          ok: false,
          error: {
            code: 'INVALID_KEY',
            message: `saveAsset: localKey must be a string, got ${typeof localKey}`,
          },
        } as const;
      }
      const clipsDir = clipsDirFrom(app.getPath('userData'));
      const srcPath = resolveClipKeyPath(localKey, clipsDir);
      if (!srcPath) {
        return {
          ok: false,
          error: {
            code: 'INVALID_KEY',
            message: `saveAsset: localKey failed path validation: ${localKey}`,
          },
        } as const;
      }
      // 图片扩展名优先取 localKey 后缀，否则默认 png。
      const extMatch = localKey.match(/\.([a-zA-Z0-9]+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      const safeName =
        typeof suggestedName === 'string' && suggestedName.length > 0
          ? suggestedName.replace(/[\\/:*?"<>|]/g, '_')
          : 'asset';
      const defaultFileName = /\.[a-zA-Z0-9]+$/.test(safeName) ? safeName : `${safeName}.${ext}`;
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      try {
        const result = win
          ? await dialog.showSaveDialog(win, {
              defaultPath: defaultFileName,
              filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
            })
          : await dialog.showSaveDialog({
              defaultPath: defaultFileName,
              filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
            });
        if (result.canceled || !result.filePath) {
          return { ok: false, error: { code: 'USER_CANCELLED', message: '用户取消保存' } } as const;
        }
        await copyFile(srcPath, result.filePath);
        return { ok: true, savedPath: result.filePath } as const;
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'SAVE_FAILED',
            message: `saveAsset: copyFile failed: ${String(err)}`,
          },
        } as const;
      }
    },
  );

  // 批8 R4: 删客户端本地成片文件（best-effort）。
  // renderer 调 sfShell.removeFilm(localKey) → main 进程 fs.rm(clipsDir/localKey)。
  // 文件不存在不报错（rm force:true），IPC 永远返 {ok:true}（除非 localKey 非法）。
  // DB render_jobs 行由 web DELETE route 删，本 IPC 只清本地文件（双面清理 R4）。
  ipcMain.handle(
    SF_IPC_CHANNELS.removeFilm,
    async (_evt, localKey: unknown) => {
      if (typeof localKey !== 'string') {
        return {
          ok: false,
          error: {
            code: 'INVALID_KEY',
            message: `removeFilm: localKey must be a string, got ${typeof localKey}`,
          },
        } as const;
      }
      const clipsDir = clipsDirFrom(app.getPath('userData'));
      const targetPath = resolveClipKeyPath(localKey, clipsDir);
      if (!targetPath) {
        return {
          ok: false,
          error: {
            code: 'INVALID_KEY',
            message: `removeFilm: localKey failed path validation: ${localKey}`,
          },
        } as const;
      }
      try {
        await rm(targetPath, { force: true });
        return { ok: true } as const;
      } catch (err) {
        // best-effort: 文件不存在已 force 跳过；其他错误（权限/IO）返失败但不崩
        return {
          ok: false,
          error: {
            code: 'REMOVE_FAILED',
            message: `removeFilm: fs.rm failed: ${String(err)}`,
          },
        } as const;
      }
    },
  );

  // 批6 音色库: 列出全部预置音色（读 resources/voices/manifest.json）。
  // main 进程按 app.isPackaged 解析 voices 根 → 读 manifest → 返 PresetVoice[]。
  // 服务器零媒体字节（wav 打包进客户端 exe，合规 dramaforge-assets-client-local）。
  // never rejects: 读 manifest 失败返 { ok:false, code, message }。
  ipcMain.handle(SF_IPC_CHANNELS.listPresetVoices, async () => {
    const voicesDir = voicesRootPath();
    return await listPresetVoices(voicesDir);
  });

  // 批6 音色库: 读单个预置 wav 为 data:audio/wav;base64,...（renderer 试听）。
  // 安全力: voice-store.readPresetVoice 三层校验（bare wav 名 + manifest allowlist
  // + path-in-voicesDir），任何路径穿透（../ 等）都被拒。
  // never rejects: 校验失败 / 读失败都返 { ok:false, code, message }。
  ipcMain.handle(
    SF_IPC_CHANNELS.readPresetVoice,
    async (_evt, file: unknown) => {
      if (typeof file !== 'string') {
        return {
          ok: false,
          code: 'INVALID_FILE',
          message: `readPresetVoice: file must be a string, got ${file === null ? 'null' : typeof file}`,
        } as const;
      }
      const voicesDir = voicesRootPath();
      return await readPresetVoice(file, voicesDir);
    },
  );

  // 转绘 X3.7: 把 OriginalRewriteStage 用户选的 3GB 整剧视频字节落到客户端
  // userData/original-uploads/<uuid>.<ext>，main 进程本地 ffmpeg -i probe duration
  // + stageOriginalUpload 已返 totalBytes，组装元数据返 renderer。
  //
  // 字节绝不上服务器（dramaforge-assets-client-local）：renderer 只把返回的 videoUrl
  // 作元数据 POST 到 /api/projects/[id]/original-video-upload，服务器只持 key + DB
  // 元数据，render-worker 后续按这个绝对路径本地 ffmpeg 切片。
  //
  // videoUrl 是绝对本地路径（非 sf-asset://）：后续 ffmpeg.splitVideoEvenly 直接
  // `ffmpeg -i <videoUrl>` 切片，sf-asset:// 是 Electron 内部 scheme，ffmpeg 无法
  // 解析。与 LongVideoRewriteInput.videoUrl 文档契约一致（file:// 或绝对路径）。
  //
  // 新契约（preferred）：preload 用 webUtils.getPathForFile(file) 在 renderer 侧
  // 解析出 File 的磁盘绝对路径，只把**路径字符串**过 IPC。main 直接 createReadStream
  // 流式 copy 到 original-uploads——**绝不把 ≤3GB 整块读进内存**（旧 arrayBuffer()
  // 路径撞 V8 单 ArrayBuffer / IPC 结构化克隆上限 → READ_ERROR →"本地暂存视频失败"）。
  //
  // 旧契约 fallback：renderer 没给路径（File 非原生 input 产生，如单测）时仍走字节
  // 路径（stageOriginalUpload）。新 preload 总给 filePath，此分支仅供兼容。
  //
  // never rejects：probe/IO/输入非法都走 { outcome:'cancelled', error }（对齐 web
  // OriginalRewriteStage.tsx OriginalVideoStageResult 契约）。
  ipcMain.handle(
    SF_IPC_CHANNELS.stageOriginalVideo,
    async (_evt, input: unknown) => {
      // 形状校验：input 必须是 { filePath?: string, file?: Blob-like, filename: string }。
      if (typeof input !== 'object' || input === null) {
        return {
          outcome: 'cancelled',
          error: {
            code: 'INVALID_INPUT',
            message: `stageOriginalVideo: input must be an object, got ${input === null ? 'null' : typeof input}`,
          },
        } as const;
      }
      const { filePath, file, filename } = input as {
        filePath?: unknown;
        file?: unknown;
        filename?: unknown;
      };
      if (typeof filename !== 'string' || filename.length === 0) {
        return {
          outcome: 'cancelled',
          error: {
            code: 'INVALID_INPUT',
            message: `stageOriginalVideo: input.filename must be a non-empty string, got ${filename === null ? 'null' : typeof filename}`,
          },
        } as const;
      }

      // 从 filename 抽扩展名（最后一个 '.' 后，小写化，去前导点）。
      // stageOriginalUpload(FromPath) 内部还会再校验 ext ∈ {mp4,webm,mov,mkv}。
      const dotIdx = filename.lastIndexOf('.');
      const ext = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : '';

      const originalUploadsDir = originalUploadsDirFrom(app.getPath('userData'));
      const hasFilePath = typeof filePath === 'string' && filePath.length > 0;
      const hasFileBlob =
        typeof file === 'object' && file !== null
        && typeof (file as { arrayBuffer?: unknown }).arrayBuffer === 'function';
      if (!hasFilePath && !hasFileBlob) {
        return {
          outcome: 'cancelled',
          error: {
            code: 'INVALID_INPUT',
            message:
              'stageOriginalVideo: need filePath (preferred, from webUtils.getPathForFile) or file (File/Blob with arrayBuffer())',
          },
        } as const;
      }

      // 原子写盘到 userData/original-uploads/<uuid>.<ext>。
      // 优先流式（filePath，不进内存）；fallback 字节（file，小文件/测试）。
      const staged = hasFilePath
        ? await stageOriginalUploadFromPath(filePath as string, {
            originalId: newClipId(),
            originalUploadsDir,
            ext,
          })
        : await (async () => {
            let bytes: Uint8Array;
            try {
              const buf = await (file as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
              bytes = new Uint8Array(buf);
            } catch (err) {
              return {
                ok: false as const,
                error: {
                  code: 'READ_ERROR' as const,
                  message: `stageOriginalVideo: read File bytes failed: ${String(err)}`,
                },
              };
            }
            return stageOriginalUpload(bytes, {
              originalId: newClipId(),
              originalUploadsDir,
              ext,
            });
          })();
      if (!staged.ok) {
        return {
          outcome: 'cancelled',
          error: staged.error,
        } as const;
      }

      // 本地 ffmpeg -i probe duration（@ffmpeg-installer/ffmpeg 只带 ffmpeg 二进制，
      // 故走 ffmpeg-pipeline.getVideoDuration 而非 ffprobe；返回 0 表示无法解析）。
      // probe 失败不阻断整流程——duration=0 会让后续 calculateKimiSegmentPlan 退化
      // 为按字节算段数（app1 同行为），renderer 会看到 totalDurationSec=0。
      let totalDurationSec = 0;
      try {
        totalDurationSec = await getVideoDuration(staged.localPath);
      } catch (err) {
        // 不视作 fatal：返 duration=0，renderer/server 可继续；错误记录在 IPC 响应里
        // 不便（会破坏 staged 形状），main 进程 console.error 兜底。
        console.error('[shell] stageOriginalVideo: ffmpeg duration probe failed:', err);
      }

      return {
        outcome: 'staged',
        videoUrl: staged.localPath,
        totalBytes: staged.totalBytes,
        totalDurationSec,
        filename,
      } as const;
    },
  );

  // 参考视频转绘：把已 staged 的原视频按场景切割成 ≤15s、720p 封顶的切片。
  // 输入 { videoPath, sceneThreshold?, maxHeight? }；输出到 videoPath 同目录的
  // `clips/` 子目录（clip-<i>.mp4）。进度经 cutReferenceVideoProgress 单向推送。
  // 字节只落客户端本地（dramaforge-assets-client-local）；renderer 后续经 presigned URL
  // 直传 MinIO。永不 reject：校验/IO/ffmpeg 失败都走 { ok:false, error }。
  ipcMain.handle(
    SF_IPC_CHANNELS.cutReferenceVideo,
    async (evt, input: unknown) => {
      const fail = (code: string, message: string) => ({ ok: false, error: { code, message } } as const);
      if (typeof input !== 'object' || input === null) {
        return fail('INVALID_INPUT', 'cutReferenceVideo: input must be an object');
      }
      const { videoPath, sceneThreshold, maxHeight } = input as {
        videoPath?: unknown;
        sceneThreshold?: unknown;
        maxHeight?: unknown;
      };
      if (typeof videoPath !== 'string' || videoPath.length === 0) {
        return fail('INVALID_INPUT', 'cutReferenceVideo: input.videoPath must be a non-empty string');
      }

      // 安全校验：只允许切割 original-uploads 目录下的本地文件（防止 renderer
      // 用任意路径驱动 ffmpeg 读取/写出用户文件系统任意位置）。
      const originalUploadsDir = originalUploadsDirFrom(app.getPath('userData'));
      const normalizedDir = originalUploadsDir.replace(/[\\/]+$/, '');
      const resolvedPath = resolve(videoPath);
      if (!resolvedPath.startsWith(normalizedDir + sep)) {
        return fail('INVALID_INPUT', 'cutReferenceVideo: videoPath 必须位于 original-uploads 目录内');
      }
      if (!existsSync(resolvedPath)) {
        return fail('INVALID_INPUT', `cutReferenceVideo: 文件不存在: ${resolvedPath}`);
      }

      const outDir = join(dirname(resolvedPath), 'clips');
      const emitProgress = (p: ReferenceVideoCutProgress): void => {
        if (!evt.sender.isDestroyed()) {
          evt.sender.send(SF_IPC_CHANNELS.cutReferenceVideoProgress, p);
        }
      };

      try {
        const { clips, sourceDurationSec } = await cutReferenceVideo(resolvedPath, outDir, {
          ...(typeof sceneThreshold === 'number' && sceneThreshold > 0 ? { threshold: sceneThreshold } : {}),
          ...(typeof maxHeight === 'number' && maxHeight > 0 ? { maxHeight } : {}),
          onProgress: emitProgress,
        });
        return { ok: true, clips, sourceDurationSec } as const;
      } catch (err) {
        // 失败清理半成品（不阻断返回错误）。
        await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
        return fail('CUT_FAILED', `cutReferenceVideo: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // 参考视频切片直传：renderer 把本地切片路径 + 服务端签发的 presigned PUT URL
  // 交给 main，main 逐个 fs.createReadStream 流式 PUT 到 MinIO（内存恒定——
  // 绝不全量 readFile；对齐 stageOriginalVideo 的 OOM 修复思路）。
  // 字节直传对象存储，web 服务器零字节落地。永不 reject：逐片失败计入 errors。
  ipcMain.handle(
    SF_IPC_CHANNELS.uploadReferenceClips,
    async (evt, input: unknown) => {
      const fail = (code: string, message: string) => ({ ok: false, uploaded: 0, errors: [{ path: '', message }] } as const);
      if (typeof input !== 'object' || input === null) {
        return fail('INVALID_INPUT', 'uploadReferenceClips: input must be an object');
      }
      const clips = (input as { clips?: unknown }).clips;
      if (!Array.isArray(clips) || clips.length === 0 || clips.length > 40) {
        return fail('INVALID_INPUT', 'uploadReferenceClips: clips 必须是非空数组（≤40）');
      }
      for (const item of clips) {
        const c = item as { path?: unknown; presignUrl?: unknown };
        if (typeof c?.path !== 'string' || typeof c?.presignUrl !== 'string' || !/^https?:\/\//.test(c.presignUrl)) {
          return fail('INVALID_INPUT', 'uploadReferenceClips: 每项需 { path: string, presignUrl: http(s) }');
        }
      }

      // 安全校验：只允许读取 original-uploads 目录下的文件。
      const originalUploadsDir = originalUploadsDirFrom(app.getPath('userData'));
      const normalizedDir = originalUploadsDir.replace(/[\\/]+$/, '');

      const errors: Array<{ path: string; message: string }> = [];
      let uploaded = 0;
      const total = clips.length;
      for (const item of clips as Array<{ path: string; presignUrl: string }>) {
        const resolvedPath = resolve(item.path);
        if (!resolvedPath.startsWith(normalizedDir + sep)) {
          errors.push({ path: item.path, message: '路径必须位于 original-uploads 目录内' });
          continue;
        }
        try {
          const { size } = await stat(resolvedPath);
          const stream = createReadStream(resolvedPath);
          const res = await fetch(item.presignUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
            // Node fetch 支持 ReadableStream body；流式上传，内存恒定。
            // duplex: 'half' 是 Node fetch 流式 body 必需标志（TS RequestInit 类型
            // 未包含，按 Node 运行时约定显式声明）。
            body: stream as unknown as BodyInit,
            duplex: 'half',
          } as RequestInit & { duplex: 'half' });
          if (!res.ok && res.status !== 200) {
            errors.push({ path: item.path, message: `PUT 失败 HTTP ${res.status}` });
          } else {
            uploaded += 1;
          }
        } catch (err) {
          errors.push({ path: item.path, message: err instanceof Error ? err.message : String(err) });
        }
        if (!evt.sender.isDestroyed()) {
          evt.sender.send(SF_IPC_CHANNELS.uploadReferenceClipsProgress, { done: uploaded + errors.length, total });
        }
      }

      if (errors.length > 0) {
        return { ok: false, uploaded, errors } as const;
      }
      return { ok: true, uploaded } as const;
    },
  );

  // 视频转剧本上传前预处理：renderer 把单集视频字节交给 main，本地 ffmpeg 探测高度，
  // >480 才重编码到 480p（H.264/AAC/mp4），否则原样返回。字节仍由 renderer 上传云端。
  // 目的：Kimi「>1080p 不提升理解只多耗 token」，强制 480p 省 token + 提速。
  // 永不 reject：IO/转码/输入非法都走 { ok:false, error }（renderer 回退原样上传）。
  ipcMain.handle(
    SF_IPC_CHANNELS.preprocessVideoForUpload,
    async (_evt, input: unknown) => {
      const TARGET_HEIGHT = 480;
      if (typeof input !== 'object' || input === null) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'preprocessVideoForUpload: input must be an object' },
        } as const;
      }
      const { file, filename, mimeType } = input as {
        file?: unknown;
        filename?: unknown;
        mimeType?: unknown;
      };
      if (!(file instanceof Uint8Array)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: `preprocessVideoForUpload: input.file must be Uint8Array, got ${file === null ? 'null' : typeof file}`,
          },
        } as const;
      }
      if (typeof filename !== 'string' || filename.length === 0) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'preprocessVideoForUpload: input.filename 必须是非空字符串' },
        } as const;
      }

      const dotIdx = filename.lastIndexOf('.');
      const ext = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : 'mp4';
      const tmpDir = await mkdtemp(join(os.tmpdir(), 'sf-v2s-'));
      const inPath = join(tmpDir, `in-${randomUUID()}.${ext}`);
      try {
        await writeFile(inPath, file);

        // probe 高度 + 时长；失败不 fatal（height=0 → 不降，直接原样返回）。
        let originalHeight = 0;
        let durationSeconds = 0;
        try {
          originalHeight = await probeVideoHeight(inPath);
          durationSeconds = await getVideoDuration(inPath);
        } catch (err) {
          console.error('[shell] preprocessVideoForUpload: ffmpeg probe failed:', err);
        }

        // >目标高度才重编码降采样；否则原样返回，避免无谓转码。
        if (originalHeight > TARGET_HEIGHT) {
          const outPath = join(tmpDir, `out-${randomUUID()}.mp4`);
          await downscaleVideoToHeight(inPath, outPath, TARGET_HEIGHT);
          const outBuf = await readFile(outPath);
          let outputHeight = 0;
          try {
            outputHeight = await probeVideoHeight(outPath);
          } catch {
            /* 输出高度探测失败不影响返回 */
          }
          const baseName = filename.replace(/\.[^.]+$/, '') || 'video';
          return {
            ok: true,
            file: Uint8Array.from(outBuf),
            filename: `${baseName}.mp4`,
            mimeType: 'video/mp4',
            size: outBuf.byteLength,
            durationSeconds,
            downscaled: true,
            originalHeight,
            outputHeight: outputHeight || TARGET_HEIGHT,
          } as const;
        }

        return {
          ok: true,
          file,
          filename,
          mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'video/mp4',
          size: file.byteLength,
          durationSeconds,
          downscaled: false,
          originalHeight,
          outputHeight: originalHeight,
        } as const;
      } catch (err) {
        console.error('[shell] preprocessVideoForUpload: transcode failed:', err);
        return {
          ok: false,
          error: {
            code: 'TRANSCODE_ERROR',
            message: `视频降分辨率失败：${err instanceof Error ? err.message : String(err)}`,
          },
        } as const;
      } finally {
        // best-effort 清理临时目录。
        rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  // 深度图生成：renderer 把本地视频路径交给 main，main 调 ffmpeg 抽帧 →
  // Python（torch + Depth Anything V2 Large）逐帧推理 → ffmpeg tmix 时间
  // 平滑 → 输出与源同 fps 的灰度深度视频。Python/torch 不可用时自动回退
  // 到 ffmpeg edgedetect 边缘图（backend='edge-fallback'）。
  //
  // Python runtime 解析优先级：
  //   1. Local 打包：resources/python-env/python.exe（开箱即用）
  //   2. 用户手动下载/安装的：userData/python-env/python.exe（云端版下载通道）
  //   3. 系统 PATH 上的 python（detectPythonRuntime 探测）
  // 模型权重优先级同理：打包 resources/depth-models > userData/depth-models。
  //
  // 永不 reject：校验/IO/推理失败都走 { ok:false, error }。进度经
  // generateDepthMapProgress 单向推送。
  ipcMain.handle(
    SF_IPC_CHANNELS.generateDepthMap,
    async (evt, input: unknown) => {
      const fail = (code: string, message: string) =>
        ({ ok: false, error: { code, message }, outPath: '', backend: 'edge-fallback' } as const);
      if (typeof input !== 'object' || input === null) {
        return fail('INVALID_INPUT', 'generateDepthMap: input must be an object');
      }
      const { videoPath, fps, smoothingFrames } = input as {
        videoPath?: unknown;
        fps?: unknown;
        smoothingFrames?: unknown;
      };
      if (typeof videoPath !== 'string' || videoPath.length === 0) {
        return fail('INVALID_INPUT', 'generateDepthMap: input.videoPath must be a non-empty string');
      }
      const resolvedPath = resolve(videoPath as string);
      if (!existsSync(resolvedPath)) {
        return fail('INVALID_INPUT', `generateDepthMap: 文件不存在: ${resolvedPath}`);
      }

      // Python runtime 解析：bundled env > userData download > system PATH。
      const pythonCandidates: string[] = [];
      const bundled = bundledPythonEnvPath();
      if (bundled) pythonCandidates.push(bundled);
      const userEnvPython = join(app.getPath('userData'), 'python-env', 'python.exe');
      if (existsSync(userEnvPython)) pythonCandidates.push(userEnvPython);

      // 模型权重目录 + 脚本路径。
      const modelDir = depthModelsRootPath();
      const scriptPath = join(scriptsRootPath(), 'gen_depth.py');
      const scriptOk = existsSync(scriptPath);

      // 输出到 videoPath 同目录，文件名加 _depth.mp4。
      const dir = dirname(resolvedPath);
      const baseName = resolvedPath.replace(/\.[^.]+$/, '');
      const outPath = `${baseName}_depth.mp4`;

      const emitProgress = (p: DepthMapProgress): void => {
        if (!evt.sender.isDestroyed()) {
          evt.sender.send(SF_IPC_CHANNELS.generateDepthMapProgress, p);
        }
      };

      try {
        // 先探测可用的 Python（bundled/user env 优先；否则系统 PATH）。
        let pythonPath: string | undefined;
        for (const candidate of pythonCandidates) {
          // bundled/user env 直接信任（已验证 python.exe 存在）。
          pythonPath = candidate;
          break;
        }

        const result = await exportContentDepthMap(resolvedPath, outPath, {
          ...(typeof fps === 'number' && fps > 0 ? { fps } : {}),
          ...(typeof smoothingFrames === 'number' && smoothingFrames > 0
            ? { smoothingFrames }
            : {}),
          modelDir,
          scriptPath,
          ...(pythonPath ? { pythonPath } : {}),
          onProgress: emitProgress,
        });
        return {
          ok: true,
          outPath: result.outPath,
          backend: result.backend,
        } as const;
      } catch (err) {
        return fail(
          'DEPTH_FAILED',
          `深度图生成失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // 深度图推理环境检测（云端版按需下载用）：检查 userData/python-env + userData/depth-models。
  // Local 版直接返回 ready（已打包）。永不 reject。
  ipcMain.handle(
    SF_IPC_CHANNELS.checkDepthEnv,
    async () => {
      const bundledPy = bundledPythonEnvPath();
      const userPy = join(app.getPath('userData'), 'python-env', 'python.exe');
      const bundledModel = app.isPackaged
        ? join(process.resourcesPath, 'depth-models')
        : '';
      const userModel = join(app.getPath('userData'), 'depth-models');

      const resolvedPy = bundledPythonEnvPath();
      const resolvedModel = depthModelsRootPath();
      const hasPython = !!resolvedPy;
      const hasModel = existsSync(resolvedModel);
      return {
        ready: hasPython && hasModel,
        python: hasPython,
        model: hasModel,
        pythonPath: resolvedPy,
        modelsPath: existsSync(resolvedModel) ? resolvedModel : '',
        bundled: !!bundledPy,
      } as const;
    },
  );

  // 深度图推理环境下载（云端版按需）：从镜像 URL 下载 python-env.zip + depth-models.zip，
  // 解压到 userData。进度经 downloadDepthEnvProgress 推送。永不 reject。
  ipcMain.handle(
    SF_IPC_CHANNELS.downloadDepthEnv,
    async (evt, input: unknown) => {
      const emitProgress = (
        stage: string,
        progress?: number,
        detail?: string,
      ): void => {
        if (!evt.sender.isDestroyed()) {
          evt.sender.send(SF_IPC_CHANNELS.downloadDepthEnvProgress, {
            stage,
            progress,
            detail,
          });
        }
      };

      // 镜像列表：用户可覆盖，否则用内置默认。
      const mirrors =
        typeof input === 'object' && input !== null && Array.isArray((input as { mirrors?: unknown }).mirrors)
          ? ((input as { mirrors: string[] }).mirrors)
          : [
              'https://your-domain.example.com/downloads',
            ];

      const userData = app.getPath('userData');
      const pyEnvDir = join(userData, 'python-env');
      const modelDir = join(userData, 'depth-models');

      // 下载文件名。
      const pyZipName = 'python-env.tar.gz';
      const modelZipName = 'depth-models.tar.gz';
      const tmpDir = await mkdtemp(join(os.tmpdir(), 'sf-depth-env-'));

      try {
        // --- 下载 python-env.zip ---
        emitProgress('downloading-python', 0, '正在下载推理环境（约 4.6GB）…');
        const pyZipPath = join(tmpDir, pyZipName);
        await downloadFromMirrors(mirrors, pyZipName, pyZipPath, (p) =>
          emitProgress('downloading-python', p),
        );

        // --- 下载 depth-models.zip ---
        emitProgress('downloading-model', 0, '正在下载模型权重（约 1.3GB）…');
        const modelZipPath = join(tmpDir, modelZipName);
        await downloadFromMirrors(mirrors, modelZipName, modelZipPath, (p) =>
          emitProgress('downloading-model', p),
        );

        // --- 解压 python-env ---
        emitProgress('extracting-python', 0, '正在解压推理环境（约 4.6GB，可能需要 5-10 分钟，请勿关闭客户端）…');
        await rm(pyEnvDir, { recursive: true, force: true }).catch(() => undefined);
        await extractTarGz(pyZipPath, userData);

        // --- 解压 depth-models ---
        emitProgress('extracting-model', 0, '正在解压模型权重（约 1.3GB，约 2-3 分钟）…');
        await rm(modelDir, { recursive: true, force: true }).catch(() => undefined);
        await extractTarGz(modelZipPath, userData);

        emitProgress('done', 1, '环境安装完成');
        return {
          ok: true,
          python: existsSync(join(pyEnvDir, 'python.exe')),
          model: existsSync(modelDir),
        } as const;
      } catch (err) {
        emitProgress('error', undefined, err instanceof Error ? err.message : String(err));
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as const;
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );

  // 手动选择 Python 推理环境：弹文件选择器，用户选 python.exe，存到配置。
  ipcMain.handle(
    SF_IPC_CHANNELS.selectDepthPython,
    async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: '选择 Python 推理环境（python.exe）',
            filters: [{ name: 'Python 可执行文件', extensions: ['exe'] }],
            properties: ['openFile'],
          })
        : await dialog.showOpenDialog({
            title: '选择 Python 推理环境（python.exe）',
            filters: [{ name: 'Python 可执行文件', extensions: ['exe'] }],
            properties: ['openFile'],
          });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false } as const;
      }
      const pythonPath = result.filePaths[0];
      const cfg = readDepthEnvConfig();
      writeDepthEnvConfig({ ...cfg, pythonPath });
      const ok = existsSync(pythonPath);
      return { ok, pythonPath } as const;
    },
  );

  // 手动选择深度模型目录：弹目录选择器，用户选 depth-models 文件夹。
  ipcMain.handle(
    SF_IPC_CHANNELS.selectDepthModels,
    async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: '选择深度模型目录（depth-models）',
            properties: ['openDirectory'],
          })
        : await dialog.showOpenDialog({
            title: '选择深度模型目录（depth-models）',
            properties: ['openDirectory'],
          });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false } as const;
      }
      const modelsPath = result.filePaths[0];
      const cfg = readDepthEnvConfig();
      writeDepthEnvConfig({ ...cfg, modelsPath });
      const ok = existsSync(modelsPath);
      return { ok, modelsPath } as const;
    },
  );

  // 项目导出必须在 main 进程完成：只有这里能读 userData/clips，云端页面拿不到 fs 权限。
  ipcMain.handle(
    SF_IPC_CHANNELS.exportProjectBundle,
    async (_evt, snapshot: unknown, title: unknown) => {
      if (!snapshot || typeof snapshot !== 'object' || typeof title !== 'string') {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: '项目快照或标题格式无效' },
        } as const;
      }
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const selected = win
        ? await dialog.showOpenDialog(win, {
            title: '选择项目迁移包保存位置',
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: '选择项目迁移包保存位置',
            properties: ['openDirectory', 'createDirectory'],
          });
      if (selected.canceled || selected.filePaths.length === 0) {
        return { ok: false, error: { code: 'USER_CANCELLED', message: '用户取消导出' } } as const;
      }
      return await exportProjectBundle({
        snapshot,
        title,
        destinationParent: selected.filePaths[0],
        userDataDir: app.getPath('userData'),
      });
    },
  );

  // 导入时先在客户端恢复媒体并改写 sf-asset://，随后 renderer 才把元数据提交到云端。
  ipcMain.handle(SF_IPC_CHANNELS.importProjectBundle, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const selected = win
      ? await dialog.showOpenDialog(win, {
          title: '选择 .sfproject 项目迁移包',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({
          title: '选择 .sfproject 项目迁移包',
          properties: ['openDirectory'],
        });
    if (selected.canceled || selected.filePaths.length === 0) {
      return { ok: false, error: { code: 'USER_CANCELLED', message: '用户取消导入' } } as const;
    }
    return await importProjectBundle({
      bundlePath: selected.filePaths[0],
      userDataDir: app.getPath('userData'),
    });
  });
}

/**
 * Register `sf-asset://` as a privileged scheme so the renderer (loaded from
 * https://your-domain.example.com) can embed `sf-asset://` URLs in `<video>` without
 * being blocked as mixed content. MUST run before `app.whenReady()` —
 * Electron freezes the scheme registry once the app starts.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CLIP_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ]);
}

/**
 * Serve `userData/clips/<key>.mp4` files to the renderer over the
 * `sf-asset://` protocol. Must be called AFTER `app.whenReady()` (the
 * privileged scheme must already be registered).
 *
 * Path traversal defense: `parseProtocolUrl` rejects any URL that isn't a
 * bare `<clipId>.mp4` and double-checks the resolved path stays inside
 * `clipsDir`. Returns 400 / 404 HTTP-style Responses for invalid / missing
 * files — never throws.
 *
 * Range support (fixes Electron #38749): Chromium's `<video>` issues byte-range
 * requests to stream + seek media. `net.fetch(file://)` ignores the `Range`
 * header and always returns `200` with the whole body — short clips buffered by
 * luck, but longer clips (e.g. imported project videos) and any seek came back
 * black. So we stat the file, honour the `Range` header with a streamed `206
 * Partial Content` (+ `Content-Range` / `Accept-Ranges` / explicit
 * `Content-Type`), and fall back to a streamed `200` for non-range requests.
 */
export function registerAssetProtocol(clipsDir: string): void {
  protocol.handle(CLIP_PROTOCOL, async (req) => {
    const localPath = parseProtocolUrl(req.url, clipsDir);
    if (!localPath) {
      return new Response('Bad clip URL', { status: 400 });
    }
    let size: number;
    try {
      size = (await stat(localPath)).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const baseHeaders: Record<string, string> = {
      'Content-Type': mimeForExt(localPath),
      'Accept-Ranges': 'bytes',
    };
    const range = parseRange(req.headers.get('range') ?? '', size);
    if (range) {
      const { start, end } = range;
      const body = Readable.toWeb(createReadStream(localPath, { start, end })) as unknown as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
    const body = Readable.toWeb(createReadStream(localPath)) as unknown as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(size) },
    });
  });
}

/**
 * Stop all started services. Polling services stop synchronously; the render
 * worker then gets a bounded window to finish its active tick and terminal
 * report. The outer timeout is deliberate defense in depth for Electron quit.
 */
export async function stopShell(
  handles: ShellHandles | null,
  timeoutMs: number = SHELL_DRAIN_TIMEOUT_MS,
): Promise<void> {
  if (!handles) return;

  let renderDrain: Promise<void>;
  try {
    renderDrain = Promise.resolve(handles.renderWorker.stop(timeoutMs));
  } catch (error) {
    handles.logger.warn('render-worker stop failed', { error: String(error) });
    renderDrain = Promise.resolve();
  }
  // Null-safe: local mode has null heartbeat/updater/cookieRefresher
  handles.heartbeat?.stop();
  handles.updater?.stop();
  handles.cookieRefresher?.stop();

  // Stop local server if running
  if (isLocalMode()) {
    await stopLocalServer().catch(() => {});
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const drained = await Promise.race([
    renderDrain.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout !== null) clearTimeout(timeout);
  if (!drained) {
    handles.logger.warn('shell render-worker drain timed out', { timeoutMs });
  }
}

// ------------------------------------------------------------
// Entry point — wires app lifecycle events. Guarded so importing
// this module under vitest (for unit-testing the pure functions
// above) does NOT kick off the real Electron lifecycle.
// ------------------------------------------------------------

/** Wire app lifecycle: single-instance lock, whenReady bootstrap, shutdown. */
export function startShell(): void {
  // EPIPE 防御：主进程 console.warn/error 写入「已关闭的管道」（调试启动的终端关闭、
  // 后台 disown、子进程退出、OS 关机）会抛 EPIPE，无 handler 时触发 Electron
  // 「A JavaScript error occurred in the main process」崩溃弹窗。在 stdout/stderr 的
  // error 事件上吞掉 EPIPE；其余流错误照常抛出（保留 Electron 默认崩溃报告，不掩盖真 bug）。
  const swallowEpipe = (err: NodeJS.ErrnoException): void => {
    if (err?.code === 'EPIPE') return;
    throw err;
  };
  process.stdout?.on?.('error', swallowEpipe);
  process.stderr?.on?.('error', swallowEpipe);

  // P4 Task 1: register the sf-asset:// scheme as privileged BEFORE
  // whenReady — Electron freezes the scheme registry at app start. The
  // protocol.handle() call is deferred to bootstrapShell (post-ready).
  registerPrivilegedSchemes();

  // Single-instance lock — quit if another instance already holds it.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  // Focus existing window when a second instance is launched.
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      const [win] = windows;
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  let handles: ShellHandles | null = null;
  let shuttingDown = false;
  let quitAuthorized = false;
  let quitAfterDrainStarted = false;
  let shutdownPromise: Promise<void> | null = null;

  const stopServicesOnce = (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    shuttingDown = true;
    const services = handles;
    handles = null;
    shutdownPromise = stopShell(services).catch((error: unknown) => {
      console.error('[shell] shutdown failed:', error);
    });
    return shutdownPromise;
  };

  const drainThenQuit = (): void => {
    if (quitAuthorized || quitAfterDrainStarted) return;
    quitAfterDrainStarted = true;
    void stopServicesOnce().finally(() => {
      quitAuthorized = true;
      app.quit();
    });
  };

  app.whenReady()
    .then(async () => {
      if (shuttingDown) return;
      const machineId = loadOrCreateMachineId();
      const logger = createLogger({
        machineId,
        logDir: join(app.getPath('userData'), 'logs'),
        apiBase: isLocalMode() ? (getLocalServerUrl() ?? API_BASE) : API_BASE,
      });

      // Local mode: start embedded server before loading UI
      if (isLocalMode()) {
        try {
          await startLocalServer();
          console.log('[shell] Local server started:', getLocalServerUrl());
        } catch (err) {
          console.error('[shell] Failed to start local server:', err);
        }
      }

      // Local build: extract bundled python-env + depth-models tar.gz on first run.
      await extractBundledDepthEnv(logger);

      const win = createShellWindow(resolveLoadUrl());

      if (isLocalMode()) {
        // In local mode, skip cloud bootstrap (cookie refresher, cloud heartbeat)
        // but still start the render worker + IPC handlers
        handles = bootstrapShellLocal(win, machineId, logger);
      } else {
        // 启动时一次性取 heartbeat 拿 renderJobSlots（服务器 RENDER_JOB_SLOTS 下发），
        // 传给 render-worker 开多槽并发；失败回退 null → render-worker 默认 1 槽（串行）。
        const initialHb = await fetchHeartbeatOnce({
          version: app.getVersion(),
          machineId,
          apiBase: API_BASE,
        });
        handles = bootstrapShell(win, machineId, logger, API_BASE, initialHb?.renderJobSlots);
      }
    })
    .catch((err: unknown) => {
      console.error('[shell] startup failed:', err);
    });

  // Covers direct app.quit() paths (force-upgrade, OS shutdown, explicit UI
  // quit). The second app.quit(), after the bounded drain, is allowed through.
  app.on('before-quit', (event) => {
    if (quitAuthorized) return;
    event.preventDefault();
    drainThenQuit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      drainThenQuit();
    } else {
      void stopServicesOnce();
    }
  });
}

// Auto-start when run as Electron's main entry (skipped under vitest so the
// pure functions above can be unit-tested without triggering the lifecycle).
if (!process.env.VITEST) {
  startShell();
}
