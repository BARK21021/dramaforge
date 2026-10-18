// ============================================================
// POST /api/auth/sms/send — 发送手机注册验证码
// ============================================================
//
// @file api/auth/sms/send/route.ts
// @description 发送手机注册验证码。
//
// @endpoints
//   POST /api/auth/sms/send - 发送验证码
//     请求体: { phone }
//     响应: 200 { success: true, data: { sent: true } }
//
// @security
//   - 手机号格式校验（11 位 + 1[3-9] 开头）
//   - 重发锁：同号 60s 内禁止重发（Redis）
//   - 双维度限流：手机号 10 分钟 3 条 + IP 10 分钟 20 条
//   - **C1（防枚举）**：已注册号仍返回 200 { sent: true }，内部静默跳过发码+落码，
//     不向攻击者泄露账号存在性。生产惯例：不区分"已注册" vs "未注册"的响应。
//   - **C4（防 XFF 伪造）**：从 x-real-ip 取合法 IP，缺失/非法返回 400（不再回落
//     'unknown' 共享桶，避免单点打满拖累全部无 XFF 用户）。
//   - **I6（防 body OOM）**：Content-Length > 4KB 拒绝。
//   - 验证码 6 位数字，TTL 60s（可由 SMS_CODE_TTL_SECONDS 配置）
//
// @auth 无需认证（公开接口）
//
// 移植自 app1 src/app/api/auth/sms/send/route.ts；改造点：
//   - Prisma → 原生 pg query
//   - getSlidingWindowLimiter → dramaforge 的 rateLimitAllow（Redis Lua 原子化）
//   - apiSuccess/apiError → dramaforge 的 envelope helpers（apiSuccess / apiFail）
//   - SMS 服务从 @dramaforge/server barrel 取（normalizePhone/genCode/storeCode/...）
// ============================================================

import type { NextRequest } from 'next/server';
import {
  normalizePhone,
  genCode,
  storeCode,
  isResendLocked,
  rateLimitAllow,
  sendCode,
  findUserByPhoneOrEmail,
} from '@dramaforge/server';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { extractClientIp, readBodyWithLimit } from '@web/lib/sms-security';

/** 注册请求体最大字节数（I6：App Router 无默认 body limit） */
const SMS_SEND_BODY_LIMIT_BYTES = 4096;

/**
 * POST /api/auth/sms/send - 发送验证码
 *
 * 流程：
 *   1. Content-Length 体积校验（I6）
 *   2. 手机号格式校验（normalizePhone）
 *   3. 客户端 IP 提取（C4：拒绝非法 / 缺失）
 *   4. 重发锁检查（60s 内禁止重发）
 *   5. 双维度限流（手机号 + IP）
 *   6. 已注册账号静默跳过（C1：仍返 200 sent:true，不发码不落码）
 *   7. 生成 6 位验证码 + 调阿里云发送 + 落码
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    // 1) 体积校验
    const bodyRes = await readBodyWithLimit<{ phone?: unknown }>(
      request,
      SMS_SEND_BODY_LIMIT_BYTES,
    );
    if (!bodyRes.ok) {
      return apiFail(bodyRes.payload, bodyRes.status);
    }
    const { phone: rawPhone } = bodyRes.body;

    // 2) 手机号格式校验
    const phone = normalizePhone(typeof rawPhone === 'string' ? rawPhone : '');
    if (!phone) {
      return apiFail({ error: '手机号格式不正确', code: 'VALIDATION_ERROR' }, 400);
    }

    // 3) 客户端 IP 提取（C4）
    const ip = extractClientIp(request);
    if (!ip) {
      // 不再回落 'unknown' 共享桶；nginx 必须正确注入 x-real-ip / XFF（见部署 runbook）
      return apiFail(
        { error: '无法识别客户端 IP，请通过反向代理访问', code: 'BAD_REQUEST' },
        400,
      );
    }

    // 4) 重发锁检查（60s 内禁止重发）
    if (await isResendLocked(phone)) {
      return apiFail(
        { error: '验证码已发送，请等待 60 秒后再试', code: 'RATE_LIMITED', retryable: true },
        429,
      );
    }

    // 5) 双维度限流：手机号 10 分钟 3 条 + IP 10 分钟 20 条
    const [phoneAllowed, ipAllowed] = await Promise.all([
      rateLimitAllow(`sms:send:phone:${phone}`, 600_000, 3),
      rateLimitAllow(`sms:send:ip:${ip}`, 600_000, 20),
    ]);
    if (!phoneAllowed || !ipAllowed) {
      return apiFail(
        { error: '发送过于频繁，请稍后再试', code: 'RATE_LIMITED', retryable: true },
        429,
      );
    }

    // 6) C1：已注册账号静默跳过发码+落码，仍返 200 sent:true（防枚举）
    //    注意：放在限流之后，攻击者每次探测都会消耗 IP / 手机号 限流配额，
    //    防止"无限枚举"。
    const existing = await findUserByPhoneOrEmail(phone);
    if (existing) {
      // 仅服务端日志（脱敏），响应与未注册路径完全一致
      console.info(
        `[sms/send] 已注册手机号请求发码，静默跳过（防枚举）：${phone.slice(0, 3)}****${phone.slice(-4)}`,
      );
      return apiSuccess({ sent: true });
    }

    // 7) 生成验证码 + 调阿里云发送（生产强制走真实短信；SMS_MOCK_ENABLED=true 且非生产走 mock）
    const code = genCode();
    const result = await sendCode(phone, code);
    if (!result.success) {
      const message = result.message
        ? `短信发送失败：${result.message}`
        : result.retryable
          ? '短信发送失败，请稍后重试'
          : '短信发送失败';
      return apiFail(
        { error: message, code: 'SMS_SEND_FAILED', retryable: result.retryable ?? false },
        result.retryable ? 500 : 400,
      );
    }

    // 8) 发送成功后再落库，避免用户没收到短信却进入重发锁
    await storeCode(phone, code);

    return apiSuccess({ sent: true });
  } catch (err) {
    return handleApiError(err, 'sms/send');
  }
}
