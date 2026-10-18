/**
 * @file next-auth.d.ts — NextAuth 类型扩展（模块增强）
 *
 * 向 Session.user / User / JWT 新增 role 字段，使前端可通过 useSession() 获取
 * 用户角色（FREE/VIP/ADMIN），用于 UI 层的角色区分（如 AppSidebar 仅管理员可见项）。
 *
 * 采用 next-auth v4 官方推荐的模块增强模式：通过 DefaultSession["user"] 交叉类型
 * 保留默认的 name/email/image 字段，同时新增 role。
 *
 * 注意：role 为非敏感信息（仅用于 UI 显示控制），放 JWT 中可接受。
 *       后端 API 鉴权仍以 DB 查询为准。
 */

import "next-auth";
import type { DefaultSession } from "next-auth";

/**
 * 用户角色枚举（M8 — 从裸 string 收紧为联合类型）。
 *
 * 对齐 server/infra/migrations/0001-init.sql 的 users.role 注释
 * `FREE/VIP/ADMIN`，以及 server/infra/user.ts 默认值 'FREE'。
 * 后端写入点（infra/auth.ts 的 jwt/session callbacks）不感知本联合——它
 * 跑在 server 包（无 next-auth.d.ts 增强），类型层面仍是 string；本声明
 * 只影响 web 侧 useSession() 的消费类型，所以前端比较 `role === 'ADMIN'`
 * 等获得字面量收窄 + 拼写错误编译期暴露。
 */
export type UserRole = "FREE" | "VIP" | "ADMIN";

declare module "next-auth" {
  // 重定义 Session.user，新增 role，保留默认字段
  interface Session {
    user: {
      role?: UserRole;
    } & DefaultSession["user"];
  }

  // 向 User 接口新增 role，authorize 返回的 user 对象可携带 role
  interface User {
    role?: UserRole;
  }
}

declare module "next-auth/jwt" {
  // 向 JWT 接口新增 role，jwt callback 可写入、session callback 可读取
  interface JWT {
    role?: UserRole;
  }
}
