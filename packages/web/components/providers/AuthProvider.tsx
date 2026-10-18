/**
 * @file AuthProvider.tsx
 * @description 认证提供者组件
 * 
 * 该组件是 NextAuth 认证系统的包装器，用于在整个应用中提供认证上下文。
 * 它必须在应用的最外层使用，确保所有子组件都能访问认证状态。
 * 
 * 核心功能：
 * - 封装 NextAuth 的 SessionProvider
 * - 为应用提供全局的认证状态管理
 * - 支持客户端组件使用认证相关的 hooks
 */

"use client";

import { SessionProvider } from "next-auth/react";
import SessionGuard from "./SessionGuard";

/**
 * AuthProvider 组件属性
 */
interface AuthProviderProps {
  /** 子组件，将被 SessionProvider 包裹 */
  children: React.ReactNode;
}

/**
 * 认证提供者组件
 * 
 * 封装 NextAuth 的 SessionProvider，为整个应用提供认证上下文。
 * 所有需要使用认证状态（如 useSession）的组件都必须在此组件内部。
 * 
 * @param props - 组件属性
 * @param props.children - 子组件
 * @returns 包裹了 SessionProvider 的子组件
 * 
 * @example
 * ```tsx
 * // 在 layout.tsx 中使用
 * <AuthProvider>
 *   <YourApp />
 * </AuthProvider>
 * ```
 */
export default function AuthProvider({ children }: AuthProviderProps) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      <SessionGuard />
      {children}
    </SessionProvider>
  );
}
