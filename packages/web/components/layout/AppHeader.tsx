/**
 * @file AppHeader.tsx
 * @description 共享顶部导航栏组件
 *
 * 消除 4 个页面（landing/workspace/settings/project）中重复的 header 代码。
 * 通过 slot 模式支持左右两侧自定义内容。
 *
 * 设计规范：
 * - 桌面端高度 56px (h-14)，移动端自适应
 * - 暗色毛玻璃背景 + 底部分隔线
 * - Logo 统一使用 /dramaforge-logo.png + DramaForge Studio 文字
 *
 * @example
 * // 简单用法（仅 Logo + 右侧）
 * <AppHeader right={<Button>登录</Button>} />
 *
 * // 带左侧返回按钮
 * <AppHeader left={<BackButton />} right={<UserMenu />} />
 *
 * // 可点击 Logo 跳转
 * <AppHeader logoHref="/workspace" right={...} />
 */
"use client";

import Link from "next/link";
import * as React from "react";
import { cn } from "../ui/cn";

export interface AppHeaderProps {
  /** 左侧内容（默认渲染 Logo）。传 null 可隐藏 Logo */
  left?: React.ReactNode;
  /** 右侧操作区（按钮、链接等） */
  right?: React.ReactNode;
  /** Logo 点击跳转地址，默认 "/"。仅当未传 left 时生效 */
  logoHref?: string;
  /** 是否使用毛玻璃 + 边框样式（内部页面用 true，落地页用 false） */
  bordered?: boolean;
  /** 透传类名 */
  className?: string;
}

/**
 * 顶部导航栏 Logo
 */
function HeaderLogo({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 group"
            aria-label="DramaForge Studio 首页"
    >
      <img
              src="/dramaforge-logo.png"
              alt="DramaForge Studio"
        className="w-10 h-10 rounded-xl object-cover transition-transform group-hover:scale-105"
      />
            <span className="font-bold tracking-tight text-[var(--text)] text-lg">DramaForge Studio</span>
    </Link>
  );
}

/**
 * 共享顶部导航栏
 *
 * 注意：在 AppShell 模式下（工作区/设置），Logo 已移至侧栏，
 * 调用方应传 left={null} 或自定义左侧内容，避免 Logo 重复。
 * 落地页/登录页未使用 AppShell，仍可使用默认 Logo。
 */
export function AppHeader({
  left,
  right,
  logoHref = "/",
  bordered = true,
  className,
}: AppHeaderProps) {
  return (
    <header
      className={cn(
        "h-12 flex items-center justify-between px-3 sm:px-6 3xl:px-8 flex-shrink-0",
        bordered
          ? "border-b border-[var(--border-light)] bg-[var(--bg-elevated)]"
          : "relative z-10",
        className,
      )}
    >
          <nav className="flex items-center gap-2 sm:gap-3 min-w-0" aria-label="主导航">
        {left === undefined ? <HeaderLogo href={logoHref} /> : left}
      </nav>
      {right && (
        <div className="flex items-center gap-1.5 sm:gap-2.5 3xl:gap-3 flex-shrink-0">
          {right}
        </div>
      )}
    </header>
  );
}
