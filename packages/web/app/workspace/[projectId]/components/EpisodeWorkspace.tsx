"use client";

/**
 * @file EpisodeWorkspace.tsx — 单集工作流编排器（批2 D）
 *
 * 照 app1 F:\app1\src\app\workspace\[projectId]\components\EpisodeWorkspace.tsx
 * 的编排核心（stage 推进 + 数据加载 + SSE 过滤 + busy 上报），精简掉 dramaforge 暂
 * 不需要的 chain-generate 高级参数（pencilPaintingMode / gridOpacity /
 * gridStrokeWidth / gridCells / parallelMode / chainForce 等 —— 那是批7
 * production 的事）。
 *
 * 职责（与 app1 对齐）：
 *   1. viewStage state + 3 ref（viewStageRef / furthestStageRef /
 *      stageSaveRequestRef）—— 双 state 设计：viewStage 自由前后切换；
 *      episode.stageStatus 后端单调持久。
 *   2. handleStageChange：乐观更新 + 单调 PATCH + 失败/被取代回滚
 *      （照搬 app1:354-381，requestId 防过期覆盖）。
 *   3. 数据加载：episode + shots + episodes 列表（loadRequestSeqRef 防过期）。
 *   4. SSE 事件过滤：events.slice(0,10) 检测 status_change 终态 → 清
 *      activeTaskIds + 300ms 防抖刷新 shots。
 *   5. busy 上报：onBusyChange(activeTaskIds.size > 0)。
 *   6. 5 阶段条件渲染：input / analyzing / assets / storyboard / production
 *      （从原 page.tsx 631 行内联块原样移入，UI/逻辑不变）。
 *
 * dramaforge 与 app1 的 C/S 适配边界：
 *   - 不实现多 Tab SPA（B 方案，URL = 每集独立路由）。
 *   - 不接 ActiveTaskStatusBar / GlobalGenerationStatus（批9）。
 *   - 不接 /api/tasks 列表端点（批3）；项目级 activeTaskIds 恢复靠 trackTaskId
 *     模块级 Set（跨路由切换不丢，SSE 重连补）。
 *   - chain-generate 高级参数由 ProductionStage 与客户端 orchestrator 共同实现。
 *   - assets 生命周期由 AssetStage 自管（dramaforge 现有契约，app1 是父级注入）。
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../../../../components/ui/Button";
import { Spinner } from "../../../../components/ui/Spinner";
import { useToast } from "../../../../components/ui/Toast";
import { getProjectArtStylePreset, type EpisodeRecord } from "@dramaforge/shared";
import type { ProjectRecord, ShotRecord, AssetRecord } from "@dramaforge/server";
import { StageNav } from "./StageNav";
import { AssetDesignStage } from "./AssetDesignStage";
import { StoryboardStage } from "./StoryboardStage";
import { EpisodeTabs } from "./EpisodeTabs";
import { InputStage } from "./InputStage";
import { ReferenceVideoStage } from "./ReferenceVideoStage";
import { AnalyzingStage } from "./AnalyzingStage";
import { ProductionStage } from "./ProductionStage";
// 批9 装配：ORIGINAL 项目的整剧重写阶段（替代 InputStage，category==="ORIGINAL" 时启用）。
import { OriginalRewriteStage } from "./OriginalRewriteStage";
// 批9 装配：分集级活跃任务聚合条（app1 EpisodeWorkspace.tsx:50 同款 import）。
import { ActiveTaskStatusBar } from "../../../../components/features/GenerationProgress";
import {
  DEFAULT_SCRIPT_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
} from "../../../../lib/models";
import {
  STAGES,
  stageOrder,
  deriveStageFromEpisode,
  type StageKey,
} from "../../../../lib/stage-config";
import {
  clearGenerationLockByTaskId,
} from "../../../../hooks/useGenerationLock";

// ============================================================
// helpers
// ============================================================

/** 从 episode.scriptData（unknown）安全读取参考视频时长（秒）；非正或缺失返回 null。 */
function readSourceVideoDurationSeconds(ep: EpisodeRecord | null): number | null {
  if (!ep) return null;
  const sd = ep.scriptData;
  if (!sd || typeof sd !== "object") return null;
  const v = (sd as Record<string, unknown>).sourceVideoDurationSeconds;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

// ============================================================
// 类型
// ============================================================

/** SSE 事件（仅声明本组件使用的字段；完整形状见 hooks/useTaskStatus.ts:TaskEvent） */
interface SSEEvent {
  taskId: string;
  type: string;
  status?: string;
  progress?: number;
  error?: string;
  timestamp: number;
  projectId?: string;
}

interface ScriptScene {
  id?: string;
  scene_id?: string;
  location?: string;
  time?: string;
  intExt?: string;
  characters?: string[];
  content?: string;
}

interface ScriptData {
  scenes?: ScriptScene[];
  characters?: string[];
  infoPoints?: unknown[];
  modelUsed?: string;
}

export interface EpisodeWorkspaceProps {
  /** 当前分集 ID */
  episodeId: string;
  /** 项目 ID */
  projectId: string;
  /** API 调用封装（useApi + useEpisodeApiQueue 装配，page.tsx 透传） */
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  /** 全局 SSE 事件（useSSE 单例，page.tsx 透传） */
  events: SSEEvent[];
  /** SSE 连接状态 */
  sseConnected: boolean;
  /** 初始视图阶段（URL ?stage= 推导；缺省时从 episode.stageStatus 推导） */
  initialViewStage?: StageKey;
  /** 视图阶段变化回调（page.tsx 写 URL ?stage=） */
  onViewStageChange?: (stage: StageKey) => void;
  /** busy 状态变化回调，供分集页阻止活跃任务期间误关闭工作区。 */
  onBusyChange?: (busy: boolean) => void;
  /** 跳转成片库回调（批7 production 用） */
  onNavigateToFilms?: (taskId: string) => void;
}

// ============================================================
// 组件
// ============================================================

export function EpisodeWorkspace({
  episodeId,
  projectId,
  api,
  events,
  // sseConnected 暂保留供未来指示器（批9）消费；本批 UI 不渲染指示器。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sseConnected: _sseConnected,
  initialViewStage,
  onViewStageChange,
  onBusyChange,
  // 批8 R1: onNavigateToFilms 激活（删下划线死 prop）—— production 完成
  // → 父组件 setViewMode("films") + setHighlightTaskId(taskId)
  onNavigateToFilms,
}: EpisodeWorkspaceProps) {
  const toast = useToast();
  const router = useRouter();

  // ============================================================
  // 视图阶段管理（照搬 app1:338-381）
  // ============================================================
  const [viewStage, setViewStage] = React.useState<StageKey>(initialViewStage || "input");
  /** 当前显示的阶段（同步 ref，handler 内可读到最新值，避免闭包陈旧） */
  const viewStageRef = React.useRef<StageKey>(initialViewStage || "input");
  /** 已持久化到后端的最远阶段（决定下次 PATCH 是否需要写） */
  const furthestStageRef = React.useRef<StageKey>(initialViewStage || "input");
  /** stage PATCH 请求序号；旧请求 resolved 时若不是最新则忽略（防过期覆盖） */
  const stageSaveRequestRef = React.useRef(0);

  React.useEffect(() => {
    viewStageRef.current = viewStage;
  }, [viewStage]);

  const syncStageView = React.useCallback(
    (stage: StageKey) => {
      viewStageRef.current = stage;
      setViewStage(stage);
      onViewStageChange?.(stage);
    },
    [onViewStageChange],
  );

  /**
   * 阶段切换 handler —— 乐观更新 + 单调 PATCH + 失败/被取代回滚
   *
   * 流程（照搬 app1 EpisodeWorkspace.tsx:354-381）：
   *   1. 记 previousViewStage / previousPersistedStage 快照
   *   2. 立即 syncStageView(stage) 乐观更新（UI 立刻反映切换）
   *   3. 若 stageOrder(stage) <= stageOrder(previousPersistedStage)：**不 PATCH**
   *      （回退到已持久化过的阶段无需写）
   *   4. requestId = ++stageSaveRequestRef.current;await PATCH stageStatus
   *   5. 成功 → furthestStageRef.current = stageToPersist
   *   6. 失败 / 被新请求取代（requestId !== stageSaveRequestRef.current）
   *      → syncStageView(previousViewStage) 回滚
   *
   * 单调持久由后端 episode/service.ts:268-275 保证（stageOrder >= 才应用）；
   * 前端只在切到更靠后阶段时 PATCH，回退/原地不动都不写。
   */
  const handleStageChange = React.useCallback(
    async (stage: StageKey) => {
      const previousViewStage = viewStageRef.current;
      const previousPersistedStage = furthestStageRef.current;
      if (stage === previousViewStage) return;

      syncStageView(stage);
      const stageToPersist =
        stageOrder(stage) > stageOrder(previousPersistedStage)
          ? stage
          : previousPersistedStage;
      if (stageToPersist === previousPersistedStage) return;

      const requestId = ++stageSaveRequestRef.current;

      try {
        const saved = await api(
          `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ stageStatus: stageToPersist }),
          },
        );

        if (saved) {
          furthestStageRef.current = stageToPersist;
        } else if (requestId === stageSaveRequestRef.current) {
          // 本次失败且期间无新切换 → 回滚（callApi 已 toast 错误）
          syncStageView(previousViewStage);
        }
      } catch {
        if (requestId === stageSaveRequestRef.current) {
          syncStageView(previousViewStage);
        }
      }
    },
    [api, episodeId, projectId, syncStageView],
  );

  /** initialViewStage 同步（URL ?stage= 变化 / popstate 时父组件改 props） */
  React.useEffect(() => {
    if (initialViewStage && initialViewStage !== viewStage) {
      viewStageRef.current = initialViewStage;
      setViewStage(initialViewStage);
    }
    // 故意只对 initialViewStage 触发；viewStage 变化时不应反向覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialViewStage]);

  // ============================================================
  // 数据加载（episode + shots + episodes 列表）
  // ============================================================
  const [episode, setEpisode] = React.useState<EpisodeRecord | null>(null);
  const [project, setProject] = React.useState<ProjectRecord | null>(null);
  /** 项目已确认资产（跨集 text-to-style 传递用；input 阶段消费） */
  const [projectAssets, setProjectAssets] = React.useState<
    Array<{ kind: string; name: string; description: string }>
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);

  // 批4：编剧分析增强提示词（对齐 app1 page.tsx:159-165，localStorage 持久化）
  const [analyzeEnhancementPrompt, setAnalyzeEnhancementPrompt] = React.useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(`analyzeEnhance_${projectId}`) || "";
    } catch {
      return "";
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(`analyzeEnhance_${projectId}`, analyzeEnhancementPrompt);
    } catch {
      // 静默：隐私模式 / quota exceeded 不阻塞
    }
  }, [projectId, analyzeEnhancementPrompt]);

  // 批5 资产设定：imageResolution / imageStyle / assetEnhancementPrompt state
  // （对齐 app1 page.tsx:109-157，按项目隔离 localStorage 持久化）
  const [imageResolution, setImageResolution] = React.useState<string>(() => {
    if (typeof window === "undefined") return "2K";
    try {
      return localStorage.getItem(`imageResolution_${projectId}`) || "2K";
    } catch {
      return "2K";
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(`imageResolution_${projectId}`, imageResolution);
    } catch {
      // 静默
    }
  }, [projectId, imageResolution]);

  const [imageStyle, setImageStyle] = React.useState<string>(() => {
    if (typeof window === "undefined") return "写实真人风格";
    try {
      return localStorage.getItem(`imageStyle_${projectId}`) || "写实真人风格";
    } catch {
      return "写实真人风格";
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(`imageStyle_${projectId}`, imageStyle);
    } catch {
      // 静默
    }
  }, [projectId, imageStyle]);

  // app1 项目级画风锁：创建时选定后覆盖本地缓存，资产与视频阶段不可漂移到其他风格。
  React.useEffect(() => {
    const preset = getProjectArtStylePreset(project?.artStyle);
    if (preset && imageStyle !== preset.assetImageKey) {
      setImageStyle(preset.assetImageKey);
    }
  }, [project?.artStyle, imageStyle]);

  // 资产设定增强提示词（对齐 app1 page.tsx:148-157，默认不含"真人写实"避免与
  // 项目级 styleLock 冲突，旧默认值含"真人写实"视为未自定义回退新默认）
  const ASSET_ENHANCE_OLD_DEFAULT =
    "真人写实，材质纹理清晰，构图严谨，角色包含正面/侧面/背面多角度参考。";
  const ASSET_ENHANCE_DEFAULT =
    "材质纹理清晰，构图严谨，角色包含正面/侧面/背面多角度参考。";
  const [assetEnhancementPrompt, setAssetEnhancementPrompt] = React.useState(() => {
    if (typeof window === "undefined") return ASSET_ENHANCE_DEFAULT;
    try {
      const stored = localStorage.getItem(`assetEnhance_${projectId}`);
      return !stored || stored === ASSET_ENHANCE_OLD_DEFAULT
        ? ASSET_ENHANCE_DEFAULT
        : stored;
    } catch {
      return ASSET_ENHANCE_DEFAULT;
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(`assetEnhance_${projectId}`, assetEnhancementPrompt);
    } catch {
      // 静默
    }
  }, [projectId, assetEnhancementPrompt]);

  // 批5 资产设定：完整 AssetRecord[] state + loadAssets（独立于 projectAssets
  // 简化版，后者只供 InputStage 跨集 text-to-style 上下文用）
  const [assets, setAssets] = React.useState<AssetRecord[]>([]);
  const [assetsLoading, setAssetsLoading] = React.useState(false);
  const loadAssets = React.useCallback(async () => {
    setAssetsLoading(true);
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/assets`,
      )) as { assets?: AssetRecord[] } | null;
      if (data?.assets) setAssets(data.assets);
    } catch {
      // 静默：资产列表缺失时 AssetDesignStage 显示空状态
    } finally {
      setAssetsLoading(false);
    }
  }, [api, projectId]);

  React.useEffect(() => {
    void loadAssets();
  }, [loadAssets]);
  // 分镜
  const [shots, setShots] = React.useState<ShotRecord[]>([]);
  /** 渐进回传:按 shotIds 就地打 patch 到 shots(乐观更新,如某组视频刚完成即显示)。
   *  链 COMPLETED 时的 loadShots 拉服务端真值兜底,故此处纯前端乐观、可被覆盖。 */
  const patchShots = React.useCallback(
    (shotIds: string[], patch: Partial<ShotRecord>) => {
      const ids = new Set(shotIds);
      setShots((prev) => prev.map((s) => (ids.has(s.id) ? { ...s, ...patch } : s)));
    },
    [],
  );
  // 多分集快捷切换条
  const [episodes, setEpisodes] = React.useState<EpisodeRecord[]>([]);

  // 模型选择（对齐 app1 顶部模型选择器；GC-1 key 云端，仅选模型不选 key）
  const [scriptModel, setScriptModel] = React.useState<string>(DEFAULT_SCRIPT_MODEL);
  const [imageModel, setImageModel] = React.useState<string>(DEFAULT_IMAGE_MODEL);
  const [videoModel, setVideoModel] = React.useState<string>(DEFAULT_VIDEO_MODEL);

  /** 加载请求序号 —— 防过期响应覆盖（SSE 触发密集刷新时旧响应可能后到） */
  const loadRequestSeqRef = React.useRef(0);
  /**
   * 首次加载是否已完成 —— 守卫全屏 `<Spinner>`（见下方 `if (loading)`）只在首次挂载
   * 触发。后续刷新（如「保存并分析」后的 onRefresh → loadEpisode、SSE 推送刷新）
   * 不再翻转 `loading`，避免整页黑底 Spinner 把 InputStage 的 inline 进度条连根卸载
   * （用户反复投诉的「保存并分析黑屏转圈」，详见 [[ui-progress-preference]]）。
   * 刷新改为原地静默更新 episode 数据。
   */
  const initialLoadDoneRef = React.useRef(false);

  // 批6：scenes/scriptData 派生已随 storyboard 内联块删除（StoryboardStage 内部
  // 自管，不再从 EpisodeWorkspace 传 scenes）。ScriptScene/ScriptData 类型保留
  // 供未来 production 阶段或对白覆盖校验消费。

  /** 拉单集详情。首次成功后从 stageStatus 推导 furthestStage（若更靠后）。 */
  const loadEpisode = React.useCallback(async () => {
    const seq = ++loadRequestSeqRef.current;
    // 只在首次（episode 还没数据可展示）显示全屏 Spinner；后续刷新（保存并分析后的
    // onRefresh、SSE 推送等）原地静默更新，不再触发整页黑底 Spinner 遮住 inline 进度条。
    const showFullScreenLoading = !initialLoadDoneRef.current;
    if (showFullScreenLoading) setLoading(true);
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}`,
      )) as EpisodeRecord | null;
      if (seq !== loadRequestSeqRef.current) return;
      if (!data) {
        // callApi 已 toast（404 / envelope.success:false / 网络）；视为未找到
        setNotFound(true);
        return;
      }
      setEpisode(data);
      // 首次成功落库后标记：此后任何刷新都不再走全屏 Spinner 分支。
      initialLoadDoneRef.current = true;

      // furthestStage 自动推进（app1:400-405）：后端 stageStatus 可能被其他端推进
      // （如成片导出），取 max(本地 furthest, 后端值)。
      const persistedStage = deriveStageFromEpisode(data.stageStatus);
      if (stageOrder(persistedStage) > stageOrder(furthestStageRef.current)) {
        furthestStageRef.current = persistedStage;
      }
    } catch {
      // callApi 已 toast；此处不重复
    } finally {
      if (showFullScreenLoading && seq === loadRequestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [api, projectId, episodeId]);

  React.useEffect(() => {
    void loadEpisode();
  }, [loadEpisode]);

  /**
   * 拉项目详情（仅取 category 供 InputStage 决定风格区显示模式）。
   *
   * 批3 新增：InputStage 需项目分类（OVERSEAS/DOMESTIC/ORIGINAL）决定 UI 分支。
   * 独立 GET 避免扩展 episode 返回结构（recon D6 决策：避免改 schema）。
   * 失败静默：项目不存在 / 403 都已被 episode GET 拦截，此处不会成首个失败源。
   */
  const loadProject = React.useCallback(async () => {
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}`,
      )) as ProjectRecord | null;
      if (data) setProject(data);
    } catch {
      // 静默：category 缺失时 InputStage 退化到 DOMESTIC（不显示风格区）
    }
  }, [api, projectId]);

  React.useEffect(() => {
    void loadProject();
  }, [loadProject]);

  /**
   * 拉项目已确认资产（跨集 text-to-style 传递用）。
   *
   * 批3 新增：第二集及之后，前端传项目已确认 CHARACTER/PROP/LOCATION 资产
   * 给 InputStage.existingAssets，让 text-to-style 模型复用首集锁定的角色名。
   * 在客户端过滤 isConfirmed=true（assets route 暂无服务端过滤参数，避免改 route）。
   */
  const loadProjectAssets = React.useCallback(async () => {
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/assets`,
      )) as { assets?: Array<{ kind: string; name: string; description: string | null; isConfirmed: boolean }> } | null;
      if (data?.assets) {
        setProjectAssets(
          data.assets
            .filter(
              (a) =>
                a.isConfirmed === true &&
                (a.kind === "CHARACTER" || a.kind === "PROP" || a.kind === "LOCATION"),
            )
            .map((a) => ({ kind: a.kind, name: a.name, description: a.description ?? "" })),
        );
      }
    } catch {
      // 静默：资产列表缺失时 existingAssets=[] ，text-to-style 仍可工作（无跨集上下文）
    }
  }, [api, projectId]);

  React.useEffect(() => {
    void loadProjectAssets();
  }, [loadProjectAssets]);

  /** 拉分镜列表。 */
  const loadShots = React.useCallback(async () => {
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots`,
      )) as { shots?: ShotRecord[] } | null;
      if (data?.shots) setShots(data.shots);
    } catch {
      // 分镜列表非关键，静默
    }
  }, [api, projectId, episodeId]);

  React.useEffect(() => {
    void loadShots();
  }, [loadShots]);

  /** 拉项目所有分集（快捷切换条用）。 */
  const loadEpisodes = React.useCallback(async () => {
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes`,
      )) as { episodes?: EpisodeRecord[] } | null;
      if (data?.episodes) setEpisodes(data.episodes);
    } catch {
      // 静默
    }
  }, [api, projectId]);

  React.useEffect(() => {
    void loadEpisodes();
  }, [loadEpisodes]);

  // ============================================================
  // 业务 handlers（移自原 page.tsx 内联）
  // ============================================================

  // 批6：handleGenerateStoryboard + generatingStoryboard state 移入 StoryboardStage
  // （app1 镜像：阶段内自治，包含 generating 本地 state + handleGenerate 直接调
  // episode 级 URL + toast d.shots?.length）。
  //
  // 批7：chainJob state + pollChainJob + handleChainGenerate 也移入 ProductionStage
  // （app1 镜像：production 阶段内自治）。

  // ============================================================
  // SSE 事件过滤 + busy 状态管理（照搬 app1:557-595）
  // ============================================================
  /** 本集相关的活跃任务 ID 集合（用于 busy 上报） */
  const [activeTaskIds, setActiveTaskIds] = React.useState<Set<string>>(new Set());

  /**
   * 从活跃任务集合移除单个 taskId（ActiveTaskStatusBar onRemoveTask 回调用）。
   *
   * 照搬 app1 EpisodeWorkspace.tsx:484-492（移除 untrackTaskId +
   * clearGenerationLockByTaskId 调用 —— dramaforge 的 untrack 已由
   * GenerationProgress 内部 onComplete/onFailure 触发，此处只需更新 Set）。
   */
  const removeActiveTask = React.useCallback((taskId: string) => {
    setActiveTaskIds((previous) => {
      const next = new Set(previous);
      next.delete(taskId);
      return next;
    });
  }, []);

  /**
   * 触发 shots 刷新的防抖调度器（300ms）
   *
   * 为什么需要：成组生成 / 链式生成会接连落多条 COMPLETED 事件，逐条触发
   * loadShots 会形成请求风暴；合并为一次刷新（视频已落库，晚 300ms 用户无感）。
   */
  const refreshShotTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleShotRefresh = React.useCallback(() => {
    if (refreshShotTimerRef.current) clearTimeout(refreshShotTimerRef.current);
    refreshShotTimerRef.current = setTimeout(() => {
      refreshShotTimerRef.current = null;
      loadShots();
    }, 300);
  }, [loadShots]);

  /** 从全局 SSE 事件中检测本集相关任务的终态 → 清 activeTaskIds + 防抖刷 shots */
  React.useEffect(() => {
    if (!events || events.length === 0) return;
    // 只看最近 10 条（app1 同款），避免遍历全部 200 条缓冲
    const recent = events.slice(0, 10);
    let changed = false;
    let needShotRefresh = false;
    const next = new Set(activeTaskIds);
    for (const evt of recent) {
      if (evt.type === "status_change") {
        if (
          evt.status === "COMPLETED" ||
          evt.status === "FAILED" ||
          evt.status === "CANCELLED" ||
          evt.status === "TIMEOUT"
        ) {
          // 终态清锁（即便不属于本集 activeTaskIds，悬挂锁也应清）
          clearGenerationLockByTaskId(evt.taskId);
          // COMPLETED/FAILED 即刷新：chain-generate 的 taskId 只 trackTaskId 到模块级
          // Set（useTaskStatus），从未 add 到本 activeTaskIds React state——若仍用
          // next.has 门禁会漏掉它，FAILED 后前端永远卡在 GENERATING 转圈（用户 4945 的 bug）。
          // 多余刷新由 scheduleShotRefresh 300ms 防抖合并，无害。
          if (evt.status === "COMPLETED" || evt.status === "FAILED") {
            needShotRefresh = true;
          }
          if (next.has(evt.taskId)) {
            next.delete(evt.taskId);
            changed = true;
          }
        }
      }
    }
    if (changed) setActiveTaskIds(next);
    if (needShotRefresh) scheduleShotRefresh();
  }, [events, activeTaskIds, scheduleShotRefresh]);

  /** 卸载时清理防抖定时器 */
  React.useEffect(() => {
    return () => {
      if (refreshShotTimerRef.current) {
        clearTimeout(refreshShotTimerRef.current);
        refreshShotTimerRef.current = null;
      }
    };
  }, []);

  /** busy 上报：有活跃任务时通知分集页，刷新和多 Tab 都能正确提示。 */
  const isBusy = activeTaskIds.size > 0;
  React.useEffect(() => {
    onBusyChange?.(isBusy);
  }, [isBusy, onBusyChange]);

  // ============================================================
  // 阶段导航
  // ============================================================
  const currentStageIdx = STAGES.findIndex((s) => s.key === viewStage);
  const nextStage = currentStageIdx < STAGES.length - 1 ? STAGES[currentStageIdx + 1] : null;
  const prevStage = currentStageIdx > 0 ? STAGES[currentStageIdx - 1] : null;

  const navigateToStage = React.useCallback(
    (stage: StageKey) => {
      void handleStageChange(stage);
    },
    [handleStageChange],
  );

  // ============================================================
  // 渲染
  // ============================================================

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Spinner size={28} />
      </main>
    );
  }

  if (notFound || !episode) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-sm text-[var(--text-3)]">分集不存在或无权访问</p>
        <Link
          href={`/workspace/${encodeURIComponent(projectId)}`}
          className="text-[var(--action)] hover:underline"
        >
          返回项目
        </Link>
      </main>
    );
  }

  // F4: 删除 analyzing→input 重映射（旧逻辑在 status=ANALYZING 时把 analyzing
  // 强制回 input 渲染，导致 URL/Tab 显示 analyzing 但 Body 实际渲染 input 的 desync）。
  // 现在 viewStage 即渲染阶段，AnalyzingStage 真正挂载并显示 GenerationProgress。
  const effectiveStage: StageKey = viewStage;

  return (
    <main className="h-screen overflow-hidden flex flex-col">
      {/* 顶部：返回 + 集标题 */}
      <header className="flex items-center gap-4 px-6 pt-6 w-full">
        <Link
          href={`/workspace/${encodeURIComponent(projectId)}`}
          className="text-sm text-[var(--text-3)] hover:text-[var(--text)] transition-colors flex-shrink-0"
        >
          ← 返回项目
        </Link>
        <h1 className="text-2xl font-bold text-[var(--text)] truncate flex-1">
          {episode.title || `第 ${episode.episodeNumber} 集`}
        </h1>
      </header>

      {/* 多分集快捷切换条（B 方案：点跳路由；视觉对齐 app1 SPA Tab 栏 —— 集号圆 +
          阶段短标签 + hover 显关闭按钮 + busy 关闭确认 ConfirmDialog） */}
      {episodes.length > 0 && (
        <div className="px-6 mt-3 w-full">
          <EpisodeTabs
            tabs={episodes.map((e) => ({
              id: e.id,
              episodeNumber: e.episodeNumber,
              // EpisodeRecord.title 是 string | null；EpisodeTabItem.title 是
              // string | undefined（对齐 app1）—— null → undefined 强转
              title: e.title ?? undefined,
              // F4: 所有 tab 一致使用服务端 stageStatus（真相源），不再对当前集
              // 特殊化用本地 viewStage——消除 URL/Tab/Body 三方不一致的 desync。
              stageStatus: deriveStageFromEpisode(e.stageStatus),
              // B 方案只挂载当前集 → 仅当前集 busy 已知；其他集恒 false
              busy: e.id === episodeId && isBusy,
            }))}
            activeEpisodeId={episodeId}
            onActivate={(id) => {
              if (id === episodeId) return;
              router.push(
                `/workspace/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(id)}`,
              );
            }}
            onClose={() => {
              // B 方案无 SPA Tab 状态：关闭 = 离开工作台回到分集列表
              // （当前/非当前一致：当前集直接回去；非当前集也无 SPA 状态可清）
              router.push(`/workspace/${encodeURIComponent(projectId)}`);
            }}
            onBackToList={() => {
              router.push(`/workspace/${encodeURIComponent(projectId)}`);
            }}
          />
        </div>
      )}

      {/* 阶段进度条 */}
      <div className="px-6 mt-3 w-full flex items-center gap-3">
        <StageNav current={effectiveStage} onNavigate={(k) => navigateToStage(k as StageKey)} />
        {/* 手动刷新按钮：客户端已禁用 Ctrl+R，点此整页刷新；放在共享阶段栏，全阶段可见 */}
        <button
          type="button"
          onClick={() => window.location.reload()}
          title="刷新页面"
          aria-label="刷新页面"
          className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border-light)] bg-[var(--bg)] text-[var(--text-2)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--action)]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M21 12a9 9 0 10-3.2 6.9M21 3v6h-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* 分集级活跃任务聚合条（照搬 app1 EpisodeWorkspace.tsx:773-779；size>0 时渲染） */}
      {activeTaskIds.size > 0 && (
        <ActiveTaskStatusBar
          activeTaskIds={activeTaskIds}
          projectId={projectId}
          onRemoveTask={removeActiveTask}
        />
      )}

      {/* 内容区（按 viewStage 渲染）—— 有界高度链：overflow-hidden + min-h-0 让子 Stage
          的 h-full 解析到有界空间，左列表 overflow-y-auto 才会独立滚动（否则资产多时
          左列表无限拉高把右侧资产图顶出视口）。照 app1 EpisodeWorkspace.tsx:715/782。 */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0 px-6 py-6 w-full">
        {/* —— 输入阶段：ORIGINAL 项目显示 OriginalRewriteStage（整剧重写/原创剧本）；
            非ORIGINAL 显示 InputStage（单集剧本输入）。
            照 app1 page.tsx:647-648 的 ORIGINAL 分支判定，落到 input 阶段位置。
            category 是 ProjectCategory 联合（'ORIGINAL'|'DOMESTIC'|'OVERSEAS'），
            scriptData.sourceMode 的 narrowing 由 OriginalRewriteStage 内部 readSourceMode 处理。 —— */}
        {effectiveStage ==="input" &&
          (project?.category === "ORIGINAL" ? (
            <OriginalRewriteStage
              project={project}
              onRefresh={(opts) => {
                void loadProject();
                if (opts?.force) {
                  // 强制刷新时同步刷分集列表（整剧重写完成可能派生新分集）
                  void loadEpisodes();
                }
              }}
            />
          ) : (project?.scriptData &&
            typeof project.scriptData === "object" &&
            !Array.isArray(project.scriptData) &&
            (project.scriptData as { sourceMode?: string }).sourceMode === "REFERENCE_VIDEO" ? (
            <ReferenceVideoStage
              projectId={projectId}
              episodeId={episodeId}
              projectTitle={project?.title ?? "海外转绘项目"}
              api={api}
              onNavigateNext={() => syncStageView("analyzing")}
              onRefresh={() => {
                void loadEpisode();
                void loadProject();
              }}
            />
          ) : (
            <InputStage
              projectId={projectId}
              episodeId={episodeId}
              episode={episode}
              category={project?.category ?? "DOMESTIC"}
              sourceMode={
                project?.scriptData &&
                typeof project.scriptData === "object" &&
                !Array.isArray(project.scriptData)
                  ? (project.scriptData as { sourceMode?: string }).sourceMode
                  : undefined
              }
              existingAssets={projectAssets}
              api={api as (url: string, options?: RequestInit) => Promise<any>}
              scriptModel={scriptModel}
              onRefresh={(opts) => {
                void loadEpisode();
                if (opts?.force) {
                  // 强制刷新时同步刷资产列表（保存分析后可能有跨集资产变化）
                  void loadProjectAssets();
                }
              }}
              onNavigateNext={() => syncStageView("analyzing")}
            />
          )))}

        {/* —— 分析阶段：AnalyzingStage 组件（批4 替换内联块，镜像 app1） —— */}
        {effectiveStage ==="analyzing" && (
          <AnalyzingStage
            projectId={projectId}
            episodeId={episodeId}
            episode={episode}
            category={project?.category ?? "DOMESTIC"}
            api={api as (url: string, options?: RequestInit) => Promise<any>}
            onRefresh={(opts) => {
              void loadEpisode();
              if (opts?.force) {
                // 强制刷新时同步刷资产列表（重新分析后可能有跨集资产变化）
                void loadProjectAssets();
              }
            }}
            onNavigateNext={() => syncStageView("assets")}
            analyzeEnhancementPrompt={analyzeEnhancementPrompt}
            setAnalyzeEnhancementPrompt={setAnalyzeEnhancementPrompt}
            scriptModel={scriptModel}
            isReview={false}
          />
        )}

        {/* —— 资产阶段：项目级资产面板（批5 AssetDesignStage 镜像 app1）—— */}
        {effectiveStage ==="assets" && (
          <AssetDesignStage
            projectId={projectId}
            episodeId={episodeId}
            assets={assets}
            api={api as (url: string, options?: RequestInit) => Promise<any>}
            onComplete={() => syncStageView("storyboard")}
            onRefresh={(opts) => {
              void loadAssets();
              if (opts?.force) {
                // 强制刷新时同步刷 projectAssets（确认/解锁可能影响 InputStage 跨集上下文）
                void loadProjectAssets();
              }
            }}
            loading={assetsLoading}
            isReview={false}
            imageModel={imageModel}
            setImageModel={setImageModel}
            imageResolution={imageResolution}
            setImageResolution={setImageResolution}
            imageStyle={imageStyle}
            setImageStyle={setImageStyle}
            scriptModel={scriptModel}
            setScriptModel={setScriptModel}
            enhancementPrompt={assetEnhancementPrompt}
            setEnhancementPrompt={setAssetEnhancementPrompt}
            scriptTextLength={
              (episode?.novelText ?? episode?.content ?? "").length
            }
          />
        )}

        {/* —— 分镜阶段：StoryboardStage 组件（批6 镜像 app1，替换内联块）—— */}
        {effectiveStage ==="storyboard" && (
          <StoryboardStage
            projectId={projectId}
            episodeId={episodeId}
            shots={shots}
            episode={episode}
            sourceVideoDurationSeconds={readSourceVideoDurationSeconds(episode)}
            assets={assets}
            category={project?.category ?? "DOMESTIC"}
            api={api as (url: string, options?: RequestInit) => Promise<any>}
           onRefresh={() => void loadShots()}
           onNavigateNext={() =>
             nextStage ? syncStageView(nextStage.key as StageKey) : undefined
           }
           videoModel={videoModel}
           setVideoModel={setVideoModel}
         />
        )}

        {/* —— 生产阶段：ProductionStage 组件（批7 镜像 app1 简化版）—— */}
        {effectiveStage ==="production" && (
          <ProductionStage
            projectId={projectId}
            episodeId={episodeId}
            shots={shots}
            episode={episode}
            project={project}
            assets={assets}
            api={api as (url: string, options?: RequestInit) => Promise<any>}
            onRefresh={() => void loadShots()}
            onPatchShots={patchShots}
            onNavigateToFilms={onNavigateToFilms}
            videoModel={videoModel}
            setVideoModel={setVideoModel}
            isReview={false}
          />
        )}
      </div>

      {/* 底部阶段导航（上/下阶段） */}
      <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-[var(--border-light)] bg-[var(--bg-elevated)] flex-shrink-0">
        {prevStage && (
          <Button variant="ghost" size="sm" onClick={() => navigateToStage(prevStage.key)}>
            ← {prevStage.label}
          </Button>
        )}
        <div className="min-w-28 px-3 text-center">
          <div className="text-[10px] text-[var(--text-3)]">第 {episode.episodeNumber ?? "?"} 集</div>
          <div className="text-xs font-semibold text-[var(--text)]">
            {STAGES[currentStageIdx]?.label || ""}
          </div>
        </div>
        {nextStage && (
          <Button variant="primary" size="sm" onClick={() => navigateToStage(nextStage.key)}>
            {nextStage.label} →
          </Button>
        )}
      </div>
    </main>
  );
}
