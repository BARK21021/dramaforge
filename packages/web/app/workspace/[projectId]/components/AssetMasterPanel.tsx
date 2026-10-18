"use client";

/**
 * @file AssetMasterPanel — 资产总表面板（可复用）
 *
 * 从 workspace/[projectId]/assets/page.tsx 抽取，供：
 *   - 独立路由 assets/page.tsx（薄壳：鉴权 + 面包屑 + 本面板）
 *   - AssetDesignStage 顶部 [资产设定 | 资产总表] 视图切换内嵌
 * 共用。
 *
 * 自带数据拉取（GET /api/projects/[id]/assets/master）与筛选/视图状态。
 * 不含鉴权门与面包屑（由宿主提供）—— 在已登录上下文里挂载即拉取。
 *
 * 双视图：资产总表（按类型 section）/ 按集查看（按集 section）。
 * 出场集从 shots 派生（server domain/asset/appearance.ts）。
 */

import * as React from "react";
import { Spinner } from "../../../../components/ui/Spinner";
import { useToast } from "../../../../components/ui/Toast";
import type {
  AssetRecord,
  AssetMasterResult,
  AssetAppearance,
} from "@dramaforge/server";

// ------------------------------------------------------------
// 常量 / 工具
// ------------------------------------------------------------

const KIND_LABELS: Record<string, string> = {
  CHARACTER: "角色",
  PROP: "物品",
  LOCATION: "环境",
  ENTITY: "实体",
};
const KIND_ORDER = ["CHARACTER", "PROP", "LOCATION", "ENTITY"];
const STATUS_OPTIONS = [
  { value: "ALL", label: "全部图片状态" },
  { value: "missing", label: "缺图" },
  { value: "confirmed", label: "已确认" },
  { value: "locked", label: "已锁定" },
] as const;

/** 把升序集号数组格式化为区间串：[1,2,3,5,6] → "EP1-3, 5-6" */
function formatEpisodeRanges(eps: number[]): string {
  if (eps.length === 0) return "";
  const sorted = [...eps].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
    } else {
      parts.push(start === prev ? `EP${start}` : `EP${start}-${prev}`);
      start = n;
      prev = n;
    }
  }
  parts.push(start === prev ? `EP${start}` : `EP${start}-${prev}`);
  return parts.join(", ");
}

/** 资产图片状态判定（v1：基于 AssetRecord 现有字段） */
function assetStatus(asset: AssetRecord): "missing" | "confirmed" | "locked" | "ok" {
  if (asset.regenLocked) return "locked";
  if (asset.isConfirmed) return "confirmed";
  if (!asset.imageUrl) return "missing";
  return "ok";
}

// ------------------------------------------------------------
// 面板
// ------------------------------------------------------------

export function AssetMasterPanel({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const toast = useToast();

  const [master, setMaster] = React.useState<AssetMasterResult | null>(null);
  const [loading, setLoading] = React.useState(true);

  // 筛选 / 视图状态
  const [view, setView] = React.useState<"master" | "byEpisode">("master");
  const [activeKind, setActiveKind] = React.useState<string>("ALL");
  const [statusFilter, setStatusFilter] = React.useState<string>("ALL");
  const [episodeFilter, setEpisodeFilter] = React.useState<string>("ALL");
  const [unassignedOnly, setUnassignedOnly] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const loadMaster = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/assets/master`);
      if (res.status === 404) {
        setMaster(null);
        return;
      }
      const json = (await res.json()) as { success?: boolean; data?: AssetMasterResult };
      if (json.success && json.data) setMaster(json.data);
    } catch {
      toast.error("网络错误，加载资产总表失败");
    } finally {
      setLoading(false);
    }
  }, [projectId, toast]);

  React.useEffect(() => {
    void loadMaster();
  }, [loadMaster]);

  // —— 客户端筛选 ——
  const appearanceOf = (assetId: string): AssetAppearance =>
    master?.appearance[assetId] ?? { byVariant: [], allEpisodes: [] };

  const filteredAssets = React.useMemo(() => {
    if (!master) return [];
    const q = search.trim().toLowerCase();
    return master.assets.filter((a) => {
      if (activeKind !== "ALL" && a.kind !== activeKind) return false;
      if (q && !`${a.name} ${a.description ?? ""}`.toLowerCase().includes(q)) return false;
      if (statusFilter !== "ALL" && assetStatus(a) !== statusFilter) return false;
      const ap = appearanceOf(a.id);
      if (unassignedOnly && ap.allEpisodes.length > 0) return false;
      if (episodeFilter !== "ALL" && !ap.allEpisodes.includes(Number(episodeFilter))) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master, activeKind, search, statusFilter, episodeFilter, unassignedOnly]);

  // 类型计数（基于全量，非筛选后）
  const kindCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of master?.assets ?? []) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    return counts;
  }, [master]);

  // 筛选后状态条计数
  const barCounts = React.useMemo(() => {
    let imageTotal = 0;
    let imagePresent = 0;
    let unassigned = 0;
    for (const a of filteredAssets) {
      const ap = appearanceOf(a.id);
      for (const v of ap.byVariant) {
        imageTotal += 1;
        if (v.hasImage) imagePresent += 1;
      }
      if (ap.allEpisodes.length === 0) unassigned += 1;
    }
    return { total: filteredAssets.length, imageTotal, imagePresent, unassigned };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredAssets, master]);

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-16 ${className ?? ""}`}>
        <Spinner size={28} />
      </div>
    );
  }
  if (!master) {
    return (
      <div className={`text-center py-16 text-sm text-[var(--text-3)] ${className ?? ""}`}>
        暂无资产数据
      </div>
    );
  }

  // —— 资产总表视图：按类型 section ——
  const renderMasterView = () => {
    const kinds = activeKind === "ALL" ? KIND_ORDER.filter((k) => kindCounts[k]) : [activeKind];
    if (filteredAssets.length === 0) {
      return <EmptyHint />;
    }
    return kinds.map((kind) => {
      const list = filteredAssets.filter((a) => a.kind === kind);
      if (list.length === 0) return null;
      return (
        <section key={kind} className="mb-8">
          <h2 className="text-sm font-semibold text-[var(--text-2)] mb-3 px-1">
            {KIND_LABELS[kind] ?? kind} · {list.length}
          </h2>
          <div className="grid grid-cols-1 gap-3">
            {list.map((a) => (
              <AssetMasterCard key={a.id} asset={a} appearance={appearanceOf(a.id)} />
            ))}
          </div>
        </section>
      );
    });
  };

  // —— 按集查看：按集 section ——
  const renderByEpisodeView = () => {
    if (master.episodes.length === 0) {
      return <EmptyHint hint="项目还没有分集" />;
    }
    return master.episodes.map((ep) => {
      const list = filteredAssets.filter((a) => appearanceOf(a.id).allEpisodes.includes(ep.episodeNumber));
      return (
        <section key={ep.id} className="mb-8">
          <h2 className="text-sm font-semibold text-[var(--text-2)] mb-3 px-1">
            EP{ep.episodeNumber}
            {ep.title ? ` · ${ep.title}` : ""} · {list.length} 个资产
          </h2>
          {list.length === 0 ? (
            <p className="text-xs text-[var(--text-3)] px-1 py-2">本集无出场资产</p>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {list.map((a) => {
                const ap = appearanceOf(a.id);
                const vInEp = ap.byVariant.find((v) => v.episodes.includes(ep.episodeNumber));
                return (
                  <div key={a.id} className="flex items-center gap-3 p-2 rounded-lg border border-[var(--border)] bg-[var(--bg)]">
                    <Thumb url={a.imageUrl} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-[var(--text)] truncate">{a.name}</div>
                      <div className="text-[11px] text-[var(--text-3)] truncate">
                        {KIND_LABELS[a.kind] ?? a.kind}
                        {vInEp && vInEp.key !== "default" ? ` · ${vInEp.label}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      );
    });
  };

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ""}`}>
      {/* 视图切换（资产总表 / 按集查看）+ 筛选栏 */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] flex-shrink-0">
          {(["master", "byEpisode"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                view === v ? "bg-[var(--action)] text-white" : "text-[var(--text-3)] hover:text-[var(--text)]"
              }`}
            >
              {v === "master" ? "资产总表" : "按集查看"}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索资产"
          className="px-3 py-1.5 text-sm rounded-md bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-[var(--action)]/40 w-44"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-2.5 py-1.5 text-sm rounded-md bg-[var(--bg)] border border-[var(--border)] text-[var(--text-2)] focus:outline-none"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={episodeFilter}
          onChange={(e) => setEpisodeFilter(e.target.value)}
          className="px-2.5 py-1.5 text-sm rounded-md bg-[var(--bg)] border border-[var(--border)] text-[var(--text-2)] focus:outline-none"
        >
          <option value="ALL">全部剧集</option>
          {master.episodes.map((ep) => (
            <option key={ep.id} value={ep.episodeNumber}>
              EP{ep.episodeNumber}{ep.title ? ` · ${ep.title}` : ""}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-2)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={unassignedOnly}
            onChange={(e) => setUnassignedOnly(e.target.checked)}
            className="accent-[var(--action)]"
          />
          只看未设置出场集的资产
        </label>
      </div>

      {/* 类型 tab + 计数 */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {["ALL", ...KIND_ORDER.filter((k) => kindCounts[k])].map((k) => (
          <button
            key={k}
            onClick={() => setActiveKind(k)}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              activeKind === k
                ? "border-[var(--action)] text-[var(--action)] bg-[var(--action-dim)]"
                : "border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text)]"
            }`}
          >
            {k === "ALL" ? "全部类型" : KIND_LABELS[k] ?? k}
            <span className="ml-1 opacity-70">{k === "ALL" ? master.assets.length : kindCounts[k]}</span>
          </button>
        ))}
      </div>

      {/* 状态条 */}
      <div className="text-[11px] text-[var(--text-3)] mb-5 px-1">
        当前显示 {barCounts.total} 个资产 / {barCounts.imageTotal} 张主形象与变体 · 图片 {barCounts.imagePresent}/{barCounts.imageTotal} · 出场集未设置 {barCounts.unassigned}
      </div>

      <div className="overflow-auto flex-1 min-h-0 pr-1">
        {view === "master" ? renderMasterView() : renderByEpisodeView()}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 子组件
// ------------------------------------------------------------

function Thumb({ url, size = 56 }: { url: string | null; size?: number }) {
  if (!url) {
    return (
      <div
        className="rounded-md flex items-center justify-center text-[10px] text-[var(--text-3)] flex-shrink-0"
        style={{
          width: size,
          height: size,
          background: "repeating-linear-gradient(45deg, var(--bg-hover), var(--bg-hover) 6px, var(--bg) 6px, var(--bg) 12px)",
          border: "1px solid var(--border)",
        }}
      >
        缺图
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="rounded-md object-cover flex-shrink-0"
      style={{ width: size, height: size, border: "1px solid var(--border)" }}
      loading="lazy"
    />
  );
}

function AssetMasterCard({ asset, appearance }: { asset: AssetRecord; appearance: AssetAppearance }) {
  const st = assetStatus(asset);
  const statusLabel = st === "missing" ? "缺图" : st === "confirmed" ? "已确认" : st === "locked" ? "已锁定" : "";
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex items-start gap-3 mb-2">
        <Thumb url={asset.imageUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--text)]">{asset.name}</span>
            <span className="text-[10px] text-[var(--text-3)]">{KIND_LABELS[asset.kind] ?? asset.kind}</span>
            {statusLabel && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-2)]">{statusLabel}</span>
            )}
          </div>
          {asset.description && (
            <p className="text-[11px] text-[var(--text-3)] mt-1 line-clamp-2">{asset.description}</p>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-[10px] text-[var(--text-3)]">出场集</div>
          <div className="text-[11px] text-[var(--text-2)] max-w-[220px]">
            {appearance.allEpisodes.length ? formatEpisodeRanges(appearance.allEpisodes) : "—"}
          </div>
        </div>
      </div>
      {/* 变体行 */}
      {appearance.byVariant.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap pt-2 border-t border-[var(--border)]">
          {appearance.byVariant.map((v) => (
            <div key={v.key} className="flex items-center gap-1.5">
              <Thumb url={v.imageUrl} size={32} />
              <div className="leading-tight">
                <div className="text-[11px] text-[var(--text-2)]">
                  {v.key === "default" ? "主形象" : v.label}
                </div>
                <div className="text-[10px] text-[var(--text-3)]">
                  {v.episodes.length ? formatEpisodeRanges(v.episodes) : (v.key === "default" ? "" : "未出场")}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyHint({ hint = "没有符合条件的资产" }: { hint?: string }) {
  return (
    <div className="text-center py-16 text-sm text-[var(--text-3)]">{hint}</div>
  );
}
