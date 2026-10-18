// ============================================================
// web/lib/sms-security — signup / sms 公开接口的请求加固工具
// ============================================================
//
// 文件职责：
//   把 C4（XFF 伪造 / 'unknown' 共享桶 DoS）+ I6（App Router 无默认 body limit）
//   共用的两段防御逻辑抽到 web/lib，避免 /sms/send 与 /register-phone 两个路由
//   各自维护一份。
//
// 函数：
//   - extractClientIp(request)  — 从 x-real-ip / XFF 第一段取合法 IP，
//                                 非法或缺失返回 null（调用方返回 400）
//   - readBodyWithLimit(request, maxBytes) — Content-Length 拒绝 + request.json()
//
// 安全约束：纯函数 + 读 NextRequest headers，无 I/O；不 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';

/**
 * IPv4 / IPv6 合法性正则
 *
 * - IPv4：四段 0-255（不严格防 leading zero，仅做基本格式校验）
 * - IPv6：粗匹配（含 :: 缩写、冒号分隔的 hex 段）
 *
 * 用途：拒绝 nginx 未正确覆写 XFF 时攻击者塞进来的任意字符串
 *       （如随机 UUID、超长串、'unknown'）落到 Redis key 共享桶或绕过限流。
 */
const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})$/;
const IPV6_RE = /^[0-9a-fA-F:]+(::[0-9a-fA-F:]*|:[0-9a-fA-F]{1,4})*$/;

/** 判定字符串是否为合法 IPv4 或 IPv6 */
export function isValidIp(ip: string): boolean {
  if (!ip) return false;
  if (IPV4_RE.test(ip)) return true;
  // IPv6 至少包含一个 ':'，长度上限 45（IPv6 max representation length）
  if (ip.includes(':') && ip.length <= 45 && IPV6_RE.test(ip)) return true;
  return false;
}

/**
 * 从请求头中提取可信的客户端 IP（C4）
 *
 * 优先级：
 *   1. `x-real-ip`（nginx 配置 proxy_set_header X-Real-IP $remote_addr 后注入；
 *      单值，攻击者无法伪造 —— 因 nginx 会覆写）
 *   2. `x-forwarded-for` 第一段（nginx 配置 proxy_set_header X-Forwarded-For $remote_addr
 *      时同上；若配置为 `$proxy_add_x_forwarded_for` 则首段仍可信）
 *   3. （仅 development）固定 'dev-loopback' 兜底：本地 `pnpm dev` 直连 3000
 *      端口无 nginx，所有 header 缺失；production 仍要求严格 nginx 注入，否则返 null
 *      由调用方返回 400 拒绝（**不**回落 'unknown' 共享桶，否则单点打满拖累全部
 *      无 XFF 用户）。
 *
 * @param request NextRequest
 * @returns 合法 IP 字符串或 null
 */
export function extractClientIp(request: NextRequest): string | null {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp && isValidIp(realIp)) return realIp;

  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first && isValidIp(first)) return first;
  }

  // Development 兜底：本地 dev 无 nginx，pnpm dev 直连 3000 端口。
  // 返回固定 'dev-loopback' 让限流仍生效（所有 dev 流量共享同一桶，单 dev 够用）。
  // production 严格走 nginx，缺失 → null → 调用方 400。
  if (process.env.NODE_ENV !== 'production') {
    return 'dev-loopback';
  }
  return null;
}

/**
 * 解析 JSON body 前的体积上限校验（I6）
 *
 * App Router 的 route handler 没有默认 body 限制（与 Express 不同），直接
 * `request.json()` 会把整段请求体载入内存；攻击者 POST 大 JSON 可触发 OOM。
 * 此 wrapper 先读 Content-Length，超阈值立即返回 413；随后逐块读取真实请求体，
 * 即使客户端使用 chunked 传输或伪造较小的 Content-Length，也不能绕过体积上限。
 *
 * @param request  NextRequest
 * @param maxBytes 上限字节，默认 4096（4KB，足够 {phone, code, password}）
 * @returns 解析后的 body；或 { errorResponse } 字段表示已构造好的 413 响应
 */
export async function readBodyWithLimit<T = unknown>(
  request: NextRequest,
  maxBytes = 4096,
): Promise<
  | { ok: true; body: T }
  | { ok: false; status: number; payload: { error: string; code: string } }
> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader) {
    const len = Number(contentLengthHeader);
    if (Number.isFinite(len) && len > maxBytes) {
      return {
        ok: false,
        status: 413,
        payload: { error: '请求体过大', code: 'PAYLOAD_TOO_LARGE' },
      };
    }
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, body: {} as T };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      // 超限后主动取消剩余流，避免继续占用网络与进程内存。
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        status: 413,
        payload: { error: '请求体过大', code: 'PAYLOAD_TOO_LARGE' },
      };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // 保持历史契约：非法或空 JSON 返回空对象，具体字段仍交给下游 Zod 校验。
  try {
    const raw = new TextDecoder().decode(bytes);
    return { ok: true, body: (raw ? JSON.parse(raw) : {}) as T };
  } catch {
    return { ok: true, body: {} as T };
  }
}
