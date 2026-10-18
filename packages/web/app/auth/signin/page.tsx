"use client";

/**
 * @file auth/signin/page.tsx
 * @description 登录页面
 *
 * 支持手机号或管理员邮箱 + 密码登录，登录成功后跳转到工作区。
 * 使用 next-auth 的 signIn（credentials provider），实际鉴权由
 * @core/api/auth 配置的 authorize 函数处理（登录标识 → 用户查询 → bcrypt 校验）。
 *
 * 双色方案铁律：
 *   - 登录按钮使用 --action 蓝（可点击行为）
 *   - 品牌标题使用 --accent 琥珀（身份/品牌层）
 *   - 链接（注册/忘记密码）使用 --action 蓝弱化（可点击但非主要行为）
 *
 * 注：useSearchParams() 必须包裹在 <Suspense> 边界中，否则 Next.js 构建时
 * 静态预渲染会报错。默认导出是 Suspense 包装器，实际内容在 SignInContent 中。
 *
 * @example
 * // 路由：/auth/signin
 * // 登录成功后：router.replace(callbackUrl)（默认 `/workspace`——P3 Task 3 起
 * // sanitizeCallbackUrl 的 fallback 已从 `/` 改到 `/workspace`，登录后落地项目列表）
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { useToast } from "../../../components/ui/Toast";
import { isValidLoginIdentifier } from "./login-identifier";
import { sanitizeCallbackUrl } from "./callback-url";

/**
 * EyeIcon / EyeOffIcon
 *
 * dramaforge 未依赖 lucide-react（app1 的 `^1.21.0` 在公共 npm 上不存在，且为单一图标
 * 引入整包并不划算）。这里以等价 SVG 内联实现：路径取自 lucide-react 的 Eye /
 * EyeOff（BSD-3，HashiCorp 与 contributors），视觉与 lucide 一致。仅保留
 * stroke 描边、currentColor 继承父级文本色，跟 lucide `<Eye size={16} />` 行为
 * 对齐。sign-in 页面只需要 size 一个 prop，故未做更通用抽象。
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

/** 密码最小长度 */
const MIN_PASSWORD_LENGTH = 6;

/**
 * 登录页面内容组件
 * 使用 useSearchParams 读取 callbackUrl / error 参数
 */
function SignInContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();

  // 登录成功后的跳转地址（默认 /workspace——P3 Task 3 起 sanitizeCallbackUrl
  // 的 fallback 改到 /workspace；显式传 callbackUrl 时透传合法站内路径）
  // 通过 sanitizeCallbackUrl 收敛为同源绝对路径，防 open-redirect
  // （ signIn redirect:false 绕过了 next-auth 的 callbackUrl allow-list ）。
  const callbackUrl = sanitizeCallbackUrl(searchParams?.get("callbackUrl"));
  // 登录失败时的错误提示（next-auth 回跳时带 error 参数）
  const authError = searchParams?.get("error");

  /** 手机号或管理员邮箱 */
  const [login, setLogin] = React.useState("");
  /** 密码 */
  const [password, setPassword] = React.useState("");
  /** 密码是否明文显示（眼睛切换） */
  const [showPassword, setShowPassword] = React.useState(false);
  /** 提交中 */
  const [submitting, setSubmitting] = React.useState(false);

  // next-auth 回跳错误提示
  React.useEffect(() => {
    if (authError) {
            toast.error("登录失败，请检查登录账号和密码");
    }
  }, [authError, toast]);

  /** 表单是否可提交 */
  const canSubmit =
    isValidLoginIdentifier(login) && password.length >= MIN_PASSWORD_LENGTH && !submitting;

  /**
   * 提交登录
   *
   * 调用 next-auth signIn（credentials provider），由后端 authorize 校验。
   * 成功：redirect: false 模式下手动跳转 callbackUrl
   * 失败：signIn 返回 { error: string | null }
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      if (!isValidLoginIdentifier(login)) {
              toast.error("请输入正确的手机号或管理员邮箱");
      } else if (password.length < MIN_PASSWORD_LENGTH) {
              toast.error(`密码至少需要 ${MIN_PASSWORD_LENGTH} 位`);
      }
      return;
    }
    setSubmitting(true);
    try {
      const result = await signIn("credentials", {
        login: login.trim(),
        password,
        redirect: false,
      });
      if (result?.error) {
              toast.error("登录账号或密码错误");
      } else if (result?.ok) {
              toast.success("登录成功");
        router.replace(callbackUrl);
        // router.refresh 触发 Server Components 重新读取 session
        router.refresh();
      } else {
              toast.error("登录失败，请稍后重试");
      }
    } catch (err: any) {
            toast.error(`登录异常：${err?.message || "未知错误"}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center premium-backdrop px-4">
      {/* 登录卡片 */}
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
              <p className="text-sm text-[var(--text-3)] mt-2">登录后继续你的创作流程</p>
        </div>

        {/* 登录表单 */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 手机号或管理员邮箱 */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
                  手机号 / 管理员邮箱
            </label>
            <Input
              type="text"
              inputMode="email"
              autoComplete="username"
                  placeholder="请输入手机号或管理员邮箱"
              value={login}
              onChange={(e) => setLogin(e.target.value.slice(0, 254))}
              maxLength={254}
              disabled={submitting}
              invalid={login.length > 0 && !isValidLoginIdentifier(login)}
            />
          </div>

          {/* 密码 */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
                  密码
            </label>
            <Input
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
                  placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              invalid={password.length > 0 && password.length < MIN_PASSWORD_LENGTH}
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

          {/* 登录按钮 */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            disabled={!canSubmit}
            className="w-full"
          >
                {submitting ? "登录中..." : "立即登录"}
          </Button>
        </form>

        {/* 底部链接 */}
        <div className="mt-6 flex items-center justify-between text-xs">
          {/* 注册页已接入短信安全策略；这里保留与登录并列的公开入口。 */}
          <Link
            href="/auth/signup"
            className="text-[var(--action)] hover:text-[var(--text)] transition-colors"
          >
                没有账号？去注册
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
               登录即表示你同意平台服务条款与隐私政策
        </p>
      </div>
    </div>
  );
}

/**
 * 登录页面默认导出
 * 用 Suspense 包裹 SignInContent，满足 Next.js 对 useSearchParams 的静态生成要求
 */
export default function SignInPage() {
  return (
    <React.Suspense fallback={null}>
      <SignInContent />
    </React.Suspense>
  );
}
