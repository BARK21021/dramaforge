// ============================================================
// 环境变量校验 - Zod schema，启动时强制校验所有必需变量
// ============================================================
//
// 文件职责：
//   用 Zod 校验 process.env，确保服务器启动时所有必需的基础设施变量就位。
//   缺字段或空字符串均抛错，避免运行时才暴露配置缺失。
//
// 使用方式：
//   import { env, loadEnv } from './env';
//   const e = env();           // 懒加载 + 缓存，首次调用触发解析
//   loadEnv();                 // 强制重新解析（测试用）
//
// 懒加载设计：模块导入时不解析（避免测试环境无 .env 时 import 即抛错）。
// 仅在首次调用 env() / loadEnv() 时解析 process.env。
// ============================================================

import { z } from 'zod';

/**
 * 环境变量 Schema
 *
 * 所有字段必填、非空字符串。新增基础设施变量时在此添加校验。
 */
export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  NEXTAUTH_SECRET: z.string().min(1),
  NEXTAUTH_URL: z.string().min(1),
  /**
   * 运行环境（M2/C3 合并：NODE_ENV 收窄为 enum，默认 development）。
   *
   * 防止历史负向检查 `NODE_ENV !== 'production'` 因拼写错误（prod / staging /
   * 未设置）退化成"非生产"而误激活 mock 模式等敏感分支。C3 已将 SMS mock 改为
   * 正向信号 SMS_MOCK_ENABLED，但保留 NODE_ENV 强类型仍然必要：env.ts 中其它
   * 安全/部署行为（如日志级别）会按 NODE_ENV 分流。
   */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * MinIO 公网访问 base URL（浏览器/客户端解析得到的域名）。
   *
   * 生产场景：MINIO_ENDPOINT=minio（docker 内部服务名），服务器走内网通信；
   * 但 presigned URL 与 upload() 返回的 url 必须用公网域名，否则浏览器无法解析 host `minio`。
   * 配置后，minio.ts 会构造一个 endPoint=公网域名的第二个 Client 专门用于签名
   * （SigV4 签名不包含 endPoint，签名 URL 仍可被内网/公网任一端点的 MinIO 服务验证）。
   *
   * 未配置时回退到 MINIO_ENDPOINT（兼容现有 dev/test 部署）。
   */
  MINIO_PUBLIC_BASE_URL: z.string().url().optional(),
  /**
   * 支付宝电脑网站支付配置（P6）。
   *
   * 全 optional：缺密钥时应用照常启动，PaymentService.createOrder 的
   * config-guard（assertAlipayConfigured）会在用户建单时抛 500，把 SDK
   * 隐晦的加签名错误转成可读提示。真·联调需在服务器 .env 配齐三把密钥
   * （GC-1：key 只在云端服务器，不分发给用户/客户端）。
   *
   * GATEWAY：生产 https://openapi.alipay.com/gateway.do；
   *         沙箱 https://openapi-sandbox.dl.alipaydev.com/gateway.do
   */
  ALIPAY_APP_ID: z.string().optional(),
  ALIPAY_APP_PRIVATE_KEY: z.string().optional(),
  ALIPAY_PUBLIC_KEY: z.string().optional(),
  ALIPAY_GATEWAY: z.string().optional(),
  ALIPAY_RETURN_URL: z.string().optional(),
  ALIPAY_NOTIFY_URL: z.string().optional(),
  /** 单笔充值金额上下限（元）。optional string，未配时 rules.ts 取默认 1 / 10000 */
  PAYMENT_ORDER_MIN_YUAN: z.string().optional(),
  PAYMENT_ORDER_MAX_YUAN: z.string().optional(),
  /**
   * 短信网关（阿里云 dysmsapi）— 全 optional。
   *
   * 缺配置时应用照常启动；web 的 /api/auth/sms/send 会在用户触发发码时
   * 由 SMS_ENABLED=false 走 dev mock 模式（仅非生产环境），或抛 500
   * 提示生产环境未配密钥（生产强制走真实短信）。
   *
   * GC-8：短信 key 只在云端服务器，不写入代码/git；用户从 app1 .env 复制真值。
   * SDK 包：@alicloud/dysmsapi20170525（与 app1 同款）。
   */
  SMS_ENABLED: z.string().optional(),
  /**
   * SMS mock 模式正向开关（C3：默认不激活）。
   *
   * 历史实现用 `SMS_ENABLED=false && NODE_ENV !== 'production'` 负向判定，
   * 任一条件失误（NODE_ENV 漏配 / 写成 prod）都会激活 mock，接受任意验证码
   * 完成注册。C3 改为正向信号：必须显式设置 `SMS_MOCK_ENABLED=true` 才激活，
   * 且在 NODE_ENV=production 下被强制拒绝（即使误配也不生效，env 校验阶段
   * 直接 throw 阻止启动）。
   */
  SMS_MOCK_ENABLED: z.string().optional(),
  SMS_CODE_TTL_SECONDS: z.string().optional(),
  SMS_RESEND_LOCK_SECONDS: z.string().optional(),
  SMS_CODE_MAX_ATTEMPTS: z.string().optional(),
  ALIYUN_SMS_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_SMS_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_SMS_SIGN_NAME: z.string().optional(),
  ALIYUN_SMS_TEMPLATE_CODE: z.string().optional(),
  ALIYUN_SMS_ENDPOINT: z.string().optional(),
  /** 新注册用户初始积分（默认 0，不赠送）。optional string，未配时取默认 0 */
  FREE_QUOTA_CREDITS: z.string().optional(),
  /**
   * PostgreSQL 连接池上限（每进程）。
   *
   * dramaforge 有 web / ai-worker / migrate 多个 Node 进程各自建独立池，而 postgres
   * max_connections=100。历史硬编码 max=80 → 三池合计可达 240 > 100，连接风暴
   * （部署并发启动 / SSE 重连 / 连接泄漏）时触发 too many connections 级联故障，
   * 且每空闲连接占 ~5-10MB 可能撑爆 pg 容器 384m 限额。实测峰值仅 39 连接 / 2 活跃，
   * 故默认 10；compose 中 ai-worker 覆盖为 5（长任务低并发）。三池合计 ≤25。
   */
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
});

/** 解析后的环境变量类型 */
export type Env = z.infer<typeof EnvSchema>;

/** 缓存的解析结果（首次调用 env() 后填充） */
let _cache: Env | null = null;

/**
 * 强制重新解析 process.env 并缓存
 *
 * 用 Zod 校验所有必需变量；任一缺失或为空字符串即抛 Error（非 ZodError），
 * 错误信息列出所有不合法字段，便于部署排错。
 *
 * @returns 解析后的环境变量对象
 * @throws Error 当任一必需变量缺失或为空
 */
export function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    _cache = null;
    throw new Error(`[env] validation failed: ${issues}`);
  }
  _cache = result.data;

  // C3 安全护栏：生产环境绝不允许 SMS mock 模式
  // 即使运维误配 SMS_MOCK_ENABLED=true，env 校验阶段直接 throw 阻止启动，
  // 避免"任意验证码完成注册"的无成本刷号事故。
  if (
    _cache.NODE_ENV === 'production' &&
    _cache.SMS_MOCK_ENABLED?.trim().toLowerCase() === 'true'
  ) {
    _cache = null;
    throw new Error(
      '[env] production 环境禁止 SMS_MOCK_ENABLED=true（会导致任意验证码注册成功）',
    );
  }

  return result.data;
}

/**
 * 获取解析后的环境变量（懒加载 + 缓存）
 *
 * 首次调用触发 loadEnv()；后续调用返回缓存。所有依赖 env 的模块
 * （pg / redis / auth）应通过此函数读取，确保校验只跑一次。
 *
 * @returns 解析后的环境变量对象
 * @throws Error 当任一必需变量缺失或为空（首次调用时）
 */
export function env(): Env {
  if (_cache) return _cache;
  return loadEnv();
}

/** 重置缓存（仅供测试使用） */
export function _resetEnvCacheForTests(): void {
  _cache = null;
}
