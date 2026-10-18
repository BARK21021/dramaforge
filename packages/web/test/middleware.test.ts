// ============================================================
// middleware — UA 软屏障 + dev 放开浏览器
// ============================================================
//
// 覆盖契约（task-2-brief）：
//   - NODE_ENV=development 时一律 NextResponse.next()：浏览器可访问页面
//     （用于本地调试与 slice 验证，slice 用浏览器 GET / 检查渲染）。
//   - NODE_ENV=production（或未设置）时 UA gate 严格执行：
//       * 非 Electron UA → redirect 到 /download
//       * Electron UA     → 放行
//       * /api/*           → 始终放行（render-worker / orchestrator 等 Node 主进程
//                            bare-fetch，UA 不含 Electron）
//       * /download        → 始终放行（避免重定向循环）
//
// 既有 NextResponse.redirect 默认 status=307（Next 16），测试用 3xx 区间断言
// 以解耦实现细节，关键点放在 location 头是否指向 /download。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 StarframeCS/1.0.0 Electron/30.0.0';

/** 构造 NextRequest，给定路径与 UA */
function makeReq(pathname: string, ua: string): NextRequest {
  return new NextRequest(new URL(pathname, 'http://localhost').toString(), {
    method: 'GET',
    headers: { 'user-agent': ua },
  });
}

/** 放行：非 3xx，且无 location 头 */
function assertPassThrough(res: Response): void {
  expect(res.status).toBe(200);
  expect(res.headers.get('location')).toBeNull();
}

/** 非 Electron 在 prod 被 404 屏蔽：web 访问全封，下载统一走外部 nginx 入口
 *  （your-domain.example.com/download）。早期版本是 302→/download，后改为直接 404。 */
function assertBlocked(res: Response): void {
  expect(res.status).toBe(404);
  expect(res.headers.get('location')).toBeNull();
}

function setNodeEnv(val: 'development' | 'production' | undefined): void {
  // vi.stubEnv 改写 process.env 并同步 TS 类型；val=undefined 时 vitest 删除键。
  // unstubAllEnvs() 会恢复到首次 stub 前的值（vitest 默认 NODE_ENV='test'）。
  vi.stubEnv('NODE_ENV', val);
}

beforeEach(() => {
  // 清掉上个测试遗留的 stub，避免 describe 级 beforeEach 设值被覆盖
  vi.unstubAllEnvs();
});

afterEach(() => {
  // 恢复到 vitest 启动时的 NODE_ENV（'test'）
  vi.unstubAllEnvs();
});

describe('middleware — dev mode (NODE_ENV=development) UA gate disabled', () => {
  beforeEach(() => setNodeEnv('development'));

  it('dev + 浏览器 UA → 放行 / （slice 验证场景）', () => {
    assertPassThrough(proxy(makeReq('/', BROWSER_UA)));
  });

  it('dev + 浏览器 UA → 放行 /auth/signin', () => {
    assertPassThrough(proxy(makeReq('/auth/signin', BROWSER_UA)));
  });

  it('dev + 浏览器 UA → 放行 /api/health（API 始终豁免）', () => {
    assertPassThrough(proxy(makeReq('/api/health', BROWSER_UA)));
  });

  it('dev + 浏览器 UA → 放行 /download（不形成重定向循环）', () => {
    assertPassThrough(proxy(makeReq('/download', BROWSER_UA)));
  });

  it('dev + Electron UA → 同样放行（dev 比 prod 更宽松，不收紧）', () => {
    assertPassThrough(proxy(makeReq('/', ELECTRON_UA)));
  });
});

describe('middleware — prod mode (NODE_ENV=production) UA gate enforced', () => {
  beforeEach(() => setNodeEnv('production'));

  it('prod + 浏览器 UA → 404（web 访问全封，下载走外部 nginx）', () => {
    assertBlocked(proxy(makeReq('/', BROWSER_UA)));
  });

  it('prod + 浏览器 UA → /auth/signin 也 404', () => {
    assertBlocked(proxy(makeReq('/auth/signin', BROWSER_UA)));
  });

  it('prod + Electron UA → 放行（客户端主路径）', () => {
    assertPassThrough(proxy(makeReq('/', ELECTRON_UA)));
  });

  it('prod + 浏览器 UA → /api/* 放行（API 始终豁免，render-worker bare-fetch）', () => {
    assertPassThrough(proxy(makeReq('/api/render/jobs', BROWSER_UA)));
  });

  it('prod + 浏览器 UA → /download 放行（避免重定向循环）', () => {
    assertPassThrough(proxy(makeReq('/download', BROWSER_UA)));
  });

  it('prod + 空 UA（curl / bot）→ 404', () => {
    assertBlocked(proxy(makeReq('/', '')));
  });
});

describe('middleware — NODE_ENV 未设置时按 prod 处理（默认安全）', () => {
  beforeEach(() => setNodeEnv(undefined));

  it('unset NODE_ENV + 浏览器 UA → 404（prod 是默认）', () => {
    assertBlocked(proxy(makeReq('/', BROWSER_UA)));
  });
});
