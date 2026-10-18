// ============================================================
// web/test/helpers — 请求构造与断言工具
// ============================================================
//
// 构造 NextRequest + 动态路由 ctx，避免每个测试手写 RequestInit。
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import { NextRequest } from 'next/server';

/** 构造 NextRequest，自动 JSON.stringify body + Content-Type 头 */
export function makeRequest(opts: {
  /** 路由测试覆盖 Next handler 使用的全部查询与变更方法。 */
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  searchParams?: Record<string, string>;
}): NextRequest {
  const base = opts.url ?? 'http://localhost/api';
  const url = new URL(base);
  if (opts.searchParams) {
    for (const [k, v] of Object.entries(opts.searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  const headers: Record<string, string> = { ...opts.headers };
  const method = opts.method ?? 'GET';
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    return new NextRequest(url.toString(), {
      method,
      headers,
      body: JSON.stringify(opts.body),
    });
  }
  return new NextRequest(url.toString(), { method, headers });
}

/** 构造动态路由 ctx：{ params: Promise<T> }。T 为 params 的具体形状。 */
export function makeParamsCtx<T extends Record<string, string>>(
  params: T,
): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/** 读取 Response JSON body */
export async function readJson(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}
