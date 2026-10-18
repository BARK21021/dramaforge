"use client";

/**
 * @file FilmLibraryPanel.tsx — 成片库面板（批8 Step 3，镜像 app1 简化版）
 *
 * 镜像源：F:\app1\src\app\workspace\[projectId]\components\FilmLibraryPanel.tsx (533 行)
 * dramaforge C/S 适配：
 *   - 支持项目模式与全局模式（projectId===null，GET /api/films）
 *   - **删** 整集完整性过滤（dramaforge 无 getEpisodesCompletionMap，列出所有 COMPLETED）
 *   - **改** `<video src={sf-asset://}>` 直接（Electron protocol handler 读本地）
 *   - **改** handleDownload → window.sfShell.saveFilm(localKey, suggestedName)（R3 IPC）
 *   - **改** handleDelete → DELETE /api/projects/[id]/films/[jobId] + 客户端 IPC
 *     sfShell.removeFilm(localKey)（R4 双面清理）
 *
 * 数据来源：GET /api/projects/[projectId]/films（批8 Step 2 新建）
 *
 * 双色方案铁律（GC-8 dramaforge-frontend-align-app1）：
 *   - 成片标题/分组标签使用 --accent（琥珀，身份/品牌层）
 *   - 下载/删除按钮使用 --action（蓝色，可点击行为）
 *
 * 跨机器失效告知（Q4 接受，C/S 固有代价）：sf-asset:// URL 只在生成该片的
 * 客户端有效。同账号换机器登录 → films 列表 sf-asset:// 在新机器 404。批8 接受。
 */

import * as React from "react";
import { cn } from "../../../../components/ui/cn";
import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Spinner } from "../../../../components/ui/Spinner";
import { useToast } from "../../../../components/ui/Toast";
import { formatShotRange } from "../../../../lib/shot-label";

// ============================================================
// 类型（对齐 films route 返字段）
// ============================================================

/** films GET route 返回的单条成片记录（packages/web/.../films/route.ts FilmRecord） */
interface FilmApiRecord {
  id: string;
  type: "CONCAT" | "CHAIN_COMPILE";
  projectId: string | null;
  outputUrl: string | null;
  localKey: string | null;
  episodeId: string | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  projectTitle: string | null;
  shotCount: number | null;
  totalDuration: number | null;
  createdAt: string;
}

/** 内部规整后的成片记录 */
interface FilmRecord {
  /** render_jobs.id（DELETE 用） */
  id: string;
  /** sf-asset:// URL（<video src> 用） */
  filmUrl: string;
  /** 客户端本地 clips/<localKey>.mp4（saveFilm/removeFilm IPC 用） */
  localKey: string | null;
  /** 卡片标题 */
  title: string;
  /** 镜头数 */
  shotCount?: number | null;
  /** 总时长（秒） */
  totalDuration?: number | null;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 关联分集 ID（项目模式用于分组） */
  episodeId: string | null;
  /** 关联分集号 */
  episodeNumber: number | null;
  /** 关联分集标题 */
  episodeTitle: string | null;
  /** 关联项目标题（卡片标题「剧名 - 第N集」用） */
  projectId: string | null;
  projectTitle: string | null;
  /** 类型（CHAIN_COMPILE 一键串生成 / CONCAT 单镜导出） */
  type: "CONCAT" | "CHAIN_COMPILE";
}

/** 分组结果 */
interface FilmGroup {
  key: string;
  label: string;
  films: FilmRecord[];
}

export interface FilmLibraryPanelProps {
  /** 项目 ID；null 表示跨项目的全局成片库。 */
  projectId: string | null;
  /** 高亮的任务 ID（新完成成片自动滚动到并高亮） */
  highlightTaskId?: string | null;
  /** 返回回调 */
  onNavigateBack?: () => void;
  /** 清除高亮回调（用户已看到高亮后调用，避免重复提示） */
  onClearHighlight?: () => void;
  /** 容器额外类名 */
  className?: string;
}

// ============================================================
// 工具函数
// ============================================================

/** 格式化时长（秒 → mm:ss） */
function formatDuration(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 格式化日期（ISO → yyyy-MM-dd HH:mm） */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/** 规整成片标题：优先 episodeTitle，否则「剧名 - 第N集」，否则按 type 兜底 */
function buildFilmTitle(film: FilmRecord): string {
  if (film.episodeTitle && film.episodeTitle.trim()) {
    const epNum = typeof film.episodeNumber === "number" ? `第 ${film.episodeNumber} 集 · ` : "";
    return `${epNum}${film.episodeTitle}`;
  }
  const epNum = typeof film.episodeNumber === "number" ? `第 ${film.episodeNumber} 集` : "";
  const showName =
    typeof film.projectTitle === "string" && film.projectTitle.trim()
      ? film.projectTitle.trim()
      : "";
  if (showName && epNum) return `${showName} - ${epNum}`;
  if (epNum) return epNum;
  if (showName) return showName;
  return film.type === "CHAIN_COMPILE" ? "一键成片" : "成片";
}

/** 从 API 记录规整为内部 FilmRecord（outputUrl 缺失 → null，调用方过滤） */
function normalizeFilmRecord(film: FilmApiRecord): FilmRecord | null {
  if (!film.outputUrl) return null;
  return {
    id: film.id,
    filmUrl: film.outputUrl,
    localKey: film.localKey ?? null,
    title: buildFilmTitle({
      id: film.id,
      filmUrl: film.outputUrl,
      localKey: film.localKey ?? null,
      title: "",
      shotCount: film.shotCount,
      totalDuration: film.totalDuration,
      createdAt: film.createdAt,
      episodeId: film.episodeId,
      episodeNumber: film.episodeNumber,
      episodeTitle: film.episodeTitle,
      projectId: film.projectId,
      projectTitle: film.projectTitle,
      type: film.type,
    }),
    shotCount: film.shotCount ?? null,
    totalDuration: film.totalDuration ?? null,
    createdAt: film.createdAt,
    episodeId: film.episodeId ?? null,
    episodeNumber: film.episodeNumber ?? null,
    episodeTitle: film.episodeTitle ?? null,
    projectId: film.projectId ?? null,
    projectTitle: film.projectTitle ?? null,
    type: film.type,
  };
}

/** 带 cookie 的 fetch 封装（与 workspace page.tsx 一致） */
async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (!headers["Content-Type"] && init?.body && typeof init.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  return fetch(input, { ...init, headers, credentials: "include" });
}

/** 解析响应 JSON，返回 data 字段 */
async function parseApiData<T = unknown>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  const json = JSON.parse(text) as { success?: boolean; data?: T; error?: string };
  if (json && json.success) return json.data as T;
  throw new Error(json?.error || "API 返回失败");
}

// ============================================================
// 组件
// ============================================================

export function FilmLibraryPanel({
  projectId,
  highlightTaskId,
  onNavigateBack,
  onClearHighlight,
  className,
}: FilmLibraryPanelProps) {
  const toast = useToast();

  /** 成片列表 */
  const [films, setFilms] = React.useState<FilmRecord[]>([]);
  /** 加载中 */
  const [loading, setLoading] = React.useState(true);
  /** 当前播放的成片 URL（点击缩略图后内嵌播放） */
  const [playingUrl, setPlayingUrl] = React.useState<string | null>(null);
  /** 删除中的任务 ID */
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  /** 下载中的任务 ID */
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  /** 高亮元素 ref（用于滚动定位） */
  const highlightRef = React.useRef<HTMLDivElement | null>(null);

  /** 拉取成片列表 */
  const loadFilms = React.useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/films`
        : "/api/films";
      const res = await authFetch(endpoint);
      const data = await parseApiData<FilmApiRecord[] | { films: FilmApiRecord[] } | null>(res);
      const list = Array.isArray(data) ? data : (data as { films?: FilmApiRecord[] } | null)?.films ?? [];
      setFilms(
        list
          .map(normalizeFilmRecord)
          .filter((f): f is FilmRecord => f !== null),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`加载成片库失败：${msg}`);
      setFilms([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  // 初始加载
  React.useEffect(() => {
    void loadFilms();
  }, [loadFilms]);

  // 高亮 taskId 处理：滚动到元素 + 5s 后清除
  React.useEffect(() => {
    if (!highlightTaskId) return;
    const t = setTimeout(() => {
      if (highlightRef.current) {
        highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      const clearT = setTimeout(() => onClearHighlight?.(), 5000);
      return () => clearTimeout(clearT);
    }, 300);
    return () => clearTimeout(t);
  }, [highlightTaskId, onClearHighlight]);

  /**
   * 下载成片（R3 IPC showSaveDialog + fs.copyFile）
   * dev/browser fallback：无 sfShell 时 toast「请在客户端下载」
   */
  const handleDownload = async (film: FilmRecord) => {
    if (!film.filmUrl) {
      toast.error("成片地址缺失，无法下载");
      return;
    }
    // dev/browser fallback
    if (typeof window === "undefined" || !window.sfShell?.isElectron) {
      toast.warning("请在桌面客户端下载成片");
      return;
    }
    if (!film.localKey) {
      toast.error("本地文件 key 缺失，无法下载");
      return;
    }
    setDownloadingId(film.id);
    try {
      const result = await window.sfShell.saveFilm(
        film.localKey,
        film.title || "film",
      );
      if (result.ok) {
        toast.success("成片已保存");
      } else if (result.error.code === "USER_CANCELLED") {
        // 用户取消，不 toast
      } else {
        toast.error(`下载失败：${result.error.message}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`下载失败：${msg}`);
    } finally {
      setDownloadingId(null);
    }
  };

  /**
   * 删除成片（R4 双面清理：先 DELETE DB 行 → 再 IPC removeFilm 删本地）
   */
  const handleDelete = async (film: FilmRecord) => {
    if (!projectId) return;
    if (!window.confirm(`确认删除成片「${film.title}」吗？此操作不可撤销。`)) return;
    setDeletingId(film.id);
    try {
      // 1. DELETE DB 行（render_jobs）
      const res = await authFetch(
        `/api/projects/${encodeURIComponent(projectId)}/films/${encodeURIComponent(film.id)}`,
        { method: "DELETE" },
      );
      const data = await parseApiData<{ deleted: boolean; localKey: string | null }>(res);
      const localKey = data?.localKey ?? film.localKey;

      // 2. IPC 删本地文件（best-effort，失败仅 toast 不阻断）
      if (localKey && typeof window !== "undefined" && window.sfShell?.isElectron) {
        try {
          const rmResult = await window.sfShell.removeFilm(localKey);
          if (!rmResult.ok) {
            // 文件可能已被删/跨机器失效，仅 toast 提示
            toast.warning(`本地文件清理失败：${rmResult.error.message}`);
          }
        } catch {
          // best-effort，DB 已删，不阻断
        }
      }
      toast.success("成片已删除");
      setFilms((prev) => prev.filter((f) => f.id !== film.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`删除失败：${msg}`);
    } finally {
      setDeletingId(null);
    }
  };

  /**
   * 分组（按 episodeId/episodeNumber 分组，memoized）
   */
  const groups = React.useMemo<FilmGroup[]>(() => {
    const groupMap = new Map<string, FilmRecord[]>();
    for (const film of films) {
      const key = projectId
        ? film.episodeId || "_no_episode"
        : film.projectId || film.projectTitle || "_no_project";
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(film);
    }
    return Array.from(groupMap.entries()).map(([key, list]) => {
      const first = list[0];
      const label = projectId
        ? first?.episodeNumber
          ? `第 ${first.episodeNumber} 集${first.episodeTitle ? " · " + first.episodeTitle : ""}`
          : first?.episodeTitle || "未分集"
        : first?.projectTitle || "未关联项目";
      return {
        key,
        label,
        films: list.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
      };
    });
  }, [films, projectId]);

  return (
    <div className={cn("flex flex-col h-full bg-[var(--bg)]", className)}>
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-3 min-w-0">
          {onNavigateBack && (
            <button
              onClick={onNavigateBack}
              className="text-sm text-[var(--text-3)] hover:text-[var(--text)] transition-colors flex items-center gap-1.5 flex-shrink-0"
              aria-label="返回"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M15 6l-6 6 6 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="hidden sm:inline">返回</span>
            </button>
          )}
          <h2 className="text-sm font-semibold text-[var(--text)] truncate">
            {projectId ? "项目成片库" : "全局成片库"}
          </h2>
          {films.length > 0 && (
            <span className="text-xs text-[var(--text-3)] tabular-nums">{films.length} 条</span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={loadFilms} loading={loading}>
          刷新
        </Button>
      </div>

      {/* 主体：成片列表 / 空状态 / 加载中 */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        {loading ? (
          <EmptyState
            size="lg"
            icon={<Spinner size={28} label="加载成片库" className="text-[var(--action)]" />}
            title="加载中..."
          />
        ) : films.length === 0 ? (
          <EmptyState
            size="lg"
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                <path
                  d="M3 3h18v18H3zM3 9l5-5M21 9l-5-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
            title="还没有成片"
            description="进入生产阶段并生成或导出成片后，这里会显示对应结果。"
          />
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.key}>
                {/* 分组标题（琥珀色身份标识，GC-8 双色铁律） */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-1 h-4 rounded-full bg-[var(--accent)]" aria-hidden="true" />
                  <h3 className="text-sm font-semibold text-[var(--accent)]">{group.label}</h3>
                  <span className="text-xs text-[var(--text-3)] tabular-nums">
                    {group.films.length}
                  </span>
                </div>

                {/* 成片卡片网格 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {group.films.map((film) => {
                    const isHighlighted = film.id === highlightTaskId;
                    const isPlaying = playingUrl === film.filmUrl;
                    const isDeleting = deletingId === film.id;
                    const isDownloading = downloadingId === film.id;
                    const filmCardKey = `${film.id}-${film.createdAt}`;
                    return (
                      <div
                        key={filmCardKey}
                        ref={isHighlighted ? highlightRef : undefined}
                        className={cn(
                          "rounded-[var(--radius-lg)] border overflow-hidden bg-[var(--bg-card)] transition-all",
                          isHighlighted
                            ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/30 animate-pulse"
                            : "border-[var(--border-strong)] hover:border-[var(--action)]/50",
                        )}
                      >
                        {/* 视频预览区（点击播放/暂停） */}
                        <div
                          className="relative aspect-video bg-black cursor-pointer"
                          onClick={() => setPlayingUrl(isPlaying ? null : film.filmUrl)}
                        >
                          {isPlaying ? (
                            <video
                              src={film.filmUrl}
                              controls
                              autoPlay
                              className="w-full h-full"
                            />
                          ) : (
                            <>
                              {/* 缩略图占位（视频首帧由浏览器自动渲染） */}
                              <video
                                src={film.filmUrl}
                                className="w-full h-full object-cover"
                                preload="metadata"
                                muted
                              />
                              {/* 播放按钮遮罩（蓝色 --action，GC-8 可点击行为色） */}
                              <div className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors">
                                <div className="w-12 h-12 rounded-full bg-[var(--action)]/90 flex items-center justify-center">
                                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                    <path d="M7 5l12 7-12 7V5z" fill="white" />
                                  </svg>
                                </div>
                              </div>
                            </>
                          )}
                          {/* 高亮徽标（琥珀色，GC-8 身份层） */}
                          {isHighlighted && (
                            <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-semibold bg-[var(--accent)] text-[#1a1a1a]">
                              Nuevo
                            </span>
                          )}
                        </div>

                        {/* 信息区 */}
                        <div className="p-3">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <h4 className="text-sm font-medium text-[var(--text)] truncate">
                              {film.title}
                            </h4>
                            <span className="text-xs text-[var(--text-3)] tabular-nums flex-shrink-0">
                              {formatDuration(film.totalDuration)}
                            </span>
                          </div>
                          {film.type === "CHAIN_COMPILE" && film.shotCount && film.shotCount > 0 ? (
                            <div className="text-xs text-[var(--accent)] mb-2">
                              {formatShotRange(film.episodeNumber, null, 1, film.shotCount)}
                            </div>
                          ) : null}
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs text-[var(--text-3)]">
                              {formatDate(film.createdAt)}
                              {film.shotCount ? ` · ${film.shotCount} 镜` : ""}
                            </span>
                            <div className="flex gap-1">
                              {/* 下载按钮（蓝色 --action，GC-8 可点击行为色） */}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => void handleDownload(film)}
                                loading={isDownloading}
                                className="h-6 w-6 text-[var(--action)] hover:text-[var(--text)]"
                                title="下载"
                                aria-label={`下载 ${film.title}`}
                              >
                                {!isDownloading && <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                  <path
                                    d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>}
                              </Button>
                              {/* 全局模式隐藏删除，避免在跨项目视图中误删本地文件。 */}
                              {projectId && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => void handleDelete(film)}
                                  loading={isDeleting}
                                  className="h-6 w-6 text-[var(--text-3)] hover:text-[var(--error)]"
                                  title="删除"
                                  aria-label={`删除 ${film.title}`}
                                >
                                  {!isDeleting && (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                      <path
                                        d="M4 7h16M9 7V4h6v3M6 7v13a2 2 0 002 2h8a2 2 0 002-2V7M10 11v6M14 11v6"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
