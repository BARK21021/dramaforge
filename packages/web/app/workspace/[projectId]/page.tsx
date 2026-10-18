"use client";

/**
 * @file workspace/[projectId]/page.tsx — 项目工作台外壳（P7.1 T4）
 *
 * app1 workspace/[projectId] 的分集工作台（多 Tab / stage 工作流 / 成片库）。职责：
 *   - 加载项目（GET /api/projects/[id]）+ 分集列表（GET .../episodes）
 *   - 顶部：返回 / 项目标题（可重命名）/ 状态徽章
 *   - 渲染 EpisodeListStage（建/编/删/排序/贴剧本）
 *
 * useSession 三态门 + 直接 fetch（cookie 自动带，对齐 P3 workspace/page.tsx）。
 * 视觉对齐 app1 stage-config 的 STATUS_LABELS；像素非 gate（结构对 + 暗色即可）。
 */

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Spinner } from "../../../components/ui/Spinner";
import { useToast } from "../../../components/ui/Toast";
import { EpisodeListStage } from "./components/EpisodeListStage";
import { OriginalRewriteStage } from "./components/OriginalRewriteStage";
import type { EpisodeRecord, ProjectRecord } from "@dramaforge/shared";

/** 项目状态显示标签（对齐 app1 stage-config STATUS_LABELS，subset）。 */
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  SCREENWRITING: "编剧中",
  ASSET_DESIGN: "资产设定",
  STORYBOARD: "分镜设计",
  PRODUCTION: "生产中",
  COMPLETE: "已完成",
};

export default function ProjectWorkspacePage() {
  const params = useParams();
  const projectId = params?.projectId as string;
  const toast = useToast();
  const { status } = useSession();

  const [project, setProject] = React.useState<ProjectRecord | null>(null);
  const [episodes, setEpisodes] = React.useState<EpisodeRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  // 项目重命名（对齐 app1 顶栏可重命名标题）
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState("");
  const [savingTitle, setSavingTitle] = React.useState(false);

  /** 拉项目 + 分集。notFound（404/无权）→ 显示提示 + 返回入口。 */
  const loadAll = React.useCallback(async () => {
    setLoading(true);
    try {
      const [projRes, epsRes] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(projectId)}`),
        fetch(`/api/projects/${encodeURIComponent(projectId)}/episodes`),
      ]);
      if (!projRes.ok || projRes.status === 404) {
        setNotFound(true);
        return;
      }
      const projJson = (await projRes.json()) as { success?: boolean; data?: ProjectRecord };
      const epsJson = (await epsRes.json()) as {
        success?: boolean;
        data?: { episodes?: EpisodeRecord[] };
      };
      if (projJson.success && projJson.data) setProject(projJson.data);
      if (epsJson.success && epsJson.data) setEpisodes(epsJson.data.episodes ?? []);
    } catch {
      toast.error("网络错误，加载项目失败");
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  React.useEffect(() => {
    if (status !== "authenticated") return;
    void loadAll();
  }, [status, loadAll]);

  /** 重命名项目（PATCH title；空或未改 → 取消）。 */
  const handleSaveTitle = async () => {
    const trimmed = titleDraft.trim();
    if (!trimmed || !project || trimmed === project.title) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        data?: ProjectRecord;
        error?: string;
      };
      if (data.success && data.data) {
        setProject(data.data);
        toast.success("项目名称已更新");
      } else {
        toast.error(data.error || "重命名失败");
      }
    } catch {
      toast.error("网络错误，重命名失败");
    } finally {
      setSavingTitle(false);
      setEditingTitle(false);
    }
  };

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
  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Spinner size={28} />
      </main>
    );
  }
  if (notFound || !project) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-sm text-[var(--text-3)]">项目不存在或无权访问</p>
        <Link href="/workspace" className="text-[var(--action)] hover:underline">
          返回项目列表
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-6 py-8 max-w-5xl mx-auto">
      {/* 顶部：面包屑（工作区 > 项目名可重命名）+ 状态徽章 — 对齐 app1 */}
      <header className="flex items-center gap-3 mb-6 flex-wrap">
        <Link
          href="/workspace"
          className="text-sm text-[var(--text-3)] hover:text-[var(--action)] transition-colors flex items-center gap-1 flex-shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M19 12H5M12 19l-7-7 7-7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          工作区
        </Link>
        <span className="text-[var(--text-3)] text-xs flex-shrink-0">/</span>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSaveTitle();
              if (e.key === "Escape") setEditingTitle(false);
            }}
            onBlur={() => void handleSaveTitle()}
            disabled={savingTitle}
            maxLength={100}
            className="text-xl font-bold px-2 py-0.5 rounded-md bg-[var(--bg)] border border-[var(--action)]/50 text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--action)]/30 min-w-0 max-w-xs"
            placeholder="项目名称"
          />
        ) : (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-[var(--text)] truncate">{project.title}</h1>
            <button
              onClick={() => {
                setTitleDraft(project.title || "");
                setEditingTitle(true);
              }}
              className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-3)] hover:text-[var(--action)] hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0"
              title="重命名项目"
              aria-label="重命名项目"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M11 2l3 3-9 9H2v-3l9-9z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
        <span
          className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium flex-shrink-0"
          style={{
            background: "var(--action-dim)",
            color: "var(--action)",
            border: "1px solid var(--action)",
          }}
        >
          {STATUS_LABELS[project.status] || project.status}
        </span>
      </header>

      {project.category === "ORIGINAL" ? (
        // ORIGINAL 项目：整剧重写（视频→剧本），无分集 —— 对齐 app1 page.tsx
        // category==="ORIGINAL" 直接路由 OriginalRewriteStage（不走 EpisodeListStage）。
        <OriginalRewriteStage project={project} onRefresh={loadAll} />
      ) : (
        <EpisodeListStage
          projectId={projectId}
          project={project}
          episodes={episodes}
          onChanged={loadAll}
        />
      )}
    </main>
  );
}
