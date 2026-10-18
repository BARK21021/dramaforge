// ============================================================
// 短信验证码服务 - 验证码生成、存储、校验
// ============================================================
//
// @file infra/sms/sms-code.service.ts
// @description 手机号验证码生命周期管理：
//   1. normalizePhone - 归一化手机号（11 位国内，1[3-9] 开头）
//   2. genCode - 生成 6 位数字验证码
//   3. storeCode - 存储到 Redis（TTL + 重发锁 + 尝试计数）
//   4. verifyCode - 校验验证码（含尝试次数限制）
//   5. isResendLocked - 检查重发锁定
//
// 核心设计：
//   - 验证码存 Redis，key = sms:code:{phone}，TTL = SMS_CODE_TTL_SECONDS
//   - 重发锁 key = sms:lock:{phone}，TTL = SMS_RESEND_LOCK_SECONDS
//   - 尝试计数 key = sms:attempts:{phone}，TTL = SMS_CODE_TTL_SECONDS
//   - 校验时递增尝试次数，超过 SMS_CODE_MAX_ATTEMPTS 后作废验证码
//
// 移植自 app1 src/core/sms/sms-code.service.ts；改造点：
//   - Redis 客户端用 dramaforge 的 getRedis（ioredis 单例）
//   - 配置直接读 process.env（带默认值）
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import { randomInt, timingSafeEqual } from 'crypto';
import { getRedis } from '../redis';

/** 验证码 Redis key 前缀 */
const CODE_KEY_PREFIX = 'sms:code:';
/** 重发锁 Redis key 前缀 */
const LOCK_KEY_PREFIX = 'sms:lock:';
/** 尝试次数 Redis key 前缀 */
const ATTEMPTS_KEY_PREFIX = 'sms:attempts:';

/** 默认验证码有效期（秒） */
const DEFAULT_TTL_SECONDS = 60;
/** 默认重发锁定期（秒） */
const DEFAULT_RESEND_LOCK_SECONDS = 60;
/** 默认最大尝试次数 */
const DEFAULT_MAX_ATTEMPTS = 5;

/** 读取 SMS_CODE_TTL_SECONDS（带默认值 + 非法值兜底） */
function codeTtl(): number {
  const v = Number(process.env.SMS_CODE_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_SECONDS;
}
/** 读取 SMS_RESEND_LOCK_SECONDS */
function resendLockTtl(): number {
  const v = Number(process.env.SMS_RESEND_LOCK_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RESEND_LOCK_SECONDS;
}
/** 读取 SMS_CODE_MAX_ATTEMPTS */
function maxAttempts(): number {
  const v = Number(process.env.SMS_CODE_MAX_ATTEMPTS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_ATTEMPTS;
}

/**
 * 归一化手机号
 *
 * 提取 11 位数字，校验是否为合法国内手机号（1[3-9] 开头）。
 * 兼容 +86 前缀、空格、横线等输入格式。
 *
 * @param rawPhone - 原始手机号字符串
 * @returns 归一化后的 11 位手机号；非法时返回 null
 */
export function normalizePhone(rawPhone: string): string | null {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  // 兼容 +86 前缀（13 位，去前缀后 11 位）
  const phone = digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits;
  if (phone.length !== 11) return null;
  if (!/^1[3-9]\d{9}$/.test(phone)) return null;
  return phone;
}

/**
 * 生成 6 位数字验证码
 * @returns 6 位数字字符串（前导零保留）
 */
export function genCode(): string {
  const code = randomInt(0, 1_000_000);
  return code.toString().padStart(6, '0');
}

/**
 * 存储验证码到 Redis
 *
 * 写入三个 key：
 *   1. sms:code:{phone}      — 验证码，TTL = codeTtl
 *   2. sms:lock:{phone}      — 重发锁，TTL = resendLockTtl
 *   3. sms:attempts:{phone}  — 尝试计数，TTL = codeTtl（与验证码同生命周期）
 */
export async function storeCode(phone: string, code: string): Promise<void> {
  const redis = getRedis();
  const ttl = codeTtl();
  await Promise.all([
    redis.set(`${CODE_KEY_PREFIX}${phone}`, code, 'EX', ttl),
    redis.set(`${LOCK_KEY_PREFIX}${phone}`, '1', 'EX', resendLockTtl()),
    redis.set(`${ATTEMPTS_KEY_PREFIX}${phone}`, '0', 'EX', ttl),
  ]);
}

/**
 * 检查是否处于重发锁定期
 *
 * @returns true 表示仍在锁定期（不能重发）；false 表示可以重发
 */
export async function isResendLocked(phone: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(`${LOCK_KEY_PREFIX}${phone}`);
  return exists > 0;
}

/**
 * 校验验证码
 *
 * 流程：
 *   1. 从 Redis 读取验证码（不存在/已过期 → false）
 *   2. 递增尝试次数
 *   3. 超过最大尝试次数 → 作废验证码，返回 false
 *   4. 比对验证码（成功则删除，失败返回 false）
 *
 * 比对采用恒定时间比较（M1）：避免通过响应时延差异枚举验证码字符位。
 * 6 位 code 实际不可利用（搜索空间 10^6 远低于限流阈值），属生产洁癖加固。
 *
 * @param phone - 归一化后的 11 位手机号
 * @param code - 用户输入的 6 位验证码
 * @returns true 校验通过；false 校验失败
 */
export async function verifyCode(phone: string, code: string): Promise<boolean> {
  if (!phone || !code) return false;
  const redis = getRedis();

  const codeKey = `${CODE_KEY_PREFIX}${phone}`;
  const attemptsKey = `${ATTEMPTS_KEY_PREFIX}${phone}`;

  const storedCode = await redis.get(codeKey);
  if (!storedCode) return false;

  const attempts = await redis.incr(attemptsKey);
  if (attempts > maxAttempts()) {
    await Promise.all([redis.del(codeKey), redis.del(attemptsKey)]);
    return false;
  }

  // M1：恒定时间比较。timingSafeEqual 要求等长 Buffer，长度不等直接 false。
  const storedBuf = Buffer.from(storedCode);
  const inputBuf = Buffer.from(code);
  const matched =
    storedBuf.length === inputBuf.length && timingSafeEqual(storedBuf, inputBuf);

  if (matched) {
    await Promise.all([redis.del(codeKey), redis.del(attemptsKey)]);
    return true;
  }
  return false;
}

/**
 * 原子化 INCR + PEXPIRE 限流脚本（C5）
 *
 * 历史问题：`INCR` 后单独 `PEXPIRE`，若进程在两步之间崩溃 → key 无 TTL 永久
 * 存在，count 单调递增 → 用户被永久限流（dramaforge 回归 bug）。Lua 脚本让 Redis
 * 单线程原子执行两步，要么全成要么全无。
 *
 * 返回当前窗口内计数（INCR 后的值）。调用方据此判断是否超阈值。
 */
const RATE_LIMIT_LUA = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c`;

/**
 * 简易固定窗口限流（Redis 原子 INCR + PEXPIRE）
 *
 * @param key       限流 key（含前缀）
 * @param windowMs  窗口大小（毫秒）
 * @param maxRequests 窗口内允许的最大请求数
 * @returns true 允许；false 拒绝
 *
 * 设计：Lua 脚本保证 INCR 与首次 PEXPIRE 原子执行；后续请求只 INCR。
 * 不是严格滑动窗口（fixed window，边界双倍突发），但对短信发送限流可接受。
 */
export async function rateLimitAllow(
  key: string,
  windowMs: number,
  maxRequests: number,
): Promise<boolean> {
  const redis = getRedis();
  const count = (await redis.eval(RATE_LIMIT_LUA, 1, key, String(windowMs))) as number;
  return count <= maxRequests;
}
