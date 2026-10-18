// ============================================================
// /api/auth/[...nextauth] — NextAuth v4 App Router 入口
// ============================================================
//
// 文件职责：
//   re-export NextAuth(authOptions) 的 GET/POST handler。authOptions 复用
//   ⑦ server/infra/auth 的配置（Credentials + JWT + 单设备登录），web 不
//   重新实现 auth。
//
// 设计要点：
//   - NextAuth v4 App Router 集成：`const handler = NextAuth(authOptions)`
//     然后 `export { handler as GET, handler as POST }`。
//   - authOptions 从 @dramaforge/server barrel 导入（ barrel 转发自 ⑦ infra）。
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import NextAuth from 'next-auth';
import { authOptions } from '@dramaforge/server';

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
