"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../../../components/ui/ConfirmDialog";
import { Spinner } from "../../../../components/ui/Spinner";

// ============================================================
// 分集标签栏（EpisodeTabs）
// ============================================================
//
// @file EpisodeTabs.tsx
// @description 多集标签页并行模式的顶部 Tab 栏。每个打开的分集一个 Tab，
//              支持切换、关闭、返回分集列表。关闭有未完成任务的 Tab 时
//              弹确认框。
//
// 与父组件的协作（dramaforge 适配说明）：
//   - app1 中父组件是 page.tsx，维护 openEpisodes[] + activeEpisodeId（SPA
//     多 Tab hidden 切换，所有 Tab 同时挂载靠 hidden 切显隐，状态不丢）。
//   - dramaforge 是 B 方案（每集独立路由），父组件 EpisodeWorkspace 是单集编排器，
//     tabs[] 由其从 episodes[] + 当前 viewStage/busy 派生；onActivate /
//     onClose / onBackToList 都映射到 router 跳转。
//   - 视觉与交互 100% 对齐 app1（含 busy 关闭确认 ConfirmDialog、集号圆圈、
//     阶段短标签、hover 显关闭按钮、激活态 action 色下边框）。
// ============================================================

/** 单个 Tab 的展示数据 */
export interface EpisodeTabItem {
  id: string;
  episodeNumber: number;
  title?: string;
  stageStatus: string;
  /** 是否有未完成任务（生成中/分析中），用于关闭确认 */
  busy?: boolean;
}

interface EpisodeTabsProps {
  /** 已打开的分集 Tab 列表（顺序即展示顺序） */
  tabs: EpisodeTabItem[];
  /** 当前激活的 Tab ID；null 表示无激活（不应出现于 stage 模式） */
  activeEpisodeId: string | null;
  /** 切换到指定 Tab */
  onActivate: (id: string) => void;
  /** 关闭指定 Tab（busy 时组件内部弹确认框后再调用） */
  onClose: (id: string) => void;
  /** 返回分集列表（保留全部 Tab 还是清空由父组件决定） */
  onBackToList: () => void;
}

/** 阶段状态 -> 短标签（Tab 内展示，对齐 EpisodeListStage 的 STAGE_STATUS_LABELS） */
const STAGE_SHORT_LABELS: Record<string, string> = {
  input: "输入",
  analyzing: "分析中",
  assets: "资产",
  storyboard: "分镜",
  production: "制作",
  complete: "完成",
};

export function EpisodeTabs({ tabs, activeEpisodeId, onActivate, onClose, onBackToList }: EpisodeTabsProps) {
  // 待关闭确认的 Tab（busy 时弹确认框）
  const [pendingClose, setPendingClose] = useState<EpisodeTabItem | null>(null);

  // ============================================================
  // 横向滚动：dramaforge B 方案把全部分集都映射成 Tab（vs app1 只显示打开过的），
  // 分集多时一屏放不下。no-scrollbar 隐藏原生滚动条 → 用户看不到能左右滑，
  // 误以为“只有 6 集”。这里加左右箭头（超屏才显）+ 激活 Tab 自动滚入可见，
  // 既保留 app1 的 no-scrollbar 视觉，又让多集可发现、可快速切。
  // ============================================================
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 4px 容差避免亚像素抖动导致箭头闪烁
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  // tabs 变化（增删集）后重算是否可滚
  useEffect(() => {
    updateScrollState();
  }, [tabs, updateScrollState]);

  // 监听 scroll / resize 实时更新箭头可见性
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateScrollState();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [updateScrollState]);

  // 激活 Tab 变化时把它滚入可见（切到屏外的集不会被挡住）
  useEffect(() => {
    if (!activeEpisodeId) return;
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector(`[data-tab-id="${activeEpisodeId}"]`);
    if (active instanceof HTMLElement) {
      // center：激活集滚到容器中间，左右邻集也可见，彻底避免贴边时集号/标题被箭头遮挡。
      active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [activeEpisodeId]);

  const scrollByPage = useCallback((dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  }, []);

  const handleClose = (tab: EpisodeTabItem) => {
    if (tab.busy) {
      setPendingClose(tab);
      return;
    }
    onClose(tab.id);
  };

  const confirmClose = () => {
    if (pendingClose) {
      onClose(pendingClose.id);
      setPendingClose(null);
    }
  };

  return (
    <>
      <div className="border-b border-[var(--border-light)] bg-[var(--bg)] flex items-center flex-shrink-0">
        {/* 返回分集列表按钮（固定左侧，不随 Tab 滚动） */}
        <button
          onClick={onBackToList}
          className="flex items-center gap-1 px-2.5 py-1.5 ml-2 rounded-md text-xs text-[var(--text-3)] hover:text-[var(--action)] hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0"
          title="返回分集列表"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 3l5 5-5 5M3 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span className="hidden sm:inline">列表</span>
        </button>

        <div className="w-px h-4 bg-[var(--border-light)] mx-1 flex-shrink-0" />

        {/* 左箭头（超出一屏才显示，提供滚动可发现性） */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scrollByPage(-1)}
            className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] rounded-md transition-colors"
            title="向左滚动"
            aria-label="向左滚动分集"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 3l-5 5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        )}

        {/* Tab 滚动区（no-scrollbar 保留 app1 视觉；箭头提供可发现性） */}
        <div ref={scrollRef} className="flex-1 min-w-0 flex items-center gap-1 px-1 overflow-x-auto no-scrollbar">
        {tabs.map((tab) => {
          const active = tab.id === activeEpisodeId;
          const shortLabel = STAGE_SHORT_LABELS[tab.stageStatus] || tab.stageStatus;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-t-md cursor-pointer transition-colors flex-shrink-0 border-b-2 ${
                active
                  ? "border-[var(--action)] bg-[var(--bg-elevated)] text-[var(--text)]"
                  : "border-transparent text-[var(--text-3)] hover:text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
              }`}
              onClick={() => onActivate(tab.id)}
              title={tab.title ? `第 ${tab.episodeNumber} 集 · ${tab.title}` : `第 ${tab.episodeNumber} 集`}
            >
              {/* 集号 */}
              <span
                className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  active
                    ? "bg-[var(--action)] text-white"
                    : tab.stageStatus === "complete"
                    ? "bg-[var(--success-dim)] text-[var(--success)]"
                    : "bg-[var(--bg-hover)] text-[var(--text-3)]"
                }`}
                style={{ fontFamily: "var(--font-display)" }}
              >
                {tab.episodeNumber}
              </span>
              {/* 标题（截断） */}
              <span className="text-xs max-w-[120px] truncate">
                {tab.title || `第 ${tab.episodeNumber} 集`}
              </span>
              {/* 阶段标签 */}
              <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                tab.busy
                  ? "bg-[var(--action-dim)]/30 text-[var(--action)]"
                  : tab.stageStatus === "complete"
                  ? "bg-[var(--success-dim)]/30 text-[var(--success)]"
                  : "bg-[var(--bg-hover)] text-[var(--text-3)]"
              }`}>
                {tab.busy ? (
                  <span className="inline-flex items-center gap-1">
                    <Spinner size={8} label="分集任务处理中" className="text-[var(--action)]" />
                    {shortLabel}
                  </span>
                ) : shortLabel}
              </span>
              {/* 关闭按钮 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(tab);
                }}
                className="ml-0.5 w-4 h-4 rounded flex items-center justify-center text-[var(--text-3)] hover:text-[var(--error)] hover:bg-[var(--bg-hover)] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                title="关闭标签页"
                aria-label={`关闭第 ${tab.episodeNumber} 集标签页`}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>
          );
        })}
        </div>

        {/* 右箭头（超出一屏才显示） */}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scrollByPage(1)}
            className="flex-shrink-0 w-7 h-7 mr-1 flex items-center justify-center text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] rounded-md transition-colors"
            title="向右滚动"
            aria-label="向右滚动分集"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        )}
      </div>

      {/* 关闭确认框（busy Tab 关闭前确认） */}
      <ConfirmDialog
        open={!!pendingClose}
        title={pendingClose ? `关闭第 ${pendingClose.episodeNumber} 集？` : ""}
        message={pendingClose ? `该集正在处理中（${STAGE_SHORT_LABELS[pendingClose.stageStatus] || pendingClose.stageStatus}），关闭标签页不会中断后台任务，但你将看不到进度。确定关闭吗？` : ""}
        confirmLabel="关闭"
        cancelLabel="取消"
        variant="warning"
        onConfirm={confirmClose}
        onCancel={() => setPendingClose(null)}
      />
    </>
  );
}
