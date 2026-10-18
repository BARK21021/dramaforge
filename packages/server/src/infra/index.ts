// ============================================================
// ⑦ server/db+config (infra) — barrel
// ============================================================
// 导出 pg 连接池 + 事务、env 校验、redis 单例。（authOptions 不在此导出，见下方说明。）
// 服务器禁止 import 任何 ffmpeg 模块。
//
// 注意：迁移执行器（runMigrations 等）**不在此 barrel 导出**。原因：
// migrate.ts 用 `new URL('./migrations', import.meta.url)` 定位 SQL 文件，
// 该模式在 Next.js Turbopack 下无法静态解析（Turbopack 试图把 ./migrations
// 当 asset 打包，但它是目录）。web 通过 @dramaforge/server → @server/infra
// 间接拉取时会触发 500。迁移执行器只由独立 bundle（dist/migrate.js，
// esbuild 产出）调用，该 bundle 直接 import './migrate'，不经过本 barrel。
// 需要迁移功能的代码请直接 import './migrate' 或 '@server/infra/migrate'。
// ============================================================

export {
  getPool,
  query,
  tx,
  runInTransaction,
  endPool,
  type QueryFn,
  type QueryResult,
} from './pg';

export { EnvSchema, loadEnv, env, type Env } from './env';

export { getRedis, disconnectRedis } from './redis';

// SMS 子域：阿里云短信网关 + 验证码生命周期管理。
// 顶层 import '@alicloud/dysmsapi20170525' 在不存在 Client 实例化时是无副作用
// 的类型/常量绑定；Client 实例懒加载在首次 sendCode() 时才创建。ai-worker 等
// 不发短信的模块若仅 import query/redis 等，esbuild tree-shaking 会剔除本导出。
export {
  sendCode,
  isDevMockMode,
  normalizePhone,
  genCode,
  storeCode,
  isResendLocked,
  verifyCode,
  rateLimitAllow,
  type SendSmsResult,
} from './sms';

// 用户仓储 helper（手机号注册流程用）。bcrypt 封装在此层，避免 web 直接
// import bcryptjs。web 的 /api/auth/register-phone 经此 helper 创建用户。
export {
  findUserByPhoneOrEmail,
  createUserFromPhone,
  changeUserPassword,
  type PhoneUserRow,
  type CreatePhoneUserResult,
  type ChangeUserPasswordResult,
} from './user';

// ⚠️ authOptions **不在此 barrel 导出**。原因：auth.ts 顶层调用 CredentialsProvider(...)
// 构造 providers，esbuild 视其为有副作用 → 任何经本 barrel 取 getRedis/query/env 的模块
// （如 ai-worker）都会连带把 auth.ts + next-auth 拖进 bundle。web 需要的 authOptions
// 由根 barrel（src/index.ts）直接 `export { authOptions } from './infra/auth'` 单独拉取，
// 这样 worker 的 @server/infra 导入路径完全不触及 auth。migrate.ts 同理直连 './pg'。
