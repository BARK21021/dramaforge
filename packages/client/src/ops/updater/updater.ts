// ⑭ ops-updater — silent auto-updater.
//
// Every `intervalMs` (default 1h) the client GETs /api/client/update with its
// current version + os. The server responds with an `UpdateCheckResponse`
// (`{ latestVersion, downloadUrl, force }`). When the server's latestVersion is
// strictly above the client's currentVersion, the updater silently downloads
// the package to `${cacheDir}/${latestVersion}-update` (skipping the download
// when that file already exists — never re-downloading) and then invokes
// `onDownloaded` so the shell can prompt the user to restart. The `force` flag
// is forwarded verbatim: when true the shell should show a strong prompt.
// `checkNow()` is exposed on the handle so the shell can trigger an immediate
// re-check (e.g. after the user defers a force prompt, or via a manual
// "检查更新" button in the settings page).
//
// 手动模式 (checkNow({ manual: true }))：设置页"检查更新"按钮用。区别于自动轮询：
//   - 永远返结构化 ManualCheckResult（自动模式调用方忽略返回值，无影响）。
//   - 当新版已下载缓存（用户之前推迟了安装提示）：再次触发 onDownloaded → main 进程
//     promptAndInstall 重弹"重启以安装"对话框。自动模式不重弹（避免每轮骚扰）。
//
// The updater MUST be resilient: any network error, non-ok response, bad JSON,
// or write error is swallowed (logged to console) so the client never crashes
// on an update-check hiccup. Uses the global `fetch` (Node 18+ / Electron) and
// node:fs/promises to write the download to disk.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { verify, createHash, createPublicKey } from 'node:crypto';
import type { UpdateCheckRequest, UpdateCheckResponse } from '@dramaforge/shared';
import { isVersionBelow } from '@dramaforge/shared';

export interface StartUpdaterOptions {
  currentVersion: string;
  os: 'win' | 'mac' | 'linux';
  apiBase: string;
  intervalMs?: number;
  cacheDir: string;
  onDownloaded?: (info: { version: string; path: string; force: boolean }) => void;
  /**
   * Ed25519 公钥（base64 SPKI DER）。下载更新包后用它验签——服务器沦陷也改不了
   * 编译进二进制的公钥，签不出能过验的包，防供应链投毒。
   * 空串/未传 = dev 未配置（跳过验签 + 警告）；生产 main/index.ts 必须编译期填入。
   */
  publicKey?: string;
}

export interface UpdaterHandle {
  stop: () => void;
  /**
   * 立即触发一次检查。自动轮询调用方忽略返回值；手动入口（设置页按钮）
   * 传 `{ manual: true }` 并读取结构化结果给用户反馈。
   */
  checkNow: (opts?: { manual?: boolean }) => Promise<ManualCheckResult>;
}

/**
 * 手动检查更新的结构化结果。renderer 据此 toast 反馈用户。
 * - `no-update`：当前版本 >= 服务端 latestVersion，提示"已是最新版本"。
 * - `update-available`：发现新版。`downloaded=true` 表示本次刚下载完成；
 *   `downloaded=false` 表示文件已缓存（之前下载过用户推迟了安装）。两种情况 main
 *   进程都会经 onDownloaded → promptAndInstall 弹"重启以安装"对话框。
 * - `network-error`：检查/下载过程中出错，message 是简短错误描述（用于 toast）。
 */
export type ManualCheckResult =
  | { outcome: 'no-update'; latestVersion: string }
  | { outcome: 'update-available'; latestVersion: string; downloaded: boolean }
  | { outcome: 'network-error'; message: string }
  | { outcome: 'signature-failed'; message: string };

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const UPDATE_PATH = '/api/client/update';

/**
 * 验证已下载的更新包：sha256 完整性 + Ed25519 签名真实性（防供应链投毒）。
 *
 * fail-closed：配置了公钥时，签名缺失/错误/sha256 不符均拒绝（删缓存、不安装）。
 * 未配置公钥（dev）时跳过验签并记警告——生产客户端 main/index.ts 必须编译期
 * 填入 UPDATE_SIGNING_PUBLIC_KEY，否则客户端无签名保护。
 *
 * @param data         已下载的字节
 * @param info         服务器返回的 { signature, sha256 }
 * @param publicKeyB64 Ed25519 公钥（base64 SPKI DER）
 * @returns { ok: true } 或 { ok: false, reason }
 */
function verifyUpdatePackage(
  data: Uint8Array,
  info: { signature?: string; sha256?: string },
  publicKeyB64: string,
): { ok: true } | { ok: false; reason: string } {
  // dev 兜底：无公钥 → 跳过验签（生产 main 必须填 UPDATE_SIGNING_PUBLIC_KEY）
  if (!publicKeyB64) {
    console.warn('[updater] no public key configured — skipping verification (dev only)');
    return { ok: true };
  }
  // 服务器未提供签名/sha256 → fail-closed（旧服务器/配置丢失，绝不装无签名包）
  if (!info.signature || !info.sha256) {
    return { ok: false, reason: '服务器未提供更新签名，已拒绝安装' };
  }
  // sha256 完整性（传输损坏/CDN 错误兜底）
  const actualSha = createHash('sha256').update(Buffer.from(data)).digest('hex');
  if (actualSha !== info.sha256) {
    return { ok: false, reason: '更新包校验失败（sha256 不符），已拒绝' };
  }
  // Ed25519 签名真实性（核心：防服务器沦陷投毒）
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    // Ed25519 一次性验签（单次签名算法，不分块）：verify(null, data, key, sig)
    const valid = verify(null, Buffer.from(data), key, Buffer.from(info.signature, 'base64'));
    if (!valid) return { ok: false, reason: '更新包签名校验失败，已拒绝' };
    return { ok: true };
  } catch (err) {
    console.error('[updater] verify threw:', err);
    return { ok: false, reason: '签名验证异常，已拒绝' };
  }
}

export function startUpdater(opts: StartUpdaterOptions): UpdaterHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function checkNow({
    manual = false,
  }: { manual?: boolean } = {}): Promise<ManualCheckResult> {
    if (stopped) return { outcome: 'network-error', message: 'updater stopped' };

    const req: UpdateCheckRequest = { version: opts.currentVersion, os: opts.os };
    const url =
      `${opts.apiBase}${UPDATE_PATH}` +
      `?version=${encodeURIComponent(req.version)}` +
      `&os=${encodeURIComponent(req.os)}`;

    let res: Response;
    try {
      res = await globalThis.fetch(url);
      // Guard against a stop() racing with an in-flight request.
      if (stopped) return { outcome: 'network-error', message: 'updater stopped' };
      if (!res.ok) {
        console.warn(`[updater] non-ok response: ${res.status} ${res.statusText}`);
        return { outcome: 'network-error', message: `服务器返回 ${res.status}` };
      }
    } catch (err) {
      // Resilient: never crash the client on a check network error.
      console.error('[updater] check error:', err);
      return { outcome: 'network-error', message: '网络错误，请稍后重试' };
    }

    let info: UpdateCheckResponse;
    try {
      info = (await res.json()) as UpdateCheckResponse;
    } catch (err) {
      console.error('[updater] bad json:', err);
      return { outcome: 'network-error', message: '服务器响应解析失败' };
    }

    // Only act when the server's latest is strictly above our current version.
    if (!isVersionBelow(opts.currentVersion, info.latestVersion)) {
      return { outcome: 'no-update', latestVersion: info.latestVersion };
    }

    const destPath = join(opts.cacheDir, `${info.latestVersion}-update`);
    const force = info.force === true;

    // Already cached — don't re-download. Auto mode silently returns; manual
    // mode re-fires onDownloaded so the install prompt shows again (user likely
    // deferred a previous prompt and now explicitly asked to check).
    if (existsSync(destPath)) {
      if (manual) {
        try {
          opts.onDownloaded?.({ version: info.latestVersion, path: destPath, force });
        } catch (err) {
          console.error('[updater] onDownloaded error:', err);
        }
      }
      return {
        outcome: 'update-available',
        latestVersion: info.latestVersion,
        downloaded: false,
      };
    }

    try {
      const dlRes = await globalThis.fetch(info.downloadUrl);
      if (stopped) return { outcome: 'network-error', message: 'updater stopped' };
      if (!dlRes.ok) {
        console.warn(
          `[updater] non-ok download: ${dlRes.status} ${dlRes.statusText}`,
        );
        return { outcome: 'network-error', message: `下载失败 ${dlRes.status}` };
      }
      await mkdir(opts.cacheDir, { recursive: true });
      // Buffer the response and write it to disk. An Electron update package
      // is a single file that fits comfortably in memory, so a full-buffer
      // write is simpler than streaming and avoids DOM/node ReadableStream
      // type friction under strict mode. Errors are swallowed by the
      // surrounding try/catch so the client never crashes on a download hiccup.
      const bytes = new Uint8Array(await dlRes.arrayBuffer());
      await writeFile(destPath, bytes);

      // 验签防供应链投毒：sha256 完整性 + Ed25519 签名。失败删缓存拒绝安装。
      const verifyResult = verifyUpdatePackage(bytes, info, opts.publicKey ?? '');
      if (!verifyResult.ok) {
        await rm(destPath, { force: true }).catch(() => {});
        console.error('[updater] update verification failed:', verifyResult.reason);
        return { outcome: 'signature-failed', message: verifyResult.reason };
      }
    } catch (err) {
      // Resilient: swallow download/write errors so the client never crashes.
      console.error('[updater] download/write error:', err);
      return { outcome: 'network-error', message: '下载失败，请稍后重试' };
    }

    try {
      opts.onDownloaded?.({
        version: info.latestVersion,
        path: destPath,
        force,
      });
    } catch (err) {
      // A buggy shell callback must not crash the updater.
      console.error('[updater] onDownloaded error:', err);
    }

    return {
      outcome: 'update-available',
      latestVersion: info.latestVersion,
      downloaded: true,
    };
  }

  // First fire is after one full interval (no immediate fire); keeps the
  // cadence a clean "every N ms" and avoids a startup burst. The shell can
  // call checkNow() directly for an immediate first check if desired.
  timer = setInterval(() => {
    void checkNow();
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    checkNow,
  };
}
