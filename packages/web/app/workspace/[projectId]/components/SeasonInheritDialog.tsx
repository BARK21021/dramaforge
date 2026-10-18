"use client";

/**
 * @file SeasonInheritDialog.tsx — 季继承对话框（功能1 前端）
 *
 * 第二季项目选第一季为源，把重复角色/物体/环境/变体的「完整外观」
 * （参考图 + identityLock + 服装变体图 + 派生图）从第一季继承过来；第二季独有
 * 的不动，绝不新增（服务端 planSeasonInheritance 已保证只返回匹配项）。
 *
 * 两步流程（H1：服务器零媒体，图复制必须在客户端）：
 *   1. POST /api/projects/[id]/assets/season-inherit → 拿 { items }（0 字节计划）
 *   2. 客户端：批量 window.sfShell.copyLocalAsset(源 key) → 新 key 映射 →
 *      PATCH 每个 target asset（imageUrl/pencilImageUrl/gridImageUrl/identityLock/costumes）
 *
 * 前提：第一季资产图与第二季在同一台客户端（同机 copyFile）。源图不在本机时
 * copyLocalAsset 返 READ_ERROR，计入失败数并 toast 提示。
 */

import * as React from "react";
import { Modal } from "../../../../components/ui/Modal";
import { Button } from "../../../../components/ui/Button";
import { Spinner } from "../../../../components/ui/Spinner";
import { useToast } from "../../../../components/ui/Toast";

type ApiFn = (url: string, options?: RequestInit) => Promise<unknown>;

interface ProjectLite {
  id: string;
  title: string;
  updatedAt?: string;
  scriptData: unknown;
}

/**
 * 整剧项目判定。与 server `isWholeScriptProject` 同集合（VIDEO_REWRITE/LOCAL_SCRIPT/
 * ORIGINAL_PROJECT）。这里内联而非 import @dramaforge/server，避免 client bundle 拖入
 * 主 barrel 的 node:* 依赖。若 server 集合变更，此处需同步。
 */
const WHOLE_SCRIPT_SOURCE_MODES = new Set(["VIDEO_REWRITE", "LOCAL_SCRIPT", "ORIGINAL_PROJECT"]);
function isWholeScriptLite(p: { scriptData: unknown }): boolean {
  const sd = p.scriptData;
  if (sd && typeof sd === "object" && !Array.isArray(sd)) {
    const m = (sd as Record<string, unknown>).sourceMode;
    return typeof m === "string" && WHOLE_SCRIPT_SOURCE_MODES.has(m);
  }
  return false;
}

interface InheritItem {
  targetAssetId: string;
  targetKind: string;
  targetName: string;
  sourceName: string;
  imageUrl: string | null;
  pencilImageUrl: string | null;
  gridImageUrl: string | null;
  identityLock: string[];
  costumes: Array<Record<string, unknown>>;
}

interface InheritPlan {
  sourceProjectId: string;
  targetProjectId: string;
  items: InheritItem[];
  skipped: Array<{ targetName: string; targetKind: string; reason: string }>;
}

export function SeasonInheritDialog({
  projectId,
  api,
  onClose,
  onDone,
}: {
  projectId: string;
  api: ApiFn;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [projects, setProjects] = React.useState<ProjectLite[]>([]);
  const [loadingProjects, setLoadingProjects] = React.useState(true);
  const [sourceId, setSourceId] = React.useState<string>("");
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number; failed: number } | null>(null);
  const [summary, setSummary] = React.useState<{ inherited: number; failed: number; skipped: number } | null>(null);

  // 加载用户项目列表（排除自己）
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await api("/api/projects")) as ProjectLite[];
        if (cancelled) return;
        const others = (Array.isArray(list) ? list : [])
          .filter((p) => p && p.id && p.id !== projectId && isWholeScriptLite(p))
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        setProjects(others);
      } catch (e) {
        toast.error(`加载项目列表失败: ${e instanceof Error ? e.message : "未知错误"}`);
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, projectId, toast]);

  const handleConfirm = async () => {
    if (!sourceId) {
      toast.warning("请先选择源季项目");
      return;
    }
    const sf = typeof window !== "undefined" ? window.sfShell : undefined;
    if (!sf?.copyLocalAsset) {
      toast.error("桌面客户端本地存储能力(sfShell)未加载，无法复制资产图。请在桌面客户端操作。");
      return;
    }
    setRunning(true);
    setProgress({ done: 0, total: 0, failed: 0 });
    setSummary(null);
    try {
      // Step 1: 服务端出继承计划（0 字节）
      const plan = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/assets/season-inherit`,
        { method: "POST", body: JSON.stringify({ sourceProjectId: sourceId }) },
      )) as InheritPlan;
      const items = plan.items ?? [];
      const skipped = plan.skipped?.length ?? 0;
      if (items.length === 0) {
        toast.info(`没有可继承的资产（${skipped} 个未匹配或源季无图）`);
        setSummary({ inherited: 0, failed: 0, skipped });
        return;
      }

      // Step 2a: 收集所有源 sf-asset:// key（去重）
      const sourceKeys = new Set<string>();
      const collect = (u: string | null | undefined) => {
        if (typeof u === "string" && u.startsWith("sf-asset://")) sourceKeys.add(u);
      };
      for (const it of items) {
        collect(it.imageUrl);
        collect(it.pencilImageUrl);
        collect(it.gridImageUrl);
        for (const c of it.costumes) collect((c.imageUrl as string | null) ?? null);
      }

      // Step 2b: 批量本地复制 old key → new key
      const keyMap = new Map<string, string>();
      let copyFailed = 0;
      for (const src of sourceKeys) {
        const r = await sf.copyLocalAsset(src);
        if (r && r.ok) keyMap.set(src, r.protocolUrl);
        else copyFailed++;
      }

      // Step 2c: 逐 item PATCH（用 keyMap 重写 url）
      const remap = (u: string | null): string | null =>
        typeof u === "string" && keyMap.has(u) ? (keyMap.get(u) as string) : u;
      let inherited = 0;
      let failed = 0;
      setProgress({ done: 0, total: items.length, failed: 0 });
      for (const it of items) {
        try {
          await api(
            `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(it.targetAssetId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                imageUrl: remap(it.imageUrl),
                pencilImageUrl: remap(it.pencilImageUrl),
                gridImageUrl: remap(it.gridImageUrl),
                identityLock: it.identityLock,
                costumes: it.costumes.map((c) => ({
                  ...c,
                  imageUrl: remap((c.imageUrl as string | null) ?? null),
                })),
              }),
            },
          );
          inherited++;
        } catch {
          failed++;
        }
        setProgress((p) => (p ? { done: p.done + 1, total: p.total, failed } : null));
      }

      const totalFailed = failed + copyFailed;
      setSummary({ inherited, failed: totalFailed, skipped });
      if (copyFailed > 0) {
        toast.warning(`部分源图在本机未找到（${copyFailed} 个），仅同机生成的源季图才能继承`);
      }
      if (totalFailed === 0 && copyFailed === 0) {
        toast.success(`已继承 ${inherited} 个资产外观`);
      } else if (inherited > 0) {
        toast.warning(`继承 ${inherited} 个，失败 ${totalFailed} 个`);
      } else {
        toast.error(`继承失败（${totalFailed} 个），请检查源季图是否在本机`);
      }
      onDone();
    } catch (e) {
      toast.error(`季继承失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal open onClose={() => onClose()} title="季继承（资产外观）" maxWidthClassName="max-w-lg">
      <div className="space-y-3 text-sm">
        <p className="text-[color:var(--text-muted)]">
          选择一个<strong>源季项目</strong>，系统会对比当前项目与源季的资产，把
          <strong>重复的角色/物体/环境/变体</strong>的外观图、身份特征、造型从源季继承过来。
          当前项目独有的资产保持不动，也<strong>不会新增</strong>源季独有的资产。
        </p>
        <p className="text-[color:var(--text-muted)]">
          前提：源季的资产图需在本机（同一台客户端）生成过。
        </p>

        <div>
          <label className="block mb-1 font-medium">源季项目</label>
          {loadingProjects ? (
            <div className="flex items-center gap-2">
              <Spinner /> 加载项目列表…
            </div>
          ) : projects.length === 0 ? (
            <p className="text-[color:var(--text-muted)]">没有可选的其它项目。</p>
          ) : (
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              disabled={running}
              className="w-full border rounded px-2 py-1.5 bg-[color:var(--surface)]"
            >
              <option value="">— 选择源季项目 —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          )}
        </div>

        {progress && running && (
          <p className="text-[color:var(--text-muted)]">
            继承中：{progress.done}/{progress.total}，失败 {progress.failed}
          </p>
        )}

        {summary && !running && (
          <p className="text-[color:var(--text-muted)]">
            完成：已继承 {summary.inherited} 个，失败 {summary.failed} 个，未匹配/无图 {summary.skipped} 个。
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => onClose()} disabled={running}>
            关闭
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleConfirm()}
            loading={running}
            disabled={loadingProjects || !sourceId || running}
          >
            {running ? "继承中" : "开始继承"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
