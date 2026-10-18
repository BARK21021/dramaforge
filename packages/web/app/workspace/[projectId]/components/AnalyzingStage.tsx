"use client";

/**
 * @file AnalyzingStage.tsx
 * @description 编剧分析阶段组件（阶段 2，批4）
 *
 * 镜像 app1 `F:\app1\src\app\workspace\[projectId]\components\AnalyzingStage.tsx`
 * （556 行），适配 dramaforge 同步直连模式（无 GenerationProgress / taskId）。
 *
 * 展示 AI 编剧分析结果（场景/角色/信息点/造型表/原始分析），支持重新分析与
 * 进入下一阶段（资产设定）。
 *
 * 触发点：分析请求由 InputStage 的「保存并分析」按钮或本组件「重新分析」按钮发起
 *   POST /api/projects/[projectId]/episodes/[episodeId]/analyze
 *   结果写入 episode.scriptData（含 rawAnalysis/scenes/infoPoints/sceneMeta/
 *   costumeMap/characters/modelUsed/analyzedAt）
 *
 * 本阶段职责（A1-A11，对齐 app1）：
 *   1. A1 标题区：h2 琥珀色图标 + 副标题（场景数/角色数/模型/时间）
 *   2. A2 顶部操作：「按实际 Token 结算」提示 + 「重新分析」+ 「进入资产设定」
 *   3. A3 只读提示条（isReview，批4 暂传 false，批9 review 模式启用）
 *   4. A4 增强提示词折叠卡（编辑/查看双态，localStorage 持久化由父组件持有）
 *   5. A5 分析中进度（ProgressBar pulse，对齐 InputStage 批3 模式）
 *   6. A6 空状态（EmptyState lg）
 *   7. A7 场景列表（序号琥珀徽章 + mono sceneId + 三 badge + 角色 chips + content）
 *   8. A8 信息点（2 列网格）
 *   9. A9 造型表（table rowSpan）
 *   10. A10 原始分析折叠（details/summary）
 *   11. A11 底部操作（进入资产设定重复按钮）
 *
 * 与 app1 差异（行为等价，GC-7 架构翻译）：
 *   - 删 GenerationProgress（dramaforge 无此组件）→ 单一 ProgressBar pulse 模式
 *   - 删 trackTaskId/untrackTaskId（同步直连不返回 taskId）
 *   - 删 analyzeTaskId state + 双态分支 + 空 useEffect（OP3/OP4 死代码清理）
 *   - 删 sortedScenes 浅拷贝（OP2 死代码，直接 scenes.map）
 *   - 修造型表 shape bug（OP1）：parseScriptResult 返回 CostumeMapEntry[]，
 *     app1 前端类型 Record<string,Record<string,string>> + Object.keys(数组)
 *     导致造型表渲染错乱；dramaforge 用数组直接重写 A9 + 兼容层
 *   - 修信息点字段 bug：parseScriptResult 返回 {type, description}，app1 前端
 *     读 {title, content} 导致信息点显示空标题/空内容；dramaforge 防御性读两种 shape
 *   - 角色名补全：scriptData.scenes[].characters 实际未由 route 写入，
 *     dramaforge 从 scriptData.characters + content.includes 派生（对齐 route.ts:177
 *     顶层 scenes 字段的派生逻辑，匹配 app1 设计意图）
 *
 * 双色方案铁律（对齐 app1）：
 *   - 「重新分析」/「进入资产设定」按钮使用 --action 蓝（可点击行为）
 *   - 阶段标题图标 + 场景/造型表分组标签使用 --accent 琥珀（身份/品牌层）
 *
 * GC 翻译：
 *   - GC-1（BYOK 禁）：POST /analyze body 仅 {model, enhancementPrompt}，无 key ✓
 *   - GC-3（app1 只读）：仅镜像，未改 app1 ✓
 *   - GC-5（无新 .sql）：analyzedAt 是 JSONB 字段追加，无 schema 变更 ✓
 *   - GC-7（架构差异行为等价）：ProgressBar 替 GenerationProgress ✓
 *   - dramaforge-assets-client-local：纯文本/JSON 展示，无媒体字节 ✓
 *   - dramaforge-keys-cloud-server-only：云端 key ✓
 *   - dramaforge-frontend-align-app1：UI 1:1 镜像 app1 ✓
 *   - prefer-better-lib-not-selfbuilt：EmptyState/ProgressBar/Textarea/Button/Toast
 *     全复用批0 UI 组件 ✓
 */

import * as React from "react";
import { Button } from "../../../../components/ui/Button";
import { Textarea } from "../../../../components/ui/Input";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { ProgressBar } from "../../../../components/ui/ProgressBar";
import { useToast } from "../../../../components/ui/Toast";
import type { EpisodeRecord } from "@dramaforge/shared";
// 客户端组件走 prompt 子路径（避免主 barrel 的 node:* 依赖污染 client bundle）。
// type-only import：编译期擦除，零运行时 server 引用（对齐 InputStage 批3 模式）。
import type {
  SceneInfo,
  InfoPoint,
  CostumeMapEntry,
} from "@dramaforge/server/prompt";
import { useInFlightGeneration } from "../../../../hooks/useInFlightGeneration";
import { runAnalysisWorkflow } from "../../../../lib/analysis-workflow";
import { useEpisodeTask } from "../../../../hooks/useEpisodeTask";
import { setTaskId } from "../../../../lib/episode-task-store";
import { GenerationProgress } from "../../../../components/features/GenerationProgress";

// ============================================================
// 类型定义（OP6：复用 barrel 类型，避免内部重复定义）
// ============================================================

/**
 * 造型表分组（OP1+OP10）：按 sceneId 分组，组内保留原始 entry 顺序。
 *
 * 兼容两种运行时 shape：
 *   - CostumeMapEntry[]（parseScriptResult 实际输出，dramaforge/app1 route 都写这个）
 *   - Record<string, Record<string, string>>（app1 前端类型声明的 shape，
 *     若未来 route 改写为 Record 也能渲染）
 */
interface CostumeGroup {
  sceneId: string;
  rows: Array<{
    character: string;
    costume: string;
  }>;
}

/** 本组件消费的 scriptData 切片（readScriptData narrow 后的 shape） */
interface ScriptDataSlice {
  scenes: SceneInfo[];
  infoPoints: InfoPoint[];
  costumeGroups: CostumeGroup[];
  characters: string[];
  /** 顶层 scriptData.sceneBlockingImages（baseSceneId→切片），供场景卡片渲染缩略图/状态。 */
  blockingImages: Record<string, BlockingImageSlice>;
  rawAnalysis?: string;
  modelUsed?: string;
  analyzedAt?: string;
  /** K3 镜头表（REFERENCE_VIDEO 模式）；存在 = K3 分析已完成，不需 DeepSeek 重新分析。 */
  referenceVideoShots?: unknown[];
}

/** 站位图记录切片（仅 UI 展示需要的三字段）。 */
interface BlockingImageSlice {
  url?: string;
  status?: string;
  sourceSpatialLayout?: string;
}

/** S3-1 → S3；与 server extractBaseSceneId 同义（本地副本，免跨包运行时 import）。 */
function baseSceneId(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = value.trim().match(/^(S\d+)/i);
  return match ? match[1].toUpperCase() : value.trim();
}

/** 分析与资产提取的可见阶段进度。 */
interface AnalyzingProgress {
  value: number;
  label: string;
  stage: string;
}

export interface AnalyzingStageProps {
  /** 项目 ID */
  projectId: string;
  /** 分集 ID */
  episodeId?: string | null;
  /** 分集数据（含 scriptData 分析结果；scriptData 是 unknown，内部 narrow） */
  episode?: EpisodeRecord | null;
  /** 项目分类（OVERSEAS / DOMESTIC / ORIGINAL，影响语言分支提示） */
  category?: string;
  /** API 调用封装（带鉴权 + envelope 解析，由 EpisodeWorkspace 透传） */
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  /** 刷新数据回调（force 时同步刷资产列表） */
  onRefresh?: (opts?: { force?: boolean }) => void;
  /** 跳转下一阶段（资产设定）回调 */
  onNavigateNext?: () => void;
  /** 编剧分析增强提示词（可选，指导角色/场景/资产提取方向） */
  analyzeEnhancementPrompt?: string;
  setAnalyzeEnhancementPrompt?: (v: string) => void;
  /** 文本模型 ID */
  scriptModel?: string;
  /** 是否只读模式（已过阶段，仅可查看；批4 暂传 false，批9 review 模式启用） */
  isReview?: boolean;
  /** 容器额外类名 */
  className?: string;
}

// ============================================================
// narrow helper（OP7：对齐 InputStage readLocalizationProfile 模式）
// ============================================================

/**
 * 从 episode.scriptData（unknown，DB JSONB 透传）安全读出本组件需要的字段。
 *
 * 任何 shape 不匹配（null / 非 object / 缺字段）→ 返回空数组/undefined。
 * 兼容 app1 类型声明的 shape 与 parseScriptResult 实际输出的 shape：
 *   - costumeMap: CostumeMapEntry[] 或 Record<string, Record<string, string>>
 *   - infoPoints: {type, description}[] 或 {title, content}[]（防御性读两种）
 *   - scenes: SceneInfo[]（route 写 parsedScript.scenes，无 characters 字段；
 *     本组件从 scriptData.characters + content.includes 派生每个 scene 的角色）
 */
function readScriptData(scriptData: unknown): ScriptDataSlice {
  const empty: ScriptDataSlice = {
    scenes: [],
    infoPoints: [],
    costumeGroups: [],
    characters: [],
    blockingImages: {},
  };
  if (!scriptData || typeof scriptData !== "object" || Array.isArray(scriptData)) {
    return empty;
  }
  const s = scriptData as Record<string, unknown>;

  // scenes：必须是数组，每项是 object（SceneInfo shape）
  const rawScenes = Array.isArray(s.scenes) ? (s.scenes as unknown[]) : [];
  const scenes: SceneInfo[] = [];
  for (const raw of rawScenes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    scenes.push({
      id: typeof r.id === "string" ? r.id : "",
      location: typeof r.location === "string" ? r.location : "",
      time: typeof r.time === "string" ? r.time : "",
      intExt: typeof r.intExt === "string" ? r.intExt : "",
      content: typeof r.content === "string" ? r.content : "",
      spatialLayout: typeof r.spatialLayout === "string" ? r.spatialLayout : undefined,
    });
  }

  // infoPoints：必须是数组，每项是 object（防御性读 type/description + title/content 两种 shape）
  const rawInfoPoints = Array.isArray(s.infoPoints) ? (s.infoPoints as unknown[]) : [];
  const infoPoints: InfoPoint[] = [];
  for (const raw of rawInfoPoints) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const type = typeof r.type === "string" ? r.type : typeof r.title === "string" ? r.title : "";
    const description =
      typeof r.description === "string"
        ? r.description
        : typeof r.content === "string"
          ? r.content
          : "";
    infoPoints.push({ type, description });
  }

  // characters：顶层 string[]（route.ts:165 写入 parsedScript.characters）
  const characters: string[] = Array.isArray(s.characters)
    ? (s.characters as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  // costumeMap：兼容数组（CostumeMapEntry[]，parseScriptResult 实际输出）与
  // Record<string, Record<string, string>>（app1 前端类型声明的 shape）两种
  const rawCostume = s.costumeMap;
  const costumeGroups = narrowCostumeGroups(rawCostume);

  // 顶层 sceneBlockingImages（baseSceneId→切片）：仅 UI 展示缩略图/状态/过期用。
  const blockingImages: Record<string, BlockingImageSlice> = {};
  const rawBlocking = s.sceneBlockingImages;
  if (rawBlocking && typeof rawBlocking === "object" && !Array.isArray(rawBlocking)) {
    for (const [k, v] of Object.entries(rawBlocking as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const br = v as Record<string, unknown>;
      const id = baseSceneId(k);
      if (!id) continue;
      blockingImages[id] = {
        url: typeof br.url === "string" ? br.url : undefined,
        status: typeof br.status === "string" ? br.status : undefined,
        sourceSpatialLayout: typeof br.sourceSpatialLayout === "string" ? br.sourceSpatialLayout : undefined,
      };
    }
  }

  return {
    scenes,
    infoPoints,
    costumeGroups,
    characters,
    blockingImages,
    rawAnalysis: typeof s.rawAnalysis === "string" ? s.rawAnalysis : undefined,
    modelUsed: typeof s.modelUsed === "string" ? s.modelUsed : undefined,
    analyzedAt: typeof s.analyzedAt === "string" ? s.analyzedAt : undefined,
    referenceVideoShots: Array.isArray(s.referenceVideoShots) ? (s.referenceVideoShots as unknown[]) : undefined,
  };
}

/**
 * 把后端 costumeMap（数组或 Record）统一转成 CostumeGroup[] 供 A9 渲染。
 *
 * 数组 shape（parseScriptResult 输出）：CostumeMapEntry[]，按 sceneId 分组
 * Record shape（app1 前端类型声明）：{ [sceneId]: { [character]: costumeDesc } }
 *
 * 输出按首次出现顺序保留 sceneId，组内保留 entry 顺序。
 */
function narrowCostumeGroups(raw: unknown): CostumeGroup[] {
  if (!raw) return [];

  // 数组 shape：CostumeMapEntry[]
  if (Array.isArray(raw)) {
    const map = new Map<string, CostumeGroup>();
    for (const item of raw as unknown[]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const e = item as Record<string, unknown>;
      const sceneId = typeof e.sceneId === "string" ? e.sceneId : "";
      const character = typeof e.character === "string" ? e.character : "";
      if (!sceneId || !character) continue;
      const costumeLabel = typeof e.costumeLabel === "string" ? e.costumeLabel : "";
      const costumeDesc = typeof e.costumeDesc === "string" ? e.costumeDesc : "";
      const isNew = e.isNew === true;
      const costume = [costumeLabel, costumeDesc, isNew ? "新造型" : ""]
        .filter(Boolean)
        .join(" / ");
      let group = map.get(sceneId);
      if (!group) {
        group = { sceneId, rows: [] };
        map.set(sceneId, group);
      }
      group.rows.push({ character, costume });
    }
    return Array.from(map.values());
  }

  // Record shape：{ [sceneId]: { [character]: costumeDesc } }
  if (typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const groups: CostumeGroup[] = [];
    for (const [sceneId, charMap] of Object.entries(r)) {
      if (!charMap || typeof charMap !== "object" || Array.isArray(charMap)) continue;
      const cm = charMap as Record<string, unknown>;
      const rows: CostumeGroup["rows"] = [];
      for (const [character, costume] of Object.entries(cm)) {
        const costumeStr = typeof costume === "string" ? costume : "";
        rows.push({ character, costume: costumeStr });
      }
      if (rows.length > 0) groups.push({ sceneId, rows });
    }
    return groups;
  }

  return [];
}

// ============================================================
// 组件
// ============================================================

export function AnalyzingStage({
  projectId,
  episodeId,
  episode,
  category,
  api,
  onRefresh,
  onNavigateNext,
  analyzeEnhancementPrompt,
  setAnalyzeEnhancementPrompt,
  scriptModel,
  isReview,
  className,
}: AnalyzingStageProps) {
  const toast = useToast();
  const [analyzing, setAnalyzing] = React.useState(false);
  const [enhancementEditing, setEnhancementEditing] = React.useState(false);
  const [enhancementDraft, setEnhancementDraft] = React.useState("");
  const [enhancementCollapsed, setEnhancementCollapsed] = React.useState(true);
  /** 分析中进度文案/阶段（对齐 InputStage 批3 单阶段 pulse 模式） */
  const [progress, setProgress] = React.useState<AnalyzingProgress | null>(null);

  // ---- 数据 narrow（OP7）----
  const sd = React.useMemo(() => readScriptData(episode?.scriptData), [episode?.scriptData]);
  const scenes = sd.scenes;
  const infoPoints = sd.infoPoints;
  const costumeGroups = sd.costumeGroups;
  const allCharacters = sd.characters;
  const blockingImages = sd.blockingImages;

  // OP12：双源 isCurrentlyAnalyzing（episode.status + 本地 state），处理刷新场景
  // 批9 轻量生命周期层：加 inflight 锁（localStorage，刷新不丢）。episode.status
  //  已覆盖 running/done，锁补 failed 检测（PENDING+锁→reconcile 返 failed→toast 重试）
  //  + 刷新瞬间（prop 未载入前）的即时「分析中」反馈。
  const inflight = useInFlightGeneration({
    key: `analyze:${episodeId}`,
    scope: "analyze",
    projectId,
    episodeId,
    reconcile: async () => {
      if (!episodeId) return null;
      const ep = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}`,
      )) as { status?: string } | null;
      if (ep?.status === "ANALYZING") return "running";
      if (ep?.status === "COMPLETED") return "done";
      return "failed"; // PENDING = 路由回滚 = 失败
    },
    onCompleted: (r) => {
      onRefresh?.({ force: true });
      if (r === "failed") toast.error("上次分析失败，可重新分析");
    },
    pollMs: 8000,
    maxPolls: 30,
  });
  const isCurrentlyAnalyzing =
    episode?.status === "ANALYZING" || analyzing || inflight.isGenerating;
  const hasAnalysis = scenes.length > 0;
  /** SSE 任务进度（F3）：刷新/直接进分析界面时从 localStorage 读 taskId → 实时百分比。 */
  const analyzeTask = useEpisodeTask(episodeId, 'STORY_ANALYZE');
  /** 重新分析(本组件自触发)时用 React state 即时驱动进度条——localStorage 读不触发
   *  rerender,纯靠 useEpisodeTask 会在 setAnalyzing(false) 后漏显。主流程(从 InputStage
   *  保存并分析)进本组件前已 setTaskId,mount 即读到,不受此影响。 */
  const [activeAnalyzeTaskId, setActiveAnalyzeTaskId] = React.useState<string | null>(null);
  const effectiveAnalyzeTaskId = activeAnalyzeTaskId ?? analyzeTask.taskId;
  // OP9：抽 canEdit 单变量，4 处替换 !isReview
  const canEdit = !isReview;

  /** 触发重新分析（同步直连模式，对齐 InputStage 批3 行 318-342） */
  const handleReanalyze = async () => {
    if (!episodeId) {
      toast.error("缺少分集 ID");
      return;
    }
    const novelText = (episode?.novelText ?? episode?.content ?? episode?.videoScriptDraft ?? "").trim();
    if (novelText.length < 10) {
      toast.error("该集剧本文本为空，请先在输入阶段保存剧本");
      return;
    }
    inflight.start();
    setAnalyzing(true);
    setProgress({ value: 10, label: "重新分析中", stage: "准备分析剧本" });
    toast.info("已提交重新分析；分析完成后会自动重新提取资产...");
    try {
      const result = await runAnalysisWorkflow({
        api,
        projectId,
        episodeId,
        model: scriptModel,
        enhancementPrompt: analyzeEnhancementPrompt,
        localizationProfile: category === 'OVERSEAS'
          ? 'Target language: English (US). Translate ALL dialogue, scene descriptions, and character names to English. Adapt all Chinese cultural references to Western equivalents (red envelopes become wedding cards, Chinese names become Western names, Chinese social norms become Western norms). All output MUST be entirely in English with zero Chinese characters.'
          : undefined,
        onProgress: ({ value, stage }) => {
          setProgress({ value, label: "重新分析并提取资产", stage });
        },
      });
      if (result?.taskId) {
        // 异步：POST 立即返 taskId；setActiveAnalyzeTaskId(React state)必然触发重渲染
        // 让进度条立刻显示；setTaskId 写 localStorage 供刷新恢复。
        // 完成由 GenerationProgress.onComplete 触发 onRefresh（不在此处误报完成）。
        setActiveAnalyzeTaskId(result.taskId);
        setTaskId('STORY_ANALYZE', episodeId, result.taskId);
      } else {
        // envelope.success:false 已被 useApi toast；此处重拉拿最新状态
        onRefresh?.({ force: true });
      }
    } catch (e: unknown) {
      toast.error(`分析失败: ${e instanceof Error ? e.message : "未知错误"}`);
      onRefresh?.({ force: true });
    } finally {
      setAnalyzing(false);
      inflight.end();
      // 300ms 后清进度（对齐 InputStage 批3 行 337-341 退出动画）
      setTimeout(() => setProgress(null), 300);
    }
  };

  // ---- 场景站位图（blocking image）：手动生成 → 客户端下回本地 → PUT 提交 ----
  // 镜像资产生图落地链（AssetDesignStage downloadProviderImage + patchImageUrl），
  // 但写回 scriptData.sceneBlockingImages（非 asset 表），由 blocking-image 路由处理。
  const [blockingBusy, setBlockingBusy] = React.useState<Record<string, boolean>>({});
  const handleGenerateBlocking = async (rawSceneId: string) => {
    if (!episodeId) {
      toast.error("缺少分集 ID");
      return;
    }
    setBlockingBusy((prev) => ({ ...prev, [rawSceneId]: true }));
    try {
      const url = `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/scenes/${encodeURIComponent(rawSceneId)}/blocking-image`;
      const gen = (await api(url, { method: "POST" })) as { providerUrl?: string } | null;
      const providerUrl = gen?.providerUrl;
      if (!providerUrl) throw new Error("未返回站位图 URL");
      const sf = window.sfShell;
      if (!sf?.downloadAsset) {
        throw new Error("桌面客户端本地存储(sfShell)未加载，请在桌面客户端内操作");
      }
      const dl = (await sf.downloadAsset(providerUrl)) as {
        ok?: boolean;
        protocolUrl?: string;
        error?: { code?: string; message?: string };
      };
      if (!dl?.ok || typeof dl.protocolUrl !== "string") {
        throw new Error(dl?.error?.message || "下载站位图到本地失败");
      }
      const localUrl = dl.protocolUrl;
      const key = localUrl.replace(/^sf-asset:\/\//, "");
      await api(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, url: localUrl }),
      });
      toast.success("场景站位图已生成");
      onRefresh?.({ force: true });
    } catch (e: unknown) {
      toast.error(`站位图生成失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setBlockingBusy((prev) => {
        const next = { ...prev };
        delete next[rawSceneId];
        return next;
      });
    }
  };

  // OP5：抽 NavigateToAssetsButton const（A2 + A11 复用）
  const navigateToAssetsButton = (
    <Button variant="primary" onClick={onNavigateNext}>
      进入资产设定
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M5 12h14m0 0l-6-6m6 6l-6 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Button>
  );

  return (
    <div
      className={`max-w-5xl mx-auto p-6 flex flex-col h-full overflow-y-auto ${className || ""}`}
    >
      {/* A1. 标题区 */}
      <div className="flex items-start justify-between mb-6 flex-shrink-0">
        <div>
          <h2
            className="text-xl font-bold text-[var(--text)] mb-1 flex items-center gap-2"
            style={{ fontFamily: "var(--font-display)" }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              className="text-[var(--accent)]"
              aria-hidden="true"
            >
              <path
                d="M7 4v16M17 4v16M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            编剧分析
          </h2>
          <p className="text-sm text-[var(--text-3)]">
            {hasAnalysis
              ? `${scenes.length} 个场景 · ${allCharacters.length} 个角色`
              : "解析场景结构与角色信息"}
            {sd.modelUsed && (
              <span className="ml-2 text-[var(--text-3)]/70">· 模型 {sd.modelUsed}</span>
            )}
            {sd.analyzedAt && (
              <span className="ml-2 text-[var(--text-3)]/70">
                · {new Date(sd.analyzedAt).toLocaleString("zh-CN", { hour12: false })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {canEdit && (
            <div className="text-xs text-[var(--text-3)] mr-1">按实际 Token 结算</div>
          )}
          {/* REFERENCE_VIDEO：K3 分析已完成（有 referenceVideoShots），不需要 DeepSeek 重新分析 */}
          {canEdit && !hasAnalysis && !sd.referenceVideoShots && (
            <Button
              variant="outline"
              onClick={() => void handleReanalyze()}
              loading={isCurrentlyAnalyzing}
              title="重新分析当前分集剧本"
            >
              {isCurrentlyAnalyzing ? "分析中" : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M1 4v6h6M23 20v-6h-6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  重新分析
                </>
              )}
            </Button>
          )}
          {hasAnalysis && onNavigateNext && navigateToAssetsButton}
        </div>
      </div>

      {/* A3. 只读提示条（isReview，批4 暂传 false 不显示，批9 启用） */}
      {isReview && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-[var(--bg-hover)] text-[var(--text-3)] text-xs flex items-center gap-2 flex-shrink-0">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 2v6m0 0v4m0-4h6M8 8H2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          只读模式 — 此阶段已过，仅可查看分析结果
        </div>
      )}

      {/* A4. 增强提示词折叠卡（仅 canEdit + 提供了 setter） */}
      {setAnalyzeEnhancementPrompt && canEdit && (
        <div className="card mb-4 overflow-hidden flex-shrink-0">
          <button
            type="button"
            onClick={() => setEnhancementCollapsed((v) => !v)}
            aria-expanded={!enhancementCollapsed}
            aria-controls="analyze-enhancement-panel"
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-[var(--bg-hover)]/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                className="text-[var(--accent)]"
                aria-hidden="true"
              >
                <path
                  d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2-6.3-4.6L5.7 21l2.3-7.2-6-4.4h7.6L12 2z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-xs font-semibold text-[var(--text-2)]">分析增强提示词</span>
              <span className="text-[10px] text-[var(--text-3)]/70">
                指导角色/场景/资产提取方向（可选）
              </span>
            </div>
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              className={`text-[var(--text-3)] transition-transform ${
                enhancementCollapsed ? "" : "rotate-180"
              }`}
            >
              <path
                d="M3 6l5 5 5-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {!enhancementCollapsed && (
            <div id="analyze-enhancement-panel" className="px-4 pb-3">
              {enhancementEditing ? (
                <>
                  <Textarea
                    value={enhancementDraft}
                    onChange={(e) => setEnhancementDraft(e.target.value)}
                    rows={3}
                    autoFocus
                    placeholder="可选。例如：聚焦主角情绪线、保留次要角色背景、突出场景氛围细节..."
                  />
                  <div className="flex items-center gap-2 mt-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        setAnalyzeEnhancementPrompt(enhancementDraft);
                        setEnhancementEditing(false);
                        toast.success("增强提示词已保存");
                      }}
                    >
                      保存
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEnhancementEditing(false);
                        setEnhancementDraft("");
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div
                    onClick={() => {
                      setEnhancementDraft(analyzeEnhancementPrompt || "");
                      setEnhancementEditing(true);
                    }}
                    className={`px-3 py-2 rounded-lg bg-[var(--bg-2)] border border-[var(--border-light)] text-xs leading-5 cursor-text min-h-[36px] ${
                      (analyzeEnhancementPrompt || "").trim()
                        ? "text-[var(--text)]"
                        : "text-[var(--text-3)]/50"
                    }`}
                  >
                    {(analyzeEnhancementPrompt || "").trim() || "点击「修改」添加增强提示词（可选）"}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEnhancementDraft(analyzeEnhancementPrompt || "");
                        setEnhancementEditing(true);
                      }}
                    >
                      修改
                    </Button>
                    {(analyzeEnhancementPrompt || "").trim() && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAnalyzeEnhancementPrompt("");
                          toast.info("已清空增强提示词");
                        }}
                      >
                        清空
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* A5. 刷新恢复时也始终显示进度条，避免只剩旋转按钮而没有阶段反馈。 */}
      {isCurrentlyAnalyzing && (
        <div className="mb-6 p-4 rounded-lg bg-[var(--action-dim)]/30 border border-[var(--action)]/20 flex-shrink-0">
          {effectiveAnalyzeTaskId ? (
            <GenerationProgress
              taskId={effectiveAnalyzeTaskId}
              label="AI 编剧分析中"
              estimatedDuration={90}
              onComplete={() => { setActiveAnalyzeTaskId(null); onRefresh?.({ force: true }); }}
              onFailure={() => { setActiveAnalyzeTaskId(null); onRefresh?.({ force: true }); }}
            />
          ) : (
            <ProgressBar
              progress={progress?.value ?? 0}
              label={progress?.label ?? 'AI 编剧分析中'}
              stage={progress?.stage ?? '正在等待服务端完成分析'}
              pulse={(progress?.value ?? 0) < 100}
              completed={(progress?.value ?? 0) >= 100}
              showPercent
            />
          )}
          <div className="text-xs text-[var(--text-3)] mt-2">
            完成剧本结构分析后会自动提取角色、道具与场景资产，请稍候。
          </div>
        </div>
      )}

      {/* A6. 空状态 */}
      {!hasAnalysis && !isCurrentlyAnalyzing && (
        <EmptyState
          icon={
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 4v16M17 4v16M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
          title="尚未进行编剧分析"
          description="请先在输入阶段保存剧本，然后点击「重新分析」按钮启动 AI 编剧分析"
          size="lg"
        />
      )}

      {/* A7. 场景列表 */}
      {hasAnalysis && (
        <div className="space-y-3 flex-shrink-0">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-[var(--text-2)] flex items-center gap-1.5">
              <span
                className="inline-block w-1 h-4 bg-[var(--accent)] rounded-full"
                aria-hidden="true"
              />
              场景列表
              <span className="text-[var(--text-3)] font-normal">({scenes.length})</span>
            </h3>
          </div>
          {scenes.map((s, i) => {
            const sceneId = s.id || `scene-${i + 1}`;
            const location = s.location || "—";
            const time = s.time || "—";
            const intExt = s.intExt || "—";
            // 角色派生：scriptData.scenes[].characters 未由 route 写入，
            // 从 scriptData.characters + content.includes 派生（对齐 route.ts:177
            // 顶层 scenes 字段的派生逻辑，修复 app1 前端 chips 永不渲染的 bug）
            const characters = allCharacters.filter((c) => s.content?.includes(c));
            const content = s.content || "";
            const spatialLayout = s.spatialLayout?.trim() || "";
            const blocking = spatialLayout ? blockingImages[baseSceneId(sceneId)] : undefined;
            const blockingStale = Boolean(
              blocking?.sourceSpatialLayout && blocking.sourceSpatialLayout !== spatialLayout,
            );
            const blockingReady =
              blocking?.status === "COMMITTED" && Boolean(blocking.url) && !blockingStale;
            return (
              <div
                key={sceneId}
                className="card p-4 animate-fade-in"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <div className="flex items-start gap-3 mb-2">
                  <div
                    className="flex-shrink-0 w-8 h-8 rounded-lg bg-[var(--accent-dim)] flex items-center justify-center"
                    aria-hidden="true"
                  >
                    <span className="text-xs font-bold text-[var(--accent)]">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-mono text-xs text-[var(--text-3)]">{sceneId}</span>
                      <span className="badge badge-accent">{location}</span>
                      <span className="badge badge-muted">{time}</span>
                      <span className="badge badge-muted">{intExt}</span>
                    </div>
                    {characters.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap mb-2">
                        <span className="text-[10px] text-[var(--text-3)] uppercase tracking-wider">
                          出场角色
                        </span>
                        {characters.map((c) => (
                          <span
                            key={c}
                            className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[10px] text-[var(--text-2)] border border-[var(--border-light)]"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-sm text-[var(--text-2)] leading-relaxed whitespace-pre-wrap break-words">
                      {content || "（无内容）"}
                    </p>
                    {spatialLayout && (
                      <div className="mt-3 pt-3 border-t border-[var(--border-light)] flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-[var(--text-3)] uppercase tracking-wider">
                          场景站位图
                        </span>
                        {blockingReady && blocking?.url ? (
                          <img
                            src={blocking.url}
                            alt="场景站位图"
                            className="w-24 h-14 object-cover rounded border border-[var(--border-light)] bg-[var(--bg-hover)]"
                          />
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(blockingBusy[sceneId])}
                          onClick={() => handleGenerateBlocking(sceneId)}
                        >
                          {blockingBusy[sceneId]
                            ? "生成中…"
                            : blockingReady
                              ? "重新生成"
                              : "生成站位图"}
                        </Button>
                        {blockingStale ? (
                          <span className="text-[10px] text-amber-500">
                            座位布局已更新，请重新生成站位图
                          </span>
                        ) : (
                          <span className="text-[10px] text-[var(--text-3)]">
                            锁定该场景跨镜头组的空间位置
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* A8. 信息点（2 列网格） */}
      {hasAnalysis && infoPoints.length > 0 && (
        <div className="mt-6 space-y-2 flex-shrink-0">
          <h3 className="text-sm font-bold text-[var(--text-2)] flex items-center gap-1.5">
            <span
              className="inline-block w-1 h-4 bg-[var(--accent)] rounded-full"
              aria-hidden="true"
            />
            信息点
            <span className="text-[var(--text-3)] font-normal">({infoPoints.length})</span>
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {infoPoints.map((p, i) => {
              // 防御性读两种 shape：parseScriptResult 实际输出 {type, description}，
              // app1 前端类型声明 {title, content}（实际跑不通，dramaforge 修复）
              const title = p.type || `信息点 ${i + 1}`;
              const content = p.description || "";
              return (
                <div key={i} className="card p-3">
                  <div className="text-xs font-semibold text-[var(--text)] mb-1">{title}</div>
                  {content && (
                    <p className="text-xs text-[var(--text-3)] leading-relaxed whitespace-pre-wrap">
                      {content}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* A9. 造型表（OP1：用 CostumeGroup[] 重写，修复 app1 shape bug） */}
      {hasAnalysis && costumeGroups.length > 0 && (
        <div className="mt-6 space-y-2 flex-shrink-0">
          <h3 className="text-sm font-bold text-[var(--text-2)] flex items-center gap-1.5">
            <span
              className="inline-block w-1 h-4 bg-[var(--accent)] rounded-full"
              aria-hidden="true"
            />
            造型表
            <span className="text-[var(--text-3)] font-normal">
              ({costumeGroups.length} 场景)
            </span>
          </h3>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[var(--bg-hover)] text-[var(--text-3)]">
                    <th className="px-3 py-2 text-left font-medium">场景</th>
                    <th className="px-3 py-2 text-left font-medium">角色</th>
                    <th className="px-3 py-2 text-left font-medium">造型</th>
                  </tr>
                </thead>
                <tbody>
                  {costumeGroups.flatMap((group) => {
                    if (group.rows.length === 0) {
                      return [
                        <tr
                          key={group.sceneId}
                          className="border-t border-[var(--border-light)]"
                        >
                          <td className="px-3 py-2 text-[var(--accent)] font-medium align-top">
                            {group.sceneId}
                          </td>
                          <td className="px-3 py-2 text-[var(--text-3)]" colSpan={2}>
                            —
                          </td>
                        </tr>,
                      ];
                    }
                    return group.rows.map((row, idx) => (
                      <tr
                        key={`${group.sceneId}-${row.character}-${idx}`}
                        className="border-t border-[var(--border-light)]"
                      >
                        {idx === 0 ? (
                          <td
                            className="px-3 py-2 text-[var(--accent)] font-medium align-top"
                            rowSpan={group.rows.length}
                          >
                            {group.sceneId}
                          </td>
                        ) : null}
                        <td className="px-3 py-2 text-[var(--text-2)] align-top">
                          {row.character}
                        </td>
                        <td className="px-3 py-2 text-[var(--text-2)] leading-relaxed">
                          {row.costume || "—"}
                        </td>
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* A10. 原始分析折叠（details/summary，对齐 app1 原生折叠） */}
      {hasAnalysis && sd.rawAnalysis && (
        <div className="mt-6 flex-shrink-0">
          <details className="card overflow-hidden">
            <summary className="px-4 py-2.5 cursor-pointer text-xs font-semibold text-[var(--text-2)] hover:bg-[var(--bg-hover)]/40 transition-colors flex items-center gap-1.5">
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="text-[var(--text-3)]"
                aria-hidden="true"
              >
                <path
                  d="M3 6l5 5 5-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              原始分析文本
              <span className="text-[var(--text-3)] font-normal">
                ({sd.rawAnalysis.length} 字符)
              </span>
            </summary>
            <pre className="px-4 pb-3 text-xs text-[var(--text-3)] whitespace-pre-wrap break-words font-mono leading-relaxed max-h-80 overflow-y-auto">
              {sd.rawAnalysis}
            </pre>
          </details>
        </div>
      )}

      {/* A11. 底部操作（进入资产设定重复按钮） */}
      {hasAnalysis && onNavigateNext && canEdit && (
        <div className="mt-6 pt-4 border-t border-[var(--border-light)] flex justify-end flex-shrink-0">
          {navigateToAssetsButton}
        </div>
      )}

      {/* category 占位（避免 unused warning；批4 暂不消费，未来海外转绘分支用） */}
      {category === "__never__" && <span hidden>{category}</span>}
    </div>
  );
}
