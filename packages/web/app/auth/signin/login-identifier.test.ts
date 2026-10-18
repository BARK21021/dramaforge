import { describe, expect, it } from "vitest";

describe("登录标识校验", () => {
  it("允许管理员使用邮箱登录", async () => {
    const modulePath = "./login-identifier";
    const loginIdentifier = await import(/* @vite-ignore */ modulePath).catch(() => ({}));
    const validate = (loginIdentifier as Record<string, unknown>).isValidLoginIdentifier;

    expect(validate).toBeTypeOf("function");
    expect((validate as (value: string) => boolean)("admin@local.dramaforge")).toBe(true);
  });

  it("允许使用合法手机号登录", async () => {
    const modulePath = "./login-identifier";
    const loginIdentifier = await import(/* @vite-ignore */ modulePath).catch(() => ({}));
    const validate = (loginIdentifier as Record<string, unknown>).isValidLoginIdentifier;

    expect(validate).toBeTypeOf("function");
    // 13800138000：以 13 开头 + 共 11 位 → 匹配 PHONE_REGEX /^1[3-9]\d{9}$/
    expect((validate as (value: string) => boolean)("13800138000")).toBe(true);
  });

  it("拒绝既非手机号也非邮箱的输入", async () => {
    const modulePath = "./login-identifier";
    const loginIdentifier = await import(/* @vite-ignore */ modulePath).catch(() => ({}));
    const validate = (loginIdentifier as Record<string, unknown>).isValidLoginIdentifier;

    expect(validate).toBeTypeOf("function");
    // "foo" 既不匹配 PHONE_REGEX 也不匹配 EMAIL_REGEX
    expect((validate as (value: string) => boolean)("foo")).toBe(false);
  });

  it("拒绝空字符串", async () => {
    const modulePath = "./login-identifier";
    const loginIdentifier = await import(/* @vite-ignore */ modulePath).catch(() => ({}));
    const validate = (loginIdentifier as Record<string, unknown>).isValidLoginIdentifier;

    expect(validate).toBeTypeOf("function");
    // 空字符串 trim 后仍为空，两条 regex 均不匹配
    expect((validate as (value: string) => boolean)("")).toBe(false);
  });
});
