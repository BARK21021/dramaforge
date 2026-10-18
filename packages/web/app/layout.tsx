/**
 * @file layout.tsx
 * @description 应用根布局组件
 *
 * 该文件定义了整个应用的根布局，是所有页面的最外层包装器。
 *
 * 核心功能：
 * - 设置页面元数据（标题、描述）
 * - 包裹 AuthProvider（提供认证上下文，最外层）
 * - 包裹 ToastProvider（提供通知功能）
 * - 包裹 RechargeProvider（全局充值弹窗，对齐 app1 4 层 Provider 嵌套）
 * - 设置全局样式和基础布局结构
 *
 * 注意：
 * - 这是 Next.js App Router 的根布局，所有页面都会渲染在此布局内
 * - 必须包含 <html> 和 <body> 标签
 * - layout.tsx 本身为 Server Component；AuthProvider/ToastProvider 自身是
 *   "use client" 客户端组件，在此处被服务端渲染是标准模式。
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import AuthProvider from "../components/providers/AuthProvider";
import { ToastProvider } from "../components/ui/Toast";
import { RechargeProvider } from "../components/ui/RechargeProvider";
import { AppShell } from "../components/layout/AppShell";

/**
 * 页面元数据配置
 * 用于 SEO 和浏览器标签显示
 */
export const metadata: Metadata = {
  title: "DramaForge AI 视频创作平台",
  description: "面向出海场景的 AI 视频创作与风格化生产平台",
};

/**
 * 根布局组件属性
 */
interface RootLayoutProps {
  /** 子组件（页面内容） */
  children: ReactNode;
}

/**
 * 根布局组件
 *
 * 渲染 <html> / <body>，并在 body 内嵌套：
 *   AuthProvider > ToastProvider > RechargeProvider > AppShell > {children}
 * 暗色主题通过 globals.css 的 :root 默认生效，<html> 不需要任何 className。
 *
 * Provider 嵌套顺序（对齐 app1 4 层）：
 *   - AuthProvider 最外：所有内部组件都可能读 session
 *   - ToastProvider：业务组件弹通知
 *   - RechargeProvider：业务组件触发 showRecharge（内部 PlatformRechargeModal
 *     自身要用 Toast，故 Toast 在其外层）
 */
export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthProvider>
          <ToastProvider>
            <RechargeProvider>
              <AppShell>{children}</AppShell>
            </RechargeProvider>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
