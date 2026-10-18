"use client";

/**
 * @file EpisodeListStage.tsx — 分集列表阶段（P7.1 T4+，对齐 app1 EpisodeListStage）
 *
 * 功能（对齐 app1 EpisodeListStage.tsx）：
 *   1. 顶部工具栏：icon + 「分集列表」+ 分集数 + artStyle 风格徽章 + 分类徽章 + 新建按钮
 *      （app1 行 411-457）
 *   2. 调用的原创整剧（sourceMode = ORIGINAL_PROJECT）只读卡片（app1 行 461-498）
 *   3. 加载态：Spinner（app1 plan 中的 skeleton；用 dramaforge ui 库的 Spinner 实现）
 *   4. 空状态：EmptyState 组件（app1 行 541-557）
 *   5. 分集卡片：accent 集号圆 + 标题 + stage 徽标 + 字数 + 摘要 + 编辑/删除按钮
 *      （app1 行 559-656）
 *   6. 排序：↑/↓ 上移下移；比拖拽更适合长列表键鼠操作，并复用同一重排接口
 *   7. 新建分集 Modal：标题 + novelText 文本域 → POST（app1 行 661-710）
 *   8. 编辑分集 Modal：标题 + novelText 文本域 → PATCH
 *   9. 删除二次确认：ConfirmDialog 组件（app1 行 712-722）
 *
 * 与 app1 差异（精简）：
 *   - ORIGINAL_PROJECT 支持 AI 分集、任务恢复和共享资产提取
 *   - 排序交互改为明确的 ↑/↓，数据行为与 app1 一致：POST ?reorder=1
 *   - props 保持 dramaforge 简洁签名：projectId/episodes/onChanged 必填；
 *     project/loading/onEnterEpisode 可选（向后兼容，page.tsx 既有调用无需改动）
 *
 * 布局铁律（对齐 app1）：
 *   - 根容器 flex-1 min-h-0，确保父级 flex 布局正确收缩
 *   - 主内容列 h-full overflow-y-auto，集数过多时可垂直滚动
 *
 * 双色方案铁律：
 *   - 「新建分集」按钮 / 编辑链接 → --action 蓝（可点击行为）
 *   - 集号徽标 / artStyle 徽标 → --accent 琥珀（身份/品牌层）
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../../../../components/ui/Button";
import { Modal } from "../../../../components/ui/Modal";
import { Input, Textarea } from "../../../../components/ui/Input";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Spinner } from "../../../../components/ui/Spinner";
import { ProgressBar } from "../../../../components/ui/ProgressBar";
import { ConfirmDialog } from "../../../../components/ui/ConfirmDialog";
import { useToast } from "../../../../components/ui/Toast";
import type { EpisodeRecord, ProjectRecord } from "@dramaforge/shared";
import type { TargetLanguage } from "@dramaforge/server/prompt";
import { LanguageMenu } from "./LanguageMenu";

// ============================================================
// 常量（对齐 app1 STAGE_STATUS_LABELS / STAGE_STATUS_BADGES）
// ============================================================

/** 分集阶段状态 → 短标签 */
const STAGE_STATUS_LABELS: Record<string, string> = {
  input: "输入",
  analyzing: "分析中",
  assets: "资产",
  storyboard: "分镜",
  production: "制作",
  complete: "完成",
};

/** 分集阶段状态 → 徽标颜色类（对齐 app1 globals.css 的 badge-* 类） */
const STAGE_STATUS_BADGES: Record<string, string> = {
  input: "badge-muted",
  analyzing: "badge-action",
  assets: "badge-accent",
  storyboard: "badge-accent",
  production: "badge-action",
  complete: "badge-success",
};

/** artStyle → 中文标签（app1 旧值映射：realistic / 2d_anime / 3d_anime） */
const ART_STYLE_LABELS: Record<string, string> = {
  realistic: "写实",
  "2d_anime": "2D 动漫",
  "3d_anime": "3D 动漫",
};

/** 项目分类 → 中文标签（对齐 app1 workspace/page.tsx CATEGORIES） */
const CATEGORY_LABELS: Record<string, string> = {
  ORIGINAL: "原创整剧",
  DOMESTIC: "国内改编",
  OVERSEAS: "海外改编",
};

// ============================================================
// Props
// ============================================================

interface EpisodeListStageProps {
  /** 项目 ID */
  projectId: string;
  /** 分集列表 */
  episodes: EpisodeRecord[];
  /** 任何变更（建/编/删/排序）后回调，让父组件重载列表 */
  onChanged: () => void | Promise<void>;
  /**
   * 可选：项目数据（用于 sourceMode / artStyle / category 展示）。
   * 不传则隐藏相关徽章与"调用的原创整剧"卡片——向后兼容。
   */
  project?: ProjectRecord;
  /** 可选：分集列表加载中（显示 Spinner） */
  loading?: boolean;
  /** 可选：点击集号/标题进入单集工作流的回调 */
  onEnterEpisode?: (episodeId: string) => void;
}

// ============================================================
// 组件
// ============================================================

export function EpisodeListStage({
  projectId,
  episodes,
  onChanged,
  project,
  loading = false,
  onEnterEpisode,
}: EpisodeListStageProps) {
  const toast = useToast();
  const router = useRouter();

  /** 按 sortOrder/episodeNumber 排序的分集列表（对齐 app1 sortedEpisodes） */
  const sortedEpisodes = React.useMemo(() => {
    return [...episodes].sort((a, b) => {
      const sa = a.sortOrder ?? a.episodeNumber ?? 0;
      const sb = b.sortOrder ?? b.episodeNumber ?? 0;
      return sa - sb;
    });
  }, [episodes]);

  /** sourceMode = ORIGINAL_PROJECT：调用的原创整剧（只读引用） */
  const scriptData = project?.scriptData as {
    sourceMode?: string;
    localizationProfile?: {
      stylePrompt?: string;
      targetLanguage?: TargetLanguage;
    };
  } | null | undefined;
  const usesOriginalProject =
    scriptData?.sourceMode === "ORIGINAL_PROJECT" && Boolean(project?.sourceProjectId);
  const isOverseasOriginal = usesOriginalProject && project?.category === "OVERSEAS";
  const fullScriptDraft = project?.novelText ?? "";

  // 新建 Modal 状态
  const [addDialogOpen, setAddDialogOpen] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState("");
  const [newNovelText, setNewNovelText] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  /** 正在提交的排序操作；锁住两个方向按钮，避免并发覆盖顺序。 */
  const [reordering, setReordering] = React.useState<{ index: number; dir: -1 | 1 } | null>(null);

  // 编辑 Modal 状态
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draftTitle, setDraftTitle] = React.useState("");
  const [draftNovel, setDraftNovel] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // 删除二次确认（ConfirmDialog）
  const [pendingDelete, setPendingDelete] = React.useState<EpisodeRecord | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [splitTaskId, setSplitTaskId] = React.useState<string | null>(null);
  const [splitting, setSplitting] = React.useState(false);
  /** 拆集任务实时进度（0-100，来自 task.progress；后端 handleEpisodeSplit 各阶段 reportProgress 上报）。 */
  const [splitProgress, setSplitProgress] = React.useState(0);
  /** 拆集任务当前阶段文字（来自 task.stage）。 */
  const [splitStage, setSplitStage] = React.useState<string | null>(null);
  const [targetLang, setTargetLang] = React.useState<TargetLanguage | null>(
    scriptData?.localizationProfile?.targetLanguage ?? null,
  );
  const [wholeSeriesStylePrompt, setWholeSeriesStylePrompt] = React.useState(
    scriptData?.localizationProfile?.stylePrompt ?? "",
  );

  /**
   * 启动原创整剧拆集。taskId 同时写入 sessionStorage，刷新页面后继续轮询；
   * 终态无论成功失败都清理计时器与本地恢复标记，避免“进度卡永久转圈”。
   */
  const handleSplitOriginal = React.useCallback(async () => {
    if (splitting) return;
    setSplitting(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/episodes/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek/deepseek-v4-flash',
          ...(isOverseasOriginal ? { stylePrompt: wholeSeriesStylePrompt } : {}),
        }),
      });
      const envelope = await response.json() as {
        success?: boolean;
        data?: { taskId?: string; reused?: boolean };
        error?: string;
      };
      if (!response.ok || !envelope.success || !envelope.data?.taskId) {
        throw new Error(envelope.error || '拆集任务创建失败');
      }
      sessionStorage.setItem(`sf:episode-split:${projectId}`, envelope.data.taskId);
      setSplitTaskId(envelope.data.taskId);
      toast.info(
        envelope.data.reused
          ? '已恢复正在执行的整剧任务'
          : isOverseasOriginal
            ? '整剧转风格、资产提取与拆集任务已开始'
            : '整剧资产提取与拆集任务已开始',
      );
    } catch (error) {
      setSplitting(false);
      toast.error(error instanceof Error ? error.message : '拆集任务创建失败');
    }
  }, [isOverseasOriginal, projectId, splitting, toast, wholeSeriesStylePrompt]);

  React.useEffect(() => {
    if (!usesOriginalProject) return;
    const stored = sessionStorage.getItem(`sf:episode-split:${projectId}`);
    if (stored) {
      setSplitTaskId(stored);
      setSplitting(true);
    }
  }, [projectId, usesOriginalProject]);

  React.useEffect(() => {
    if (!splitTaskId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(splitTaskId)}`, { cache: 'no-store' });
        const envelope = await response.json() as {
          success?: boolean;
          data?: {
            status?: string;
            progress?: number;
            stage?: string | null;
            error?: string;
            output?: { coverage?: number };
          };
        };
        const status = envelope.data?.status;
        if (status === 'COMPLETED') {
          const coverage = envelope.data?.output?.coverage;
          sessionStorage.removeItem(`sf:episode-split:${projectId}`);
          if (!stopped) {
            setSplitTaskId(null);
            setSplitting(false);
            setSplitProgress(0);
            setSplitStage(null);
            toast.success(typeof coverage === 'number' && coverage < 0.95
              ? `拆集完成，但原文覆盖率仅 ${(coverage * 100).toFixed(1)}%，建议复核`
              : '原创整剧拆集完成');
            await onChanged();
          }
          return;
        }
        if (status === 'FAILED') {
          sessionStorage.removeItem(`sf:episode-split:${projectId}`);
          if (!stopped) {
            setSplitTaskId(null);
            setSplitting(false);
            setSplitProgress(0);
            setSplitStage(null);
            toast.error(envelope.data?.error || '原创整剧拆集失败');
          }
          return;
        }
        // 非终态：更新实时进度（后端 handleEpisodeSplit 各阶段 reportProgress 上报，前端 ProgressBar 据此显示）。
        if (!stopped) {
          setSplitProgress(typeof envelope.data?.progress === 'number' ? envelope.data.progress : 0);
          setSplitStage(typeof envelope.data?.stage === 'string' && envelope.data.stage ? envelope.data.stage : null);
        }
      } catch {
        // 短暂断网保留 taskId，下次轮询继续恢复，不把执行中的任务误报为失败。
      }
      if (!stopped) window.setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { stopped = true; };
  }, [onChanged, projectId, splitTaskId, toast]);

  /**
   * 新建分集
   * POST /api/projects/[projectId]/episodes
   * body: { title?, novelText? }（对齐 app1 行 293-314）
   */
  const handleAdd = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/episodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim() || undefined,
          novelText: newNovelText.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (data.success) {
        toast.success("已新建分集");
        setAddDialogOpen(false);
        setNewTitle("");
        setNewNovelText("");
        await onChanged();
      } else {
        toast.error(data.error || "新建失败");
      }
    } catch {
      toast.error("网络错误，新建失败");
    } finally {
      setAdding(false);
    }
  };

  /** 打开编辑 Modal，预填当前分集 title + novelText */
  const openEditor = (ep: EpisodeRecord) => {
    setEditingId(ep.id);
    setDraftTitle(ep.title ?? "");
    setDraftNovel(ep.novelText ?? "");
  };

  const closeEditor = () => {
    setEditingId(null);
    setDraftTitle("");
    setDraftNovel("");
  };

  /**
   * 保存编辑
   * PATCH title + novelText（contentKilo 后端按 novelText 重算）
   */
  const handleSave = async () => {
    if (!editingId || saving) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(editingId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: draftTitle.trim(), novelText: draftNovel }),
        },
      );
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (data.success) {
        toast.success("已保存");
        closeEditor();
        await onChanged();
      } else {
        toast.error(data.error || "保存失败");
      }
    } catch {
      toast.error("网络错误，保存失败");
    } finally {
      setSaving(false);
    }
  };

  /**
   * 确认删除分集（ConfirmDialog.onConfirm）
   * DELETE /api/projects/[projectId]/episodes/[episodeId]
   * shots 经 FK 级联自动清
   */
  const handleDeleteConfirm = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(pendingDelete.id)}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (data.success) {
        toast.success("已删除分集");
        if (editingId === pendingDelete.id) closeEditor();
        setPendingDelete(null);
        await onChanged();
      } else {
        toast.error(data.error || "删除失败");
      }
    } catch {
      toast.error("网络错误，删除失败");
    } finally {
      setDeleting(false);
    }
  };

  /**
   * 上移/下移分集（交换相邻 → POST ?reorder=1）
   * 对齐 app1 行 339-349（拖拽版）的简化等价：dramaforge 用 ↑/↓ 按钮触发同样的 reorder 端点
   */
  const handleReorder = async (index: number, dir: -1 | 1) => {
    if (reordering) return;
    const target = index + dir;
    if (target < 0 || target >= sortedEpisodes.length) return;
    const ids = sortedEpisodes.map((e) => e.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setReordering({ index, dir });
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/episodes?reorder=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ episodeIds: ids }),
        },
      );
      const data = (await res.json()) as { success?: boolean };
      if (data.success) {
        await onChanged();
      } else {
        toast.error("排序失败");
      }
    } catch {
      toast.error("网络错误，排序失败");
    } finally {
      setReordering(null);
    }
  };

  /** 获取分集的阶段标签 */
  const getStageLabel = (ep: EpisodeRecord): string => {
    const stage = ep.stageStatus || "input";
    return STAGE_STATUS_LABELS[stage] || stage;
  };

  /** 获取分集的阶段徽标类 */
  const getStageBadgeClass = (ep: EpisodeRecord): string => {
    const stage = ep.stageStatus || "input";
    return STAGE_STATUS_BADGES[stage] || "badge-muted";
  };

  /** 截取剧本文本摘要（对齐 app1 getTextSummary 行 400-406） */
  const getTextSummary = (ep: EpisodeRecord, maxLen = 80): string => {
    const text = ep.novelText || ep.content || "";
    if (!text) return "（暂无剧本内容）";
    const trimmed = text.trim();
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
  };

  const editing = sortedEpisodes.find((e) => e.id === editingId) ?? null;
  const isEmpty = sortedEpisodes.length === 0;

  return (
    <section className="flex-1 min-h-0 flex flex-col">
      {/* =================================================== */}
      {/* 顶部工具栏（对齐 app1 行 411-457）                  */}
      {/* =================================================== */}
      <div className="flex items-center gap-2 px-4 sm:px-6 py-3 border-b border-[var(--border)] flex-shrink-0">
        <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-1.5">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            className="text-[var(--accent)]"
            aria-hidden="true"
          >
            <path
              d="M4 6h16M4 12h16M4 18h7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          分集列表
          <span className="text-[var(--text-3)] font-normal">({sortedEpisodes.length})</span>
        </h2>

        <div className="flex-1" />

        {/* artStyle 风格徽章 */}
        {project?.artStyle && ART_STYLE_LABELS[project.artStyle] && (
          <span className="badge badge-accent">{ART_STYLE_LABELS[project.artStyle]}</span>
        )}

        {/* 项目分类徽章 */}
        {project?.category && CATEGORY_LABELS[project.category] && (
          <span className="badge badge-muted">{CATEGORY_LABELS[project.category]}</span>
        )}

        {/* 新建分集按钮：ORIGINAL_PROJECT 模式禁用手动新增（对齐 app1 行 445-456） */}
        {!usesOriginalProject && (
          <Button variant="primary" size="sm" onClick={() => setAddDialogOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 5v14M5 12h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            新建分集
          </Button>
        )}
      </div>

      {/* =================================================== */}
      {/* 主内容区（垂直滚动）                                 */}
      {/* =================================================== */}
      <div className="h-full overflow-y-auto flex-1 min-h-0">
        {/* 调用的原创整剧（只读）卡片 — 对齐 app1 行 461-498 */}
        {usesOriginalProject && (
          <div className="p-4 sm:p-6 pb-0">
            <div className="card p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--action-dim)] flex items-center justify-center flex-shrink-0">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-[var(--action)]"
                    aria-hidden="true"
                  >
                    <path
                      d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9m-6-6l6 6m-9 4h6m-6 4h6"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--text)]">调用的原创整剧</h3>
                    <span className="badge badge-muted">只读引用</span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-3)] leading-relaxed">
                    {isOverseasOriginal
                      ? "读取原创整剧后一次性完成目标语言转绘，自动提取整剧资产，再用同一份剧本拆集；单集不再重复转风格。"
                      : "读取原创整剧，自动提取整剧共享资产后再拆集；单集沿用项目画风，不重复设置风格。"}
                  </p>
                </div>
              </div>

              <div className="mt-4">
                <Textarea
                  rows={6}
                  value={fullScriptDraft}
                  readOnly
                  placeholder="所选原创项目还没有完整剧本"
                  className="font-mono text-sm leading-relaxed"
                />
                <div className="mt-2 text-[11px] text-[var(--text-3)]">
                  当前 {fullScriptDraft.trim().length} 字 · 原创整剧是本次处理的唯一文本来源
                </div>
                {isOverseasOriginal && (
                  <div className="mt-3 space-y-2 rounded-lg border border-[var(--border-light)] bg-[var(--bg-elevated)] p-3">
                    <div className="text-xs font-medium text-[var(--text-2)]">
                      整剧目标语言 <span className="text-[var(--error)]">（必选）</span>
                    </div>
                    <LanguageMenu
                      value={targetLang}
                      onChange={(language) => {
                        setTargetLang(language);
                        setWholeSeriesStylePrompt(
                          `${language.zh} / ${language.cultureHint} / ${language.region}`,
                        );
                      }}
                      disabled={splitting}
                    />
                    <p className="text-[11px] text-[var(--text-3)]">
                      选择一次后应用到整剧；整剧资产将从转绘完成的全文中自动提取。
                    </p>
                  </div>
                )}
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="primary"
                    size="sm"
                    loading={splitting}
                    disabled={
                      fullScriptDraft.trim().length < 50 ||
                      (isOverseasOriginal && !wholeSeriesStylePrompt.trim())
                    }
                    onClick={() => void handleSplitOriginal()}
                  >
                    {splitting
                      ? '整剧处理中…'
                      : isOverseasOriginal
                        ? sortedEpisodes.length > 0
                          ? '重新处理整剧并拆集'
                          : '整剧转风格并自动拆集'
                        : sortedEpisodes.length > 0
                          ? '重新提取整剧资产并拆集'
                          : '提取整剧资产并自动拆集'}
                  </Button>
                </div>
                {splitting && (
                  <div className="mt-3">
                    <ProgressBar
                      progress={splitProgress}
                      label="整剧处理中"
                      stage={splitStage ?? undefined}
                      pulse={false}
                      showPercent
                    />
                    {/* 显眼阶段文案：资产提取等长阶段进度条冻结时，也明确告诉用户在做什么 */}
                    <p className="mt-1.5 text-xs text-[var(--text-2)]">
                      当前阶段：{splitStage ?? "整剧通读中"}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--text-3)]">
                      流程：转风格 → 资产提取 → 角色映射 → 落库；单次 AI 通读会在某阶段停留数分钟（进度条暂时不动），属正常现象，请耐心等待。
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 加载中（对齐 app1 plan 中的 skeleton，用 dramaforge Spinner 实现） */}
        {loading && (
          <div className="flex items-center justify-center py-16 gap-2 text-[var(--text-3)]">
            <Spinner size={16} />
            <span className="text-sm">加载分集中…</span>
          </div>
        )}

        {/* 空状态（对齐 app1 行 541-557，用 EmptyState 组件） */}
        {!loading && isEmpty ? (
          <div className="h-full flex items-center justify-center p-6">
            <EmptyState
              icon={
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 6h16M4 12h16M4 18h7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              }
              title="暂无分集"
              description={
                usesOriginalProject
                  ? "点击上方「开始 AI 拆集」，生成可独立制作的分集"
                  : "点击「新建分集」按钮，添加第一个分集剧本"
              }
              size="lg"
            />
          </div>
        ) : !loading ? (
          /* 分集卡片列表（对齐 app1 行 559-656） */
          <ul className="p-4 sm:p-6 space-y-3">
            {sortedEpisodes.map((ep, idx) => {
              const epNum = ep.episodeNumber ?? idx + 1;
              const stageLabel = getStageLabel(ep);
              const badgeClass = getStageBadgeClass(ep);
              const textSummary = getTextSummary(ep);
              const textLen = (ep.novelText || ep.content || "").length;
              const epUrl = `/workspace/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(ep.id)}`;
              const handleEnter = () => onEnterEpisode?.(ep.id);

              return (
                <li
                  key={ep.id}
                  onClick={() => router.push(epUrl)}
                  className="group card p-4 transition-all hover:border-[var(--action)]/40 cursor-pointer"
                >
                  <div className="flex items-start gap-3">
                    {/* 集号徽标（accent-dim 圆 + 琥珀数字）— 对齐 app1 行 600-604 */}
                    <Link
                      href={epUrl}
                      onClick={handleEnter}
                      className="flex-shrink-0 w-10 h-10 rounded-xl bg-[var(--accent-dim)] flex items-center justify-center hover:scale-105 transition-transform"
                      aria-label={`进入第 ${epNum} 集`}
                    >
                      <span
                        className="text-sm font-bold text-[var(--accent)]"
                        style={{ fontFamily: "var(--font-display)" }}
                      >
                        {String(epNum).padStart(2, "0")}
                      </span>
                    </Link>

                    {/* 内容区 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <Link
                          href={epUrl}
                          onClick={handleEnter}
                          className="text-sm font-semibold text-[var(--text)] truncate hover:text-[var(--action)] transition-colors"
                        >
                          {ep.title || `第 ${epNum} 集`}
                        </Link>
                        {/* 阶段徽标 */}
                        <span className={`badge ${badgeClass}`}>{stageLabel}</span>
                        {/* 字数（优先用 contentKilo，否则用原始字数） */}
                        {textLen > 0 && (
                          <span className="text-[10px] text-[var(--text-3)] tabular-nums">
                            {ep.contentKilo != null ? `${ep.contentKilo} 千字` : `${textLen} 字`}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[var(--text-3)] leading-relaxed line-clamp-2 break-words">
                        {textSummary}
                      </p>
                    </div>

                    {/* 操作按钮（hover 显示，对齐 app1 行 622-651 的 group-hover 模式） */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); void handleReorder(idx, -1); }}
                        loading={reordering?.index === idx && reordering.dir === -1}
                        disabled={idx === 0 || reordering !== null}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors opacity-0 group-hover:opacity-100"
                        title="上移"
                        aria-label="上移"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M12 19V5M5 12l7-7 7 7"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); void handleReorder(idx, 1); }}
                        loading={reordering?.index === idx && reordering.dir === 1}
                        disabled={idx === sortedEpisodes.length - 1 || reordering !== null}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors opacity-0 group-hover:opacity-100"
                        title="下移"
                        aria-label="下移"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M12 5v14M5 12l7 7 7-7"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </Button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); openEditor(ep); }}
                        className="px-2 h-7 rounded-md text-xs text-[var(--action)] hover:bg-[var(--action-dim)] transition-colors opacity-0 group-hover:opacity-100"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setPendingDelete(ep); }}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-3)] hover:text-[var(--error)] hover:bg-[var(--error-dim)] transition-colors opacity-0 group-hover:opacity-100"
                        title="删除分集"
                        aria-label={`删除第 ${epNum} 集`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* =================================================== */}
      {/* 新建分集 Modal（对齐 app1 行 661-710）              */}
      {/* =================================================== */}
      <Modal
        open={addDialogOpen}
        onClose={() => !adding && setAddDialogOpen(false)}
        title="新建分集"
        maxWidthClassName="max-w-lg"
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-[var(--text-2)] mb-1.5 uppercase tracking-wider">
              分集标题（可选）
            </label>
            <Input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={`第 ${sortedEpisodes.length + 1} 集`}
              maxLength={100}
              disabled={adding}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[var(--text-2)] mb-1.5 uppercase tracking-wider">
              剧本文本（可选）
              {newNovelText && (
                <span className="ml-2 text-[var(--text-3)] normal-case font-normal">
                  约 {Math.ceil(newNovelText.length / 1000)} 千字
                </span>
              )}
            </label>
            <Textarea
              rows={6}
              value={newNovelText}
              onChange={(e) => setNewNovelText(e.target.value)}
              placeholder="粘贴本集小说 / 剧本文本…"
              disabled={adding}
            />
            <div className="mt-1 text-[10px] text-[var(--text-3)]">{newNovelText.length} 字符</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-[var(--border)]">
          <Button variant="ghost" size="sm" onClick={() => setAddDialogOpen(false)} disabled={adding}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={() => void handleAdd()} loading={adding}>
            创建分集
          </Button>
        </div>
      </Modal>

      {/* =================================================== */}
      {/* 编辑分集 Modal（PATCH title + novelText）           */}
      {/* =================================================== */}
      <Modal
        open={editingId !== null}
        onClose={() => !saving && closeEditor()}
        title={editing ? `编辑 ${editing.title || `第 ${editing.episodeNumber} 集`}` : "编辑分集"}
        maxWidthClassName="max-w-lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[var(--text-2)] mb-1.5 uppercase tracking-wider">
              分集标题
            </label>
            <Input
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder={`第 ${editing?.episodeNumber ?? ""} 集`}
              maxLength={100}
              disabled={saving}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[var(--text-2)] mb-1.5 uppercase tracking-wider">
              剧本文本
              {draftNovel && (
                <span className="ml-2 text-[var(--text-3)] normal-case font-normal">
                  约 {Math.ceil(draftNovel.length / 1000)} 千字
                </span>
              )}
            </label>
            <Textarea
              rows={10}
              value={draftNovel}
              onChange={(e) => setDraftNovel(e.target.value)}
              placeholder="粘贴本集小说 / 剧本文本…"
              disabled={saving}
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-2">
            {/* 删除入口（仍走 ConfirmDialog 二次确认） */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => editing && setPendingDelete(editing)}
              disabled={saving}
              className="text-[var(--text-3)] hover:text-[var(--error)]"
            >
              删除此分集
            </Button>

            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={closeEditor} disabled={saving}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleSave()}
                loading={saving}
                disabled={!draftTitle.trim()}
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* =================================================== */}
      {/* 删除二次确认 — ConfirmDialog（对齐 app1 行 712-722）*/}
      {/* =================================================== */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete
            ? `删除「${pendingDelete.title || `第 ${pendingDelete.episodeNumber ?? "?"} 集`}」？`
            : ""
        }
        message="删除后无法恢复，该分集的剧本、资产、分镜等数据将一并清除。确定删除吗？"
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => !deleting && setPendingDelete(null)}
        loading={deleting}
      />
    </section>
  );
}
