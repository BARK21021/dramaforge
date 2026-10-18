// ============================================================
// NextAuth 配置 - Credentials + JWT + 单设备登录
// ============================================================
//
// 文件职责：
//   导出 authOptions，供 /api/auth/[...nextauth] re-export 使用。
//   - CredentialsProvider：邮箱/手机号 + 密码登录，bcrypt 校验
//   - JWT 策略：无状态会话，JWT 存 cookie
//   - 可撤销会话：登录成功生成 activeSessionStamp 写入 DB；session callback
//     每次解析 JWT 时与 DB 比对，其他设备登录或改密后旧会话立即失效
//
// 移植自 app1 src/core/api/auth.ts 的 authOptions，改造点：
//   - Prisma 调用 → 原生 pg query（dramaforge-cs 无 Prisma）
//   - uuid → @shared/utils genId（复用已装契约）
//   - 剔除 requireAuth/apiSuccess/apiError 等 API 层工具（归属 web 模块）
//   - phone 规范化简化为内联函数（避免引入 app1 sms 服务依赖）
// ============================================================

import { type NextAuthOptions } from 'next-auth';
import _CredentialsProvider from 'next-auth/providers/credentials';

// next-auth v4 的 provider 是 CJS 经 esModule 互操作编译。esbuild ESM bundle +
// packages:'external' 下，`import X from 'next-auth/providers/credentials'` 在 Node 运行
// 时拿到的是 { default: fn } 而非 fn 本身（实测 raw.default 才是函数）→ 直接当函数调用
// 报 "CredentialsProvider is not a function"（曾致 ai-worker 启动 crash）。Next.js(Turbopack)
// 路径则直接给 fn。故运行时按 typeof 判定取值；类型侧用 `as typeof _CredentialsProvider`
// 保留 next-auth 原始类型——否则 CredentialsProvider 退化成 any，authorize(credentials)
// 丢失类型推断，next build 在 noImplicitAny 下报 "Parameter 'credentials' implicitly has
// an 'any' type"（本地 esbuild 是 transpile-only 不查类型，故只在 next build 暴露）。
const CredentialsProvider = (
  typeof _CredentialsProvider === 'function'
    ? _CredentialsProvider
    : (_CredentialsProvider as any).default
) as typeof _CredentialsProvider;
import bcrypt from 'bcryptjs';
import { genId } from '@shared/utils';
import { query } from './pg';

/** 登录用户行（query 返回的未知行断言用） */
interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  passwordHash: string | null;
  activeSessionStamp: string | null;
}

/** 会话校验查询只取权威角色，不把数据库印章带回应用层或浏览器。 */
interface ActiveSessionRow {
  role: string;
}

type UserRole = 'FREE' | 'VIP' | 'ADMIN';

/**
 * 手机号规范化
 *
 * 输入 11 位国内手机号（1 开头）→ +86 前缀国际格式；
 * 已带 + 前缀的国外号码原样返回；其余返回 null（不按手机号处理）。
 *
 * 简化自 app1 src/core/sms/sms-code.service.ts 的 normalizePhone，
 * 仅保留登录查询所需的最低逻辑。
 */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+86${digits}`;
  if (raw.trim().startsWith('+') && digits.length > 0) return raw.trim();
  return null;
}

/**
 * 按 JWT 中的用户 id + 会话戳验证当前会话，并返回数据库权威角色。
 *
 * 安全语义采用 fail-closed：旧 JWT 缺少 stamp、数据库中的 stamp 为空、记录
 * 不存在或查询失败都视为未登录，用户需重新登录生成新戳。这里故意不做缓存，
 * 每次会话解析仅执行一次 users 主键点查，以换取改密/异地登录后的立即撤销。
 */
async function findActiveSessionRole(
  tokenId: unknown,
  tokenStamp: unknown,
): Promise<UserRole | null> {
  if (
    typeof tokenId !== 'string' ||
    tokenId.length === 0 ||
    typeof tokenStamp !== 'string' ||
    tokenStamp.length === 0
  ) {
    return null;
  }

  try {
    const { rows } = await query(
      `SELECT role
         FROM users
        WHERE id = $1 AND "activeSessionStamp" = $2
        LIMIT 1`,
      [tokenId, tokenStamp],
    );
    const row = rows[0] as ActiveSessionRow | undefined;
    if (!row) return null;
    if (row.role === 'VIP' || row.role === 'ADMIN') return row.role;
    return 'FREE';
  } catch {
    // 数据库不可用时不能降级为信任旧 JWT，否则撤销边界会在故障时失效。
    return null;
  }
}

/**
 * NextAuth 配置
 *
 * - session.strategy: 'jwt' — 无状态会话
 * - providers: CredentialsProvider — login(邮箱/手机)+password
 * - callbacks.jwt: 首次登录写入 id/role/stamp 到 token
 * - callbacks.session: 注入 session.user.id / role 供前端读取
 * - pages.signIn: 自定义登录页 /auth/signin
 *
 * secret 从 process.env.NEXTAUTH_SECRET 读取（NextAuth 约定），
 * env.ts 会校验其存在。
 */
export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
  pages: { signIn: '/auth/signin' },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        login: { label: 'Login', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      /**
       * 凭证校验：查 users 表 + bcrypt 比对密码
       *
       * @returns 用户对象（id/email/name/role/stamp）或 null（校验失败）
       */
      async authorize(credentials) {
        const payload = credentials as { login?: string; password?: string } | undefined;
        const rawLogin = payload?.login?.trim() ?? '';
        if (!rawLogin || !payload?.password) return null;
        try {
          const phone = normalizePhone(rawLogin);
          const lookup = rawLogin.toLowerCase();
          // 邮箱或手机号匹配；phone 同时尝试原始与规范化两种形式
          const { rows } = await query(
            `SELECT id, email, name, role, "passwordHash", "activeSessionStamp"
             FROM users
             WHERE email = $1 OR phone = $1 OR phone = $2
             LIMIT 1`,
            [lookup, phone ?? ''],
          );
          const user = rows[0] as UserRow | undefined;
          if (!user || !user.passwordHash) return null;

          const valid = await bcrypt.compare(payload.password, user.passwordHash);
          if (!valid) return null;

          // I1 平滑升级：检测旧 cost（< 12）的 hash，登录校验通过后准备新哈希。
          // 新哈希与会话戳在下方同一次 CAS 更新中落库，避免并发改密后仍签发旧凭据会话。
          let nextPasswordHash = user.passwordHash;
          try {
            const currentRounds = bcrypt.getRounds(user.passwordHash);
            if (Number.isFinite(currentRounds) && currentRounds < 12) {
              nextPasswordHash = await bcrypt.hash(payload.password, 12);
            }
          } catch {
            // 重哈希失败不影响本次密码校验；保留原哈希并继续轮换会话戳。
          }

          // 单设备登录：会话戳写入必须成功才能签发 JWT。WHERE 带上刚验证的
          // passwordHash，若期间发生并发改密则 CAS 失败，本次旧密码登录不生效。
          const stamp = genId();
          const stampWrite = await query(
            `UPDATE users
                SET "activeSessionStamp" = $1, "passwordHash" = $2
              WHERE id = $3 AND "passwordHash" = $4
              RETURNING id`,
            [stamp, nextPasswordHash, user.id, user.passwordHash],
          );
          if (stampWrite.rows.length !== 1) {
            return null;
          }

          return {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name ?? undefined,
            // DB schema (0001-init.sql) 注释 role ∈ FREE/VIP/ADMIN,默认 'FREE'。
            // 此处 cast 收窄到联合,对齐 web/types/next-auth.d.ts 的 UserRole 增强
            // (web build 透过 @server/* path 拉本文件做 typecheck)。运行时若 DB
            // 出现非枚举值,token 仍以 string 流转,session callback 兜底回 'FREE'。
            role: user.role as UserRole,
            stamp,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    /** 登录时将 id/role/stamp 写入 JWT */
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as { id: string }).id;
        // role 类型对齐 web/types/next-auth.d.ts 的 UserRole 增强(联合类型)。
        // user.role 在 authorize() 已收窄;此处 cast 兼容 server 旧调用面。
        token.role = (user as { role?: 'FREE' | 'VIP' | 'ADMIN' }).role;
        token.stamp = (user as { stamp?: string }).stamp;
      }
      return token;
    },
    /** 校验 token 会话戳后，将 DB 权威 id/role 注入 session.user。 */
    async session({ session, token }) {
      if (session.user) {
        const sessionUser = session.user as {
          id?: string;
          role?: UserRole;
        };
        // 先清除调用方可能传入的旧权威字段；校验失败时 requireUser 看不到 id。
        delete sessionUser.id;
        delete sessionUser.role;

        const role = await findActiveSessionRole(token.id, token.stamp);
        if (role) {
          sessionUser.id = token.id as string;
          sessionUser.role = role;
        }
      }
      return session;
    },
  },
};
