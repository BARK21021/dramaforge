// ============================================================
// POST /api/auth/register-phone — 手机号 + 验证码注册
// ============================================================
//
// @file api/auth/register-phone/route.ts
// @description 手机号 + 短信验证码 + 密码注册流程。
//
// @endpoints
//   POST /api/auth/register-phone
//     请求体: { phone, code, password, name? }
//     响应: 201 { success: true, data: { id, phone, name, credits } }
//
// @security
//   - 手机号格式校验（11 位 + 1[3-9] 开头）
//   - **I2 密码策略**：≥8 位 + 至少 1 字母 + 1 数字
//   - **I9 bcrypt 截断陷阱**：password.length > 72 字节拒绝
//   - **C2 + I3 双维度限流**：手机号 60s 内最多 3 次 + IP 60s 内最多 10 次
//   - **C2 调换顺序**：verifyCode（消费验证码）在 findUserByPhoneOrEmail 之前，
//     未持有效 code 者拿不到任何账号存在性信号
//   - **C2 错误信息泛化**：verifyCode 失败统一"验证码错误或已过期"
//   - **C4 防伪造 XFF**：x-real-ip 优先；非法 IP 直接 400
//   - **I6 body limit**：Content-Length > 4KB 拒绝
//   - DB phone 唯一索引兜住并发注册竞态（23505）
//
// @auth 无需认证（公开接口，但需要先调用 /api/auth/sms/send 获取验证码）
//
// 移植自 app1 src/app/api/auth/register-phone/route.ts；改造点：
//   - Prisma → 原生 pg query（封装在 server 层 createUserFromPhone）
//   - bcrypt 直接调用 → server 层 createUserFromPhone（保持 web 零 bcryptjs 依赖）
//   - getSlidingWindowLimiter → dramaforge 的 rateLimitAllow
//   - apiSuccess/apiError → dramaforge envelope helpers
//   - 前端在收到 201 后自行调 signIn("credentials") 完成自动登录（app1 同款）
// ============================================================

import type { NextRequest } from 'next/server';
import {
  normalizePhone,
  verifyCode,
  rateLimitAllow,
  findUserByPhoneOrEmail,
  createUserFromPhone,
} from '@dramaforge/server';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { extractClientIp, readBodyWithLimit } from '@web/lib/sms-security';

/** 密码最小长度（I2：从 6 提到 8） */
const MIN_PASSWORD_LENGTH = 8;
/** 密码最大字节长度（I9：bcrypt 72 字节截断陷阱，超出拒绝） */
const MAX_PASSWORD_BYTES = 72;
/** 注册请求体最大字节数（I6：App Router 无默认 body limit） */
const REGISTER_BODY_LIMIT_BYTES = 4096;

/** IP 维度限流：60 秒内最多 10 次注册尝试（C2 + I3） */
const IP_RATE_LIMIT_WINDOW_MS = 60_000;
const IP_RATE_LIMIT_MAX = 10;
/** 手机号维度限流：60 秒内最多 3 次注册尝试 */
const PHONE_RATE_LIMIT_WINDOW_MS = 60_000;
const PHONE_RATE_LIMIT_MAX = 3;

/**
 * 密码强度策略校验（I2）
 *
 * 规则：≥8 位 + 至少含 1 字母 + 1 数字。
 * 不强求符号 / 大小写混合：国内注册场景过严的策略反而推动用户使用统一弱密码。
 * 与 signup/page.tsx 前端校验对齐，避免前后端规则漂移。
 *
 * @returns null 表示通过；非 null 为错误代码
 */
function validatePasswordPolicy(
  password: string,
): { error: string; code: string } | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      error: `密码至少需要 ${MIN_PASSWORD_LENGTH} 位，且包含字母与数字`,
      code: 'WEAK_PASSWORD',
    };
  }
  // I9：bcrypt 72 字节截断陷阱；超长密码在 bcryptjs 内会被静默截断，
  // 攻击者可用 "前72位 + 任意后缀" 通过校验 → 同 hash → 失去密码唯一性。
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return { error: '密码过长（最多 72 字节）', code: 'PASSWORD_TOO_LONG' };
  }
  if (!/[A-Za-z]/.test(password)) {
    return { error: '密码必须包含至少 1 个字母', code: 'WEAK_PASSWORD' };
  }
  if (!/\d/.test(password)) {
    return { error: '密码必须包含至少 1 个数字', code: 'WEAK_PASSWORD' };
  }
  return null;
}

/**
 * POST /api/auth/register-phone — 手机号注册
 *
 * 流程（C2 调换顺序后）：
 *   1. 体积校验 + body 解析
 *   2. 手机号格式校验
 *   3. code/password 基本存在性 + 密码策略（I2 + I9）
 *   4. IP 提取（C4：拒绝非法 / 缺失）
 *   5. 双维度限流（IP + 手机号）
 *   6. **verifyCode（消费 code）**：先消费，未持有效 code 者到此为止
 *   7. 手机号唯一性检查（C2：放在 verifyCode 之后，已注册号不会走到这里——
 *      /sms/send 已静默跳过 storeCode，无有效 code 可用）
 *   8. 创建用户（事务保证 users+preferences 一致，I8）
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    // 1) 体积校验 + body 解析（I6）
    const bodyRes = await readBodyWithLimit<{
      phone?: unknown;
      code?: unknown;
      password?: unknown;
      name?: unknown;
    }>(request, REGISTER_BODY_LIMIT_BYTES);
    if (!bodyRes.ok) {
      return apiFail(bodyRes.payload, bodyRes.status);
    }
    const { phone: rawPhone, code, password, name } = bodyRes.body;

    // 2) 手机号格式校验
    const phone = normalizePhone(typeof rawPhone === 'string' ? rawPhone : '');
    if (!phone) {
      return apiFail({ error: '手机号格式不正确', code: 'VALIDATION_ERROR' }, 400);
    }

    // 3) 验证码必填
    if (!code || typeof code !== 'string') {
      return apiFail({ error: '验证码不能为空', code: 'VALIDATION_ERROR' }, 400);
    }

    // 3.1) 密码基本存在 + 策略校验
    if (!password || typeof password !== 'string') {
      return apiFail({ error: '密码不能为空', code: 'VALIDATION_ERROR' }, 400);
    }
    const pwdErr = validatePasswordPolicy(password);
    if (pwdErr) {
      return apiFail({ error: pwdErr.error, code: pwdErr.code }, 400);
    }

    // 4) IP 提取（C4）
    const ip = extractClientIp(request);
    if (!ip) {
      return apiFail(
        { error: '无法识别客户端 IP，请通过反向代理访问', code: 'BAD_REQUEST' },
        400,
      );
    }

    // 5) 双维度限流（C2 + I3）
    const [phoneAllowed, ipAllowed] = await Promise.all([
      rateLimitAllow(
        `auth:register-phone:phone:${phone}`,
        PHONE_RATE_LIMIT_WINDOW_MS,
        PHONE_RATE_LIMIT_MAX,
      ),
      rateLimitAllow(
        `auth:register-phone:ip:${ip}`,
        IP_RATE_LIMIT_WINDOW_MS,
        IP_RATE_LIMIT_MAX,
      ),
    ]);
    if (!phoneAllowed || !ipAllowed) {
      return apiFail(
        { error: '注册尝试过于频繁，请稍后再试', code: 'RATE_LIMITED', retryable: true },
        429,
      );
    }

    // 6) **C2 调换顺序**：先 verifyCode（消费 code）
    //    泛化错误信息：不区分 code 不存在 / 已过期 / 输入错，避免被枚举。
    const codeValid = await verifyCode(phone, String(code));
    if (!codeValid) {
      return apiFail({ error: '验证码错误或已过期', code: 'INVALID_CODE' }, 400);
    }

    // 7) 手机号唯一性检查
    //    正常流量下：/sms/send 对已注册号静默跳过 storeCode（C1），
    //    故此处对已注册号理论上不可达；保留作安全冗余 + 兜未来回退。
    //    verifyCode 已消费 code，此处即便返回 409 也不再泄露存在性
    //    （攻击者需要先持有有效 code，而 /sms/send 已堵住这条路径）。
    const existing = await findUserByPhoneOrEmail(phone);
    if (existing) {
      return apiFail({ error: '该手机号已注册，请直接登录', code: 'CONFLICT' }, 409);
    }

    // 8) 创建用户（事务保证 users+preferences 一致，I8）
    const created = await createUserFromPhone(
      phone,
      password,
      typeof name === 'string' ? name : undefined,
    );

    return apiSuccess(created, 201);
  } catch (err) {
    // PG 唯一约束兜住并发注册竞态（23505 = unique_violation）
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      return apiFail({ error: '该手机号已注册，请直接登录', code: 'CONFLICT' }, 409);
    }
    return handleApiError(err, 'register-phone');
  }
}
