"use client";

/**
 * @file workspace/page.tsx
 * @description 项目列表页（登录后落地页）—— 对齐 app1 src/app/workspace/page.tsx
 *
 * 调用 `/api/projects`：
 *   - GET  列出当前用户的所有项目（按 updatedAt desc）
 *   - POST 创建新项目（分类、内容来源、源项目与项目画面风格）
 *   - DELETE /api/projects/[id] 删除项目（对齐 app1）
 *
 * 对齐 app1 的核心交互（[[dramaforge-frontend-align-app1]]）：
 *   - 顶部分类 Tab（border-b + 计数），客户端 filter，默认 DOMESTIC
 *   - 卡片 hover 显示红色删除按钮 → ConfirmDialog(danger) → DELETE
 *   - DOMESTIC/OVERSEAS 项目显示琥珀色风格锁徽章（hover tip "创建后锁定"）
 *   - 新建 Modal 含「内容来源」选项（按分类切换，对齐 app1）
 *   - 列表空 → EmptyState(size=lg)；listLoading → 6 个 skeleton
 *   - AppHeader slot：left="工作区" + right=CreditsBadge(lg)
 *
 * ProjectRecord 字段确认（packages/shared/src/project.ts）：
 *   ✅ artStyle        有（TEXT 可空，值 realistic/2d_anime/3d_anime）
 *   ✅ sourceMode      持久化到 scriptData.sourceMode，驱动工作台分支
 *   ✅ episodeCount    列表 API 聚合返回，不额外请求每个项目的分集
 *
 * ORIGINAL_PROJECT 会复制源项目文本快照，并可通过 episodes/split 自动 AI 分集；
 * 源项目本身保持独立，避免后续编辑产生隐式联动。
 *
 * 鉴权：直接 `fetch('/api/projects')`——NextAuth session cookie 自动带。
 * 视觉像素非 gate（结构对齐 app1 + 暗色即可），细节留用户 QA + 视觉验。
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Trash2, Lock, Plus, Download, Upload, Pencil } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { CreditsBadge } from "../../components/ui/CreditsBadge";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { AppHeader } from "../../components/layout/AppHeader";
import type {
  ProjectArtStyle,
  ProjectCategory,
  ProjectRecord,
  ProjectSourceMode,
  ProjectStatus,
} from "@dramaforge/shared";

// ============================================================
// 常量
// ============================================================

/**
 * 项目状态显示标签（对齐 app1 STATUS_LABELS）。
 * DB 列 TEXT 无 CHECK，历史数据可能含其他值——消费方兜底 `|| p.status`。
 */
const STATUS_LABELS: Record<ProjectStatus, string> = {
  DRAFT: "草稿",
  SCREENWRITING: "编剧分析",
  ASSET_DESIGN: "资产设计",
  STORYBOARD: "分镜生成",
  PRODUCTION: "生产中",
  COMPLETE: "已完成",
};

/**
 * 项目分类选项（对齐 app1 CATEGORIES；只读 reference）。
 * desc 用于按钮 title 提示，与 app1 一致。
 */
const CATEGORIES: { key: ProjectCategory; label: string; desc: string }[] = [
  { key: "ORIGINAL", label: "剧本原创", desc: "整剧改写：视频转剧本、大纲与完整重写" },
  { key: "DOMESTIC", label: "国内直出", desc: "中文剧本与国内 AI 服务链路" },
  { key: "OVERSEAS", label: "海外转绘", desc: "适合多语言出海与海外模型链路" },
];

/**
 * 内容来源选项（对齐 app1 sourceMode 选项）。
 * 分类不同时切换选项集：
 *   - ORIGINAL：整剧情上传 / 原创整剧
 *   - DOMESTIC | OVERSEAS：分集台内新增 / 调用原创整剧
 *
 * 该值由共享 createProjectSchema 校验，并由 service 写入 scriptData.sourceMode。
 */
const SOURCE_MODE_OPTIONS: Record<
  ProjectCategory,
  { key: ProjectSourceMode; label: string; desc: string; disabled?: boolean }[]
> = {
  ORIGINAL: [
    { key: "VIDEO_REWRITE", label: "整剧情上传", desc: "上传整部短剧视频，自动还原、提纲并重写" },
    { key: "OUTLINE_TO_SCRIPT", label: "根据大纲写剧本", desc: "输入故事大纲，AI 扩写成竖屏短剧完整剧本" },
    { key: "LOCAL_SCRIPT", label: "原创整剧", desc: "创建后粘贴或保存完整原创剧本" },
  ],
  DOMESTIC: [
    { key: "EPISODE_INPUT", label: "分集台内新增", desc: "创建项目后，在分集台逐集添加剧本" },
    {
      key: "ORIGINAL_PROJECT",
      label: "调用原创整剧",
      desc: "引用原创整剧，自动提取整剧资产后再拆分为分集",
    },
  ],
  OVERSEAS: [
    { key: "EPISODE_INPUT", label: "分集台内新增", desc: "创建项目后，在分集台逐集添加剧本" },
    {
      key: "ORIGINAL_PROJECT",
      label: "调用原创整剧",
      desc: "引用原创整剧，先整剧转绘并提取整剧资产，再自动拆分",
    },
    {
      key: "REFERENCE_VIDEO",
      label: "参考视频转绘",
      desc: "上传原片，kimi 转剧本提取资产，按场景切片做 video-to-video 转绘（桌面端）",
    },
  ],
};

/**
 * artStyle 风格锁徽章显示映射（对齐 app1 ART_STYLES）。
 * ProjectRecord.artStyle 是自由 TEXT，消费方兜底显示原值。
 */
const ART_STYLE_LABELS: Record<string, string> = {
  realistic: "真人写实",
  "2d_anime": "2D 动漫",
  "3d_anime": "3D 动漫",
};

/** 国内直出与海外转绘创建时必须锁定的风格；创建后不开放修改。 */
const ART_STYLES: Array<{
  key: ProjectArtStyle;
  label: string;
  desc: string;
}> = [
  { key: "realistic", label: "真人写实", desc: "电影感真人画面与自然光影" },
  { key: "2d_anime", label: "2D 动漫", desc: "平面动画线条与赛璐璐上色" },
  { key: "3d_anime", label: "3D 动漫", desc: "三维角色与动画电影质感" },
];

/**
 * 格式化 ISO 字符串为可读日期（yyyy-MM-DD HH:mm）。失败兜底原值。
 */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/**
 * 状态徽章内联样式（完成绿 / 草稿灰 / 进行中蓝）。
 * 用 inline style 而非 app1 的 badge-* CSS 类（dramaforge globals 未移植 .badge-*）。
 */
function statusBadgeStyle(status: ProjectStatus): React.CSSProperties {
  if (status === "COMPLETE") {
    return {
      background: "rgba(52, 211, 153, 0.12)",
      color: "#34d399",
      border: "1px solid rgba(52, 211, 153, 0.3)",
    };
  }
  if (status === "DRAFT") {
    return {
      background: "var(--bg-hover)",
      color: "var(--text-3)",
      border: "1px solid var(--border)",
    };
  }
  return {
    background: "var(--action-dim)",
    color: "var(--action)",
    border: "1px solid var(--action)",
  };
}

// ============================================================
// 组件
// ============================================================

export default function WorkspacePage() {
  const router = useRouter();
  const toast = useToast();
  const { status } = useSession();

  /** 项目列表 */
  const [projects, setProjects] = React.useState<ProjectRecord[]>([]);
  /** inline 改名：正在编辑的项目 id（null=不在编辑）+ 输入框值 + 提交中。 */
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [editingTitle, setEditingTitle] = React.useState("");
  const [renaming, setRenaming] = React.useState(false);
  /** 列表首次加载中 */
  const [listLoading, setListLoading] = React.useState<boolean>(true);
  /** 当前激活的分类 Tab（app1 默认进入剧本原创）。 */
  const [activeCategory, setActiveCategory] = React.useState<ProjectCategory>("ORIGINAL");

  /** 新建弹窗是否打开 */
  const [createOpen, setCreateOpen] = React.useState(false);
  /** 新建弹窗里的项目标题（受控） */
  const [newTitle, setNewTitle] = React.useState("");
  /** 新建项目分类（与 app1 一致，默认剧本原创）。 */
  const [newCategory, setNewCategory] = React.useState<ProjectCategory>("ORIGINAL");
  /** 内容来源会持久化到 scriptData.sourceMode，驱动后续工作台分支。 */
  const [newSourceMode, setNewSourceMode] = React.useState<ProjectSourceMode>("VIDEO_REWRITE");
  /** ORIGINAL_PROJECT 模式引用的当前用户原创项目。 */
  const [newSourceProjectId, setNewSourceProjectId] = React.useState("");
  /** 海外转绘创建时锁定的风格。 */
  const [newArtStyle, setNewArtStyle] = React.useState<ProjectArtStyle>("realistic");
  /** 新建提交中（按钮 loading + 禁用关闭/取消） */
  const [creating, setCreating] = React.useState(false);

  /** 删除确认弹窗状态 */
  const [deleteConfirm, setDeleteConfirm] = React.useState<{
    open: boolean;
    project: ProjectRecord | null;
  }>({ open: false, project: null });
  /** 删除提交中 */
  const [deleting, setDeleting] = React.useState(false);
  /** 项目迁移期间锁住重复点击；值为 import 或正在导出的项目 ID。 */
  const [transferring, setTransferring] = React.useState<string | null>(null);

  /**
   * 拉取项目列表。直接 fetch，cookie 自动带 NextAuth session cookie。
   */
  const loadProjects = React.useCallback(async () => {
    setListLoading(true);
    try {
      const res = await fetch("/api/projects");
      const data = (await res.json()) as { success?: boolean; data?: ProjectRecord[]; error?: string };
      if (data.success) {
        setProjects(data.data ?? []);
      } else {
        toast.error(data.error || "加载项目失败");
      }
    } catch {
      toast.error("网络错误，加载项目失败");
    } finally {
      setListLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    if (status !== "authenticated") return;
    void loadProjects();
  }, [status, loadProjects]);

  /**
   * 提交新建项目。来源引用和画面风格均在共享 schema/service 再校验一次，
   * UI 的 disabled 仅用于即时反馈，不能替代服务端安全边界。
   */
  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          category: newCategory,
          sourceMode: newSourceMode,
          sourceProjectId:
            newSourceMode === "ORIGINAL_PROJECT" ? newSourceProjectId : undefined,
          // 国内直出同样依赖稳定画风；剧本原创不生成画面，因此不写风格。
          artStyle: newCategory !== "ORIGINAL" ? newArtStyle : undefined,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; data?: ProjectRecord };
      if (data.success) {
        toast.success("项目已创建");
        setCreateOpen(false);
        setNewTitle("");
        setNewSourceProjectId("");
        // 对齐 app1：创建后直接跳进项目详情
        if (data.data?.id) {
          router.push(`/workspace/${encodeURIComponent(data.data.id)}`);
        } else {
          await loadProjects();
        }
      } else {
        toast.error(data.error || "创建失败");
      }
    } catch {
      toast.error("网络错误，创建失败");
    } finally {
      setCreating(false);
    }
  };

  /**
   * 删除项目。DELETE /api/projects/[id]。
 * 成功 → 从本地 state 移除（无需重新拉列表）。
 */
  /** 项目列表 inline 改名：PATCH /api/projects/[id] {title}，成功后本地更新。 */
  const handleRenameProject = async (project: ProjectRecord) => {
    const title = editingTitle.trim();
    if (!title) {
      toast.warning("项目名称不能为空");
      return;
    }
    if (title === project.title) {
      setEditingProjectId(null);
      return;
    }
    setRenaming(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (data.success) {
        toast.success("项目名称已更新");
        setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, title } : p)));
        setEditingProjectId(null);
      } else {
        toast.error(data.error || "改名失败");
      }
    } catch {
      toast.error("网络错误，改名失败");
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    const project = deleteConfirm.project;
    if (!project || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (data.success) {
        toast.success("项目已删除");
        setProjects((prev) => prev.filter((p) => p.id !== project.id));
      } else {
        toast.error(data.error || "删除项目失败");
      }
    } catch {
      toast.error("网络错误，删除失败");
    } finally {
      setDeleting(false);
      setDeleteConfirm({ open: false, project: null });
    }
  };

  /** 导出云端元数据，再由 Electron 将本机 sf-asset:// 媒体一并写入迁移包。 */
  const handleExportProject = async (project: ProjectRecord) => {
    if (!window.sfShell?.isElectron) {
      toast.error("完整项目导出需要在 DramaForge 桌面客户端中操作");
      return;
    }
    setTransferring(project.id);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/transfer`);
      const envelope = (await response.json()) as { success?: boolean; data?: unknown; error?: string };
      if (!response.ok || !envelope.success) throw new Error(envelope.error || "读取项目快照失败");
      const result = await window.sfShell.exportProjectBundle(envelope.data, project.title);
      if (!result.ok) {
        if (result.error.code !== "USER_CANCELLED") toast.error(result.error.message);
        return;
      }
      toast.success(`项目已导出，包含 ${result.mediaCount} 个本地媒体文件`);
      if (result.warnings.length > 0) toast.error(`有 ${result.warnings.length} 个本地文件缺失，请查看迁移包清单`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "项目导出失败");
    } finally {
      setTransferring(null);
    }
  };

  /** 客户端先恢复媒体和改写 URL，服务端随后用新 ID 原子克隆全部业务记录。 */
  const handleImportProject = async () => {
    if (!window.sfShell?.isElectron) {
      toast.error("完整项目导入需要在 DramaForge 桌面客户端中操作");
      return;
    }
    setTransferring("import");
    try {
      const local = await window.sfShell.importProjectBundle();
      if (!local.ok) {
        if (local.error.code !== "USER_CANCELLED") toast.error(local.error.message);
        return;
      }
      const response = await fetch("/api/projects/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(local.snapshot),
      });
      const envelope = (await response.json()) as {
        success?: boolean;
        data?: { projectId?: string };
        error?: string;
      };
      if (!response.ok || !envelope.success) throw new Error(envelope.error || "服务端导入失败");
      toast.success(`项目导入完成，已恢复 ${local.mediaCount} 个本地媒体文件`);
      if (envelope.data?.projectId) router.push(`/workspace/${encodeURIComponent(envelope.data.projectId)}`);
      else await loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "项目导入失败");
    } finally {
      setTransferring(null);
    }
  };

  /** 切换新建弹窗里的分类时，同步重置 sourceMode 到该分类的默认首项。 */
  const handleNewCategoryChange = (cat: ProjectCategory) => {
    setNewCategory(cat);
    setNewSourceMode(SOURCE_MODE_OPTIONS[cat][0].key);
    setNewSourceProjectId("");
  };

  /** 仅有完整剧本的原创项目才可作为引用源，避免创建后才发现无法分集。 */
  const originalSourceProjects = projects.filter(
    (project) =>
      project.category === "ORIGINAL" && Boolean(String(project.novelText ?? "").trim()),
  );

  /** 客户端按 activeCategory 过滤；category 缺失时兜底 DOMESTIC（对齐 app1）。 */
  const visibleProjects = projects.filter(
    (p) => (p.category ?? "DOMESTIC") === activeCategory,
  );

  // -------- useSession 三态渲染 --------

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
        <p className="text-sm text-[var(--text-3)]">未登录，请先登录后查看项目</p>
        <Button asChild variant="primary">
          <Link href="/auth/signin">去登录</Link>
        </Button>
      </main>
    );
  }

  // status === "authenticated"
  return (
    <div className="flex-1 bg-[var(--bg)] flex flex-col overflow-hidden">
      {/* 顶部导航栏（对齐 app1：left=工作区 + right=CreditsBadge lg） */}
      <AppHeader
        left={<span className="font-bold text-[var(--text)]">工作区</span>}
        right={<CreditsBadge size="lg" />}
      />

      <main className="flex-1 overflow-auto px-6 py-8 max-w-6xl mx-auto w-full">
        {/* 页面标题 + 副标题 + 新建按钮（对齐 app1 顶部布局） */}
        <header className="flex items-center justify-between gap-4 mb-6 sm:mb-8 flex-wrap">
          <div>
            <h1
              className="text-2xl font-bold text-[var(--text)] mb-1"
              style={{ fontFamily: "var(--font-display)" }}
            >
              我的项目
            </h1>
            <p className="text-sm text-[var(--text-2)]">
              选择一个项目继续创作，或新建项目开始你的下一支作品
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => void handleImportProject()}
              loading={transferring === "import"}
              disabled={transferring !== null}
            >
              <Upload size={16} strokeWidth={2} />
              {transferring === "import" ? "导入中..." : "导入项目"}
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} strokeWidth={2.5} />
              新建项目
            </Button>
          </div>
        </header>

        {/* 分类 Tab（对齐 app1：border-b + 计数） */}
        <div
          className="flex gap-2 mb-6 border-b border-[var(--border-light)]"
          role="tablist"
          aria-label="项目类型"
        >
          {CATEGORIES.map((cat) => {
            const count = projects.filter(
              (p) => (p.category ?? "DOMESTIC") === cat.key,
            ).length;
            const isActive = activeCategory === cat.key;
            return (
              <button
                key={cat.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveCategory(cat.key)}
                className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                  isActive
                    ? "border-[var(--action)] text-[var(--action)]"
                    : "border-transparent text-[var(--text-3)] hover:text-[var(--text)]"
                }`}
              >
                {cat.label}
                <span className="ml-1 text-xs opacity-70">{count}</span>
              </button>
            );
          })}
        </div>

        {/* 项目列表 / 骨架 / 空状态（对齐 app1 三态） */}
        {listLoading ? (
          /* 加载骨架屏（6 个网格，对齐 app1） */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="skeleton h-40 w-full rounded-xl" />
            ))}
          </div>
        ) : visibleProjects.length === 0 ? (
          /* 空状态（用批 0 的 EmptyState，替代原内联 JSX） */
          <EmptyState
            size="lg"
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M3 3h18v18H3zM3 9l5-5M21 9l-5-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="14" r="3" stroke="currentColor" strokeWidth="2" />
              </svg>
            }
            title={`还没有${
              CATEGORIES.find((c) => c.key === activeCategory)?.label ?? "此类"
            }项目`}
            description='点击右上角"新建项目"开始你的下一支作品'
          />
        ) : (
          /* 项目卡片网格 */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleProjects.map((p) => (
              <div
                key={p.id}
                onClick={() => router.push(`/workspace/${encodeURIComponent(p.id)}`)}
                className="p-4 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--action)]/50 transition-colors cursor-pointer group relative"
              >
                {/* 状态徽章 + 风格锁徽章 + 分类徽章（对齐 app1） */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium"
                    style={statusBadgeStyle(p.status)}
                  >
                    {STATUS_LABELS[p.status] || p.status}
                  </span>

                  {/* artStyle 风格锁徽章（琥珀色，hover tip，对齐 app1） */}
                  {p.artStyle && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                      style={{
                        background: "var(--accent-dim)",
                        color: "var(--accent)",
                        border: "1px solid var(--accent-glow)",
                      }}
                      title="项目风格创建后将锁定"
                    >
                      <Lock size={10} strokeWidth={1.5} aria-hidden="true" />
                      {ART_STYLE_LABELS[p.artStyle] ?? p.artStyle}
                    </span>
                  )}

                  {/* 分类徽章（非默认 DOMESTIC 时显示，对齐 app1） */}
                  {p.category && p.category !== "DOMESTIC" && (
                    <span
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium"
                      style={{
                        background: "var(--bg-hover)",
                        color: "var(--text-3)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {CATEGORIES.find((c) => c.key === p.category)?.label ?? p.category}
                    </span>
                  )}
                </div>

                {/* 标题（hover 变 action 色 + 显示改名图标，对齐 app1） */}
                {editingProjectId === p.id ? (
                  <div className="mb-1" onClick={(e) => e.stopPropagation()}>
                    <Input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      maxLength={100}
                      autoFocus
                      disabled={renaming}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !renaming) void handleRenameProject(p);
                        if (e.key === "Escape") setEditingProjectId(null);
                      }}
                      onBlur={() => {
                        if (editingTitle.trim() && editingTitle.trim() !== p.title) {
                          void handleRenameProject(p);
                        } else {
                          setEditingProjectId(null);
                        }
                      }}
                      className="text-base font-semibold h-9"
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 mb-1">
                    <h3 className="text-base font-semibold text-[var(--text)] truncate group-hover:text-[var(--action)] transition-colors flex-1 min-w-0">
                      {p.title}
                    </h3>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingProjectId(p.id);
                        setEditingTitle(p.title);
                      }}
                      className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-[var(--text-3)] hover:text-[var(--action)] hover:bg-[var(--bg-hover)] opacity-0 group-hover:opacity-100 transition-opacity"
                      title="重命名"
                      aria-label={`重命名项目：${p.title}`}
                    >
                      <Pencil size={12} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                )}

                {/* 描述 */}
                <p className="text-xs text-[var(--text-3)] line-clamp-2 mb-3 min-h-[2rem]">
                  {p.description || "暂无描述"}
                </p>

                {/*
                 * 底栏承载项目自身的次级信息与迁移动作：导出属于单个项目，
                 * 固定放在卡片底部并显示文字，避免与右上角危险删除操作混排。
                 */}
                <div className="flex items-center justify-between text-[10px] text-[var(--text-3)] tabular-nums pt-2 border-t border-[var(--border-light)]">
                  <span>更新于：{formatDate(p.updatedAt)}</span>
                  <div className="flex items-center gap-2">
                    <span>{p.episodeCount ?? 0} 集</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleExportProject(p);
                      }}
                      loading={transferring === p.id}
                      disabled={transferring !== null}
                      className="h-auto px-1.5 py-1 text-[10px] text-[var(--text-2)]"
                      title="导出项目（包含客户端本地媒体）"
                      aria-label={`导出项目：${p.title}`}
                    >
                      <Download size={12} strokeWidth={2} aria-hidden="true" />
                      {transferring === p.id ? "导出中" : "导出项目"}
                    </Button>
                  </div>
                </div>

                {/* 删除按钮（hover 显示，对齐 app1） */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm({ open: true, project: p });
                  }}
                  className="absolute top-3 right-3 w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-3)] hover:text-[var(--error)] hover:bg-[var(--error)]/10 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="删除项目"
                  aria-label="删除项目"
                >
                  <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 新建项目弹窗（对齐 app1：标题 + 分类 + 内容来源） */}
      {createOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={() => !creating && setCreateOpen(false)}
        >
          <div
            className="w-full max-w-md p-6 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border-strong)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-[var(--text)] mb-4">新建项目</h2>

            {/* 项目标题 */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-[var(--text-2)] mb-1.5 uppercase tracking-wider">
                项目标题
              </label>
              <Input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="例如：DramaForge出海短片"
                maxLength={100}
                autoFocus
                disabled={creating}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !creating) void handleCreate();
                }}
              />
            </div>

            {/* 项目分类（对齐 app1 CATEGORIES 三按钮） */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-[var(--text-2)] mb-1.5 uppercase tracking-wider">
                项目类型
              </label>
              <div className="grid grid-cols-3 gap-2">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => handleNewCategoryChange(cat.key)}
                    disabled={creating}
                    title={cat.desc}
                    className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors border ${
                      newCategory === cat.key
                        ? "bg-[var(--action-dim)] border-[var(--action)] text-[var(--text)]"
                        : "bg-transparent border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text-2)] hover:border-[var(--text-3)]"
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 内容来源按分类切换；共享 schema 会在服务端再次校验组合合法性。 */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-[var(--text-2)] mb-1.5 uppercase tracking-wider">
                内容来源
              </label>
              <div className="grid grid-cols-2 gap-2">
                {SOURCE_MODE_OPTIONS[newCategory].map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => {
                      if (!opt.disabled) setNewSourceMode(opt.key);
                    }}
                    disabled={creating || opt.disabled}
                    title={opt.desc}
                    className={`px-3 py-2.5 rounded-lg text-xs font-medium border text-left transition-colors ${
                      newSourceMode === opt.key
                        ? "bg-[var(--action-dim)] border-[var(--action)] text-[var(--text)]"
                        : "bg-transparent border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text-2)] hover:border-[var(--text-3)] disabled:opacity-50 disabled:cursor-not-allowed"
                    }`}
                  >
                    <span className="block">{opt.label}</span>
                    <span className="block mt-1 text-[10px] opacity-70">{opt.desc}</span>
                  </button>
                ))}
              </div>
              {newSourceMode === "ORIGINAL_PROJECT" && (
                <select
                  value={newSourceProjectId}
                  onChange={(event) => setNewSourceProjectId(event.target.value)}
                  disabled={creating}
                  className="input-base w-full mt-2 px-3 py-2.5 rounded-lg text-sm"
                >
                  <option value="">请选择已有且已保存完整剧本的原创项目</option>
                  {originalSourceProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* 国内直出/海外转绘都必须在创建时锁定画风，供五大流程统一读取。 */}
            {newCategory !== "ORIGINAL" && (
              <div className="mb-5">
                <label className="block text-xs font-semibold text-[var(--text-2)] mb-1.5 uppercase tracking-wider">
                  {newCategory === "OVERSEAS" ? "风格转绘" : "画面风格"}
                  <span className="ml-1 text-[var(--accent)] normal-case">
                    （必选，创建后不可修改）
                  </span>
                </label>
                <div className="space-y-2">
                  {ART_STYLES.map((style) => (
                    <button
                      key={style.key}
                      type="button"
                      onClick={() => setNewArtStyle(style.key)}
                      disabled={creating}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left border transition-colors ${
                        newArtStyle === style.key
                          ? "bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--text)]"
                          : "border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text-2)]"
                      }`}
                    >
                      <span
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                          newArtStyle === style.key
                            ? "border-[var(--accent)]"
                            : "border-[var(--border)]"
                        }`}
                      >
                        {newArtStyle === style.key && (
                          <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />
                        )}
                      </span>
                      <span>
                        <span className="block text-sm font-medium">{style.label}</span>
                        <span className="block text-[10px] text-[var(--text-3)]">
                          {style.desc}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleCreate()}
                loading={creating}
                disabled={
                  !newTitle.trim() ||
                  (newSourceMode === "ORIGINAL_PROJECT" && !newSourceProjectId) ||
                  (newCategory !== "ORIGINAL" && !newArtStyle)
                }
              >
                {creating ? "创建中..." : "创建项目"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认框（批 0 ConfirmDialog，variant=danger） */}
      <ConfirmDialog
        open={deleteConfirm.open}
        title={
          deleteConfirm.project
            ? `确认删除项目"${deleteConfirm.project.title}"吗？`
            : ""
        }
        message="项目及其分集、镜头和资产都会被永久删除，此操作不可撤销。"
        confirmLabel="确认删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => {
          if (!deleting) setDeleteConfirm({ open: false, project: null });
        }}
        loading={deleting}
      />
    </div>
  );
}
