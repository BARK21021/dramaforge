"use client";

/**
 * @file auth/signup/page.tsx
 * @description 注册页面（手机号 + 短信验证码 + 密码）
 *
 * 支持手机号 + 短信验证码 + 密码注册，注册成功后跳转到工作区。
 * 流程：
 *   1. 输入手机号，点击「获取验证码」→ POST /api/auth/sms/send
 *   2. 输入验证码 + 密码，点击「注册」→ POST /api/auth/register-phone
 *   3. 注册成功 → 调 signIn("credentials") 自动登录 → router.replace("/workspace")
 *
 * 与 signin/page.tsx 风格一致：
 *   - 品牌标题使用 --accent 琥珀（身份/品牌层）
 *   - 注册按钮 / 获取验证码按钮使用 --action 蓝（可点击行为）
 *   - 链接（去登录）使用 --action 蓝弱化
 *
 * dramaforge 视觉/交互对齐 app1（F:\app1，活的开发副本），数据层走 dramaforge 新契约。
 * 注：dramaforge signin/page.tsx 用内联 SVG 实现 Eye/EyeOff（避免单一图标引整包）。
 * 本 signup 页复用同一对内联图标，保持视觉与 signin 一致。
 *
 * @example
 * // 路由：/auth/signup
 * // 注册成功后：router.replace("/workspace")
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { useToast } from "../../../components/ui/Toast";

/**
 * EyeIcon / EyeOffIcon
 *
 * 与 signin/page.tsx 完全相同的实现（视觉一致性）。路径取自 lucide-react
 * 的 Eye / EyeOff（BSD-3，HashiCorp 与 contributors），dramaforge 未将 lucide-react
 * 用于 auth 页面以避免为单一图标引入整包。
 */
interface IconProps {
  size?: number;
}

function EyeIcon({ size = 24 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon({ size = 24 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

/** 手机号正则：11 位国内手机号，1[3-9] 开头 */
const PHONE_REGEX = /^1[3-9]\d{9}$/;

/** 密码最小长度（I2：从 6 提到 8，与 register-phone 后端策略对齐） */
const MIN_PASSWORD_LENGTH = 8;
/** 密码最大字节长度（I9：与 bcrypt 72 字节截断陷阱对齐） */
const MAX_PASSWORD_BYTES = 72;

/** 验证码长度 */
const CODE_LENGTH = 6;

/** 验证码重发倒计时（秒，与后端重发锁 60s 对齐） */
const RESEND_COUNTDOWN = 60;

export default function SignUpPage() {
  const router = useRouter();
  const toast = useToast();

  /** 手机号 */
  const [phone, setPhone] = React.useState("");
  /** 验证码 */
  const [code, setCode] = React.useState("");
  /** 密码 */
  const [password, setPassword] = React.useState("");
  /** 密码是否明文显示（眼睛切换） */
  const [showPassword, setShowPassword] = React.useState(false);
  /** 发送验证码中 */
  const [sendingCode, setSendingCode] = React.useState(false);
  /** 提交注册中 */
  const [submitting, setSubmitting] = React.useState(false);
  /** 重发倒计时（秒，>0 时按钮禁用并显示倒计时） */
  const [countdown, setCountdown] = React.useState(0);

  // 倒计时递减
  React.useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  /** 手机号是否合法 */
  const isPhoneValid = PHONE_REGEX.test(phone);
  /**
   * 密码 UTF-8 字节长度（I9：bcrypt 72 字节截断陷阱对齐）
   * 浏览器侧用 TextEncoder 取字节长度；password 输入框变化时即时计算。
   */
  const passwordBytes = React.useMemo(
    () => new TextEncoder().encode(password).length,
    [password],
  );
  /**
   * 密码是否合法（I2：≥8 位 + 至少 1 字母 + 至少 1 数字 + ≤72 字节）
   * 与 /api/auth/register-phone 后端 validatePasswordPolicy 完全对齐，
   * 避免前后端策略漂移导致用户被前端放行却后端拒绝。
   */
  const isPasswordValid =
    password.length >= MIN_PASSWORD_LENGTH &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password) &&
    passwordBytes <= MAX_PASSWORD_BYTES;
  /** 验证码是否合法 */
  const isCodeValid = code.length === CODE_LENGTH && /^\d+$/.test(code);

  /** 表单是否可提交 */
  const canSubmit = isPhoneValid && isCodeValid && isPasswordValid && !submitting;

  /** 是否可发送验证码 */
  const canSendCode = isPhoneValid && !sendingCode && countdown <= 0;

  /**
   * 发送验证码
   *
   * 调用 POST /api/auth/sms/send，成功后启动 60s 倒计时。
   */
  const handleSendCode = async () => {
    if (!isPhoneValid) {
      toast.error("请输入正确的手机号");
      return;
    }
    if (!canSendCode) return;
    setSendingCode(true);
    try {
      const res = await fetch("/api/auth/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) {
        toast.success("验证码已发送，请注意查收短信");
        setCountdown(RESEND_COUNTDOWN);
      } else {
        const errMsg = data?.error || `验证码发送失败（${res.status}）`;
        toast.error(errMsg);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未知错误";
      toast.error(`发送异常：${msg}`);
    } finally {
      setSendingCode(false);
    }
  };

  /**
   * 提交注册
   *
   * 调用 POST /api/auth/register-phone，成功后自动 signIn 跳 /workspace。
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      if (!isPhoneValid) {
        toast.error("请输入正确的手机号");
      } else if (!isCodeValid) {
        toast.error(`请输入 ${CODE_LENGTH} 位验证码`);
      } else if (!isPasswordValid) {
        toast.error(
          `密码至少 ${MIN_PASSWORD_LENGTH} 位，且需包含字母与数字`,
        );
      }
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/register-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) {
        // 注册成功 → 自动登录跳工作区
        const signInResult = await signIn("credentials", {
          login: phone,
          password,
          redirect: false,
        });
        if (signInResult?.ok) {
          toast.success("账号创建成功");
          router.replace("/workspace");
          router.refresh();
        } else {
          toast.success("账号已创建，请登录后继续");
          router.replace("/auth/signin");
        }
      } else {
        const errMsg = data?.error || `注册失败（${res.status}）`;
        const suggestion = data?.suggestion ? `\n建议：${data.suggestion}` : "";
        toast.error(`${errMsg}${suggestion}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未知错误";
      toast.error(`注册异常：${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center premium-backdrop px-4">
      {/* 注册卡片 */}
      <div className="w-full max-w-sm">
        {/* 品牌标题 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--accent-dim)] border border-[var(--accent)]/30 mb-4 shadow-[0_8px_30px_-8px_var(--accent-glow)]">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-[var(--accent)]">
              <path d="M3 3h18v18H3zM3 9l5-5M21 9l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="14" r="3" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-[var(--text)]">DramaForge AI 视频创作平台</h1>
          <p className="text-sm text-[var(--text-3)] mt-2">创建账号，马上开始创作</p>
        </div>

        {/* 注册表单 */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 手机号 */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
              手机号
            </label>
            <Input
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="请输入手机号"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
              maxLength={11}
              disabled={submitting}
              invalid={phone.length > 0 && !isPhoneValid}
            />
          </div>

          {/* 验证码 + 发送按钮 */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
              验证码
            </label>
            <div className="flex gap-2">
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={`${CODE_LENGTH} 位验证码`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
                maxLength={CODE_LENGTH}
                disabled={submitting}
                invalid={code.length > 0 && !isCodeValid}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleSendCode}
                loading={sendingCode}
                disabled={!canSendCode}
                className="flex-shrink-0 whitespace-nowrap"
              >
                {countdown > 0 ? `${countdown}s` : sendingCode ? "发送中..." : "发送验证码"}
              </Button>
            </div>
          </div>

          {/* 密码 */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
              密码
            </label>
            <Input
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位（含字母+数字）`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              invalid={password.length > 0 && !isPasswordValid}
              suffix={
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShowPassword((s) => !s)}
                  className="text-[var(--text-3)] hover:text-[var(--text)] transition-colors flex items-center"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                </button>
              }
            />
          </div>

          {/* 注册按钮 */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            disabled={!canSubmit}
            className="w-full"
          >
            {submitting ? "创建中..." : "创建账号"}
          </Button>
        </form>

        {/* 底部链接 */}
        <div className="mt-6 flex items-center justify-between text-xs">
          <Link
            href="/auth/signin"
            className="text-[var(--action)] hover:text-[var(--text)] transition-colors"
          >
            已有账号？去登录
          </Link>
          <Link
            href="/"
            className="text-[var(--text-3)] hover:text-[var(--text)] transition-colors"
          >
            返回首页
          </Link>
        </div>

        {/* 提示信息 */}
        <p className="mt-8 text-center text-xs text-[var(--text-3)]">
          注册即表示你同意平台服务条款与隐私政策
        </p>
      </div>
    </div>
  );
}
