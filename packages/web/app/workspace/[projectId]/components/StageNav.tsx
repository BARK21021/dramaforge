"use client";

/**
 * @file StageNav.tsx — 分集阶段进度条（对齐 app1 EpisodeWorkspace 顶部阶段导航）
 *
 * 横排 5 阶段（输入 → 分析 → 资产 → 分镜 → 生产），点击切换 viewStage。
 * 三态：当前（action 蓝）/ 已过（success 绿勾）/ 未来（灰）。
 * 双色铁律：激活用 --action（行为），进度勾用 --success（完成态）。
 *
 * 阶段定义来自共享 `lib/stage-config.ts`（recon 批2 §3.1：避免 page↔workspace
 * 循环依赖，STAGES + 4 helper 集中管理）。
 */

import * as React from "react";
import { STAGES } from "../../../../lib/stage-config";

interface StageNavProps {
  /** 当前视图阶段 key */
  current: string;
  /** 切换阶段回调 */
  onNavigate: (key: string) => void;
}

export function StageNav({ current, onNavigate }: StageNavProps) {
  const currentIdx = STAGES.findIndex((s) => s.key === current);

  return (
    <div className="flex items-center gap-1 px-3 sm:px-4 py-2 border-y border-[var(--border-light)] bg-[var(--bg-elevated)] flex-shrink-0 overflow-x-auto no-scrollbar rounded-[var(--radius)]">
      {STAGES.map((stage, idx) => {
        const isActive = stage.key === current;
        const isPassed = idx < currentIdx;
        return (
          <React.Fragment key={stage.key}>
            <button
              type="button"
              onClick={() => onNavigate(stage.key)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all duration-200 flex-shrink-0 ${
                isActive
                  ? "bg-[var(--action-dim)] text-[var(--action)]"
                  : isPassed
                    ? "text-[var(--text-2)] hover:bg-[var(--bg-hover)] cursor-pointer"
                    : "text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] cursor-pointer"
              }`}
              title={`切换到${stage.label}`}
            >
              <span
                className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  isActive
                    ? "bg-[var(--action)] text-white"
                    : isPassed
                      ? "bg-[var(--success-dim)] text-[var(--success)]"
                      : "bg-[var(--bg-hover)] text-[var(--text-3)]"
                }`}
              >
                {isPassed ? (
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8l3.5 3.5L13 5"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  idx + 1
                )}
              </span>
              <span>{stage.label}</span>
            </button>
            {idx < STAGES.length - 1 && (
              <div
                className={`flex-shrink-0 w-4 h-px ${isPassed ? "bg-[var(--success)]/40" : "bg-[var(--border-light)]"}`}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
