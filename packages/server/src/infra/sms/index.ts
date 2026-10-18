// ============================================================
// server/infra/sms — barrel
// ============================================================
// 短信子域：阿里云 dysmsapi 封装 + 验证码生命周期管理。
// 服务器禁止 import 任何 ffmpeg 模块（本子域零 ffmpeg 依赖）。
// ============================================================

export {
  sendCode,
  isDevMockMode,
  _resetSmsClientForTests,
  type SendSmsResult,
} from './aliyun-sms';

export {
  normalizePhone,
  genCode,
  storeCode,
  isResendLocked,
  verifyCode,
  rateLimitAllow,
} from './sms-code.service';
