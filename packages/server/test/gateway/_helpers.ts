// ============================================================
// ② server/gateway — 测试共享工具
// ============================================================
//
// 提供：
//   - mockFetch: 按 URL/方法匹配返回预设响应，记录所有调用
//   - jsonResponse: 构造 Response 对象
//   - CALLS: 取出 fetch mock 的调用记录（url, init）
//
// 所有 provider 测试 mock global fetch，绝不发起真实 API 请求。
// ============================================================

import { vi } from 'vitest';

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * 构造 JSON Response
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 构造 OpenAI 兼容的 SSE Response，供流式文本 provider 测试使用。 */
export function sseResponse(events: unknown[], status = 200): Response {
  const body = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * 构造二进制 Response（TTS/ComfyUI /view 下载）
 */
export function binaryResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status });
}

/**
 * mock global fetch。
 *
 * @param matcher  URL 子串匹配（或自定义谓词）→ 返回 Response | Promise<Response>
 *                  支持按调用顺序回退：第一次匹配到的 handler 生效
 * @returns        spy，含 calls 副本
 */
export function mockFetch(
  handlers: Array<{ match: string | ((url: string, init?: RequestInit) => boolean); response: Response | (() => Response | Promise<Response>) }>,
): { calls: FetchCall[]; mock: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    for (const h of handlers) {
      const matched =
        typeof h.match === 'string' ? url.includes(h.match) : h.match(url, init);
      if (matched) {
        return typeof h.response === 'function' ? await h.response() : h.response;
      }
    }
    // 默认：返回空 200，便于测试聚焦关键调用
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

/** 从 init.body 解析 JSON（断言为 string） */
export function bodyJson(call: FetchCall | undefined): Record<string, unknown> {
  if (!call?.init?.body) return {};
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** 从 init.headers 取指定头（大小写不敏感） */
export function header(call: FetchCall | undefined, name: string): string | undefined {
  const headers = call?.init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  const record = headers as Record<string, string>;
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return undefined;
}
