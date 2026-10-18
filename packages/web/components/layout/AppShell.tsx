/**
 * @file AppShell.tsx — 应用骨架布局（对齐 app1 src/components/layout/AppShell.tsx）
 *
 * dramaforge 根 layout 原本直接渲染 children，登录后无左侧 sidebar。
 * 本组件按路由决定布局（对齐 app1 双分支策略）：
 *   - 落地页 / 登录 (/) 与 /auth/*：全屏沉浸（无 sidebar）
 *   - 其他（/workspace* / /films* / /groups* / /settings* / /admin/* / 客户端回调）：
 *     sidebar 模式（h-screen flex + 左 AppSidebar + 右内容区独立滚动）
 *
 * 为什么用 isAuthPage（黑名单 auth 即 sidebar）而非 isAppPage 白名单：
 *   app1 用黑名单策略——凡是非 auth 页都套 sidebar。这样新增功能页（如 /films /groups
 *   /admin/users）自动获得 sidebar，不必每次改白名单。dramaforge 跟齐。
 *
 * 避免在 /auth/* 套 sidebar 的硬约束：
 *   登录页若被 sidebar 包裹，CreditsBadge 会请求 /api/user/balance 拿 401 后
 *   又跳回登录页，形成无限重定向。auth 页必须全屏无 sidebar。
 *
 * 内容区用 overflow-y-auto（而非 app1 的 overflow-hidden + 内部 flex scroll），
 * 兼容 dramaforge 现有 app 页面的 min-h-screen 整页滚动模式，零破坏。
 */

"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "./AppSidebar";
// ⚠ GlobalGenerationStatus 临时移除（2026-07-21 P0 导航修复）：
// 其内部 useSSE()→useSyncExternalStore 订阅「模块级全局单例 store」，在
// Next16/React19 下会打断 client-side 路由 commit——sidebar 模式下所有 <Link>
// 点击都发 RSC flight 请求（200 合法数据）但 URL/页面永不切换（auth 分支无此
// 组件故导航正常）。移除后全局 client 导航恢复。根因（useSyncExternalStore 单例
// 与 App Router layout 段缓存冲突）待专项修复后，以「不在 layout 顶层订阅」或
// 重构 SSE hook 的方式恢复该状态条。
// import { GlobalGenerationStatus } from "../features/GenerationProgress";

/**
 * 判断是否为认证/落地页（不使用 AppShell）
 *
 * 匹配 / 与 /auth/* 前缀。
 */
function isAuthPage(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname === "/auth/signin" || pathname.startsWith("/auth/signin")) return true;
  if (pathname === "/auth/signup" || pathname.startsWith("/auth/signup")) return true;
  // 兜底：所有 /auth/* 都视为认证页（避免新增 auth 子路由漏配）
  if (pathname.startsWith("/auth/")) return true;
  return false;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const authPage = isAuthPage(pathname ?? "");

  if (authPage) {
    // 落地页 / 登录 / 注册：全屏沉浸布局（无 sidebar，避免 CreditsBadge 401 死循环）
    return <div className="min-h-screen flex flex-col">{children}</div>;
  }

  // 工作区 / 设置 / 成片库 / 镜头组 / admin / 客户端回调：sidebar 模式
  return (
    <div className="h-screen flex overflow-hidden bg-[var(--bg)]">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {/* GlobalGenerationStatus 临时移除（见文件顶部注释：P0 导航修复） */}
        <div className="flex-1 overflow-y-auto min-w-0">{children}</div>
      </div>
    </div>
  );
}
