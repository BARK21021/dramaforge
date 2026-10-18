/**
 * @file ZoomViewer.tsx
 * @description 统一放大查看组件（移植自 F:\app1\src\components\ui\ZoomViewer.tsx）
 *
 * 支持 image / video / text 三种模式的全屏放大查看：
 * - image：滚轮缩放（0.5x-5x）+ 拖拽平移（scale>1 时）+ 双击切换 1x/2x
 * - video：内联播放（autoPlay + muted 适配浏览器策略）+ 下载按钮
 * - text：格式化展示（whitespace-pre-wrap），适合阅读长文本
 *
 * 通用能力：
 * - 同类型条目左右切换（items.length > 1 时显示 prev/next 按钮 + "3/12" 索引指示）
 * - 键盘快捷键：ESC（Radix 原生）/ ←→（切换）/ +-（图片缩放）/ 0（重置）
 * - 顶部标题栏 + 底部 meta 信息栏
 * - 基于 Radix Dialog（ESC 关闭、点击遮罩关闭、焦点陷阱、body 滚动锁）
 *
 * 与 app1 差异：无（纯移植）。@radix-ui/react-dialog + lucide-react 已引入，
 * cn 路径与 dramaforge 一致（./cn）。CSS 变量与 Tailwind 类名 100% 保留。
 *
 * @example
 * <ZoomViewer
 *   mode="image"
 *   items={assets.map(a => ({ id: a.id, title: a.name, src: a.imageUrl }))}
 *   index={0}
 *   open={open}
 *   onClose={() => setOpen(false)}
 *   onIndexChange={setIndex}
 * />
 */
"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { cn } from "./cn";

// ============================================================
// 类型定义
// ============================================================

export type ZoomMode = "image" | "video" | "text";

export interface ZoomMetaItem {
  label: string;
  value: string;
}

export interface ZoomItem {
  /** 唯一标识，用于 React key */
  id: string;
  /** 顶部标题栏显示的标题 */
  title: string;
  /** 顶部标题栏右侧的副标题/序号（如 "镜头 03/12"） */
  subtitle?: string;

  // —— image 模式必填 ——
  /** 图片 URL（业务侧负责拼装代理 URL + cache-buster） */
  src?: string;
  /** 图片 alt 文本 */
  alt?: string;

  // —— video 模式必填 ——
  /** 视频 URL */
  videoSrc?: string;
  /** 视频海报（可选，未播放时显示） */
  poster?: string;
  /** 是否显示下载按钮（默认 true） */
  downloadable?: boolean;

  // —— text 模式必填 ——
  /** 文本正文（保留 whitespace-pre-wrap） */
  content?: string;

  // —— 通用元数据（在底部信息面板展示，由业务侧自由填充） ——
  /** 结构化元数据，按"字段名 → 值"渲染为定义列表 */
  meta?: ZoomMetaItem[];
  /** 自定义底部信息渲染（覆盖 meta，用于复杂结构如资产富字段标签） */
  renderMeta?: () => React.ReactNode;
}

export interface ZoomViewerProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 当前模式 */
  mode: ZoomMode;
  /** 可浏览的条目列表（同类型）；单条时长度为 1，不显示左右切换按钮 */
  items: ZoomItem[];
  /** 当前条目索引（受控） */
  index: number;
  /** 索引变化回调（受控） */
  onIndexChange: (i: number) => void;
  /** 顶部标题栏文案（覆盖 items[index].title） */
  headerTitle?: string;
  /** 是否隐藏底部信息面板（默认 false） */
  hideMeta?: boolean;
  /** 是否禁用左右切换（默认 false；成片预览单条时设 true） */
  disableNavigation?: boolean;
}

// ============================================================
// 主组件
// ============================================================

export function ZoomViewer({
  open,
  onClose,
  mode,
  items,
  index,
  onIndexChange,
  headerTitle,
  hideMeta = false,
  disableNavigation = false,
}: ZoomViewerProps) {
  // 空 items 或索引越界时强制不打开
  const safeIndex = items.length === 0 ? 0 : Math.min(Math.max(0, index), items.length - 1);
  const currentItem = items[safeIndex];
  const effectivelyOpen = open && items.length > 0 && !!currentItem;
  const canNavigate = !disableNavigation && items.length > 1;

  const goPrev = React.useCallback(() => {
    if (!canNavigate) return;
    onIndexChange(safeIndex === 0 ? items.length - 1 : safeIndex - 1);
  }, [canNavigate, safeIndex, items.length, onIndexChange]);

  const goNext = React.useCallback(() => {
    if (!canNavigate) return;
    onIndexChange(safeIndex === items.length - 1 ? 0 : safeIndex + 1);
  }, [canNavigate, safeIndex, items.length, onIndexChange]);

  // 键盘事件：←→ 切换、+- 缩放、0 重置（仅 image 模式）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" && canNavigate && mode !== "text") {
      e.preventDefault();
      goPrev();
    } else if (e.key === "ArrowRight" && canNavigate && mode !== "text") {
      e.preventDefault();
      goNext();
    }
    // image 模式缩放由 ImagePanel 内部处理（通过 ref 暴露方法），这里不拦截 + - 0
    // 让 ImagePanel 自己监听
  };

  if (!effectivelyOpen) return null;

  const title = headerTitle || currentItem.title || "";

  return (
    <DialogPrimitive.Root open={effectivelyOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col focus:outline-none animate-fade-in"
          onKeyDown={handleKeyDown}
          aria-label={title}
        >
          {/* 顶部标题栏 */}
          <div className="flex-shrink-0 h-12 px-4 flex items-center justify-between bg-black/40 text-white">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <span className="text-sm font-medium truncate">{title}</span>
              {currentItem.subtitle && (
                <span className="text-xs text-white/50 flex-shrink-0">{currentItem.subtitle}</span>
              )}
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              {canNavigate && (
                <span className="text-xs text-white/50 tabular-nums">
                  {safeIndex + 1} / {items.length}
                </span>
              )}
              <DialogPrimitive.Close
                className="w-8 h-8 rounded-md flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="关闭"
              >
                <X size={18} />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* 中间内容区 */}
          <div className="flex-1 relative overflow-hidden flex items-center justify-center">
            {/* 左切换按钮 */}
            {canNavigate && (
              <button
                onClick={goPrev}
                className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors"
                aria-label="上一项"
              >
                <ChevronLeft size={22} />
              </button>
            )}

            {/* 内容面板（按 mode 分发） */}
            <div className="w-full h-full flex items-center justify-center overflow-hidden">
              {mode === "image" && (
                <ImagePanel key={currentItem.id} item={currentItem} />
              )}
              {mode === "video" && (
                <VideoPanel key={currentItem.id} item={currentItem} />
              )}
              {mode === "text" && (
                <TextPanel key={currentItem.id} item={currentItem} />
              )}
            </div>

            {/* 右切换按钮 */}
            {canNavigate && (
              <button
                onClick={goNext}
                className="absolute right-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors"
                aria-label="下一项"
              >
                <ChevronRight size={22} />
              </button>
            )}
          </div>

          {/* 底部信息栏 */}
          {!hideMeta && (currentItem.meta || currentItem.renderMeta) && (
            <div className="flex-shrink-0 max-h-[30vh] overflow-y-auto bg-black/40 text-white px-4 py-3">
              {currentItem.renderMeta ? (
                currentItem.renderMeta()
              ) : currentItem.meta && currentItem.meta.length > 0 ? (
                <dl className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
                  {currentItem.meta.map((m, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <dt className="text-white/50 flex-shrink-0 min-w-[5rem]">{m.label}</dt>
                      <dd className="text-white/90 break-words whitespace-pre-wrap flex-1">{m.value || "—"}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ============================================================
// ImagePanel - 图片放大面板（滚轮缩放 + 拖拽 + 双击）
// ============================================================

function ImagePanel({ item }: { item: ZoomItem }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(1);
  const [translate, setTranslate] = React.useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = React.useState(false);
  const dragStart = React.useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  // 切换 item 时重置缩放和平移
  React.useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, [item.id, item.src]);

  // 滚轮缩放（useEffect + 原生监听，避免 passive 限制）
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.0015;
      setScale((s) => {
        const next = Math.min(Math.max(s + delta * s, 0.5), 5);
        // 缩小到 1x 以下时重置平移
        if (next <= 1) setTranslate({ x: 0, y: 0 });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 拖拽平移（scale > 1 时启用；监听 window 事件避免鼠标移出丢失）
  React.useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setTranslate({ x: dragStart.current.tx + dx, y: dragStart.current.ty + dy });
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    e.preventDefault();
    dragStart.current = { x: e.clientX, y: e.clientY, tx: translate.x, ty: translate.y };
    setIsDragging(true);
  };

  const handleDoubleClick = () => {
    if (scale === 1) {
      setScale(2);
    } else {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
    }
  };

  // 键盘 + - 0 缩放（监听 window keydown，仅当图片面板挂载时）
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale((s) => Math.min(s + 0.5, 5));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setScale((s) => {
          const next = Math.max(s - 0.5, 0.5);
          if (next <= 1) setTranslate({ x: 0, y: 0 });
          return next;
        });
      } else if (e.key === "0") {
        e.preventDefault();
        setScale(1);
        setTranslate({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!item.src) {
    return (
      <div className="text-white/50 text-sm">无图片可显示</div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center overflow-hidden relative"
    >
      <img
        src={item.src}
        alt={item.alt || item.title}
        draggable={false}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
        className="max-w-full max-h-full object-contain select-none transition-transform duration-100"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          cursor: scale > 1 ? (isDragging ? "grabbing" : "grab") : "zoom-in",
        }}
      />
      {/* 右下角缩放控制按钮 */}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 bg-black/60 rounded-lg p-1 text-white">
        <button
          onClick={() => {
            setScale((s) => {
              const next = Math.max(s - 0.5, 0.5);
              if (next <= 1) setTranslate({ x: 0, y: 0 });
              return next;
            });
          }}
          className="w-8 h-8 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
          aria-label="缩小"
          title="缩小 (-)"
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-xs tabular-nums px-1 min-w-[3rem] text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale((s) => Math.min(s + 0.5, 5))}
          className="w-8 h-8 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
          aria-label="放大"
          title="放大 (+)"
        >
          <ZoomIn size={16} />
        </button>
        <button
          onClick={() => {
            setScale(1);
            setTranslate({ x: 0, y: 0 });
          }}
          className="w-8 h-8 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
          aria-label="重置"
          title="重置 (0)"
        >
          <Maximize size={16} />
        </button>
      </div>
    </div>
  );
}

// ============================================================
// VideoPanel - 视频放大面板（内联播放 + 下载）
// ============================================================

function VideoPanel({ item }: { item: ZoomItem }) {
  if (!item.videoSrc) {
    return <div className="text-white/50 text-sm">无视频可显示</div>;
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-center p-4">
      <video
        src={item.videoSrc}
        poster={item.poster}
        controls
        autoPlay
        muted
        playsInline
        className="max-w-full max-h-full object-contain bg-black rounded-lg"
      />
      {item.downloadable !== false && (
        <div className="mt-3 flex items-center gap-2">
          <a
            href={item.videoSrc}
            download
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs transition-colors"
          >
            <Download size={14} />
            下载视频
          </a>
        </div>
      )}
    </div>
  );
}

// ============================================================
// TextPanel - 文本放大面板（格式化展示 + 滚动阅读）
// ============================================================

function TextPanel({ item }: { item: ZoomItem }) {
  return (
    <div className="w-full h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 text-white">
        {item.title && (
          <h2 className="text-lg font-semibold mb-4 text-white/90">{item.title}</h2>
        )}
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-white/80">
          {item.content || "（无内容）"}
        </pre>
      </div>
    </div>
  );
}
