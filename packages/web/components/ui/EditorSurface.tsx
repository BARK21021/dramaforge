/**
 * @file EditorSurface.tsx
 * @description 编辑器外壳 + 代码样式文本域（移植自 F:\app1\src\components\ui\EditorSurface.tsx）
 *
 * - EditorSurface：暗色编辑器外壳（标题/summary/meta + toolbar 插槽 + 子内容 +
 *   footer 插槽）。dark 模式自带 mac 风格的微抬升阴影。
 * - CodeTextarea：带行号槽的等宽文本域，与 EditorSurface 配合使用。行号槽
 *   跟随 textarea 滚动同步。
 *
 * 与 app1 差异：无（纯移植）。app1 本就将 EditorSurface 与 CodeTextarea 合并
 * 在同一文件；dramaforge 保持相同组织。所有 CSS 变量（--border-light / --bg-elevated /
 * --bg / --text / --text-3 / --action）dramaforge 均存在，且本组件未使用 Radix 或
 * lucide，无需替换。
 *
 * @example
 * <EditorSurface
 *   title="分镜 JSON"
 *   summary="可编辑的镜头表"
 *   toolbar={<Button size="sm">格式化</Button>}
 *   dark
 * >
 *   <CodeTextarea value={json} onChange={...} />
 * </EditorSurface>
 */
"use client";

import * as React from "react";
import { cn } from "./cn";

export interface EditorSurfaceProps {
  title: React.ReactNode;
  summary?: React.ReactNode;
  meta?: React.ReactNode;
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  dark?: boolean;
}

export function EditorSurface({
  title,
  summary,
  meta,
  toolbar,
  footer,
  children,
  className,
  contentClassName,
  dark = false,
}: EditorSurfaceProps) {
  const shellClassName = dark
    ? "border-[var(--border-light)] bg-[#0f131b] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    : "border-[var(--border-light)] bg-[var(--bg-elevated)]";
  const headerClassName = dark
    ? "border-white/5 bg-[#141922]"
    : "border-[var(--border-light)] bg-[var(--bg)]";
  const titleClassName = dark ? "text-white" : "text-[var(--text)]";
  const summaryClassName = dark ? "text-white/45" : "text-[var(--text-3)]";

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl border", shellClassName, className)}>
      <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3", headerClassName)}>
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-xs font-semibold uppercase tracking-[0.14em]", titleClassName)}>{title}</div>
          {summary ? <div className={cn("mt-1 truncate text-[11px]", summaryClassName)}>{summary}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {meta}
          {toolbar}
        </div>
      </div>
      <div className={cn("min-h-0 flex-1", contentClassName)}>{children}</div>
      {footer ? <div className={cn("border-t px-4 py-3", headerClassName)}>{footer}</div> : null}
    </div>
  );
}

export interface CodeTextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "children"> {
  value: string;
  lineClassName?: string;
  shellClassName?: string;
}

export const CodeTextarea = React.forwardRef<HTMLTextAreaElement, CodeTextareaProps>(
  ({ value, className, lineClassName, shellClassName, onScroll, ...props }, ref) => {
    const gutterRef = React.useRef<HTMLDivElement | null>(null);
    const lineCount = Math.max(1, value.replace(/\r\n/g, "\n").split("\n").length);

    const handleScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
      if (gutterRef.current) {
        gutterRef.current.scrollTop = event.currentTarget.scrollTop;
      }
      onScroll?.(event);
    };

    return (
      <div className={cn("grid min-h-0 grid-cols-[56px_minmax(0,1fr)]", shellClassName)}>
        <div
          ref={gutterRef}
          className="overflow-hidden border-r border-white/6 bg-black/10 px-3 py-3 text-right font-mono text-xs leading-6 text-white/28"
          aria-hidden="true"
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <div key={index} className={cn("select-none", lineClassName)}>
              {index + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={ref}
          value={value}
          onScroll={handleScroll}
          spellCheck={false}
          className={cn(
            "min-h-0 w-full resize-none border-0 bg-transparent px-4 py-3 font-mono text-sm leading-6 text-[var(--text)] outline-none placeholder:text-[var(--text-3)]",
            darkTextareaClassName,
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);
CodeTextarea.displayName = "CodeTextarea";

const darkTextareaClassName = "bg-transparent selection:bg-[var(--action)]/25";
