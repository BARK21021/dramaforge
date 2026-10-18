/**
 * @file AppSidebar.tsx — 应用持久侧边栏（对齐 app1 src/components/layout/AppSidebar.tsx）
 *
 * 在 AppShell 模式下渲染于内容区左侧。dramaforge 版（对齐 app1 全功能）：
 *   - 顶部 Logo（点击跳 /workspace）
 *   - 主导航全 5 项：工作区 / 成片库 / 镜头组 / 设置 / 用户管理（adminOnly）
 *   - 底部：退出账户 + CreditsBadge
 *   - 桌面端 w-60 固定；移动端 (<768px) drawer 抽屉式（默认收起 + 汉堡按钮 + 遮罩）
 *
 * useSession 三态门：会话 loading 时隐藏 admin 项防闪烁；
 *   session.user.role === "ADMIN" 才渲染「用户管理」。
 *
 * 双色方案（globals.css 铁律）：
 *   - 激活/hover = --action 蓝（可点击行为）
 *   - 激活左条 = --accent 琥珀（身份/位置标识）
 *
 * icon 全部用 lucide-react（批0 已装），不再内联 SVG path。
 */

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  LayoutGrid,
  Film,
  Layers,
  Settings,
  Users,
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../ui/cn";
import { CreditsBadge } from "../ui/CreditsBadge";

/** 侧边栏导航项定义 */
interface NavItem {
  /** 路由地址 */
  href: string;
  /** 显示文字 */
  label: string;
  /** lucide-react 图标组件 */
  icon: LucideIcon;
  /** 是否为当前激活态（基于 pathname 匹配） */
  match: (pathname: string) => boolean;
  /** 仅管理员可见（session.user.role === "ADMIN" 时才渲染） */
  adminOnly?: boolean;
}

/** 导航项列表（对齐 app1 NAV_ITEMS） */
const NAV_ITEMS: NavItem[] = [
  {
    href: "/workspace",
    label: "工作区",
    icon: LayoutGrid,
    match: (p) => p === "/workspace" || p.startsWith("/workspace/"),
  },
  {
    href: "/films",
    label: "成片库",
    icon: Film,
    match: (p) => p === "/films" || p.startsWith("/films/"),
  },
  {
    href: "/groups",
    label: "镜头组",
    icon: Layers,
    match: (p) => p === "/groups" || p.startsWith("/groups/"),
  },
  {
    href: "/settings",
    label: "设置",
    icon: Settings,
    match: (p) => p === "/settings" || p.startsWith("/settings/"),
  },
  {
    href: "/admin/users",
    label: "用户管理",
    icon: Users,
    match: (p) => p === "/admin/users" || p.startsWith("/admin/users"),
    adminOnly: true,
  },
];

/**
 * 应用侧边栏
 *
 * 桌面端固定宽度展开；移动端抽屉式（默认收起，汉堡按钮触发）。
 */
export function AppSidebar() {
  const pathname = usePathname() || "";

  // useSession 三态门：loading 时隐藏 admin 项，避免非管理员看到闪烁
  const { data: session, status } = useSession();
  // 仅当 session 明确返回 role === "ADMIN" 时才显示 admin 项
  const isAdmin = status === "authenticated" && session?.user?.role === "ADMIN";

  /** 移动端是否展开（默认折叠） */
  const [mobileOpen, setMobileOpen] = React.useState(false);
  /** 是否为窄屏（< 768px） */
  const [isMobile, setIsMobile] = React.useState(false);

  // 响应式断点检测
  React.useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // 移动端展开时点击导航项后自动收起
  const handleNavClick = () => {
    if (isMobile) setMobileOpen(false);
  };

  // 移动端遮罩点击关闭
  const handleOverlayClick = () => setMobileOpen(false);

  return (
    <>
      {/* 移动端顶部汉堡按钮（仅窄屏可见） */}
      {isMobile && (
        <button
          onClick={() => setMobileOpen((o) => !o)}
          className="fixed top-2 left-2 z-50 w-9 h-9 rounded-md flex items-center justify-center bg-[var(--bg-elevated)] border border-[var(--border-light)] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
          aria-label={mobileOpen ? "关闭菜单" : "打开菜单"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? (
            <X size={18} strokeWidth={2} />
          ) : (
            <Menu size={18} strokeWidth={2} />
          )}
        </button>
      )}

      {/* 移动端遮罩 */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={handleOverlayClick}
          aria-hidden="true"
        />
      )}

      {/* 侧边栏主体 */}
      <aside
        className={cn(
          "flex flex-col bg-[var(--bg-elevated)] border-r border-[var(--border-light)] flex-shrink-0 z-40",
          // 桌面端：固定宽度展开
          // 移动端：抽屉式，从左侧滑入
          isMobile
            ? cn(
                "fixed top-0 bottom-0 left-0 w-60 transition-transform duration-200",
                mobileOpen ? "translate-x-0" : "-translate-x-full",
              )
            : "w-60",
        )}
      >
        {/* Logo 区 */}
        <div className="h-12 flex items-center gap-3 px-4 border-b border-[var(--border-light)] flex-shrink-0">
          <Link
            href="/workspace"
            onClick={handleNavClick}
            className="flex items-center gap-3 group"
            aria-label="DramaForge Studio 工作区"
          >
            <img
              src="/dramaforge-logo.png"
              alt="DramaForge Studio"
              className="w-8 h-8 rounded-lg object-cover transition-transform group-hover:scale-105 flex-shrink-0"
            />
            <span className="font-bold tracking-tight text-[var(--text)] text-base whitespace-nowrap">
              DramaForge Studio
            </span>
          </Link>
        </div>

        {/* 导航列表 */}
        <nav className="flex-1 overflow-y-auto py-3 px-2" aria-label="侧边导航">
          <ul className="space-y-1">
            {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => {
              const active = item.match(pathname);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={handleNavClick}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors relative group",
                      active
                        ? "bg-[var(--action-dim)] text-[var(--text)] font-medium"
                        : "text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]",
                    )}
                    title={item.label}
                  >
                    {/* 激活态左侧琥珀条（身份/位置标识） */}
                    {active && (
                      <span
                        className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full bg-[var(--accent)]"
                        aria-hidden="true"
                      />
                    )}
                    {/* 图标（lucide-react） */}
                    <Icon
                      size={18}
                      strokeWidth={2}
                      className={cn(
                        "flex-shrink-0",
                        active
                          ? "text-[var(--action)]"
                          : "text-[var(--text-3)] group-hover:text-[var(--text-2)]",
                      )}
                    />
                    {/* 文字 */}
                    <span className="whitespace-nowrap">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* 底部：退出账户 + 积分徽标 */}
        <div className="p-3 border-t border-[var(--border-light)] flex-shrink-0 space-y-2">
          <button
            onClick={() => void signOut({ callbackUrl: "/auth/signin", redirect: true })}
            className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]"
            title="退出账户"
          >
            <LogOut
              size={18}
              strokeWidth={2}
              className="flex-shrink-0 text-[var(--text-3)]"
            />
            <span className="whitespace-nowrap">退出账户</span>
          </button>
          <CreditsBadge size="sm" />
        </div>
      </aside>
    </>
  );
}
