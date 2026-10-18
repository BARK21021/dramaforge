"use client";

/**
 * @file VideoPlayer.tsx
 * @description 自定义视频播放器（帧界/剪映风格），用于生产「编辑器视图」预览区。
 *
 * 替换原生 `<video controls>`：隐藏浏览器控件（含 Chrome 的 ⋮ 菜单），自绘
 *   - 可拖进度条（click + drag seek，pointer capture）
 *   - 上一镜 / 下一镜 段导航
 *   - 蓝色实心播放/暂停钮（全控件最显眼）
 *   - `cur / dur` 时间码
 *
 * 底层仍是一个标准 `<video>` 元素（src 通常是 Electron 的 sf-asset:// 本地协议，
 * 见 VideoEditor.tsx 头注释），只是 controls=false、事件全自接管。
 *
 * 设计 token：var(--action)=主蓝（播放钮/已播段）、--bg-elevated 系暗色。组件自包含，
 * 不引外部 cn/图标库，对齐 VideoEditor.tsx 的写法（模板字符串 className + 内联 SVG）。
 */

import * as React from "react";

/** 秒 → `m:ss` / `h:mm:ss`。NaN/负数兜底 `0:00`。 */
function formatTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00";
  const total = Math.floor(t);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface VideoPlayerProps {
  /** 视频源（通常 sf-asset://）。 */
  src: string;
  /** 首帧前显示的海报（镜头缩略图）。 */
  poster?: string | null;
  /** 上一镜回调；不传则按钮禁用。 */
  onPrevShot?: () => void;
  /** 下一镜回调；不传则按钮禁用。 */
  onNextShot?: () => void;
  /** 是否存在上一镜（false → 禁用）。 */
  hasPrevShot?: boolean;
  /** 是否存在下一镜（false → 禁用）。 */
  hasNextShot?: boolean;
  className?: string;
}

export function VideoPlayer({
  src,
  poster,
  onPrevShot,
  onNextShot,
  hasPrevShot,
  hasNextShot,
  className,
}: VideoPlayerProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const draggingRef = React.useRef(false);

  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [paused, setPaused] = React.useState(true);
  const [buffered, setBuffered] = React.useState(0);

  // src 切换（换镜头）→ 重置本地状态，随后由 video 事件刷新真实值。
  React.useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setPaused(true);
  }, [src]);

  const togglePlay = React.useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const seekToFraction = React.useCallback((frac: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const t = Math.min(1, Math.max(0, frac)) * v.duration;
    v.currentTime = t;
    setCurrentTime(t);
  }, []);

  const fracFromEvent = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture 偶发抛错，忽略即可 */
    }
    seekToFraction(fracFromEvent(e.clientX));
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    seekToFraction(fracFromEvent(e.clientX));
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 同上 */
    }
  };

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufPct = duration > 0 ? (buffered / duration) * 100 : 0;
  const prevDisabled = !hasPrevShot || !onPrevShot;
  const nextDisabled = !hasNextShot || !onNextShot;

  return (
    <div className={`flex w-full flex-col ${className ?? ""}`}>
      {/* 画面：点击切换播放/暂停；不渲染原生 controls（避免 Chrome 的 ⋮ 菜单） */}
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        playsInline
        onClick={togglePlay}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={() => setPaused(true)}
        onProgress={(e) => {
          const v = e.currentTarget;
          if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
        }}
        className="max-h-[420px] w-full cursor-pointer bg-black object-contain"
      />

      {/* 控制条：深色 #0E0E13，上方可拖进度条 + 下方按钮行 */}
      <div className="flex flex-col gap-2 bg-[#0E0E13] px-3 py-2.5">
        {/* 可拖进度条（scrubber） */}
        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="group relative flex h-4 cursor-pointer items-center touch-none"
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/15">
            {/* 已缓冲 */}
            <div
              className="absolute inset-y-0 left-0 bg-white/20"
              style={{ width: `${bufPct}%` }}
            />
            {/* 已播放 */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[var(--action)]"
              style={{ width: `${pct}%` }}
            />
          </div>
          {/* 拖动头（hover/拖动时显现） */}
          <div
            className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
            style={{ left: `${pct}%` }}
          />
        </div>

        {/* 按钮行：上一镜 | 播放/暂停（蓝实心圆）| 下一镜 … 时间码 */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onPrevShot}
            disabled={prevDisabled}
            aria-label="上一镜"
            className="flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 5v14M20 5l-9 7 9 7V5z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* 主播放/暂停钮：蓝色实心圆（参考 #2563EB ≈ var(--action)） */}
          <button
            type="button"
            onClick={togglePlay}
            aria-label={paused ? "播放" : "暂停"}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--action)] text-white shadow-[0_4px_14px_rgba(0,0,0,0.35)] transition-transform hover:scale-105"
          >
            {paused ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 4l14 8-14 8V4z" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            )}
          </button>

          <button
            type="button"
            onClick={onNextShot}
            disabled={nextDisabled}
            aria-label="下一镜"
            className="flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M17 5v14M4 5l9 7-9 7V4z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* 时间码：当前(白) / 总时长(灰) */}
          <span className="ml-auto select-none font-mono text-xs tabular-nums">
            <span className="text-white">{formatTime(currentTime)}</span>
            <span className="text-white/45"> / {formatTime(duration)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
