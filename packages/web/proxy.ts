// ============================================================
// web/proxy.ts — 客户端专属网关（UA 软屏障，仅 gate 页面）
// ============================================================
//
// 目的：阻止普通浏览器直接访问 your-domain.example.com 的页面（登录页 /auth/signin、
// 应用页面），重定向到"请下载桌面客户端"提示页。Electron 客户端 UA 含
// "Electron/" 放行。
//
// ⚠️ 这是 UX / 软屏障，不是真正的安全措施：
//   - User-Agent 可被一行 `curl -H "User-Agent: ...Electron..."` 伪造。
//   - 真正的安全边界是认证（账号密码 + JWT + 单设备踢人），早已就位；没有
//     有效凭据的人即便绕过本 gate 也登录不了。
//   - 后续硬化：叠加 HMAC 时间戳签名 attestation（客户端签名、服务端校验时间
//     窗），把门槛从"伪造 UA"抬到"逆向 exe 提取 secret"。
//
// 为什么【只 gate 页面，不 gate /api/*】：
//   客户端的 render-worker / orchestrators 跑在 Electron 主进程（Node），用
//   globalThis.fetch 发请求——Node 的 UA 不含 "Electron/"。它们打的是
//   /api/render/jobs/*、/api/generate/* 等。若对 /api/* 拦非 Electron，会
//   直接掐断 FILM_EXPORT 链路（客户端拉不到任务）。
//   只 gate 页面：浏览器载不入登录页 → 登不了录 → 无 session → 受保护 API
//   （render/generate/sse）自然返回 401，同样挡住"浏览器烧 credits"，且不
//   误伤客户端主进程的 bare-fetch。
//
// 非 Electron 访问的处置：
//   /api/*            → 一律放行（含 /api/health 健康检查、/api/client/* 机器级）
//   /download         → 放行（避免重定向循环）
//   其余页面（含 /auth/signin、根 /）→ 302 重定向到 /download
//
// dev 放开（NODE_ENV=development）：跳过整个 UA gate，一律 NextResponse.next()。
// 原因：开发期需要用普通浏览器查看页面做 UI 调试 / slice 验证，gate 会把浏览器
// 跳到 /download 导致无法访问。生产行为【不变】：NODE_ENV 未设或 =production 时
// 上面的 UA 规则全量生效。
// ============================================================

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ELECTRON_UA = /Electron\//;

/** Mutation HTTP methods covered by the Origin / CSRF check below. */
const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * C2 — allow-list of Origins permitted to issue mutation requests against
 * /api/*. Always includes the prod cloud UI origin + the local Next dev
 * server. SF_DEV_URL / NEXTAUTH_URL are appended when set so a single env
 * knob configures the client, NextAuth, and this gate consistently.
 *
 * Computed once at module load (env is fixed per process). Returns a Set for
 * O(1) lookup on the hot path.
 */
function buildAllowedOrigins(): Set<string> {
  const origins = new Set<string>([
    'https://your-domain.example.com',
    'http://localhost:3000',
  ]);
  for (const raw of [process.env.SF_DEV_URL, process.env.NEXTAUTH_URL]) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    try {
      const u = new URL(raw);
      origins.add(`${u.protocol}//${u.host}`);
    } catch {
      /* ignore malformed env values — fail closed on the lookup, not at boot */
    }
  }
  return origins;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  // ------------------------------------------------------------
  // C2 — CSRF / Origin defense for mutation API routes (dev + prod).
  // ------------------------------------------------------------
  // Browsers ALWAYS send `Origin` + `Sec-Fetch-Site` on cross-origin
  // mutation requests, so a malicious site driving a user's browser into
  // POSTing to our API surfaces here as either a non-allowlisted Origin or
  // a `cross-site` Sec-Fetch-Site. We block both.
  //
  // Origin-absent requests are allowed through: Node's fetch (used by the
  // Electron main-process workers — render-worker / heartbeat / updater /
  // logger — see loop.ts:202, heartbeat.ts:68, uploader.ts:21) does NOT set
  // an Origin header, and those routes authenticate via session cookie +
  // machineId, not CSRF tokens. Same for Sec-Fetch-Site (Node never emits
  // Fetch Metadata headers). Browsers cannot be coerced into omitting
  // either header, so the CSRF surface stays closed where it matters.
  //
  // /api/auth/* is exempt: NextAuth v4 issues its own CSRF token + cookie
  // and POSTs to /api/auth/callback/*; an Origin check there would collide.
  if (
    MUTATION_METHODS.has(method) &&
    pathname.startsWith('/api/') &&
    !pathname.startsWith('/api/auth/')
  ) {
    const origin = req.headers.get('origin');
    if (origin !== null && !ALLOWED_ORIGINS.has(origin)) {
      return NextResponse.json(
        { error: 'Forbidden: invalid Origin', code: 'CSRF_FORBIDDEN' },
        { status: 403 },
      );
    }
    // Defense-in-depth: browsers also send Sec-Fetch-Site. Reject anything
    // explicitly marked cross-site (allow same-origin / same-site / none).
    const secFetchSite = req.headers.get('sec-fetch-site');
    if (
      secFetchSite !== null &&
      secFetchSite !== 'same-origin' &&
      secFetchSite !== 'same-site' &&
      secFetchSite !== 'none'
    ) {
      return NextResponse.json(
        { error: 'Forbidden: cross-site mutation blocked', code: 'CSRF_FORBIDDEN' },
        { status: 403 },
      );
    }
  }

  // dev：放开 UA gate，允许浏览器访问页面（本地调试 / slice 验证）。
  // 注意：CSRF 块（上方）在 dev 仍跑——安全检查不随 NODE_ENV 退化为 noop。
  // NODE_ENV 未设时按 prod 处理（默认安全）。
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.next();
  }

  // API 一律放行：避免误伤客户端主进程的 bare-fetch（render-worker /
  // orchestrator / heartbeat / updater / logger，UA 不含 Electron）。
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // /download 自身放行（避免重定向循环）
  if (pathname === '/download') {
    return NextResponse.next();
  }
  // /downloads（有 s）是 nginx 的固定下载入口（302 落到最新版 .exe），同样放行不重定向。
  if (pathname === '/downloads' || pathname === '/downloads/') {
    return NextResponse.next();
  }

  // Electron 客户端放行（默认 UA 含 "Electron/x.y.z"）
  const ua = req.headers.get('user-agent') ?? '';
  if (ELECTRON_UA.test(ua)) {
    return NextResponse.next();
  }

  // 非 Electron（浏览器 / bot / curl）→ 404：根域名及任何非下载页面都不可访问。
  // 下载入口统一走 https://your-domain.example.com/download（nginx 直接 302 到最新 .exe）。
  return new NextResponse(null, { status: 404 });
}

// matcher：大视频上传由 route 自行做同等 CSRF 校验；排除后 Next 不再克隆整段正文，
// 让客户端流可以按背压直达 Kimi，避免 100MiB 视频在 384MiB web 容器内形成多份副本。
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/projects/[^/]+/episodes/[^/]+/video-to-script).*)',
  ],
};
