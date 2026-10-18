// ============================================================
// ⑪ client/shell — IPC channel names (shared contract, side-effect-free)
// ============================================================
//
// 被 main 进程 (main/index.ts 注册 ipcMain.handle) 和 preload
// (main/preload.ts 调 ipcRenderer.invoke) 共同 import。
//
// 之所以单独抽出来：preload.ts 顶层有 `contextBridge.exposeInMainWorld(...)`
// 副作用调用。若 main/index.ts 直接 `from './preload'` import 这个常量，esbuild
// bundle 会把整个 preload 模块（含 contextBridge 调用）拖进 main bundle →
// main 进程里 contextBridge 是 undefined →
//   "Cannot read properties of undefined (reading 'exposeInMainWorld')"
// 崩溃。把纯常量抽到无副作用模块即可切断这个传递性拖入。
// ============================================================

/** IPC channel names — must match the handlers registered in main/index.ts. */
export const SF_IPC_CHANNELS = {
  getAppVersion: 'sf:get-app-version',
  getMachineId: 'sf:get-machine-id',
  triggerUpdateCheck: 'sf:trigger-update-check',
  /**
   * 手动检查更新（设置页"检查更新"按钮）。区别于 `triggerUpdateCheck`：
   *   - 返结构化 ManualCheckResult（renderer 据此 toast 用户：已是最新/发现新版/网络错误）。
   *   - main 侧调 `updater.checkNow({ manual: true })`：新版已缓存时再次弹"重启以安装"
   *     对话框（用户之前推迟过、现在主动重查的场景）。
   * 保留 triggerUpdateCheck 通道作向后兼容（旧客户端 binary 仍可能调用）。
   */
  checkForUpdate: 'sf:check-for-update',
  /** P4 Task 1: download a remote video URL to userData/clips/<clipId>.mp4. */
  downloadAsset: 'sf:download-asset',
  /** P6: open an external https URL in the system default handler (Alipay 收银台). */
  openExternal: 'sf:open-external',
  /** 批2a: 写 renderer 传入的本地 bytes 到 userData/clips（用户上传图/云端结果落地）。 */
  saveLocalAsset: 'sf:save-local-asset',
  /** 季继承: 本地 sf-asset:// 图复制成新 key（源季图→目标季，同机 copyFile，零网络）。 */
  copyLocalAsset: 'sf:copy-local-asset',
  /** 批4: 读本地 sf-asset:// → base64 data URL（cloud AI i2i 接缝：costume/铅笔参考图透传）。 */
  readAssetToBaseUrl: 'sf:read-asset-to-base-url',
  /** 批8 R3: 另存成片到用户选定位（dialog.showSaveDialog + fs.copyFile）。 */
  saveFilm: 'sf:save-film',
  /** B5b: 另存资产图片到用户选定位（图片历史下载；sf-asset:// 不能触发 <a download>）。 */
  saveAsset: 'sf:save-asset',
  /** 批8 R4: 删客户端本地成片文件（fs.rm best-effort）。 */
  removeFilm: 'sf:remove-film',
  /** 批6 音色库: 列出全部预置音色（读 resources/voices/manifest.json）。 */
  listPresetVoices: 'sf:list-preset-voices',
  /** 批6 音色库: 读单个预置 wav 为 data:audio/wav;base64,...（试听）。 */
  readPresetVoice: 'sf:read-preset-voice',
  /**
   * 转绘 X3.7: 把 OriginalRewriteStage 用户选的整剧视频字节落到客户端本地
   * `userData/original-uploads/<uuid>.<ext>`，返绝对路径 + duration + size。
   * 字节绝不上服务器（dramaforge-assets-client-local）。返回的 videoUrl 是绝对本地
   * 路径（非 sf-asset://），因为后续 render-worker 的 ffmpeg.splitVideoEvenly
   * 直接读这个路径切片（sf-asset:// 是 Electron 内部 scheme，ffmpeg 无法解析）。
   */
  stageOriginalVideo: 'sf:stage-original-video',
  /**
   * 参考视频转绘（REFERENCE_VIDEO）：把已 staged 的本地原视频按场景切割成
   * ≤15s、720p 封顶的切片。输入 { videoPath, sceneThreshold?, maxHeight? }，
   * 返 { ok, clips[], sourceDurationSec }。进度经 cutReferenceVideoProgress
   * 推送。字节只落客户端本地（dramaforge-assets-client-local）。
   */
  cutReferenceVideo: 'sf:cut-reference-video',
  /** main → renderer 单向推送：参考视频切割进度 { stage, done, total }。 */
  cutReferenceVideoProgress: 'sf:cut-reference-video-progress',
  /**
   * 参考视频切片直传：renderer 把本地切片路径 + 服务端签发的 presigned PUT URL
   * 交给 main，main 逐个流式读文件 PUT 到 MinIO（内存恒定，不整块读入堆）。
   * 输入 { clips: { path, presignUrl }[] }，返 { ok, uploaded, errors }。
   * 进度经 uploadReferenceClipsProgress 推送。字节直传对象存储，
   * web 服务器零字节落地（H1 有界瞬态例外）。
   */
  uploadReferenceClips: 'sf:upload-reference-clips',
  /** main → renderer 单向推送：切片直传进度 { done, total }。 */
  uploadReferenceClipsProgress: 'sf:upload-reference-clips-progress',
  /**
   * 视频转剧本上传前预处理：renderer 把用户选的单集视频字节交给 main，
   * main 用本地 ffmpeg 探测高度，>480 才重编码到 480p（H.264/AAC/mp4），否则原样返回。
   * 目的：Kimi「>1080p 不提升理解只多耗 token」，强制 480p 省 token + 提速。
   * 返 { ok, file(Uint8Array), filename, mimeType, size, durationSeconds, downscaled, originalHeight, outputHeight }。
   * 字节仍由 renderer 上传到云端；本 IPC 只做本地降采样，不落库不持久。
   */
  preprocessVideoForUpload: 'sf:preprocess-video-for-upload',
  /** 导出服务端元数据 + 本机媒体为目录式 .sfproject 迁移包。 */
  exportProjectBundle: 'sf:export-project-bundle',
  /** 选择并读取 .sfproject 包，恢复本机媒体后返回已改写 URL 的快照。 */
  importProjectBundle: 'sf:import-project-bundle',
  /**
   * 深度图生成：把本地视频逐帧提取 → Depth Anything V2 Large 推理 → tmix 时间
   * 平滑 → 输出与源同 fps 的灰度深度视频。输入 { videoPath }，输出 { ok,
   * outPath, backend }。进度经 generateDepthMapProgress 单向推送。
   *
   * 降级：检测不到 Python/torch/transformers（或脚本缺失）时自动回退到 ffmpeg
   * edgedetect 边缘图——产出仍为灰度 mp4，只是 backend 标记为 'edge-fallback'。
   * 深度模型权重（~1.4 GB）不打包，首次推理时下载到 userData/depth-models。
   */
  generateDepthMap: 'sf:generate-depth-map',
  /** main → renderer 单向推送：深度图生成进度 { stage, progress?, detail? }。 */
  generateDepthMapProgress: 'sf:generate-depth-map-progress',
  /**
   * 深度图推理环境检测：检查 userData/python-env + userData/depth-models 是否就绪。
   */
  checkDepthEnv: 'sf:check-depth-env',
  /**
   * 深度图推理环境下载：从镜像 URL 下载 python-env.zip + depth-models.zip，
   * 解压安装到 userData。进度经 downloadDepthEnvProgress 推送。
   */
  downloadDepthEnv: 'sf:download-depth-env',
  /** main → renderer 单向推送：环境下载进度 { stage, progress?, detail? }。 */
  downloadDepthEnvProgress: 'sf:download-depth-env-progress',
  /**
   * 手动选择 Python 推理环境（弹文件选择器，用户选 python.exe）。
   * 路径存到 userData/depth-env-config.json，持久化跨会话。
   */
  selectDepthPython: 'sf:select-depth-python',
  /**
   * 手动选择深度模型目录（弹目录选择器）。
   */
  selectDepthModels: 'sf:select-depth-models',
} as const;
