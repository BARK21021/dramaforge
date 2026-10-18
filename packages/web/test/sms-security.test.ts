// ============================================================
// 修-C signup 安全修复 — web 侧新增逻辑回归测试
// ============================================================
//
// 覆盖：
//   - lib/sms-security: extractClientIp（C4 x-real-ip / XFF / 非法 IP）、
//                       readBodyWithLimit（I6 Content-Length 拒绝）
//   - lib/response.handleApiError：M6 ZodError 不暴露 schema 细节
//
// 用 next/server 的 NextRequest 构造请求对象；纯函数测试。
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { extractClientIp, isValidIp, readBodyWithLimit } from '../lib/sms-security';
import { handleApiError } from '../lib/response';

type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function makeRequest(opts: {
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  method?: string;
}): NextRequest {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const init: NextRequestInit = {
    method: opts.method ?? 'POST',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  };
  return new NextRequest(opts.url ?? 'http://localhost/api/test', init);
}

// ------------------------------------------------------------
// C4：isValidIp / extractClientIp
// ------------------------------------------------------------

describe('isValidIp', () => {
  it('接受合法 IPv4', () => {
    expect(isValidIp('1.2.3.4')).toBe(true);
    expect(isValidIp('255.255.255.255')).toBe(true);
    expect(isValidIp('YOUR_SERVER')).toBe(true);
  });

  it('接受合法 IPv6', () => {
    expect(isValidIp('::1')).toBe(true);
    expect(isValidIp('2001:db8::1')).toBe(true);
  });

  it('拒绝非法 IP（XFF 注入攻击载荷）', () => {
    expect(isValidIp('unknown')).toBe(false);
    expect(isValidIp('')).toBe(false);
    expect(isValidIp('not-an-ip')).toBe(false);
    expect(isValidIp('999.999.999.999')).toBe(false);
    expect(isValidIp('8.8.8.8.8')).toBe(false);
    expect(isValidIp("1.2.3.4'; DROP TABLE--")).toBe(false);
  });
});

describe('extractClientIp (C4)', () => {
  it('优先取 x-real-ip', () => {
    const req = makeRequest({
      headers: { 'x-real-ip': 'YOUR_SERVER', 'x-forwarded-for': '1.1.1.1' },
    });
    expect(extractClientIp(req)).toBe('YOUR_SERVER');
  });

  it('x-real-ip 缺失时取 XFF 第一段', () => {
    const req = makeRequest({
      headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1, 192.168.1.1' },
    });
    expect(extractClientIp(req)).toBe('8.8.8.8');
  });

  it('x-real-ip 非法时回落 XFF', () => {
    const req = makeRequest({
      headers: { 'x-real-ip': 'unknown', 'x-forwarded-for': '8.8.8.8' },
    });
    expect(extractClientIp(req)).toBe('8.8.8.8');
  });

  it('development 下两 header 缺失 → 兜底 dev-loopback（dev 友好）', () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      expect(extractClientIp(makeRequest({}))).toBe('dev-loopback');
      expect(
        extractClientIp(
          makeRequest({ headers: { 'x-real-ip': 'unknown', 'x-forwarded-for': 'fake-ip' } }),
        ),
      ).toBe('dev-loopback');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('production 下两 header 缺失或非法 → null（调用方应返 400）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(extractClientIp(makeRequest({}))).toBeNull();
      expect(
        extractClientIp(
          makeRequest({ headers: { 'x-real-ip': 'unknown', 'x-forwarded-for': 'fake-ip' } }),
        ),
      ).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('XFF 含 leading whitespace 时正确 trim', () => {
    const req = makeRequest({
      headers: { 'x-forwarded-for': '   8.8.8.8, 10.0.0.1' },
    });
    expect(extractClientIp(req)).toBe('8.8.8.8');
  });
});

// ------------------------------------------------------------
// I6：readBodyWithLimit
// ------------------------------------------------------------

describe('readBodyWithLimit (I6)', () => {
  it('小 body → 正常解析', async () => {
    const req = makeRequest({ body: { phone: '13800138000' } });
    const res = await readBodyWithLimit(req, 4096);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toEqual({ phone: '13800138000' });
    }
  });

  it('Content-Length 超阈值 → 413 payload（不读取 body）', async () => {
    const req = makeRequest({
      body: { phone: '13800138000' },
      headers: { 'content-length': '99999' },
    });
    const res = await readBodyWithLimit(req, 4096);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(413);
      expect(res.payload.code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('Content-Length 缺失时仍解析（小 body 常见情形）', async () => {
    const req = makeRequest({ body: { foo: 'bar' } });
    const res = await readBodyWithLimit(req, 4096);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toEqual({ foo: 'bar' });
    }
  });

  it('Content-Length 缺失时仍按实际字节数拒绝大 body', async () => {
    const req = new NextRequest('http://localhost/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(5000) }),
    });
    const res = await readBodyWithLimit(req, 4096);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(413);
      expect(res.payload.code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('非法 JSON body → 返回空对象兜底（不抛错）', async () => {
    const init: NextRequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not valid json',
    };
    const req = new NextRequest('http://localhost/api/test', init);
    const res = await readBodyWithLimit(req, 4096);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toEqual({});
    }
  });
});

// ------------------------------------------------------------
// M6：handleApiError ZodError 不暴露 schema 细节
// ------------------------------------------------------------

describe('handleApiError: ZodError (M6 不暴露 schema 细节)', () => {
  it('对外只返回泛化"输入校验失败"提示，code=VALIDATION_ERROR', async () => {
    let thrown: unknown;
    try {
      z.object({ phone: z.string(), code: z.string().length(6) }).parse({
        phone: 123,
        code: 'x',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(z.ZodError);
    const res = handleApiError(thrown);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    // M6：错误信息是泛化提示，不应含具体字段名 / 期望类型
    expect(body.error).toBe('输入校验失败，请检查请求体字段');
  });
});
