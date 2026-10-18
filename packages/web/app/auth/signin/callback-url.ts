/**
 * 将登录后的 callbackUrl 收敛为同源绝对路径，防 open-redirect。
 *
 * dramaforge auth 边界加固：`app/auth/signin/page.tsx` 在 `signIn({ redirect: false })`
 * 之后手动 `router.replace(callbackUrl)`，绕过了 next-auth 自身的 callbackUrl
 * allow-list。若直接把 `searchParams.get("callbackUrl")` 透传，攻击者可构造
 * `?callbackUrl=https://evil.com`，在受害者成功登录后将其重定向到钓鱼站点。
 *
 * 共 4 道检查，任一未过均回退到 `/workspace`（P3 Task 3 起登录后默认落地页）：
 *   1. 非字符串（null / undefined / 其它类型）
 *   2. 不以 `/` 开头（完整 URL 如 `https://evil.com`、相对路径 `foo/bar`）
 *   3. 以 `//` 开头（协议相对 URL `//evil.com`）
 *   4. 含裸反斜杠 `\` 或 ASCII 控制字符 U+0000–U+001F（backslash / control-char
 *      open-redirect bypass）——WHATWG URL spec 在协议相对路径状态下去除
 *      `\t` / `\n` / `\r`（ASCII 0x09 / 0x0A / 0x0D），并在 http/https 特殊
 *      scheme 下把 `\` 规范化为 `/`。故 `/\n/evil.com`、`/\t/evil.com`、
 *      `/\r/evil.com`、`/\evil.com` 均会被浏览器解析为 `//evil.com` →
 *      `http://evil.com`，是 3. 的真实 bypass（backslash 与 tab/newline/CR
 *      是同一规范规则的 siblings）。其余控制字符（NUL 等）虽不被 WHATWG
 *      特殊处理，但合法同源 callbackUrl 不含裸控制字符（应 URL-encode 成
 *      `%09` / `%0A` / `%0D` / `%00`），一律拦截不误伤。
 *
 * 显式传入合法站内绝对路径（`"/"`、`"/foo"`、`"/foo?x=1"`）原样返回——同源
 * 绝对路径本身是安全的，防护只针对跨源 / 协议相对 / backslash 与控制字符
 * bypass / 非字符串输入。app1 原版未做此校验，dramaforge 在 auth 边界加固（参见
 * .superpowers/sdd/task-1-report.md "Fix pass (I-1)"、
 * .superpowers/sdd/p3-task-3-report.md "Security fix: backslash bypass"、
 * "Security fix #2: control-char bypass"）。
 *
 * @param raw 来自 `searchParams.get("callbackUrl")`，可能为 null / undefined
 * @returns 安全的站内绝对路径，永远以 "/" 开头（缺省 `/workspace`）
 */
export function sanitizeCallbackUrl(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "/workspace";
  if (!raw.startsWith("/")) return "/workspace";
  if (raw.startsWith("//")) return "/workspace";
  // 反斜杠 + ASCII 控制字符（U+0000–U+001F）。WHATWG URL spec 在协议相对路径
  // 状态下去除 \t / \n / \r，并在 http/https 特殊 scheme 下把 `\` 规范化为 `/`，
  // 故 `/\n/evil.com` / `/\t/evil.com` / `/\r/evil.com` / `/\evil.com` 均被
  // 浏览器解析为 `//evil.com` → 跨源 open-redirect。合法同源 callbackUrl 不含
  // 裸控制字符（应 URL-encode），拦截不误伤。
  if (/[\x00-\x1f\\]/.test(raw)) return "/workspace";
  return raw;
}
