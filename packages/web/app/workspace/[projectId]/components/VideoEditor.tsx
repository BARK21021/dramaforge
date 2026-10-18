"use client";

/**
 * @file VideoEditor.tsx
 * @description 生产制作阶段的工作台式编辑器视图（移植自 app1）
 *
 * 移植源：F:\app1\src\app\workspace\[projectId]\components\VideoEditor.tsx (491 行)
 * 与 app1 差异：仅 import 路径（`@/components/ui/...` → 相对 `../../../../components/ui/...`，
 * 对齐 dramaforge ProductionStage 约定）。视觉/布局/三栏结构/SVG/双色配色 100% 保留。
 *
 * ============================================================
 * 架构适配（dramaforge C/S）
 * ============================================================
 * app1 export-film 在 server 合片（BullMQ + server ffmpeg）。dramaforge 把 ffmpeg 合片
 * 整体挪到 **client render-worker**（约束 dramaforge-assets-client-local）。
 *
 * 但 VideoEditor 本身只 emit `onExportFilm()` 回调（与 app1 形状一致）。
 * 父组件（ProductionStage）负责把 `onExportFilm` 接到 dramaforge 的客户端 ffmpeg 链路：
 *
 *   VideoEditor.onExportFilm()
 *     → POST /api/projects/[id]/export-film      （仅派发 CONCAT render_job）
 *     → client render-worker 轮询 /api/render/jobs/next 拉取该 job
 *     → executor.ts CONCAT case 在用户本机跑 ffmpeg.execFfmpegConcat
 *     → 写入 filmsDir/<jobId>.mp4（持久化，非 tmp）
 *     → 返回 result.outputUrl = sf-asset://<jobId>.mp4
 *     → server 不存任何媒体字节
 *
 * 也就是说 "调 client IPC(render-worker ffmpeg),不是 server route" 这条硬约束
 * 已经在 dramaforge 的服务端路由 + render-worker 架构里 baked-in：VideoEditor 触发的
 * 这条链路里，ffmpeg 100% 跑在客户端，server route 只是派发入口。
 *
 * ============================================================
 * 媒体落地 sf-asset://
 * ============================================================
 * 镜头预览 selectedPreviewUrl 通常是 sf-asset://（客户端本地协议，Electron
 * registerAssetProtocol 已挂载）。Electron 渲染进程里 `<video src="sf-asset://...">`
 * 直接可播（参考 ProductionStage.tsx 第 986 行同款用法）。
 */

import * as React from "react";
import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { ProgressBar } from "../../../../components/ui/ProgressBar";
import { VideoPlayer } from "./VideoPlayer";

interface EditorShot {
  id: string;
  shotSeq?: number;
  sortOrder?: number;
  description?: string;
  visualPrompt?: string;
  durationSeconds?: number;
  shotSize?: string;
  cameraMovement?: string;
  dialogue?: string;
  videoStatus?: string;
  currentMaterialUrl?: string | null;
  thumbnailUrl?: string | null;
  metadata?: Record<string, any>;
}

/** 运镜存在 metadata.storyboardTable.cameraMovement（ShotRecord 无顶级 cameraMovement 字段，直接读 shot.cameraMovement 永远 undefined）。 */
function readCameraMovement(shot: EditorShot | undefined | null): string {
  if (!shot) return '';
  const v = shot.metadata?.storyboardTable?.cameraMovement;
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

export interface VideoEditorProps {
  shots: EditorShot[];
  completedShots: number;
  generatingShots: Set<string>;
  isReview: boolean;
  onRefresh: () => void;
  projectId: string;
  onExportFilm: () => void;
  exporting: boolean;
  exportProgress: number;
  exportStage: string;
  className?: string;
}

const VIDEO_STATUS_LABELS: Record<string, string> = {
  PENDING: "待生成",
  GENERATING: "生成中",
  COMPLETED: "已完成",
  FAILED: "失败",
};

const VIDEO_STATUS_COLORS: Record<string, string> = {
  PENDING: "text-[var(--text-3)] bg-[var(--bg-hover)] border-[var(--border-light)]",
  GENERATING: "text-[var(--action)] bg-[var(--action-dim)] border-[var(--action)]/20",
  COMPLETED: "text-[var(--success)] bg-[var(--success-dim)] border-[var(--success)]/20",
  FAILED: "text-[var(--error)] bg-[var(--error-dim)] border-[var(--error)]/20",
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getShotStatus(shot: EditorShot, generatingShots: Set<string>) {
  const status = generatingShots.has(shot.id) ? "GENERATING" : (shot.videoStatus || "PENDING");
  return {
    key: status,
    label: VIDEO_STATUS_LABELS[status] || status,
    classes: VIDEO_STATUS_COLORS[status] || VIDEO_STATUS_COLORS.PENDING,
  };
}

function splitEditorBlock(text?: string): string[] {
  if (!text || !text.trim()) return ["-"];
  return text.replace(/\r\n/g, "\n").split("\n");
}

function buildShotScript(shot: EditorShot, generatingShots: Set<string>, fallbackSeq: number): string[] {
  const status = getShotStatus(shot, generatingShots).label;
  const seq = shot.shotSeq ?? fallbackSeq;
  const cameraAngle = shot.metadata?.storyboardTable?.cameraAngle || shot.metadata?.cameraAngle || "-";

  return [
    `SHOT ${String(seq).padStart(2, "0")}`,
    `STATUS ${status}`,
    `DURATION ${formatDuration(shot.durationSeconds ?? 0)}`,
    `SHOT_SIZE ${shot.shotSize || "-"}`,
    `CAMERA_MOVE ${shot.cameraMovement || "-"}`,
    `CAMERA_ANGLE ${cameraAngle}`,
    "",
    "DESCRIPTION",
    ...splitEditorBlock(shot.description || shot.visualPrompt),
    "",
    "DIALOGUE",
    ...splitEditorBlock(shot.dialogue),
  ];
}

function renderEditorLine(line: string) {
  if (!line.trim()) {
    return <span className="select-none text-[var(--text-3)]/40">.</span>;
  }

  const keywordMatch = line.match(/^([A-Z_]+)(?:\s+(.*))?$/);
  if (keywordMatch) {
    const [, keyword, rest = ""] = keywordMatch;
    return (
      <>
        <span className="text-[var(--action)]">{keyword}</span>
        {rest ? <span className="text-[var(--text)]"> {rest}</span> : null}
      </>
    );
  }

  const quoteMatch = line.match(/^["'`].*["'`]$/);
  if (quoteMatch) {
    return <span className="text-[var(--success)]">{line}</span>;
  }

  return <span className="text-[var(--text-2)]">{line}</span>;
}

function EditorCodePanel({
  lines,
  title,
  summary,
}: {
  lines: string[];
  title: string;
  summary: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border-light)] bg-[#0f131b] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/5 bg-[#141922] px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-white">{title}</div>
          <div className="truncate text-[11px] text-white/45">{summary}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-full px-0 py-3 font-mono text-[12px] leading-6">
          {lines.map((line, index) => (
            <div
              key={`${index}-${line}`}
              className="grid grid-cols-[52px_minmax(0,1fr)] px-4 hover:bg-white/[0.03]"
            >
              <div className="select-none border-r border-white/5 pr-4 text-right text-white/28">
                {index + 1}
              </div>
              <div className="overflow-x-auto pl-4 whitespace-pre">
                {renderEditorLine(line)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function VideoEditor({
  shots,
  completedShots,
  generatingShots,
  isReview,
  onRefresh,
  projectId,
  onExportFilm,
  exporting,
  exportProgress,
  exportStage,
  className,
}: VideoEditorProps) {
  const sortedShots = React.useMemo(() => {
    return [...shots].sort((a, b) => {
      const sa = a.sortOrder ?? a.shotSeq ?? 0;
      const sb = b.sortOrder ?? b.shotSeq ?? 0;
      return sa - sb;
    });
  }, [shots]);

  const [selectedShotId, setSelectedShotId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (sortedShots.length === 0) {
      setSelectedShotId(null);
      return;
    }
    const stillExists = sortedShots.some((shot) => shot.id === selectedShotId);
    if (!stillExists) {
      const preferredShot = sortedShots.find((shot) => shot.videoStatus === "COMPLETED") || sortedShots[0];
      setSelectedShotId(preferredShot.id);
    }
  }, [selectedShotId, sortedShots]);

  const progress = shots.length > 0 ? Math.round((completedShots / shots.length) * 100) : 0;
  const totalDuration = React.useMemo(
    () => sortedShots.reduce((sum, shot) => sum + (shot.durationSeconds ?? 0), 0),
    [sortedShots],
  );
  const selectedShot = React.useMemo(
    () => sortedShots.find((shot) => shot.id === selectedShotId) || null,
    [selectedShotId, sortedShots],
  );

  const selectedIndex = selectedShot ? sortedShots.findIndex((shot) => shot.id === selectedShot.id) : -1;
  const selectedStatus = selectedShot ? getShotStatus(selectedShot, generatingShots) : null;
  const scriptLines = React.useMemo(
    () => selectedShot ? buildShotScript(selectedShot, generatingShots, selectedIndex + 1) : [],
    [generatingShots, selectedIndex, selectedShot],
  );

  const selectedPreviewUrl = selectedShot?.currentMaterialUrl || null;
  const selectedThumbUrl = selectedShot?.thumbnailUrl || null;

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg)] ${className ?? ""}`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-light)] bg-[var(--bg-elevated)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--accent)]/20 bg-[var(--accent-dim)] text-[var(--accent)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M23 7l-7 5 7 5V7zM1 5h15v14H1z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--text)]">编辑器工作台</div>
              <div className="truncate text-xs text-[var(--text-3)]">
                选择镜头后可播放视频，并通过播放器进度条拖动查看
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-xl border border-[var(--border-light)] bg-[var(--bg)] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-3)]">Progress</div>
            <div className="text-lg font-black text-[var(--accent)]" style={{ fontFamily: "var(--font-display)" }}>
              {progress}%
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-light)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-3)]">
            <span>{sortedShots.length} 镜头</span>
            <span>·</span>
            <span>{formatDuration(totalDuration)}</span>
            <span>·</span>
            <span className={completedShots === sortedShots.length && sortedShots.length > 0 ? "text-[var(--success)]" : ""}>
              {completedShots}/{sortedShots.length} 完成
            </span>
          </div>

          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M21 12a9 9 0 10-3.2 6.9M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            刷新
          </Button>
        </div>
      </div>

      {sortedShots.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <EmptyState
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                <path d="M23 7l-7 5 7 5V7zM1 5h15v14H1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="暂无镜头数据"
            description="请先在分镜设计阶段生成镜头序列，再进入编辑器工作台。"
            size="lg"
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[200px_minmax(0,1fr)_240px] xl:grid-cols-[240px_minmax(0,1fr)_300px] 2xl:grid-cols-[280px_minmax(0,1fr)_320px]">
          <aside className="flex min-h-0 flex-col border-b border-[var(--border-light)] bg-[var(--bg-elevated)] lg:border-b-0 lg:border-r">
            <div className="border-b border-[var(--border-light)] px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-3)]">Shot Explorer</div>
              <div className="mt-1 text-sm text-[var(--text)]">镜头导航</div>
            </div>
            <div className="min-h-[200px] flex-1 space-y-2 overflow-auto p-3">
              {sortedShots.map((shot, index) => {
                const status = getShotStatus(shot, generatingShots);
                const isSelected = shot.id === selectedShotId;
                const seq = shot.shotSeq ?? index + 1;
                return (
                  <button
                    key={shot.id}
                    type="button"
                    onClick={() => setSelectedShotId(shot.id)}
                    className={`w-full rounded-xl border p-3 text-left transition-all ${
                      isSelected
                        ? "border-[var(--action)] bg-[var(--action-dim)]/20 shadow-[0_0_0_1px_rgba(59,130,246,0.15)]"
                        : "border-[var(--border-light)] bg-[var(--bg)] hover:border-[var(--action)]/30 hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--accent)]/20 bg-[var(--accent-dim)]/50 font-mono text-sm font-bold text-[var(--accent)]">
                        {String(seq).padStart(2, "0")}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${status.classes}`}>
                            {status.label}
                          </span>
                          <span className="truncate text-[11px] text-[var(--text-3)]">
                            {formatDuration(shot.durationSeconds ?? 0)}
                          </span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--text-2)]">
                          {shot.description || shot.visualPrompt || "暂无镜头描述"}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-3)]">
                          <span>{shot.shotSize || "未标注景别"}</span>
                          <span>·</span>
                          <span>{readCameraMovement(shot) || "未标注运镜"}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="flex min-h-0 flex-col border-b border-[var(--border-light)] bg-[var(--bg)] lg:border-b-0 lg:border-r">
            <div className="border-b border-[var(--border-light)] px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-semibold text-[var(--text)]">
                  {selectedShot ? `镜头 ${String(selectedShot.shotSeq ?? selectedIndex + 1).padStart(2, "0")}` : "未选择镜头"}
                </div>
                {selectedStatus ? (
                  <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${selectedStatus.classes}`}>
                    {selectedStatus.label}
                  </span>
                ) : null}
                {selectedShot?.shotSize ? <span className="text-xs text-[var(--text-3)]">{selectedShot.shotSize}</span> : null}
                {readCameraMovement(selectedShot) ? <span className="text-xs text-[var(--text-3)]">· {readCameraMovement(selectedShot)}</span> : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 p-4">
              <div className="flex min-h-0 flex-col gap-4">
                <div className="overflow-hidden rounded-2xl border border-[var(--border-light)] bg-black shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
                  <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2.5">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/60">Preview</div>
                    <div className="text-[11px] text-white/45">
                      {selectedShot?.currentMaterialUrl ? "可拖动进度条预览" : "暂无可播放素材"}
                    </div>
                  </div>
                  <div className="relative flex min-h-[260px] items-center justify-center bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.18),transparent_42%),linear-gradient(180deg,#0d1117_0%,#05070b_100%)]">
                    {selectedPreviewUrl ? (
                      <VideoPlayer
                        src={selectedPreviewUrl}
                        poster={selectedThumbUrl}
                        hasPrevShot={selectedIndex > 0}
                        hasNextShot={selectedIndex >= 0 && selectedIndex < sortedShots.length - 1}
                        onPrevShot={
                          selectedIndex > 0
                            ? () => setSelectedShotId(sortedShots[selectedIndex - 1].id)
                            : undefined
                        }
                        onNextShot={
                          selectedIndex >= 0 && selectedIndex < sortedShots.length - 1
                            ? () => setSelectedShotId(sortedShots[selectedIndex + 1].id)
                            : undefined
                        }
                      />
                    ) : selectedThumbUrl ? (
                      <img
                        src={selectedThumbUrl}
                        alt={`镜头 ${selectedShot?.shotSeq ?? selectedIndex + 1}`}
                        className="max-h-[420px] w-full object-contain opacity-90"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-3 text-center">
                        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white/70">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                            <path d="M5 3l14 9-14 9V3z" fill="currentColor" />
                          </svg>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-white">当前镜头还没有可播放素材</div>
                          <div className="mt-1 text-xs text-white/55">
                            素材就绪后会在这里直接显示，并支持拖动播放器进度条查看。
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <EditorCodePanel
                  title={selectedShot ? `shot-${String(selectedShot.shotSeq ?? selectedIndex + 1).padStart(2, "0")}.prompt` : "shot.prompt"}
                  summary="行号与内容区域固定对齐，长行保留横向滚动，便于定位和检查镜头脚本。"
                  lines={scriptLines}
                />
              </div>
            </div>
          </main>

          <aside className="flex min-h-0 flex-col gap-4 overflow-auto border-b border-[var(--border-light)] bg-[var(--bg)] p-4 lg:border-b-0">
                <div className="rounded-2xl border border-[var(--border-light)] bg-[var(--bg-elevated)] p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-3)]">Inspector</div>
                      <div className="mt-1 text-sm text-[var(--text)]">镜头检查器</div>
                    </div>
                    <div className="rounded-lg border border-[var(--border-light)] bg-[var(--bg)] px-2 py-1 text-[11px] text-[var(--text-3)]">
                      {projectId}
                    </div>
                  </div>

                  {selectedShot ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-[var(--border-light)] bg-[var(--bg)] p-3">
                          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">Duration</div>
                          <div className="mt-1 text-sm font-semibold text-[var(--text)]">
                            {formatDuration(selectedShot.durationSeconds ?? 0)}
                          </div>
                        </div>
                        <div className="rounded-xl border border-[var(--border-light)] bg-[var(--bg)] p-3">
                          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">State</div>
                          <div className="mt-1 text-sm font-semibold text-[var(--text)]">{selectedStatus?.label || "待生成"}</div>
                        </div>
                      </div>

                      <div className="space-y-2 rounded-xl border border-[var(--border-light)] bg-[var(--bg)] p-3 text-xs">
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-[var(--text-3)]">景别</span>
                          <span className="text-right text-[var(--text)]">{selectedShot.shotSize || "-"}</span>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-[var(--text-3)]">运镜</span>
                          <span className="text-right text-[var(--text)]">{selectedShot.cameraMovement || "-"}</span>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-[var(--text-3)]">机位</span>
                          <span className="text-right text-[var(--text)]">
                            {selectedShot.metadata?.storyboardTable?.cameraAngle || selectedShot.metadata?.cameraAngle || "-"}
                          </span>
                        </div>
                      </div>

                      <div className="rounded-xl border border-[var(--border-light)] bg-[var(--bg)] p-3">
                        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">Notes</div>
                        <div className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-[var(--text-2)]">
                          {selectedShot.description || selectedShot.visualPrompt || "暂无镜头说明"}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
          </aside>

          <div className="flex items-center justify-between gap-4 border-t border-[var(--border-light)] bg-[var(--bg-elevated)] px-4 py-3 lg:col-span-3 lg:border-t">
            <div className="min-w-0 flex-1">
              <ProgressBar
                progress={progress}
                label={`整体进度：${completedShots}/${shots.length} 镜头完成`}
                variant="action"
                size="sm"
                completed={completedShots === shots.length && shots.length > 0}
              />
              {exporting ? (
                <div className="mt-2">
                  <ProgressBar
                    progress={exportProgress}
                    label={exportStage || "导出中"}
                    variant="accent"
                    size="sm"
                    pulse={exportProgress < 100}
                    completed={exportProgress >= 100}
                  />
                </div>
              ) : null}
            </div>

            <div className="flex flex-shrink-0 items-center gap-2">
              <Button
                variant="primary"
                onClick={onExportFilm}
                disabled={isReview || exporting || completedShots === 0}
                loading={exporting}
                progress={exporting ? exportProgress : undefined}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M12 3v12m0 0l-4-4m4 4l4-4M3 17v2a2 2 0 002 2h14a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {exporting ? "导出中..." : "导出成片"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
