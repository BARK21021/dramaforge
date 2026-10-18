"use client";

/**
 * @file AdminUserFilmsSection.tsx
 * @description 用户成片只读查看（admin，对齐 app1）
 *
 * GET /api/admin/users/[userId]/films → 按 projectTitle 分组渲染只读 <video>
 * （禁下载/右键/画中画）。dramaforge 成片为客户端本地资产（sf-asset://），仅 Electron
 * 客户端可播放；纯 Web admin 预览不可播（dramaforge-assets-client-local 约束）。
 */

import * as React from "react";
import { Film } from "lucide-react";
import { EmptyState } from "../../../../components/ui/EmptyState";

interface AdminFilm {
  id: string;
  type: string;
  outputUrl: string | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  projectTitle: string | null;
  shotCount: number | null;
  totalDuration: number | null;
  createdAt: string;
}

function fmtDuration(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function AdminUserFilmsSection({ userId }: { userId: string }) {
  const [films, setFilms] = React.useState<AdminFilm[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/users/${userId}/films`, { credentials: "include" });
        const data = await res.json();
        if (!cancelled && data.success) setFilms(data.data as AdminFilm[]);
      } catch {
        // 静默
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const groups = React.useMemo(() => {
    const m = new Map<string, AdminFilm[]>();
    for (const f of films) {
      const k = f.projectTitle || "未关联项目";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    }
    return Array.from(m.entries()).map(([label, list]) => ({ label, list }));
  }, [films]);

  if (loading) {
    return <div className="text-xs text-[var(--text-3)] px-4 py-6">成片加载中…</div>;
  }
  if (films.length === 0) {
    return (
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-light)]">
          <Film size={14} className="text-[var(--text-2)]" />
          <span className="text-xs font-bold text-[var(--text-2)]">用户成片</span>
        </div>
        <div className="px-4 py-6">
          <EmptyState size="sm" title="暂无成片" description="该用户尚未生成任何成片" />
        </div>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-light)]">
        <Film size={14} className="text-[var(--text-2)]" />
        <span className="text-xs font-bold text-[var(--text-2)]">用户成片</span>
        <span className="ml-auto text-xs text-[var(--text-3)]">共 {films.length} 部 · 只读</span>
      </div>
      <div className="p-4 space-y-4">
        {groups.map(({ label, list }) => (
          <div key={label}>
            <div className="text-xs font-medium text-[var(--text-2)] mb-2">{label}</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {list.map((f) => (
                <div key={f.id} className="rounded-[var(--radius-sm)] overflow-hidden border border-[var(--border-light)] bg-[var(--bg-hover)]">
                  <video
                    src={f.outputUrl ?? undefined}
                    controls
                    controlsList="nodownload nofullscreen noremoteplayback"
                    disablePictureInPicture
                    onContextMenu={(e) => e.preventDefault()}
                    className="w-full aspect-video bg-black"
                  />
                  <div className="p-2 text-[10px] text-[var(--text-3)] space-y-0.5">
                    <div className="text-[var(--text-2)] truncate">
                      {f.episodeTitle || `第 ${f.episodeNumber ?? "?"} 集`}
                    </div>
                    <div>
                      {f.shotCount != null ? `${f.shotCount} 镜 · ` : ""}
                      {fmtDuration(f.totalDuration)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
