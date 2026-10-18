// ============================================================
// 阿里云短信服务 - 验证码短信发送
// ============================================================
//
// @file infra/sms/aliyun-sms.ts
// @description 阿里云短信 SDK 封装，提供验证码短信发送能力。
//              使用官方 v2 SDK（@alicloud/dysmsapi20170525）。
//
// 核心功能：
//   1. 单例 Client 管理（懒加载，首次调用时创建）
//   2. sendCode(phone, code) - 发送 6 位数字验证码
//   3. 开发环境假验证码模式（SMS_ENABLED=false 且非生产时跳过阿里云调用，
//      返回 123456 由调用方决定如何回填）
//   4. 错误分类（可重试 vs 不可重试），便于上层限流和用户提示
//
// 移植自 app1 src/core/sms/aliyun-sms.ts；改造点：
//   - 配置直接读 process.env（dramaforge env.ts schema 将 SMS_* 列为 optional）
//   - 剔除 app1 debugLog/console 信息（统一交由路由层日志）
//   - 单例简化为模块级闭包变量
//
// 配置依赖（env）：
//   - ALIYUN_SMS_ACCESS_KEY_ID / SECRET：RAM 子账号密钥
//   - ALIYUN_SMS_SIGN_NAME：短信签名（控制台审核通过）
//   - ALIYUN_SMS_TEMPLATE_CODE：验证码模板 CODE（模板须含 ${code} 变量）
//   - ALIYUN_SMS_ENDPOINT：默认 dysmsapi.aliyuncs.com
//   - SMS_ENABLED：开关，false 时走假验证码模式（仅非生产环境）
//
// @security
//   - 生产环境（NODE_ENV=production）强制走真实短信，无视 SMS_ENABLED=false
//   - RAM 子账号建议仅授予 dysmsapi:SendSms 权限
//   - key 只在云端服务器（GC-8：不写入代码/git；用户从 app1 .env 复制真值）
// ============================================================

import Dysmsapi20170525, * as $Dysmsapi20170525 from '@alicloud/dysmsapi20170525';
import * as $OpenApi from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';

/**
 * 短信发送结果
 */
export interface SendSmsResult {
  /** 是否发送成功 */
  success: boolean;
  /** 阿里云回执 ID（成功时） */
  bizId?: string;
  /** 阿里云业务码（如 "OK" / "isv.BUSINESS_LIMIT_CONTROL"） */
  code?: string;
  /** 业务消息 */
  message?: string;
  /** 是否可重试（网络/限流类错误为 true，配置/号码错误为 false） */
  retryable?: boolean;
}

/**
 * 读取 SMS 配置（全部 optional；缺值时返回 null 表示未配置）
 */
function readSmsConfig() {
  return {
    accessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID?.trim() || '',
    accessKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET?.trim() || '',
    signName: process.env.ALIYUN_SMS_SIGN_NAME?.trim() || '',
    templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE?.trim() || '',
    endpoint: process.env.ALIYUN_SMS_ENDPOINT?.trim() || 'dysmsapi.aliyuncs.com',
    enabled: process.env.SMS_ENABLED?.trim().toLowerCase() !== 'false',
  };
}

/** SDK Client 单例（懒加载） */
let _client: Dysmsapi20170525 | null = null;

/**
 * 获取或创建 SDK Client
 * @throws Error 当阿里云配置缺失时
 */
function getClient(): Dysmsapi20170525 {
  if (_client) return _client;
  const cfg = readSmsConfig();
  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    throw new Error('阿里云短信配置缺失（ALIYUN_SMS_ACCESS_KEY_ID / SECRET）');
  }
  const config = new $OpenApi.Config({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    endpoint: cfg.endpoint,
  });
  _client = new Dysmsapi20170525(config);
  return _client;
}

/** 重置单例（仅供测试使用） */
export function _resetSmsClientForTests(): void {
  _client = null;
}

/**
 * 手机号脱敏（M3）：取首 3 + 末 4，中间 ****，避免日志泄露完整手机号。
 *
 * 短于 7 位的输入直接返回 '***'（不应发生，保护性兜底）。
 */
export function maskPhone(phone: string): string {
  return phone.length >= 7
    ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
    : '***';
}

/**
 * 是否走假验证码模式（C3 改造：正向信号 + 生产强制拒绝）
 *
 * - 默认不激活（SMS_MOCK_ENABLED 未设或非 'true'）。
 * - 显式 SMS_MOCK_ENABLED=true 且非 production 时激活，跳过阿里云调用。
 * - production 下即使误配 SMS_MOCK_ENABLED=true 也返回 false（env.ts 已在
 *   启动时 throw，本兜底防止绕过 env 路径的极端情形）。
 *
 * 历史风险：原 `!cfg.enabled && NODE_ENV !== 'production'` 负向判定，
 * NODE_ENV 写成 prod/staging 或漏配 → 误激活 mock → 任意 code 注册成功。
 */
export function isDevMockMode(): boolean {
  if (process.env.SMS_MOCK_ENABLED?.trim().toLowerCase() !== 'true') {
    return false;
  }
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[sms] 检测到 NODE_ENV=production 且 SMS_MOCK_ENABLED=true：env.ts 应已 throw 阻止启动，' +
        '此处兜底强制禁用 mock（生产环境禁止 mock 验证码）',
    );
    return false;
  }
  return true;
}

/**
 * 发送验证码短信
 *
 * @param phone 中国大陆 11 位手机号（阿里云要求 11 位大陆号码，不拼 +86）
 * @param code  6 位数字验证码
 * @returns 发送结果（含成功标志、业务码、是否可重试）
 */
export async function sendCode(phone: string, code: string): Promise<SendSmsResult> {
  // 假验证码模式：仅当 SMS_MOCK_ENABLED=true 且非生产环境
  if (isDevMockMode()) {
    // M3：日志脱敏，避免完整手机号落入 stdout/容器日志
    console.warn(
      `[sms] [DEV-MOCK] 假验证码模式，跳过阿里云调用：${maskPhone(phone)}（实际 code 已按生成值存 Redis）`,
    );
    return { success: true, bizId: 'DEV-MOCK', code: 'OK', retryable: false };
  }

  const cfg = readSmsConfig();
  try {
    const req = new $Dysmsapi20170525.SendSmsRequest({
      phoneNumbers: phone,
      signName: cfg.signName,
      templateCode: cfg.templateCode,
      templateParam: JSON.stringify({ code }),
    });
    const resp = await getClient().sendSmsWithOptions(req, new RuntimeOptions({}));
    const body = resp.body;

    if (!body) {
      return { success: false, message: '短信服务响应为空', retryable: true };
    }

    if (body.code === 'OK') {
      return { success: true, bizId: body.bizId, code: 'OK', retryable: false };
    }

    const retryable = /BUSINESS_LIMIT_CONTROL|RATE_LIMIT|SYSTEM/.test(body.code || '');
    return { success: false, code: body.code, message: body.message, retryable };
  } catch (e) {
    console.error('[sms] sendCode 异常:', e);
    return { success: false, message: (e as Error).message, retryable: true };
  }
}
