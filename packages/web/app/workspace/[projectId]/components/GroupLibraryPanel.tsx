/**
 * @file GroupLibraryPanel.tsx — 全局镜头组库面板（批9 Step 1，镜像 app1）
 *
 * 镜像源：F:\app1\src\app\workspace\[projectId]\components\GroupLibraryPanel.tsx (290 行)
 *
 * 聚合展示当前用户所有项目下「整组已生成成功」的镜头组，按 项目 → 分集
 * 两级分组。数据源是 shots.currentMaterialUrl：同组镜头共享视频 URL，整集成片
 * 不会被误当成一个镜头组。
 *
 * 与 app1 的差异：
 *   - **数据源**：GET /api/groups 从当前 shots 聚合，返跨项目扁平 GroupItem[]。
 *   - **媒体落地 sf-asset://**：g.videoUrl 是 sf-asset:// URL，<video src> 在
 *     桌面客户端经 protocol handler 读 userData/clips/<localKey>.mp4 本地文件。
 *     provider 原始 URL 由客户端 render-worker 在生成时 downloadAsset 落地，
 *     服务器零媒体字节（GC-7 / dramaforge-assets-client-local）。
 *   - **下载**：sf-asset:// 不能触发 `<a download>` save-as，改走 IPC
 *     window.sfShell.saveFilm(localKey, suggestedName)（批8 R3）。
 *     dev/browser fallback：toast.warning「请在桌面客户端下载」。
 *   - **删除**：镜头仍引用组片时不提供删除，避免删 render_job/本地文件后制造死链。
 *   - **groupIndex**：API 按分集内镜头顺序稳定编号；组件不再按时间重排。
 *
 * 双色方案铁律（GC-8 dramaforge-frontend-align-app1）：
 *   - 分组标题/项目名/类型徽标用 --accent（琥珀，身份/品牌层）
 *   - 下载按钮用 --action（蓝）
 *
 * 换机器时通过项目 `.sfproject` 导出/导入同步 render_job 元数据与 sf-asset:// 媒体，
 * 导入过程会改写目标机器的本地资源 key。
 */

"use client";

import * as React from "react";
import { cn } from "../../../../components/ui/cn";
import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Spinner } from "../../../../components/ui/Spinner";
import { useToast } from "../../../../components/ui/Toast";
import { formatShotRange } from "../../../../lib/shot-label";

// ============================================================
// 类型
// ============================================================

/** GET /api/groups 返的单条镜头组记录（packages/web/.../api/groups/route.ts GroupItem） */
interface Generation {
  videoUrl: string;
  localKey: string | null;
  generatedAt: string;
  isCurrent: boolean;
}

interface GroupItem {
  id: string;
  type: "CHAIN_COMPILE" | "CONCAT";
  projectId: string;
  projectTitle: string;
  episodeId: string;
  episodeNumber: number | null;
  episodeTitle: string | null;
  /** 同项目/分集内按镜头顺序稳定编号。 */
  groupIndex: number;
  groupLabel: string;
  /** sf-asset:// URL（桌面客户端 protocol handler 读本地） */
  videoUrl: string;
  /** 客户端本地 clips/<localKey>.mp4（saveFilm IPC 用） */
  localKey: string | null;
  /** 该组覆盖的全局镜头起止序号。 */
  shotStart: number;
  shotEnd: number;
  /** 语义组名（建场组/高潮组…）。 */
  groupName: string;
  shotCount: number;
  /** 总时长（秒） */
  duration: number;
  updatedAt: string;
  /** 该组全部生成历史（每次重生一代），倒序；isCurrent=当前在用。 */
  generations?: Generation[];
}

/** 两级分组：项目 → 分集 → 组列表 */
interface EpisodeGroup {
  /** 复合 key：projectId|episodeId */
  key: string;
  projectId: string;
  projectTitle: string;
  episodeId: string;
  episodeLabel: string;
  groups: GroupItem[];
}

// ============================================================
// 工具函数
// ============================================================

/** 格式化时长（秒 → mm:ss） */
function formatDuration(seconds?: number): string {
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

export interface GroupLibraryPanelProps {
  /** 返回回调（顶部「返回」按钮） */
  onBack?: () => void;
  /** 容器额外类名 */
  className?: string;
}

export function GroupLibraryPanel({ onBack, className }: GroupLibraryPanelProps) {
  const toast = useToast();
  const [groups, setGroups] = React.useState<GroupItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [playingUrl, setPlayingUrl] = React.useState<string | null>(null);
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);

  const loadGroups = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/groups");
      const data = await parseApiData<GroupItem[] | null>(res);
      const list = Array.isArray(data) ? data : [];
      // 仅保留 videoUrl 非空（防御性，API 已过滤）
      setGroups(
        list.filter((g) => typeof g.videoUrl === "string" && g.videoUrl),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`加载镜头组库失败：${msg}`);
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  /**
   * 按 项目 → 分集 两级分组。API 已按当前镜头顺序确定 groupIndex；这里仅排序，
   * 不再用生成时间覆盖服务端组号。
   */
  const grouped = React.useMemo<EpisodeGroup[]>(() => {
    const byProject = new Map<
      string,
      { title: string; episodes: Map<string, EpisodeGroup> }
    >();
    for (const g of groups) {
      let proj = byProject.get(g.projectId);
      if (!proj) {
        proj = {
          title: g.projectTitle || "未知项目",
          episodes: new Map(),
        };
        byProject.set(g.projectId, proj);
      }
      const epKey = g.episodeId || "_no_episode";
      let ep = proj.episodes.get(epKey);
      if (!ep) {
        const epLabel = g.episodeNumber
          ? `第 ${g.episodeNumber} 集${g.episodeTitle ? " · " + g.episodeTitle : ""}`
          : (g.episodeTitle || "未分集");
        ep = {
          key: `${g.projectId}|${epKey}`,
          projectId: g.projectId,
          projectTitle: proj.title,
          episodeId: epKey,
          episodeLabel: epLabel,
          groups: [],
        };
        proj.episodes.set(epKey, ep);
      }
      ep.groups.push(g);
    }
    // 组内严格按服务端事实源的 groupIndex 展示。
    const result: EpisodeGroup[] = [];
    for (const proj of byProject.values()) {
      for (const ep of proj.episodes.values()) {
        ep.groups.sort((a, b) => a.groupIndex - b.groupIndex);
        result.push(ep);
      }
    }
    return result;
  }, [groups]);

  /**
   * 下载镜头组（R3 IPC showSaveDialog + fs.copyFile）。
   * dev/browser fallback：无 sfShell 时 toast「请在客户端下载」。
   */
  const handleDownload = async (g: GroupItem) => {
    if (!g.videoUrl) {
      toast.error("镜头组地址缺失，无法下载");
      return;
    }
    if (typeof window === "undefined" || !window.sfShell?.isElectron) {
      toast.warning("请在桌面客户端下载镜头组");
      return;
    }
    if (!g.localKey) {
      toast.error("本地文件 key 缺失，无法下载");
      return;
    }
    setDownloadingId(g.id);
    try {
      const suggestedName = `${g.projectTitle}-${g.episodeNumber ? `第${g.episodeNumber}集` : ""}-组${g.groupIndex}`.replace(/\s+/g, "_");
      const result = await window.sfShell.saveFilm(g.localKey, suggestedName);
      if (result.ok) {
        toast.success("镜头组已保存");
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

  return (
    <div className={cn("flex flex-col h-full bg-[var(--bg)]", className)}>
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
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
          <h2 className="text-sm font-semibold text-[var(--text)] truncate">镜头组库</h2>
          {groups.length > 0 && (
            <span className="text-xs text-[var(--text-3)] tabular-nums">
              {groups.length} 组
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={loadGroups} loading={loading}>
          刷新
        </Button>
      </div>

      {/* 主体 */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        {loading ? (
          <EmptyState
            size="lg"
            icon={<Spinner size={28} label="加载镜头组库" className="text-[var(--action)]" />}
            title="加载中..."
          />
        ) : grouped.length === 0 ? (
          <EmptyState
            size="lg"
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M4 6h16M4 6v12a2 2 0 002 2h12a2 2 0 002-2V6M4 6a2 2 0 012-2h12a2 2 0 012 2"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
            title="还没有镜头组"
            description="单个镜头组生成成功后会自动汇总到这里。整集合成片在「成片库」查看。"
          />
        ) : (
          <div className="space-y-8">
            {grouped.map((ep) => (
              <div key={ep.key}>
                {/* 分组标题：项目 · 分集（琥珀色身份标识，GC-8） */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-1 h-4 rounded-full bg-[var(--accent)]" aria-hidden="true" />
                  <h3 className="text-sm font-semibold text-[var(--accent)]">
                    {ep.projectTitle}
                  </h3>
                  <span className="text-xs text-[var(--text-3)]">·</span>
                  <h3 className="text-sm font-semibold text-[var(--text-2)]">
                    {ep.episodeLabel}
                  </h3>
                  <span className="text-xs text-[var(--text-3)] tabular-nums">
                    {ep.groups.length} 组
                  </span>
                </div>

                {/* 组卡片网格 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {ep.groups.map((g) => {
                    const genUrls = (g.generations ?? []).map((x) => x.videoUrl);
                    // 若正在播放本组某代历史，就播那代；否则默认当前代（g.videoUrl）。
                    const activeUrl = playingUrl && genUrls.includes(playingUrl) ? playingUrl : g.videoUrl;
                    const isPlaying = playingUrl === activeUrl;
                    const gens = g.generations ?? [];
                    return (
                      <div
                        key={g.id}
                        className="rounded-[var(--radius-lg)] border border-[var(--border-strong)] hover:border-[var(--action)]/50 overflow-hidden bg-[var(--bg-card)] transition-all"
                      >
                        {/* 视频预览 */}
                        <div
                          className="relative aspect-video bg-black cursor-pointer"
                          onClick={() => setPlayingUrl(isPlaying ? null : activeUrl)}
                        >
                          {isPlaying ? (
                            <video src={activeUrl} controls autoPlay className="w-full h-full" />
                          ) : (
                           <>
                              {/* 静态占位：大量镜头组时 <video preload> 会同时挂载数百个媒体元素，
                                  冻结主线程导致"加载中"卡死。非播放状态只显示播放按钮占位，
                                  点击后才创建 <video> 加载实际媒体。 */}
                              <div className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors">
                                <div className="w-11 h-11 rounded-full bg-[var(--action)]/90 flex items-center justify-center">
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                                    <path d="M7 5l12 7-12 7V5z" fill="white" />
                                  </svg>
                                </div>
                              </div>
                            </>
                          )}
                          {/* 组编号徽标（琥珀色身份层，GC-8）：第N集·组名·镜头起–止 */}
                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-semibold bg-[var(--accent)] text-[#1a1a1a]">
                            {formatShotRange(g.episodeNumber, g.groupName, g.shotStart, g.shotEnd)}
                          </span>
                          {gens.length >= 1 && (
                            <span className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-semibold bg-[var(--action)] text-white">
                              {gens.length} 代
                            </span>
                          )}
                        </div>

                        {/* 信息区 */}
                        <div className="p-3">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <h4 className="text-sm font-medium text-[var(--text)] truncate">
                              {g.groupLabel}
                            </h4>
                            <span className="text-xs text-[var(--text-3)] tabular-nums flex-shrink-0">
                              {formatDuration(g.duration)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs text-[var(--text-3)]">
                              {formatDate(g.updatedAt)}
                              {g.shotCount ? ` · ${g.shotCount} 镜` : ""}
                            </span>
                            <div className="flex gap-1">
                              {/* 下载按钮（蓝色 --action，GC-8 可点击行为色） */}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => void handleDownload(g)}
                                loading={downloadingId === g.id}
                                className="h-6 w-6 text-[var(--action)] hover:text-[var(--text)]"
                                title="下载"
                                aria-label={`下载 ${g.groupLabel}`}
                              >
                                {downloadingId !== g.id && <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                  <path
                                    d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>}
                              </Button>
                            </div>
                          </div>
                          {/* 生成历史：每次重生留一代，标时间+当前在用，点选可预览该代。
                              ≥1 代即展示（含原代 1 次的组），不再因「只有 1 代」而隐藏——
                              用户要能确认每组视频都生成进去了。 */}
                          {gens.length >= 1 && (
                            <div className="mt-2 pt-2 border-t border-[var(--border)]">
                              <div className="text-[10px] text-[var(--text-3)] mb-1.5">
                                生成历史（{gens.length} 代，点选预览）
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {gens.map((gen, idx) => {
                                  const genPlaying = playingUrl === gen.videoUrl;
                                  return (
                                    <button
                                      key={gen.videoUrl + idx}
                                      onClick={() => setPlayingUrl(genPlaying ? null : gen.videoUrl)}
                                      className={
                                        "px-1.5 py-0.5 rounded text-[10px] border transition-colors flex items-center gap-1 " +
                                        (gen.isCurrent
                                          ? "border-[var(--action)] bg-[var(--action)]/10 text-[var(--action)] font-semibold"
                                          : "border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text)] hover:border-[var(--text-3)]")
                                      }
                                      title={gen.isCurrent ? "当前在用（最新一代）" : "历史生成（已被覆盖，文件仍在本地）"}
                                    >
                                      <span>{formatDate(gen.generatedAt).slice(5)}</span>
                                      {gen.isCurrent ? (
                                        <span className="px-1 rounded bg-[var(--action)] text-white text-[9px]">当前</span>
                                      ) : genPlaying ? (
                                        <span className="text-[var(--action)]">▶</span>
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
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
