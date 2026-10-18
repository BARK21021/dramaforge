// Render-job contract — frozen. All other modules depend on these types.
// See docs/superpowers/plans/2026-07-18-cs-refactor.md Task 1 Step 1.

export type RenderJobType =
  | 'CONCAT'
  | 'EXTRACT_FRAME'
  | 'SPLIT_BY_DURATION'
  | 'SPLIT_EVENLY'
  | 'CHAIN_COMPILE'
  | 'LONG_VIDEO_REWRITE';

export type RenderJobStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface ConcatInput {
  clips: { url: string; durationSec?: number }[];
  /**
   * 本任务是否由“最后一个镜头组完成”自动创建。客户端仍只执行普通 CONCAT；
   * 该标记只供服务器做幂等审计，不能改变本地媒体处理行为。
   */
  autoCompiled?: boolean;
  /** 触发自动整集合片的 CHAIN_COMPILE 作业 ID，便于排查任务因果链。 */
  sourceRenderJobId?: string;
  /**
   * LEGACY MinIO presigned PUT URL. Films are now CLIENT-LOCAL (constraint
   * `dramaforge-assets-client-local`): the client render-worker writes the concat
   * output to `userData/clips/<jobId>.mp4` and reports an `sf-asset://` URL.
   * `dispatchFilmExport` no longer mints this. Kept optional only for backward
   * compat with tests that pre-mint their own URL; the product path leaves it
   * unset and the executor writes locally.
   */
  outputUploadUrl?: string;
  /**
   * LEGACY MinIO stable object key. Films are client-local now; the
   * client-local film key is carried on `RenderJobResult.meta.localKey`
   * instead. Kept optional for backward compat.
   */
  outputKey?: string;
  /**
   * 批8 R6 films 列表分组元数据（filmMeta）。dispatch 时由 route 写入
   * `render_jobs.input` JSONB，films GET route 提取用于项目过滤 + 卡片展示。
   * 客户端 executor / orchestrator 不读这些字段（行为零影响），仅 films
   * route 消费。全部 optional：历史 render_jobs 行无此字段时 films route
   * 视为「未关联项目」并跳过项目过滤匹配。
   */
  filmMeta?: FilmMeta;
}

/**
 * 批8 R6 films 列表分组元数据。同时挂在 ConcatInput 和 ChainCompileInput 上，
 * 由 export-film route / chain-generate route 在派发时写入 input JSONB。
 * films GET route 从 input.filmMeta 提取 projectId 做项目过滤，episodeNumber/
 * episodeTitle/projectTitle/shotCount/totalDuration 直接渲染到卡片。
 */
export interface FilmMeta {
  /** 关联项目 ID（films route 过滤键） */
  projectId: string;
  /** 关联分集 ID */
  episodeId?: string;
  /** 关联分集号（卡片标题「第 N 集」用） */
  episodeNumber?: number | null;
  /** 关联分集标题 */
  episodeTitle?: string | null;
  /** 关联项目标题（卡片标题「剧名 - 第N集」用） */
  projectTitle?: string | null;
  /** 镜头数（卡片副信息） */
  shotCount?: number;
  /** 总时长秒数（卡片副信息） */
  totalDuration?: number;
  /**
   * 可选的目标镜头子集。缺省表示整集；存在时用于单镜/成组任务的精确复用、
   * 审计与计费范围判断，顺序以服务端分镜顺序为准。
   */
  shotIds?: string[];
}

export interface ExtractFrameInput {
  videoUrl: string;
  atSec: number;
  outputUploadUrl: string;
}

export interface SplitByDurationInput {
  videoUrl: string;
  durationSec: number;
  outputPrefix: string;
  /** X4.3: 预创建的 episodeIds（顺序对应 split 后的片段），供 client render-worker
   * 把每个片段的本地路径回写到对应 episode。optional（旧调用方不传，向后兼容）。 */
  episodeIds?: string[];
}

export interface SplitEvenlyInput {
  videoUrl: string;
  segments: number;
  outputPrefix: string;
  /** X4.3: 同 SplitByDurationInput.episodeIds。 */
  episodeIds?: string[];
}

export interface ChainCompileInput {
  groupResults: {
    /** 已有组片 URL；空字符串表示客户端需按 params 调用视频模型生成。 */
    url: string;
    /** 该组覆盖的服务端镜头 ID；客户端完成后据此上报可持久化的组片映射。 */
    shotIds?: string[];
    /** 客户端视频生成参数；缺省时直接复用 url，兼容历史任务。 */
    params?: Record<string, unknown>;
  }[];
  /**
   * strict 保留上一组末帧连续性；parallel 牺牲跨组末帧依赖来换取吞吐。
   * 并发只发生在客户端云端请求阶段，本地合片仍按 groupResults 输入顺序执行。
   */
  execution?: {
    mode: 'strict' | 'parallel';
    concurrency?: number;
  };
  /**
   * LEGACY MinIO presigned PUT URL. Chain films are now CLIENT-LOCAL
   * (constraint `dramaforge-assets-client-local`, batch 7 OP1): the client
   * chainCompile orchestrator writes the concat output to
   * `<filmsDir>/<jobId>.mp4` and reports an `sf-asset://` URL.
   * `dispatchChainGenerate` no longer mints this. Kept optional only for
   * backward compat with tests that pre-mint their own URL; the product path
   * leaves it unset and the orchestrator writes locally.
   */
  outputUploadUrl?: string;
  /**
   * 批8 R6 films 列表分组元数据。同 ConcatInput.filmMeta，由 chain-generate
   * route 写入 input JSONB，films GET route 提取用于项目过滤 + 卡片展示。
   * 客户端 chainCompile orchestrator 不读此字段（行为零影响）。
   */
  filmMeta?: FilmMeta;
}

export interface LongVideoRewriteInput {
  /** 客户端本地视频路径（file:// 或绝对路径，orchestrator 本地 ffmpeg 切片用） */
  videoUrl: string;
  /** 总段数（calculateKimiSegmentPlan 算出的 segmentCount） */
  segments: number;
  /**
   * LEGACY MinIO presigned PUT URL。X3 orchestrator 不再上传 MinIO，结果改走
   * /api/projects/[id]/long-video-rewrite/result route 回写（dramaforge-assets-client-local）。
   * 保留 optional 仅为向后兼容（旧 stub/test），新链路不设。
   */
  outputUploadUrl?: string;
  // ---- 转绘 X3.4 生产链路必填元数据 ----
  // orchestrator 会据此计算稳定断点目录，并向项目级 progress/result 路由回写；
  // 因此不能继续沿用早期 stub 的 optional 契约，否则任务只能入队后再失败。
  /** 项目 ID（进度/结果回写 route 鉴权 + ownership） */
  projectId: string;
  /** 用户 ID（内部审计元数据；任务归属仍以 RenderJob.userId 为准） */
  userId?: string;
  /** 视频总时长（秒），传给 calculateKimiSegmentPlan */
  totalDurationSec: number;
  /** 视频总字节数，传给 calculateKimiSegmentPlan 防单段超 48MiB */
  totalBytes: number;
  /** 单段目标上限秒，默认 DEFAULT_KIMI_MAX_SEGMENT_SEC=600 */
  segmentSec?: number;
  /** Kimi 视频理解模型，默认 'kimi-k2.6' */
  kimiModel?: string;
  /** DeepSeek 大纲模型，默认 'deepseek/deepseek-v4-flash' */
  outlineModel?: string;
  /** DeepSeek 重写模型，默认 'deepseek/deepseek-v4-flash' */
  rewriteModel?: string;
  /** 已确认一致的 Kimi 分析稿；失败重跑时跳过 Kimi 阶段（断点复用） */
  sourceScriptOverride?: string;
  /** 源文件名仅用于恢复提示与审计，不参与客户端路径解析。 */
  sourceFilename?: string;
  /** 从该集所在三段式生产阶段重新生成；此前完整阶段从已存剧本恢复。 */
  regenerateFromEpisode?: number;
  /** 已完成项目的剧本文本；只用于客户端恢复断点，不包含任何媒体字节。 */
  previousNovelText?: string;
  /** 已完成项目的 longVideoRewrite 元数据；客户端会校验分析指纹后才复用。 */
  previousLongVideoRewrite?: Record<string, unknown>;
  /** 是否把目标阶段旧稿作为返修上下文；默认 false，避免旧错误污染新生成。 */
  reuseTargetStageDraft?: boolean;
  /** 客户端本地断点目录（Electron userData/long-video-checkpoints/<projectId>-<fp>/） */
  checkpointDir?: string;
}

export type RenderJobInput =
  | ConcatInput
  | ExtractFrameInput
  | SplitByDurationInput
  | SplitEvenlyInput
  | ChainCompileInput
  | LongVideoRewriteInput;

export interface RenderJobResult {
  outputUrl?: string;
  outputs?: string[];
  durationSec?: number;
  meta?: Record<string, unknown>;
}

/** CHAIN_COMPILE 组片映射条目（客户端落盘后上报，服务端按 shotIds 白名单回写镜头 URL）。 */
export interface ChainCompileGroupClip {
  shotIds: string[];
  videoUrl: string;
  localKey?: string;
}

/** CHAIN_COMPILE 失败组的错误（写到对应镜头 metadata.videoError，前端在失败组旁展示）。 */
export interface ChainCompileFailedGroupError {
  shotIds: string[];
  error: string;
}

/**
 * CHAIN_COMPILE 作业结果 meta 的强类型视图（RenderJobResult.meta 对 chain 作业的实际形状）。
 *
 * 区分三种组结局，避免历史 skippedGroups 把"复用(已完成)"和"失败(真跳过)"混淆：
 *   - reusedGroups:    params===undefined 的 pass-through 组，复用既有视频（=已完成，未调云端）。
 *   - generatedGroups: 本次真调云端生成成功的组。
 *   - failedGroups:    云端失败/被跳过的组（ChainGroupSkippedError，无视频）。
 *   完成组 = reusedGroups + generatedGroups；失败组 = failedGroups。
 *
 * partialCompleted=true 表示"部分完成"（failedGroups>0）：job 终态 COMPLETED 但 outputUrl
 * 为空（部分片不算整集成片），失败镜头标 FAILED+videoError，需重试失败组后再触发整集 CONCAT。
 *
 * skippedGroups 为历史兼容字段（旧客户端上报，语义=现 reusedGroups）；读取侧优先 reusedGroups。
 */
export interface ChainCompileResultMeta {
  localKey?: string;
  totalGroups?: number;
  reusedGroups?: number;
  generatedGroups?: number;
  failedGroups?: number;
  partialCompleted?: boolean;
  groupClips?: ChainCompileGroupClip[];
  failedGroupErrors?: ChainCompileFailedGroupError[];
  /** @deprecated 历史字段，语义=reusedGroups；保留兼容旧客户端上报。 */
  skippedGroups?: number;
}

export interface RenderJob {
  id: string;
  taskId: string;
  userId: string;
  type: RenderJobType;
  status: RenderJobStatus;
  /**
   * 0-100 实时进度（/progress 路由每次上报落库）。持久化到行，使刷新 / 4s 轮询 /
   * 直接查行都能看到真实进度，不再塌缩成 0%（曾导致误判活链为卡死并 cancel）。
   */
  progress: number;
  /** 当前阶段文案（如"生成第 N/12 组"），随 /progress 上报落库。 */
  stage: string | null;
  input: RenderJobInput;
  result: RenderJobResult | null;
  claimedBy: string | null;
  /** Opaque, single-claim lease credential. Replaced every time a job is reclaimed. */
  claimToken: string | null;
  error: string | null;
  createdAt: string;
  claimedAt: string | null;
  /** Last accepted callback for the active claim; drives stale-lease recovery. */
  heartbeatAt: string | null;
  completedAt: string | null;
  /**
   * 渐进回传的组片段(每组完成时 /progress 上报 append 落库)。刷新 / 4s 轮询 / 恢复端点
   * 读此字段把已完成组翻成视频——不依赖 task_events(其 "taskId" 外键到 tasks,而
   * CHAIN_COMPILE 只插 render_jobs 不入 tasks,导致 groupClip 永不落 task_events)。
   * 整链 COMPLETED 后 result.meta.groupClips 仍是最终权威兜底。
   */
  progressClips: RenderJobGroupClip[];
}

export interface RenderJobProgress {
  progress: number;
  stage: string;
  /**
   * 渐进回传(dramaforge 独建,app1 无):某镜头组视频已在客户端本地落盘,随进度事件回前端
   * 让对应镜头卡片即时显示,不必等整条链跑完。仅 chain 编排器在每组完成时携带;
   * 普通进度上报/心跳不传(一次性事件,不进 latestProgress)。
   *
   * videoUrl 是 sf-asset://<jobId>-group-<i>.mp4(客户端本地,服务端零字节)。
   * 前端收到后乐观更新这些 shot 的 currentMaterialUrl + videoStatus='COMPLETED';
   * 链 COMPLETED 时的 onRefresh 拉真值兜底。
   */
  groupClip?: RenderJobGroupClip;
}

/** 渐进回传的单组视频描述(随 progress 事件下发,前端按 shotIds 定位镜头)。 */
export interface RenderJobGroupClip {
  /** 该组覆盖的镜头 ID(对应 entries[i].shotIds)。 */
  shotIds: string[];
  /** 客户端本地组片 URL(sf-asset://<jobId>-group-<i>.mp4)。 */
  videoUrl: string;
}
