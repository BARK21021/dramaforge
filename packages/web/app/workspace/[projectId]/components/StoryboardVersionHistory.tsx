"use client";

/**
 * @file StoryboardVersionHistory.tsx — 分镜历史版本浮层
 *
 * 重生/恢复时自动归档的整集快照列表，支持：查看（只读镜头表）/ 恢复（当前另存为新版本
 * 后写回旧版，视频素材需重新生产）/ 手动删除。当前镜头在 shots 表，这里只列历史快照。
 *
 * 数据走 inline useState + api()（仿 EpisodeWorkspace.loadShots，无 SWR）。
 * 后端：storyboard-versions 域模块 + 4 个路由（list/get/delete/restore）。
 */

import * as React from 'react';
import { Modal } from '../../../../components/ui/Modal';
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog';
import { Button } from '../../../../components/ui/Button';
import { useToast } from '../../../../components/ui/Toast';

/** 历史版本摘要（列表用） */
interface VersionSummary {
  id: string;
  ordinal: number;
  shotCount: number;
  createdAt: string;
}

/** 只读镜头（快照里足够展示的字段） */
interface ShotSnapshot {
  shotIndex: number;
  durationSeconds?: number | null;
  visualPrompt?: string | null;
  sceneId?: string | null;
  metadata?: Record<string, unknown> | null;
  currentMaterialUrl?: string | null;
  videoStatus?: string | null;
}

interface VersionDetail extends VersionSummary {
  shotsSnapshot: ShotSnapshot[];
}

export interface StoryboardVersionHistoryProps {
  projectId: string;
  episodeId?: string | null;
  /** API 调用封装（envelope 解析 + toast） */
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  open: boolean;
  onClose: (open: boolean) => void;
  /** 恢复成功后刷新当前 shots（父组件 onRefresh） */
  onRestored: () => void;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export function StoryboardVersionHistory({
  projectId,
  episodeId,
  api,
  open,
  onClose,
  onRestored,
}: StoryboardVersionHistoryProps) {
  const toast = useToast();
  const [versions, setVersions] = React.useState<VersionSummary[]>([]);
  const [viewing, setViewing] = React.useState<VersionDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [restoreTarget, setRestoreTarget] = React.useState<VersionSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<VersionSummary | null>(null);
  const [actionLoading, setActionLoading] = React.useState(false);

  const baseUrl = React.useMemo(
    () => `/api/projects/${projectId}/episodes/${episodeId}/storyboard-versions`,
    [projectId, episodeId],
  );

  const loadList = React.useCallback(async () => {
    if (!episodeId) return;
    setLoading(true);
    try {
      const data = (await api(baseUrl)) as { versions?: VersionSummary[] };
      setVersions(data.versions ?? []);
    } catch {
      // api() 已 toast 错误
    } finally {
      setLoading(false);
    }
  }, [api, baseUrl, episodeId]);

  React.useEffect(() => {
    if (open && episodeId) {
      setViewing(null);
      void loadList();
    }
  }, [open, episodeId, loadList]);

  const handleView = async (v: VersionSummary) => {
    setLoading(true);
    try {
      const data = (await api(`${baseUrl}/${v.id}`)) as { version?: VersionDetail };
      if (data.version) setViewing(data.version);
    } catch {
      // api() 已 toast
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setActionLoading(true);
    try {
      await api(`${baseUrl}/${restoreTarget.id}/restore`, { method: 'POST' });
      toast.success('已恢复该版本（当前分镜已另存为历史版本；视频素材需重新生产）');
      setRestoreTarget(null);
      onRestored();
      onClose(false);
    } catch {
      // api() 已 toast
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setActionLoading(true);
    try {
      await api(`${baseUrl}/${deleteTarget.id}`, { method: 'DELETE' });
      toast.success('已删除该历史版本');
      setDeleteTarget(null);
      await loadList();
    } catch {
      // api() 已 toast
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={viewing ? `第 ${viewing.ordinal} 版 · ${formatTime(viewing.createdAt)}` : '分镜历史版本'}
      description={viewing ? undefined : '重生/恢复时自动归档的整集快照。当前镜头不会出现在这里。'}
      maxWidthClassName="max-w-5xl"
    >
      {!viewing ? (
        <div className="space-y-2">
          {loading && versions.length === 0 ? (
            <div className="text-center py-10 text-sm text-[var(--text-3)]">加载中…</div>
          ) : versions.length === 0 ? (
            <div className="text-center py-10 text-sm text-[var(--text-3)]">
              暂无历史版本（重生分镜后会自动保留上一版）
            </div>
          ) : (
            versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg)] px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--text)]">第 {v.ordinal} 版</div>
                  <div className="text-xs text-[var(--text-3)] tabular-nums">
                    {formatTime(v.createdAt)} · {v.shotCount} 镜
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button variant="ghost" onClick={() => void handleView(v)} disabled={loading}>
                    查看
                  </Button>
                  <Button variant="outline" onClick={() => setRestoreTarget(v)} disabled={actionLoading}>
                    恢复
                  </Button>
                  <Button variant="ghost" onClick={() => setDeleteTarget(v)} disabled={actionLoading}>
                    删除
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Button variant="ghost" onClick={() => setViewing(null)}>
            ← 返回列表
          </Button>
          <div className="rounded-[var(--radius-md)] border border-[var(--border)] overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-[var(--bg-hover)] text-[var(--text-2)]">
                <tr>
                  <th className="text-left px-3 py-2 w-10">#</th>
                  <th className="text-left px-3 py-2">画面提示词</th>
                  <th className="text-right px-3 py-2 w-16">时长</th>
                  <th className="text-left px-3 py-2 w-20">对白</th>
                </tr>
              </thead>
              <tbody>
                {viewing.shotsSnapshot.map((s, i) => (
                  <tr key={i} className="border-t border-[var(--border)] align-top">
                    <td className="px-3 py-2 text-[var(--text-3)] tabular-nums">{s.shotIndex}</td>
                    <td className="px-3 py-2 text-[var(--text-2)]">
                      {s.visualPrompt ? (
                        <span className="line-clamp-2">{s.visualPrompt}</span>
                      ) : (
                        <span className="text-[var(--text-3)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--text-3)] tabular-nums">
                      {s.durationSeconds != null ? `${s.durationSeconds}s` : '—'}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-2)]">
                      {typeof s.metadata?.dialogue === 'string' && s.metadata.dialogue ? (
                        <span className="line-clamp-2">{s.metadata.dialogue}</span>
                      ) : (
                        <span className="text-[var(--text-3)]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!restoreTarget}
        variant="warning"
        title={`恢复第 ${restoreTarget?.ordinal ?? ''} 版？`}
        message="恢复后当前分镜会另存为新的历史版本（不会丢），选中的旧版写回为当前；视频素材需重新生产。"
        confirmLabel="恢复"
        loading={actionLoading}
        onConfirm={() => void handleRestore()}
        onCancel={() => (actionLoading ? undefined : setRestoreTarget(null))}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        variant="danger"
        title={`删除第 ${deleteTarget?.ordinal ?? ''} 版？`}
        message="删除后该历史版本不可恢复。当前镜头不受影响。"
        confirmLabel="删除"
        loading={actionLoading}
        onConfirm={() => void handleDelete()}
        onCancel={() => (actionLoading ? undefined : setDeleteTarget(null))}
      />
    </Modal>
  );
}
