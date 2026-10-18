import { describe, expect, it } from "vitest";
import { sanitizeCallbackUrl } from "./callback-url";

describe("callbackUrl 净化（防 open-redirect）", () => {
  it("保留合法的站内绝对路径", () => {
    expect(sanitizeCallbackUrl("/workspace")).toBe("/workspace");
  });

  it("保留查询字符串", () => {
    expect(sanitizeCallbackUrl("/auth/signin?x=1")).toBe("/auth/signin?x=1");
  });

  it("保留显式根路径（同源绝对路径，安全）", () => {
    expect(sanitizeCallbackUrl("/")).toBe("/");
  });

  it("保留任意站内绝对路径", () => {
    expect(sanitizeCallbackUrl("/foo")).toBe("/foo");
  });

  // I-1 open-redirect 回归：以下三类输入必须落到站内路径，不得透传到跨源
  it("拒绝完整 URL（https://evil.com → /workspace，I-1 回归）", () => {
    expect(sanitizeCallbackUrl("https://evil.com")).toBe("/workspace");
  });

  it("拒绝协议相对 URL（//evil.com → /workspace，I-1 回归）", () => {
    expect(sanitizeCallbackUrl("//evil.com")).toBe("/workspace");
  });

  it("空字符串回退到 /workspace（不以 / 开头分支）", () => {
    expect(sanitizeCallbackUrl("")).toBe("/workspace");
  });

  it("null / undefined 回退到 /workspace（非字符串分支）", () => {
    expect(sanitizeCallbackUrl(null)).toBe("/workspace");
    expect(sanitizeCallbackUrl(undefined)).toBe("/workspace");
  });

  // backslash open-redirect bypass 回归：`/\evil.com` 以 `/` 开头、不以 `//`
  // 开头，但 WHATWG URL spec 在 http/https 特殊 scheme 下把 `\` 规范化为 `/`，
  // 浏览器把 `router.replace("/\\evil.com")` 解析为 `//evil.com` → `http://evil.com`
  // —— I-1 的真实 bypass，必须拦。
  it("拒绝 backslash open-redirect bypass（/\\evil.com → /workspace）", () => {
    expect(sanitizeCallbackUrl("/\\evil.com")).toBe("/workspace");
  });

  it("拒绝含裸反斜杠的路径（/foo\\bar → /workspace）", () => {
    expect(sanitizeCallbackUrl("/foo\\bar")).toBe("/workspace");
  });

  // control-char open-redirect bypass 回归：`/\t/evil.com`、`/\n/evil.com`、
  // `/\r/evil.com` 以 `/` 开头、不以 `//` 开头、不含反斜杠，但 WHATWG URL spec
  // 在协议相对路径状态下去除 \t / \n / \r，浏览器把 router.replace("/\n/evil.com")
  // 解析为 `//evil.com` → `http://evil.com` —— backslash bypass 的 sibling
  // （同一规范规则），opus reviewer 用 Node `new URL()` 实测确认 bypass，必须拦。
  it("拒绝 tab control-char open-redirect bypass (/\\t/evil.com → /workspace)", () => {
    expect(sanitizeCallbackUrl("/\t/evil.com")).toBe("/workspace");
  });

  it("拒绝 newline control-char open-redirect bypass (/\\n/evil.com → /workspace)", () => {
    expect(sanitizeCallbackUrl("/\n/evil.com")).toBe("/workspace");
  });

  it("拒绝 CR control-char open-redirect bypass (/\\r/evil.com → /workspace)", () => {
    expect(sanitizeCallbackUrl("/\r/evil.com")).toBe("/workspace");
  });

  it("拒绝 NUL 等 ASCII 控制字符（拦全 U+0000–U+001F，不只 \\t\\n\\r）", () => {
    // NUL 不被 WHATWG 去除（pct-encoded），但合法 callbackUrl 不含裸 NUL，
    // 一律拦截证明 regex 覆盖整个 control 范围，不只 tab/newline/CR。
    expect(sanitizeCallbackUrl("/\0evil")).toBe("/workspace");
  });
});
