/**
 * @file sf-shell.d.ts — 全局 Window.sfShell 类型声明（与 client preload 对齐）
 *
 * 桌面客户端 packages/client/main/preload.ts 通过 contextBridge.exposeInMainWorld
 * 在 window.sfShell 注入最小 IPC bridge。这里以全局 interface Window 增强，
 * 让 web 侧直接 `window.sfShell?.xxx` 拿到类型——不再需要每处都写
 * `as Window & { sfShell?: ... }` 或重复定义本地 SfShellBridge。
 *
 * 为什么不跨包 import type：client 包是 electron 入口，tsconfig paths 未配 client
 * 别名，跨包 import type 不可行（且会把 electron 类型拖进 web type graph）。
 * 故此 interface 在 d.ts 内联定义，字段保持与 preload.ts SfShellBridge 同步——
 * 改 preload 时务必同步这里（注释里也标了出处行号）。
 *
 * 同步源：packages/client/main/preload.ts:29 (export interface SfShellBridge)
 */

export type SfShellDownloadAssetResult =
  | { ok: true; key: string; protocolUrl: string }
  | { ok: false; error: { code: string; message: string; status?: number } };

/** 批4: readAssetToBaseUrl 结果（与 client preload ReadAssetResult 对齐）。 */
export type SfShellReadAssetResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: { code: string; message: string } };

/** 批8 R3 saveFilm 结果（与 preload.ts SaveFilmResult 对齐）。 */
export type SfShellSaveFilmResult =
  | { ok: true; savedPath: string }
  | { ok: false; error: { code: string; message: string } };

/** B5b saveAsset 结果（与 preload.ts SaveAssetResult 对齐）。 */
export type SfShellSaveAssetResult =
  | { ok: true; savedPath: string }
  | { ok: false; error: { code: string; message: string } };

/** 批8 R4 removeFilm 结果（与 preload.ts RemoveFilmResult 对齐）。 */
export type SfShellRemoveFilmResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export type SfShellExportProjectBundleResult =
  | { ok: true; bundlePath: string; mediaCount: number; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };
export type SfShellImportProjectBundleResult =
  | { ok: true; snapshot: unknown; mediaCount: number; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

/**
 * 批6 音色库: 单条预置音色（与 preload.ts PresetVoice 对齐）。
 * 字段一一对应 manifest.json: file/gender/dur/desc/text/lang。
 */
export type SfShellPresetVoice = {
  file: string;
  gender: string;
  dur: number;
  desc: string;
  text: string;
  lang: string;
};

/** 批6 listPresetVoices 结果（与 preload.ts ListPresetVoicesResult 对齐）。 */
export type SfShellListPresetVoicesResult =
  | { ok: true; voices: SfShellPresetVoice[] }
  | { ok: false; code: string; message: string };

/** 批6 readPresetVoice 结果（与 preload.ts ReadPresetVoiceResult 对齐）。 */
export type SfShellReadPresetVoiceResult =
  | { ok: true; dataUrl: string }
  | { ok: false; code: string; message: string };

/**
 * 转绘 X3.7 stageOriginalVideo 结果（与 preload.ts StageOriginalVideoResult +
 * OriginalRewriteStage.tsx OriginalVideoStageResult 严格对齐）。
 *
 * discriminated union by `outcome`，永不 reject。`videoUrl` 是客户端本地绝对
 * 路径（original-uploads/<uuid>.<ext>），后续 render-worker 的 ffmpeg 直接读
 * 它切片。renderer 把这个绝对路径作元数据 POST 给服务器（字节零上传）。
 */
export type SfShellStageOriginalVideoResult = {
  outcome: 'staged' | 'cancelled';
  videoUrl?: string;
  totalBytes?: number;
  totalDurationSec?: number;
  filename?: string;
  error?: { code: string; message: string };
};

/**
 * 视频转剧本上传前预处理结果（与 preload.ts PreprocessVideoForUploadResult 对齐）。
 * 永不 reject：转码/IO/输入非法都走 { ok:false, error }（renderer 回退原样上传）。
 * `file` 是（可能已降到 480p 的）mp4 字节，renderer 包成 File 上传云端。
 */
export type SfShellPreprocessVideoForUploadResult =
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
 * 手动检查更新结果（与 src/ops/updater ManualCheckResult 同形，preload.ts CheckForUpdateResult 对齐）。
 * - `no-update`：当前版本已是最新。
 * - `update-available`：发现新版（downloaded=true 表示本次刚下载完成；downloaded=false
 *   表示文件已缓存，用户之前推迟了安装）。两种情况 main 进程都会弹"重启以安装"对话框。
 * - `network-error`：检查/下载失败，message 是简短错误描述（用于 toast）。
 */
export type SfShellCheckForUpdateResult =
  | { outcome: 'no-update'; latestVersion: string }
  | { outcome: 'update-available'; latestVersion: string; downloaded: boolean }
  | { outcome: 'network-error'; message: string };

/**
 * 与 packages/client/main/preload.ts 的 `export interface SfShellBridge` 字段一一对应。
 * 任何字段/签名变更必须双向同步。
 */
export interface SfShellBridge {
  /** Always `true` on the Electron desktop client. */
  readonly isElectron: true;
  /** Resolves to the app version string (e.g. "1.2.3"). 异步，经 ipcRenderer.invoke。 */
  getAppVersion(): Promise<string>;
  /** Resolves to this machine's stable id (UUID). */
  getMachineId(): Promise<string>;
  /** Triggers an immediate update check (returns when the check completes). */
  triggerUpdateCheck(): Promise<void>;
  /**
   * 手动触发一次更新检查（设置页"检查更新"按钮）。
   * 返结构化结果：no-update / update-available / network-error。
   * 发现新版时 main 进程同时弹"重启以安装"对话框（与自动轮询共用 promptAndInstall）。
   */
  checkForUpdate(): Promise<SfShellCheckForUpdateResult>;
  /**
   * Download a remote asset URL to the user's local `userData/clips/` dir.
   * Returns a `sf-asset://<clipId>.<ext>` URL on success.
   */
  downloadAsset(
    url: string,
    opts?: { ext?: string },
  ): Promise<SfShellDownloadAssetResult>;
  /**
   * 批2b: 写 renderer 传入的本地 bytes 到 userData/clips（用户上传图/云端结果落地）。
   * C/S 逆运算：downloadAsset 是拉远端 URL，saveLocalAsset 是收本地 bytes。
   * 返 sf-asset://<clipId>.<ext> key；服务器只见 key（零媒体字节）。
   */
  saveLocalAsset(
    bytes: Uint8Array,
    opts: { ext: string },
  ): Promise<SfShellDownloadAssetResult>;
  /**
   * 季继承: 复制本地 sf-asset:// 图成新 key（源季→目标季，同机 copyFile）。
   * 返 SfShellDownloadAssetResult；源图不在本机时 ok:false READ_ERROR。
   */
  copyLocalAsset(srcProtocolUrl: string): Promise<SfShellDownloadAssetResult>;
  /**
   * 批4: 读本地 sf-asset:// → base64 data URL（cloud AI i2i 接缝：costume/铅笔
   * 参考图透传给云端 ARK/ComfyUI）。返 { ok, dataUrl } | { ok, error }。
   */
  readAssetToBaseUrl(protocolUrl: string): Promise<SfShellReadAssetResult>;
  /** Open an external URL in the system's default handler (P6). */
  openExternal(url: string): Promise<void>;
  /**
   * 批8 R3: 另存成片到用户选定位（showSaveDialog + fs.copyFile）。
   * sf-asset:// 不能触发 `<a download>` save-as，故走 IPC。
   * 永不 reject：用户取消/IO 失败都返 {ok:false}。
   */
  saveFilm(localKey: string, suggestedName?: string): Promise<SfShellSaveFilmResult>;
  /** B5b: 另存资产图片到用户选定位（图片历史下载）。 */
  saveAsset(localKey: string, suggestedName?: string): Promise<SfShellSaveAssetResult>;
  /**
   * 批8 R4: 删客户端本地成片文件（fs.rm best-effort,文件不存在 force 跳过）。
   * DB 行由 web DELETE route 删，本 IPC 只清本地（双面清理）。
   */
  removeFilm(localKey: string): Promise<SfShellRemoveFilmResult>;
  /**
   * 批6 音色库: 列出全部预置音色（读 resources/voices/manifest.json）。
   * 200 个 wav + manifest 打包进客户端 exe，服务器零媒体字节。永不 reject：
   * 读失败返 { ok:false, code:'READ_ERROR'|'INVALID_MANIFEST', message }。
   */
  listPresetVoices(): Promise<SfShellListPresetVoicesResult>;
  /**
   * 批6 音色库: 读单个预置 wav 为 `data:audio/wav;base64,...`（试听）。
   * file 必须是 manifest 里列出的裸文件名（三层校验挡路径穿透）。永不 reject。
   */
  readPresetVoice(file: string): Promise<SfShellReadPresetVoiceResult>;
  /**
   * 转绘 X3.7: 把 OriginalRewriteStage 用户选的 3GB 整剧视频字节落到客户端本地
   * `userData/original-uploads/<uuid>.<ext>`，main 进程本地 ffmpeg -i probe
   * duration + fs.stat size，返 { videoUrl, totalBytes, totalDurationSec, filename }。
   * 字节绝不上服务器（dramaforge-assets-client-local）。
   *
   * videoUrl 是绝对本地路径（非 sf-asset://）—— render-worker 的 ffmpeg 切片直接
   * 读它（sf-asset:// 是 Electron 内部 scheme，ffmpeg 无法解析）。renderer 拿到
   * 后作元数据 POST 给服务器，服务器只持 key + DB 元数据。
   *
   * 永不 reject：IO/probe/输入非法都走 { outcome:'cancelled', error }（对齐
   * OriginalRewriteStage.tsx OriginalVideoStageResult 契约）。
   */
  stageOriginalVideo(input: {
    file: File;
    filename: string;
  }): Promise<SfShellStageOriginalVideoResult>;
  /**
   * 视频转剧本上传前预处理：renderer 把视频字节交给客户端 main，本地 ffmpeg
   * 探测高度、>480 才降到 480p（mp4），否则原样返回。字节仍由 renderer 上传云端。
   * 失败返 { ok:false }，renderer 回退原样上传（旧客户端无此方法时同理）。
   */
  preprocessVideoForUpload(input: {
    file: Uint8Array;
    filename: string;
    mimeType: string;
  }): Promise<SfShellPreprocessVideoForUploadResult>;
  /** 导出元数据及客户端本地媒体，供换电脑迁移。 */
  exportProjectBundle(
    snapshot: unknown,
    title: string,
  ): Promise<SfShellExportProjectBundleResult>;
  /** 选择迁移包并在本机恢复媒体，返回待导入的项目快照。 */
  importProjectBundle(): Promise<SfShellImportProjectBundleResult>;
  /** cutReferenceVideo */
  cutReferenceVideo(input: { videoPath: string; sceneThreshold?: number; maxHeight?: number }): Promise<SfShellCutReferenceVideoResult>;
  /** generateDepthMap */
  generateDepthMap(input: { videoPath: string; fps?: number; smoothingFrames?: number }): Promise<SfShellGenerateDepthMapResult>;
  onGenerateDepthMapProgress(cb: (p: SfShellDepthMapProgress) => void): () => void;
  onGenerateDepthMapProgress(cb: (p: SfShellDepthMapProgress) => void): () => void;
  /** 参考视频切片直传 MinIO（presigned PUT） */
  uploadReferenceClips(input: { clips: Array<{ path: string; presignUrl: string }> }): Promise<{ ok: boolean; uploaded: number; errors: Array<{ path: string; message: string }> }>;
  onUploadReferenceClipsProgress(cb: (p: { done: number; total: number }) => void): () => void;
  /** 深度图推理环境检测（云端版按需下载） */
  checkDepthEnv(): Promise<{ ready: boolean; python: boolean; model: boolean; pythonPath: string; bundled: boolean }>;
  /** 深度图推理环境下载 */
  downloadDepthEnv(input?: { mirrors?: string[] }): Promise<{ ok: boolean; python?: boolean; model?: boolean; error?: string }>;
  onDownloadDepthEnvProgress(cb: (p: { stage: string; progress?: number; detail?: string }) => void): () => void;
  /** 手动选择 Python 推理环境 */
  selectDepthPython(): Promise<{ ok: boolean; pythonPath?: string }>;
  /** 手动选择深度模型目录 */
  selectDepthModels(): Promise<{ ok: boolean; modelsPath?: string }>;
}

declare global {
  interface Window {
    sfShell?: SfShellBridge;
  }
}

/** GenerateDepthMapResult */
export type SfShellGenerateDepthMapResult = { ok: boolean; outPath: string; backend: string; error?: string };

/** CutReferenceVideoResult */
export type SfShellCutReferenceVideoResult = { ok: boolean; clips: Array<{ path: string; startSec: number; endSec: number; durationSec: number; height: number }>; totalDurationSec: number; error?: string };

/** DepthMapProgress */
export type SfShellDepthMapProgress = { stage: string; current: number; total: number };
