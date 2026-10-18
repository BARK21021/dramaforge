/**
 * @file ChangePasswordModal.tsx
 * @description 修改密码弹窗（批1，移植 app1）
 *
 * 字段：当前密码 + 新密码 + 确认。新密码至少 8 位且同时包含字母、数字，
 * 并要求两次输入一致且不能复用当前密码；策略与后端路由保持一致。
 * 提交：POST /api/user/change-password，后端验证旧密码后以 bcrypt 更新凭据。
 *
 * 双色方案铁律：确认修改按钮 --action 蓝（行为）；标题/锁图标 --accent（身份）。
 *
 * @example
 * <ChangePasswordModal open={open} onClose={() => setOpen(false)} />
 */
"use client";

import * as React from "react";
import { signOut } from "next-auth/react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input } from "./Input";
import { useToast } from "./Toast";
import { finishPasswordChange } from "./change-password-session";

/** 密码策略与注册及后端 change-password route 对齐。 */
const MIN_PASSWORD_LENGTH = 8;

function meetsPasswordPolicy(password: string): boolean {
  return (
    password.length >= MIN_PASSWORD_LENGTH &&
    /[A-Za-z]/.test(password) &&
    /\d/.test(password)
  );
}

export interface ChangePasswordModalProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
}

export function ChangePasswordModal({ open, onClose }: ChangePasswordModalProps) {
  const toast = useToast();

  const [oldPassword, setOldPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  /** 弹窗关闭时清空表单 */
  React.useEffect(() => {
    if (!open) {
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSubmitting(false);
    }
  }, [open]);

  /** 新密码合法性 */
  const isNewPasswordValid =
    meetsPasswordPolicy(newPassword) && newPassword !== oldPassword;
  /** 两次输入一致 */
  const isConfirmMatch = confirmPassword.length > 0 && newPassword === confirmPassword;
  /** 表单是否可提交 */
  const canSubmit = oldPassword.length > 0 && isNewPasswordValid && isConfirmMatch && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      if (oldPassword.length === 0) toast.error("请输入当前密码");
      else if (!meetsPasswordPolicy(newPassword))
        toast.error(`新密码至少 ${MIN_PASSWORD_LENGTH} 位，并同时包含字母和数字`);
      else if (newPassword === oldPassword) toast.error("新密码不能与当前密码相同");
      else if (!isConfirmMatch) toast.error("两次输入的新密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        suggestion?: string;
      };
      if (res.ok && data?.success) {
        toast.success("密码修改成功，请使用新密码重新登录");
        // 后端已撤销当前 JWT；显式 signOut 负责删除浏览器 cookie 并跳回登录页。
        await finishPasswordChange(onClose, (options) => signOut(options));
      } else {
        const errMsg = data?.error || `修改失败 (${res.status})`;
        const suggestion = data?.suggestion ? `\n建议：${data.suggestion}` : "";
        toast.error(`${errMsg}${suggestion}`);
      }
    } catch (err) {
      toast.error(`修改异常: ${(err as Error)?.message || "未知错误"}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={() => onClose()} title="修改密码" maxWidthClassName="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 当前密码 */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
            当前密码
          </label>
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="请输入当前密码"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            disabled={submitting}
            autoFocus
          />
        </div>

        {/* 新密码 */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
            新密码
          </label>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位，包含字母和数字`}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
            invalid={newPassword.length > 0 && !isNewPasswordValid}
          />
          {newPassword.length > 0 && newPassword === oldPassword && (
            <p className="mt-1 text-xs text-[var(--warning)]">新密码不能与当前密码相同</p>
          )}
        </div>

        {/* 确认新密码 */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
            确认新密码
          </label>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="请再次输入新密码"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
            invalid={confirmPassword.length > 0 && !isConfirmMatch}
          />
          {confirmPassword.length > 0 && !isConfirmMatch && (
            <p className="mt-1 text-xs text-[var(--error)]">两次输入的新密码不一致</p>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex gap-3 justify-end pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={submitting} disabled={!canSubmit}>
            {submitting ? "更新中..." : "确认修改"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
