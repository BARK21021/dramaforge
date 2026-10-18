// ============================================================
// ⑪ client/shell — preload (contextBridge: MINIMAL safe IPC surface)
// ============================================================
//
// Runs in the renderer's isolated world (contextIsolation: true). Exposes a
// tiny, explicitly-audited `sfShell` API to the cloud web page via
// contextBridge. Phase-1 rule (HARD): the renderer MUST NOT get ffmpeg, fs,
// node, or any power. Only three no-arg invoke helpers are exposed — every
// call round-trips through ipcMain handlers in the main process, so the web
// page can never touch local resources directly.
//
// What is deliberately NOT exposed: require, process, fs, ffmpeg, child_process,
// shell, webFrame, crashReporter, etc. If a future phase needs more, add it
// here ONLY after a security review — never widen this surface casually.

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { SF_IPC_CHANNELS } from './ipc-channels';
import type { ManualCheckResult } from '../src/ops/updater';
// type-only import：不把 ffmpeg 链拖进 preload bundle（esbuild 会擦除 type import）。
import type { ReferenceVideoCutClip, ReferenceVideoCutProgress, DepthMapProgress } from '../src/ffmpeg/ffmpeg-pipeline';

/**
 * P4 Task 1 — local-asset download result. Discriminated union: success
 * carries the `sf-asset://` URL the renderer's `<video src>` should load;
 * failure carries a structured error to toast. Never rejects.
 */
export type DownloadAssetResult =
  | { ok: true; key: string; protocolUrl: string }
  | { ok: false; error: { code: string; message: string; status?: number } };

/** 批4: readAssetToBaseUrl 结果（base64 data URL 给 cloud AI i2i，或结构化 error）。 */
export type ReadAssetResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: { code: string; message: string } };

/**
 * 批8 R3 — saveFilm result. 成功返 savedPath；失败返结构化 error。
 * 永不 reject（用户取消/IO 失败都走 {ok:false}）。
 */
export type SaveFilmResult =
  | { ok: true; savedPath: string }
  | { ok: false; error: { code: string; message: string } };

/**
 * B5b — saveAsset result（资产图片另存）。同 saveFilm envelope：成功返 savedPath；
 * 用户取消/IO 失败/输入非法都走 {ok:false}。永不 reject。
 */
export type SaveAssetResult =
  | { ok: true; savedPath: string }
  | { ok: false; error: { code: string; message: string } };

/**
 * 批8 R4 — removeFilm result. 文件不存在视为已删（force:true），返 {ok:true}。
 * localKey 非法或 IO 错误返 {ok:false}。永不 reject。
 */
export type RemoveFilmResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

/** 项目迁移包 IPC 结果；snapshot 只含可结构化克隆的 JSON 数据。 */
export type ExportProjectBundleResult =
  | { ok: true; bundlePath: string; mediaCount: number; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };
export type ImportProjectBundleResult =
  | { ok: true; snapshot: unknown; mediaCount: number; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

/**
 * 批6 音色库 — 单条预置音色（与 manifest.json 字段一一对应）。
 * 与 IPC 契约（packages/web/types/sf-shell.d.ts SfShellPresetVoice）严格同步。
 */
export type PresetVoice = {
  file: string;
  gender: string;
  dur: number;
  desc: string;
  text: string;
  lang: string;
};

/**
 * 批6 音色库 — listPresetVoices / readPresetVoice 结果 envelope。
 * code 字段供 renderer toast 区分错误类型。永不 reject。
 */
export type ListPresetVoicesResult =
  | { ok: true; voices: PresetVoice[] }
  | { ok: false; code: string; message: string };

export type ReadPresetVoiceResult =
  | { ok: true; dataUrl: string }
  | { ok: false; code: string; message: string };

/**
 * 手动检查更新结果（与 src/ops/updater ManualCheckResult 同形）。
 * renderer 据此 toast：no-update→"已是最新版本"；update-available→"发现新版本"；
 * network-error→错误提示。main 进程 promptAndInstall 对话框独立于本结果弹出。
 */
export type CheckForUpdateResult = ManualCheckResult;

/**
 * 转绘 X3.7 stageOriginalVideo 结果（与 web OriginalRewriteStage.tsx
 * OriginalVideoStageResult 严格对齐）。discriminated union by `outcome`，
 * 永不 reject：IO 失败 / probe 失败 / 输入非法都走 { outcome:'cancelled', error }。
 *
 * `videoUrl` 是客户端本地绝对路径（如 `C:\...\original-uploads\<uuid>.mp4`），
 * 不是 `sf-asset://` —— 后续 render-worker 的 ffmpeg.splitVideoEvenly 直接
 * `ffmpeg -i <videoUrl>` 切片，sf-asset:// 是 Electron 内部 scheme，ffmpeg
 * 无法解析。renderer 把这个绝对路径作元数据 POST 给服务器，服务器只持 key
 * + DB 元数据，零字节（dramaforge-assets-client-local）。
 */
export type StageOriginalVideoResult = {
  outcome: 'staged' | 'cancelled';
  /** 本地绝对路径（original-uploads/<uuid>.<ext>）。staged 时必填。 */
  videoUrl?: string;
  /** 文件字节大小（fs.stat）。staged 时必填。 */
  totalBytes?: number;
  /** 视频时长秒（main 进程 ffmpeg -i probe）。staged 时必填。 */
  totalDurationSec?: number;
  /** 用户原始文件名（renderer 透传给服务器作 DB 元数据）。staged 时必填。 */
  filename?: string;
  /** cancelled 时的结构化错误（renderer 据此 toast）。 */
  error?: { code: string; message: string };
};

/**
 * 视频转剧本上传前预处理结果（与 main/index.ts preprocessVideoForUpload handler 对齐）。
 * 永不 reject：转码/IO/输入非法都走 { ok:false, error }（renderer 回退原样上传）。
 * `file` 是（可能已降到 480p 的）mp4 字节，renderer 包成 File 上传云端。
 */
export type PreprocessVideoForUploadResult =
  | {
      ok: true;
      file: Uint8Array;
      filename: string;
      mimeType: string;
      size: number;
      durationSeconds: number;
      downscaled: boolean;
      originalHeight: number;
      outputHeight: number;
    }
  | { ok: false; error: { code: string; message: string } };

/**
 * 参考视频转绘切割结果。成功带切片清单（本地路径 + 时间窗）与源时长；
 * 失败带结构化 error。永不 reject。
 */
export type CutReferenceVideoResult =
  | { ok: true; clips: ReferenceVideoCutClip[]; sourceDurationSec: number }
  | { ok: false; error: { code: string; message: string } };

/** 深度图生成结果。成功带 outPath（本地绝对路径）+ backend；失败带结构化 error。永不 reject。 */
export type GenerateDepthMapResult =
  | { ok: true; outPath: string; backend: 'depth-anything' | 'edge-fallback' }
  | { ok: false; error: { code: string; message: string } };

/** 参考视频切片直传结果；部分失败时 errors 列出失败项，永不 reject。 */
export type UploadReferenceClipsResult =
  | { ok: true; uploaded: number }
  | { ok: false; uploaded: number; errors: Array<{ path: string; message: string }> };

/** The bridge contract — also the source of truth for the IPC channel names. */
export interface SfShellBridge {
  /** Always `true` on the Electron desktop client. Renderer uses this to
   * decide between the local-asset path (Electron) and the browser fallback
   * (direct `<video src=URL>`, no persist). P4 Task 2 consumes this. */
  readonly isElectron: true;
  /** Resolves to the app version string (e.g. "1.2.3"). */
  getAppVersion(): Promise<string>;
  /** Resolves to this machine's stable id (UUID). */
  getMachineId(): Promise<string>;
  /** Triggers an immediate update check (returns when the check completes). */
  triggerUpdateCheck(): Promise<void>;
  /**
   * 手动触发一次更新检查（设置页"检查更新"按钮）。
   * 返结构化结果：no-update / update-available / network-error。发现新版时 main 进程
   * 会同时弹"重启以安装"对话框（与自动轮询共用 promptAndInstall）。
   */
  checkForUpdate(): Promise<CheckForUpdateResult>;
  /**
   * Download a remote asset URL to the user's local `userData/clips/` dir.
   * Returns a `sf-asset://<clipId>.<ext>` URL on success — the renderer's
   * `<video>` / `<img>` loads it via the custom protocol registered in main.
   * The cloud server never touches the asset bytes (constraint
   * `dramaforge-assets-client-local`).
   *
   * `opts.ext` is optional. When omitted, the main process infers the ext from
   * the URL suffix, then Content-Type, then falls back to `'mp4'`. Pass it
   * explicitly when the caller knows the type and the URL/headers can't be
   * trusted to disambiguate (e.g. an image served from a `.bin` endpoint).
   */
  downloadAsset(url: string, opts?: { ext?: string }): Promise<DownloadAssetResult>;
  /**
   * Save renderer-supplied bytes to the user's local `userData/clips/` dir.
   * The C/S inverse of `downloadAsset`: the renderer reads a user-picked File
   * (`File.arrayBuffer()`) or a cloud-AI result and hands the bytes here once;
   * the cloud server only ever sees the returned `sf-asset://<clipId>.<ext>`
   * key string (server holds zero media bytes — `dramaforge-assets-client-local`).
   *
   * `opts.ext` is required (the renderer knows the file type from the File).
   * Returns the same discriminated union as `downloadAsset`. Never rejects.
   */
  saveLocalAsset(bytes: Uint8Array, opts: { ext: string }): Promise<DownloadAssetResult>;
  /**
   * 季继承: 复制本地 sf-asset:// 图成新 key（源季→目标季，同机 copyFile）。
   * 返回 DownloadAssetResult（源图不在本机时 ok:false READ_ERROR）。
   */
  copyLocalAsset(srcProtocolUrl: string): Promise<DownloadAssetResult>;
  /**
   * Read a local `sf-asset://` file back into a base64 `data:` URL — cloud AI
   * i2i seam (costume / pencil repaint). Returns { ok, dataUrl } | { ok, error }.
   */
  readAssetToBaseUrl(protocolUrl: string): Promise<ReadAssetResult>;
  /**
   * Open an external URL in the system's default handler (P6). Used to hand
   * the Alipay 收银台 payUrl out of the Electron window into the system
   * browser (page.pay is a redirect, not in-app). Main validates the URL is
   * http(s) before delegating to `shell.openExternal` — a compromised renderer
   * cannot open arbitrary schemes (file:// etc.).
   */
  openExternal(url: string): Promise<void>;
  /**
   * 批8 R3: 另存成片到用户选定位（showSaveDialog + fs.copyFile）。
   *
   * sf-asset:// 是 Electron 自定义 scheme，Chromium `<a download>` 不触发
   * save-as（R3 真 bug）。renderer 调本方法 → main 弹保存对话框 → copyFile
   * 从 clipsDir/localKey 到用户选定位。localKey 走 CLIP_KEY_RE 校验（路径
   * 穿透防御）。永不 reject：用户取消/IO 失败都返 {ok:false}。
   *
   * @param localKey      clips 目录下文件名（如 `<jobId>.mp4`）
   * @param suggestedName 建议文件名（不含扩展，main 自动加 .mp4）
   */
  saveFilm(localKey: string, suggestedName?: string): Promise<SaveFilmResult>;
  /**
   * B5b: 另存资产图片到用户选定位（图片历史下载）。
   *
   * sf-asset:// 的 <img> 不能触发 Chromium `<a download>` save-as（同 saveFilm R3 bug），
   * renderer 调本方法 → main 弹保存对话框 → copyFile 从 clipsDir/localKey 到用户选定位。
   * localKey 走 CLIP_KEY_RE 校验。永不 reject：用户取消/IO 失败都返 {ok:false}。
   *
   * @param localKey      clips 目录下文件名（sf-asset:// 的 key）
   * @param suggestedName 建议文件名（不含扩展，main 从 localKey 推断图片扩展名）
   */
  saveAsset(localKey: string, suggestedName?: string): Promise<SaveAssetResult>;
  /**
   * 批8 R4: 删客户端本地成片文件（fs.rm best-effort）。
   *
   * DB render_jobs 行由 web DELETE route 删，本 IPC 只清本地文件（双面清理）。
   * 文件不存在视为已删（force:true）。localKey 走 CLIP_KEY_RE 校验。
   */
  removeFilm(localKey: string): Promise<RemoveFilmResult>;
  /**
   * 批6 音色库: 列出全部预置音色（读 resources/voices/manifest.json）。
   *
   * 200 个 wav（女声/男声多语种）+ manifest 打包进客户端 exe，服务器零媒体
   * 字节（合规 dramaforge-assets-client-local）。renderer 拿到清单后渲染音色选择 UI。
   * 永不 reject：读 manifest 失败返 { ok:false, code, message }。
   */
  listPresetVoices(): Promise<ListPresetVoicesResult>;
  /**
   * 批6 音色库: 读单个预置 wav 为 `data:audio/wav;base64,...` data URL（试听）。
   *
   * `file` 必须是 manifest 里列出的裸文件名（voice-store 三层校验：形状 +
   * manifest allowlist + path-in-voicesDir，挡住任何路径穿透）。返 data URL
   * 给 renderer `<audio src>` 直接播放。永不 reject。
   */
  readPresetVoice(file: string): Promise<ReadPresetVoiceResult>;
  /**
   * 转绘 X3.7: 把 OriginalRewriteStage 用户选的 3GB 整剧视频字节落到客户端
   * 本地 `userData/original-uploads/<uuid>.<ext>`，main 进程本地 ffmpeg -i
   * probe duration + fs.stat size，返 { videoUrl, totalBytes, totalDurationSec,
   * filename }。字节绝不上服务器（dramaforge-assets-client-local）。
   *
   * `videoUrl` 是绝对本地路径（非 sf-asset://），后续 render-worker 的
   * ffmpeg.splitVideoEvenly 直接读它切片（sf-asset:// 是 Electron 内部
   * scheme，ffmpeg 无法解析）。
   *
   * `file` 是 renderer 的 File（contextBridge 结构化克隆到 main 侧成 Blob-like
   * 对象，main 调其 arrayBuffer() 拿字节）。永不 reject：IO/probe/输入非法
   * 都走 { outcome:'cancelled', error }。
   *
   * @param input.file     用户选的整剧视频 File（renderer `<input type=file>`）
   * @param input.filename 用户原始文件名（透传给服务器作 DB 元数据 + 扩展名推断）
   */
  stageOriginalVideo(input: { file: File; filename: string }): Promise<StageOriginalVideoResult>;
  /**
   * 视频转剧本上传前预处理：把 renderer 读出的视频字节（Uint8Array）交给 main，
   * 本地 ffmpeg 探测高度，>480 才重编码到 480p（mp4），否则原样返回。
   * 返 { ok, file, filename, mimeType, size, durationSeconds, downscaled, originalHeight, outputHeight }。
   * 失败返 { ok:false, error }（renderer 回退原样上传，不阻断）。字节仍由 renderer 上传云端。
   */
  preprocessVideoForUpload(input: {
    file: Uint8Array;
    filename: string;
    mimeType: string;
  }): Promise<PreprocessVideoForUploadResult>;
  /**
   * 参考视频转绘：把已 staged 的本地原视频按场景切割成 ≤15s、720p 封顶的切片。
   * `videoPath` 为 stageOriginalVideo 返回的本地绝对路径。切片只落客户端本地
   * （dramaforge-assets-client-local），由 renderer 后续经 presigned URL 直传云端。
   * 进度经 onCutReferenceVideoProgress 订阅。永不 reject。
   */
  cutReferenceVideo(input: {
    videoPath: string;
    sceneThreshold?: number;
    maxHeight?: number;
  }): Promise<CutReferenceVideoResult>;
  /**
   * 订阅参考视频切割进度（main → renderer 单向推送）。
   * 返回取消订阅函数（组件卸载时调用）。
   */
  onCutReferenceVideoProgress(cb: (p: ReferenceVideoCutProgress) => void): () => void;
  /**
   * 深度图生成：把本地视频逐帧提取 → Depth Anything V2 Large 推理 → tmix 时间
   * 平滑 → 输出与源同 fps 的灰度深度视频。`videoPath` 为 stageOriginalVideo 返回的
   * 本地绝对路径。Python/torch 不可用时自动回退 edgedetect。进度经
   * onGenerateDepthMapProgress 订阅。永不 reject。
   */
  generateDepthMap(input: { videoPath: string; fps?: number; smoothingFrames?: number }): Promise<GenerateDepthMapResult>;
  /** 订阅深度图生成进度（main → renderer 单向推送）。返回取消订阅函数。 */
  onGenerateDepthMapProgress(cb: (p: DepthMapProgress) => void): () => void;
  /** 深度图推理环境检测（云端版按需）。返回 { ready, python, model, pythonPath?, bundled }。 */
  checkDepthEnv(): Promise<{ ready: boolean; python: boolean; model: boolean; pythonPath: string; bundled: boolean }>;
  /** 深度图推理环境下载（云端版按需）。进度经 onDownloadDepthEnvProgress 订阅。 */
  downloadDepthEnv(input?: { mirrors?: string[] }): Promise<{ ok: boolean; python?: boolean; model?: boolean; error?: string }>;
  /** 订阅环境下载进度。返回取消订阅函数。 */
  onDownloadDepthEnvProgress(cb: (p: { stage: string; progress?: number; detail?: string }) => void): () => void;
  /** 手动选择 Python 推理环境（弹文件选择器）。 */
  selectDepthPython(): Promise<{ ok: boolean; pythonPath?: string }>;
  /** 手动选择深度模型目录（弹目录选择器）。 */
  selectDepthModels(): Promise<{ ok: boolean; modelsPath?: string }>;
  /**
   * 参考视频切片直传：main 逐个流式读本地切片 PUT 到 presigned URL
   * （MinIO；内存恒定）。输入 { clips: { path, presignUrl }[] }。
   * 进度经 onUploadReferenceClipsProgress 订阅。永不 reject。
   */
  uploadReferenceClips(input: {
    clips: Array<{ path: string; presignUrl: string }>;
  }): Promise<UploadReferenceClipsResult>;
  /** 订阅切片直传进度 { done, total }；返回取消订阅函数。 */
  onUploadReferenceClipsProgress(cb: (p: { done: number; total: number }) => void): () => void;
  /** 将云端项目快照与本机媒体一起写成可跨电脑迁移的 .sfproject 文件夹。 */
  exportProjectBundle(snapshot: unknown, title: string): Promise<ExportProjectBundleResult>;
  /** 选择 .sfproject 文件夹，恢复媒体并返回可提交给服务端的快照。 */
  importProjectBundle(): Promise<ImportProjectBundleResult>;
}

// IPC channel names 已抽到 ./ipc-channels（无副作用模块，main + preload 共用，
// 避免 esbuild 把 preload 的 contextBridge 顶层副作用拖进 main bundle）。

const bridge: SfShellBridge = {
  isElectron: true,
  getAppVersion: () => ipcRenderer.invoke(SF_IPC_CHANNELS.getAppVersion),
  getMachineId: () => ipcRenderer.invoke(SF_IPC_CHANNELS.getMachineId),
  triggerUpdateCheck: () => ipcRenderer.invoke(SF_IPC_CHANNELS.triggerUpdateCheck),
  checkForUpdate: () =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.checkForUpdate) as Promise<CheckForUpdateResult>,
  downloadAsset: (url: string, opts?: { ext?: string }) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.downloadAsset, url, opts) as Promise<DownloadAssetResult>,
  saveLocalAsset: (bytes: Uint8Array, opts: { ext: string }) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.saveLocalAsset, bytes, opts) as Promise<DownloadAssetResult>,
  copyLocalAsset: (srcProtocolUrl: string) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.copyLocalAsset, srcProtocolUrl) as Promise<DownloadAssetResult>,
  readAssetToBaseUrl: (protocolUrl: string) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.readAssetToBaseUrl, protocolUrl) as Promise<ReadAssetResult>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.openExternal, url) as Promise<void>,
  saveFilm: (localKey: string, suggestedName?: string) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.saveFilm, localKey, suggestedName) as Promise<SaveFilmResult>,
  saveAsset: (localKey: string, suggestedName?: string) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.saveAsset, localKey, suggestedName) as Promise<SaveAssetResult>,
  removeFilm: (localKey: string) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.removeFilm, localKey) as Promise<RemoveFilmResult>,
  listPresetVoices: () =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.listPresetVoices) as Promise<ListPresetVoicesResult>,
  readPresetVoice: (file: string) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.readPresetVoice, file) as Promise<ReadPresetVoiceResult>,
  stageOriginalVideo: (input: { file: File; filename: string }) => {
    // 在 renderer 侧用 webUtils.getPathForFile 解析 File 的磁盘绝对路径——只把
    // **路径字符串**过 IPC，避免旧契约把 ≤3GB File 整块 arrayBuffer() 灌进 main
    // 进程堆而 OOM（READ_ERROR →"本地暂存视频失败"）。main 拿到路径后流式 copy，
    // 内存占用恒定。合成 File（非原生 input）getPathForFile 返 ''，main 按
    // INVALID_INPUT 拒绝并提示重新通过文件选择器选择。
    const filePath = webUtils.getPathForFile(input.file);
    return ipcRenderer.invoke(
      SF_IPC_CHANNELS.stageOriginalVideo,
      { filePath, filename: input.filename },
    ) as Promise<StageOriginalVideoResult>;
  },
  preprocessVideoForUpload: (input: {
    file: Uint8Array;
    filename: string;
    mimeType: string;
  }) =>
    ipcRenderer.invoke(
      SF_IPC_CHANNELS.preprocessVideoForUpload,
      input,
    ) as Promise<PreprocessVideoForUploadResult>,
  cutReferenceVideo: (input: { videoPath: string; sceneThreshold?: number; maxHeight?: number }) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.cutReferenceVideo, input) as Promise<CutReferenceVideoResult>,
  onCutReferenceVideoProgress: (cb: (p: ReferenceVideoCutProgress) => void) => {
    const listener = (_event: unknown, p: ReferenceVideoCutProgress): void => cb(p);
    ipcRenderer.on(SF_IPC_CHANNELS.cutReferenceVideoProgress, listener);
    return () => {
      ipcRenderer.removeListener(SF_IPC_CHANNELS.cutReferenceVideoProgress, listener);
    };
  },
  generateDepthMap: (input: { videoPath: string; fps?: number; smoothingFrames?: number }) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.generateDepthMap, input) as Promise<GenerateDepthMapResult>,
  onGenerateDepthMapProgress: (cb: (p: DepthMapProgress) => void) => {
    const listener = (_event: unknown, p: DepthMapProgress): void => cb(p);
    ipcRenderer.on(SF_IPC_CHANNELS.generateDepthMapProgress, listener);
    return () => {
      ipcRenderer.removeListener(SF_IPC_CHANNELS.generateDepthMapProgress, listener);
    };
  },
  checkDepthEnv: () => ipcRenderer.invoke(SF_IPC_CHANNELS.checkDepthEnv),
  downloadDepthEnv: (input?: { mirrors?: string[] }) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.downloadDepthEnv, input ?? {}),
  onDownloadDepthEnvProgress: (cb: (p: { stage: string; progress?: number; detail?: string }) => void) => {
    const listener = (_event: unknown, p: { stage: string; progress?: number; detail?: string }): void => cb(p);
    ipcRenderer.on(SF_IPC_CHANNELS.downloadDepthEnvProgress, listener);
    return () => {
      ipcRenderer.removeListener(SF_IPC_CHANNELS.downloadDepthEnvProgress, listener);
    };
  },
  selectDepthPython: () => ipcRenderer.invoke(SF_IPC_CHANNELS.selectDepthPython),
  selectDepthModels: () => ipcRenderer.invoke(SF_IPC_CHANNELS.selectDepthModels),
  uploadReferenceClips: (input: { clips: Array<{ path: string; presignUrl: string }> }) =>
    ipcRenderer.invoke(
      SF_IPC_CHANNELS.uploadReferenceClips,
      input,
    ) as Promise<UploadReferenceClipsResult>,
  onUploadReferenceClipsProgress: (cb: (p: { done: number; total: number }) => void) => {
    const listener = (_event: unknown, p: { done: number; total: number }): void => cb(p);
    ipcRenderer.on(SF_IPC_CHANNELS.uploadReferenceClipsProgress, listener);
    return () => {
      ipcRenderer.removeListener(SF_IPC_CHANNELS.uploadReferenceClipsProgress, listener);
    };
  },
  exportProjectBundle: (snapshot: unknown, title: string) =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.exportProjectBundle, snapshot, title) as Promise<ExportProjectBundleResult>,
  importProjectBundle: () =>
    ipcRenderer.invoke(SF_IPC_CHANNELS.importProjectBundle) as Promise<ImportProjectBundleResult>,
};

// Expose the minimal surface to the cloud web page (window.sfShell).
contextBridge.exposeInMainWorld('sfShell', bridge);
