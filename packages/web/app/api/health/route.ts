// ============================================================
// GET /api/health — 容器健康检查端点
// ============================================================
//
// middleware 豁免此路径（任何 UA 可访问），供 docker-compose healthcheck
// 的 wget 探测。返回 200 即代表 web 进程存活。
//
// 刻意不查 DB：健康检查只关心进程是否 up；DB 故障会通过业务接口的 500
// 暴露，不应让健康检查把整个 web 容器标记为 unhealthy（web 本身没崩）。
// ============================================================

import { NextResponse } from 'next/server';

export async function GET(): Promise<Response> {
  return NextResponse.json({ ok: true });
}
