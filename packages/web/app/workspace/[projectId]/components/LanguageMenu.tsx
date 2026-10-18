"use client";

/**
 * @file LanguageMenu.tsx
 * @description 可搜索的目标语言菜单（海外转绘「文本转风格」用）
 *
 * 替换原自由文本框：触发按钮 → popover（顶部搜索 + 按区域分组的语言按钮网格）。
 * 选中语言后由父组件（InputStage）把结构化串写入 stylePrompt，供后端 parseTargetLanguage 解析。
 *
 * 双色方案：选中项用 --action-dim（可点击行为），区域小标题用 --text-3。
 *
 * 来源：1:1 镜像 app1 `F:\app1\src\app\workspace\[projectId]\components\LanguageMenu.tsx`。
 * import 调整：
 *   - app1 `@/core/ai/target-languages` → dramaforge `@dramaforge/server`（批3 barrel re-export）
 *   - app1 `@/components/ui/cn` → dramaforge `../../../../components/ui/cn`（已存在）
 */

import * as React from "react";
// 客户端组件不能 import 主 barrel（@dramaforge/server 顶层会拉 bullmq/pg/minio 等
// node:* 模块进 client bundle，build 失败）。改走 prompt 子路径（纯函数 + 常量，
// 零 node 依赖；server package.json exports 已暴露 ./prompt）。
import {
  TARGET_LANGUAGES,
  type TargetLanguage,
} from "@dramaforge/server/prompt";
import { cn } from "../../../../components/ui/cn";

interface LanguageMenuProps {
  value: TargetLanguage | null;
  onChange: (lang: TargetLanguage) => void;
  disabled?: boolean;
}

/** 按区域分组的可搜索目标语言菜单。 */
export function LanguageMenu({ value, onChange, disabled }: LanguageMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);

  // 点击外部 / Esc 关闭
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? TARGET_LANGUAGES.filter(
        (l) =>
          l.zh.includes(q.trim()) ||
          l.native.includes(q.trim()) ||
          l.en.toLowerCase().includes(ql) ||
          l.code === ql,
      )
    : TARGET_LANGUAGES;

  // 按区域分组（保持 TARGET_LANGUAGES 内的区域顺序）
  const groups = filtered.reduce<Record<string, TargetLanguage[]>>((acc, l) => {
    (acc[l.region] ||= []).push(l);
    return acc;
  }, {});

  const pick = (l: TargetLanguage) => {
    onChange(l);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition-colors",
          "border-[var(--border-light)] bg-[var(--bg-elevated)] text-[var(--text)]",
          "hover:border-[var(--action)]/50",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        <span className={value ? "text-[var(--text)]" : "text-[var(--text-3)]"}>
          {value ? `${value.native} · ${value.zh}` : "选择目标语言"}
        </span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-[var(--text-3)]">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-72 max-h-80 flex flex-col rounded-lg border border-[var(--border-light)] bg-[var(--bg-elevated)] shadow-lg">
          <div className="p-2 border-b border-[var(--border-light)]">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索 语言 / native / english"
              className="w-full px-2 py-1.5 rounded-md bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] outline-none focus:border-[var(--action)]"
            />
          </div>
          <div className="overflow-y-auto p-1">
            {Object.keys(groups).length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-[var(--text-3)]">无匹配语言</div>
            )}
            {Object.entries(groups).map(([region, langs]) => (
              <div key={region} className="mb-1">
                <div className="px-2 py-1 text-[10px] font-medium text-[var(--text-3)]">{region}</div>
                <div className="grid grid-cols-2 gap-1">
                  {langs.map((l) => {
                    const active = value?.code === l.code;
                    return (
                      <button
                        key={l.code}
                        type="button"
                        onClick={() => pick(l)}
                        className={cn(
                          "text-left px-2 py-1.5 rounded-md text-xs transition-colors",
                          active
                            ? "bg-[var(--action-dim)] text-[var(--text)]"
                            : "text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
                        )}
                      >
                        <div className="font-medium">{l.native}</div>
                        <div className="text-[10px] text-[var(--text-3)]">{l.zh}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
