"use client";

/**
 * @file workspace/[projectId]/episodes/[episodeId]/page.tsx — 分集工作流外壳（批2 D + 批8 R1）
 *
 * 重构后职责（对齐 app1 多层架构的 dramaforge B 方案版）：
 *   - 三态门（useSession: loading / unauthenticated / authenticated）
 *   - URL `?stage=` 读写（viewStageInitRef ref 守卫防 hydration mismatch，
 *     recon §5.4）
 *   - useApi + useEpisodeApiQueue + useSSE 顶层装配（events / queuedApi 透传）
 *   - 渲染 `<EpisodeWorkspace ... />`（5 阶段编排核心已移入）
 *
 * 批8 R1 增量：viewMode("stage"|"films") 切换
 *   - production 完成时 EpisodeWorkspace.onNavigateToFilms(taskId) 回调激活
 *     （批7 死 prop `_onNavigateToFilms` 删下划线激活）
 *   - viewMode==="films" → 渲染 <FilmLibraryPanel/>（批8 Step 3 新建）
 *   - viewMode==="stage" → 渲染 <EpisodeWorkspace/>（现有 5 阶段）
 *
 * 业务逻辑（stage 推进 / 数据加载 / 5 阶段渲染 / SSE 过滤 / busy 上报）
 * 全部移入 `components/EpisodeWorkspace.tsx`。本文件 ~180 行外壳。
 *
 * 与 app1 差异（dramaforge B 方案）：
 *   - app1 page.tsx 是多 Tab 编排器（openEpisodes[] + hidden 切换）
 *   - dramaforge 是单集路由外壳（URL = 每集独立路由），无多 Tab SPA 状态
 */

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Spinner } from "../../../../../components/ui/Spinner";
import { EpisodeWorkspace } from "../../components/EpisodeWorkspace";
import { FilmLibraryPanel } from "../../components/FilmLibraryPanel";
import { STAGES, type StageKey } from "../../../../../lib/stage-config";
import { useApi } from "../../../../../lib/api";
import { useEpisodeApiQueue } from "../../../../../hooks/useEpisodeApiQueue";
import { useSSE } from "../../../../../hooks/useTaskStatus";

export default function EpisodeDetailPage() {
  const params = useParams();
  const projectId = params?.projectId as string;
  const episodeId = params?.episodeId as string;
  const { status } = useSession();

  // ---- API 队列装配（同集串行、跨集并行；批0 useEpisodeApiQueue 已就绪） ----
  const { api } = useApi();
  const { queuedApi } = useEpisodeApiQueue(api);
  /** 绑定本集 episodeId 的 api（透传给 EpisodeWorkspace） */
  const getEpApi = React.useCallback(
    (url: string, options?: RequestInit) => queuedApi(episodeId, url, options),
    [queuedApi, episodeId],
  );

  // ---- SSE 顶层单例（批0 useSSE 已就绪；events 透传给 EpisodeWorkspace） ----
  const { events, connected: sseConnected } = useSSE();

  // ---- URL ?stage= 读写（viewStageInitRef ref 守卫防 hydration mismatch） ----
  const [initialViewStage, setInitialViewStage] = React.useState<StageKey | undefined>(undefined);
  const viewStageInitRef = React.useRef(false);

  /** 从 URL ?stage= 读初始 viewStage（挂载 + popstate 时） */
  const readStageFromUrl = React.useCallback(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const stage = urlParams.get("stage");
      if (stage && STAGES.some((s) => s.key === stage)) {
        setInitialViewStage(stage as StageKey);
      }
    } catch {
      // 静默（SSR 或非浏览器环境）
    }
  }, []);

  React.useEffect(() => {
    if (viewStageInitRef.current) return;
    viewStageInitRef.current = true;
    readStageFromUrl();
  }, [readStageFromUrl]);

  // popstate：浏览器前进/后退时重新读 URL（recon §4 step E 可选项，简化实现）
  React.useEffect(() => {
    const onPopState = () => readStageFromUrl();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [readStageFromUrl]);

  /** viewStage 变化 → 写 URL ?stage=（replaceState 不触发 popstate / 路由跳转） */
  const handleViewStageChange = React.useCallback((stage: StageKey) => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("stage", stage);
      window.history.replaceState(null, "", url.toString());
    } catch {
      // 静默
    }
  }, []);

  // ---- busy 状态（dramaforge B 方案暂无多 Tab 关闭确认；保留接口供批9 顶栏组件消费） ----
  const handleBusyChange = React.useCallback((_busy: boolean) => {
    // 批9 ActiveTaskStatusBar / GlobalGenerationStatus 接入点
  }, []);

  // ---- 批8 R1: viewMode("stage"|"films") + highlightTaskId ----
  // production 完成（export-film / chain-generate COMPLETED）→ onNavigateToFilms
  // 激活 → setViewMode("films") + setHighlightTaskId(taskId) → FilmLibraryPanel
  // 高亮新片（琥珀边框 + "Nuevo" 徽标 + 自动滚动）。
  const [viewMode, setViewMode] = React.useState<"stage" | "films">("stage");
  const [highlightTaskId, setHighlightTaskId] = React.useState<string | null>(null);

  const handleNavigateToFilms = React.useCallback((taskId: string) => {
    setHighlightTaskId(taskId);
    setViewMode("films");
  }, []);

  const handleClearHighlight = React.useCallback(() => {
    setHighlightTaskId(null);
  }, []);

  const handleNavigateBackFromFilms = React.useCallback(() => {
    setViewMode("stage");
  }, []);

  // ---- 三态门 ----
  if (status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Spinner size={28} />
      </main>
    );
  }
  if (status === "unauthenticated") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-sm text-[var(--text-3)]">未登录，请先登录</p>
        <Link href="/auth/signin" className="text-[var(--action)] hover:underline">
          去登录
        </Link>
      </main>
    );
  }

  // ---- 主体：viewMode 切换 stage / films ----
  if (viewMode === "films") {
    return (
      <main className="min-h-screen flex flex-col">
        <FilmLibraryPanel
          projectId={projectId}
          highlightTaskId={highlightTaskId}
          onNavigateBack={handleNavigateBackFromFilms}
          onClearHighlight={handleClearHighlight}
        />
      </main>
    );
  }

  return (
    <EpisodeWorkspace
      episodeId={episodeId}
      projectId={projectId}
      api={getEpApi}
      events={events}
      sseConnected={sseConnected}
      initialViewStage={initialViewStage}
      onViewStageChange={handleViewStageChange}
      onBusyChange={handleBusyChange}
      onNavigateToFilms={handleNavigateToFilms}
    />
  );
}
