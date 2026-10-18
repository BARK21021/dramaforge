// ============================================================
// Redis 状态 API - 实时健康监测 + 轮询反馈（dramaforge 版）
// ============================================================
//
// @file app/api/system/redis-status/route.ts
//
// 1:1 镜像 app1（F:\app1\src\app\api\system\redis-status\route.ts +
// F:\app1\src\core\config\redis-health.ts）的三模式结构 + 健康检查逻辑。
// dramaforge 差异（无功能行为变更）：
//   - 连接：app1 用 host/port/password/db 分字段；dramaforge 统一用 REDIS_URL
//     （docker-compose 友好），连接信息直接读 ioredis 实例 options。
//   - 实例复用：调 @dramaforge/server barrel 暴露的 getRedis()（⑦ infra 单例），
//     绝不新建连接；本 route 与 /api/sse、BullMQ 队列共用同一 ioredis 实例。
//   - 健康逻辑：app1 抽到 core/config/redis-health.ts 因多消费者（queue 入队预检 /
//     app 启动 waitForRedisReady）。dramaforge 仅本 route 一个消费者 → 内联到本文件，
//     避免在 server 包多开一个文件（YAGNI）。
//   - 鉴权：对齐 app1 —— 无鉴权（app1 同款）。/settings 页本身在登录态后才能进入，
//     此端点暴露的 host/port/uptime/memory 是低敏感运维指标，与 app1 暴露面一致。
//
// @endpoints
//   GET /api/system/redis-status          - 单次完整检查（返回 JSON）
//   GET /api/system/redis-status?stream=1 - SSE 流式推送（持续监测，8秒间隔）
//   GET /api/system/redis-status?quick=1  - 快速 Ping 检测（轻量级，适合高频轮询）
//
// @response 健康报告结构：
//   {
//     status: "healthy" | "degraded" | "unhealthy",
//     connection: { host, port, db, connected },
//     checks: [{ name, passed, latencyMs, error }],
//     summary: { totalChecks, passedChecks, avgLatencyMs },
//     serverInfo: { uptimeSeconds, usedMemoryHuman, ... }
//   }
//
// 降级（redis 没起 / 连不通）：
//   - quick：仍返 200，body.status="unhealthy", connection.connected=false
//     （quickPing 内部 catch，永不抛；route 的 try/catch 是兜底）
//   - 完整检查：status="unhealthy" → HTTP 503；degraded → 200；healthy → 200
//   - 前端组件只 fetch ?quick=1，永远拿到 200 + 状态体，不会因 redis 故障报错。
// ============================================================

import { NextRequest } from "next/server";
import type { Redis } from "ioredis";
import { getRedis } from "@dramaforge/server";

// ============================================================
// 类型定义（对齐 app1 redis-health.ts）
// ============================================================

type RedisHealthStatus = "healthy" | "degraded" | "unhealthy";

interface HealthCheck {
  name: string;
  passed: boolean;
  latencyMs?: number;
  error?: string;
}

interface RedisHealthReport {
  status: RedisHealthStatus;
  connection: {
    host: string;
    port: number;
    db: number;
    connected: boolean;
  };
  checks: HealthCheck[];
  summary: {
    totalChecks: number;
    passedChecks: number;
    avgLatencyMs: number;
  };
  serverInfo?: {
    uptimeSeconds?: number;
    usedMemoryHuman?: string;
    connectedClients?: number;
    version?: string;
  };
  timestamp: string;
  error?: string;
  latencyMs?: number;
}

// ============================================================
// 健康检查 helper（对齐 app1 redis-health.ts，inline 因仅本 route 消费）
// ============================================================

/**
 * 获取 Redis 连接信息（从 ioredis 实例 options 读取）。
 *
 * dramaforge 用 REDIS_URL 连接串，ioredis 解析后填到 options.host/port/db；
 * 与 app1 的 getRedis 一致。redis.status 由 ioredis 维护，常见值：
 * "wait" | "reconnecting" | "connecting" | "connect" | "ready" | "close" | "end"
 */
function getConnectionInfo(redis: Redis) {
  const options = redis.options;
  return {
    host: options.host || "localhost",
    port: options.port || 6379,
    db: options.db || 0,
    connected:
      redis.status === "ready" ||
      redis.status === "connect" ||
      redis.status === "connecting",
  };
}

/**
 * 快速 Ping 检测（对齐 app1 quickPing）
 *
 * 仅 PING/PONG + 5s 超时，约 5-20ms。高频轮询用。
 * 内部 try/catch 永不抛 —— 调用方拿到 unhealthy 报告而非异常。
 */
async function quickPing(): Promise<RedisHealthReport> {
  const redis = getRedis();
  const timestamp = new Date().toISOString();
  const connection = getConnectionInfo(redis);

  try {
    const start = Date.now();
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("PING 超时（5s）")), 5_000),
      ),
    ]);
    const latencyMs = Date.now() - start;

    const passed = pong === "PONG";
    const checks: HealthCheck[] = [
      { name: "PING", passed, latencyMs, error: passed ? undefined : `响应: ${pong}` },
    ];

    return {
      status: passed ? "healthy" : "unhealthy",
      connection: { ...connection, connected: passed },
      checks,
      summary: {
        totalChecks: 1,
        passedChecks: passed ? 1 : 0,
        avgLatencyMs: latencyMs,
      },
      timestamp,
      latencyMs,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      status: "unhealthy",
      connection: { ...connection, connected: false },
      checks: [{ name: "PING", passed: false, error }],
      summary: { totalChecks: 1, passedChecks: 0, avgLatencyMs: 0 },
      timestamp,
      error,
      latencyMs: 0,
    };
  }
}

/**
 * 完整 Redis 健康检查（对齐 app1 checkRedisHealth）
 *
 * 检测项：PING / SET-GET / INFO（每项独立 5s 超时）。
 * 核心检查（PING + SET/GET）都过为 healthy；核心过但 INFO 失败为 degraded；
 * 核心失败为 unhealthy。
 */
async function checkRedisHealth(): Promise<RedisHealthReport> {
  const redis = getRedis();
  const timestamp = new Date().toISOString();
  const connection = getConnectionInfo(redis);
  const checks: HealthCheck[] = [];

  // 检查 1: PING
  try {
    const start = Date.now();
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("超时")), 5_000)),
    ]);
    const latencyMs = Date.now() - start;
    checks.push({ name: "PING", passed: pong === "PONG", latencyMs });
  } catch (err) {
    checks.push({ name: "PING", passed: false, error: err instanceof Error ? err.message : String(err) });
  }

  // 检查 2: SET/GET 读写
  try {
    const testKey = `__health_check_${Date.now()}`;
    const testVal = "ok";
    const start = Date.now();
    await redis.set(testKey, testVal, "EX", 10);
    const got = await redis.get(testKey);
    await redis.del(testKey);
    const latencyMs = Date.now() - start;
    checks.push({ name: "SET/GET", passed: got === testVal, latencyMs });
  } catch (err) {
    checks.push({ name: "SET/GET", passed: false, error: err instanceof Error ? err.message : String(err) });
  }

  // 检查 3: 服务器信息（INFO）
  let serverInfo: RedisHealthReport["serverInfo"];
  try {
    const start = Date.now();
    const info = await Promise.race([
      redis.info(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("超时")), 5_000)),
    ]);
    const latencyMs = Date.now() - start;
    checks.push({ name: "INFO", passed: !!info, latencyMs });
    // 解析 INFO 输出
    const getInfo = (key: string): string | undefined => {
      const m = info.match(new RegExp(`^${key}:([^\\r\\n]+)`, "m"));
      return m?.[1];
    };
    serverInfo = {
      uptimeSeconds: parseInt(getInfo("uptime_in_seconds") || "0", 10),
      usedMemoryHuman: getInfo("used_memory_human"),
      connectedClients: parseInt(getInfo("connected_clients") || "0", 10),
      version: getInfo("redis_version"),
    };
  } catch (err) {
    checks.push({ name: "INFO", passed: false, error: err instanceof Error ? err.message : String(err) });
  }

  // 汇总统计
  const totalChecks = checks.length;
  const passedChecks = checks.filter((c) => c.passed).length;
  const latencies = checks
    .filter((c) => c.passed && c.latencyMs !== undefined)
    .map((c) => c.latencyMs!);
  const avgLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

  // 状态判定（与 app1 一致）：
  // 核心（PING + SET/GET）都过 → healthy/degraded；否则 unhealthy
  const corePassed = checks.slice(0, 2).every((c) => c.passed);
  const status: RedisHealthStatus = corePassed
    ? passedChecks === totalChecks
      ? "healthy"
      : "degraded"
    : "unhealthy";

  return {
    status,
    connection: { ...connection, connected: corePassed },
    checks,
    summary: { totalChecks, passedChecks, avgLatencyMs },
    serverInfo,
    timestamp,
    error:
      status === "unhealthy"
        ? "Redis 核心检查失败（PING 或 SET/GET 未通过）"
        : undefined,
    latencyMs: avgLatencyMs,
  };
}

/**
 * 创建 Redis 健康检查轮询器（对齐 app1 createRedisPoller）
 *
 * 周期性 checkRedisHealth → onStatusChange 回调。用于 SSE 流式推送。
 * 返回 { start, destroy }；running flag 防止上次检测未完成时重叠。
 */
function createRedisPoller(opts?: {
  intervalMs?: number;
  onStatusChange?: (report: RedisHealthReport) => void;
  onError?: (error: Error) => void;
}): { start: () => void; destroy: () => void } {
  const intervalMs = opts?.intervalMs ?? 8_000;
  const onStatusChange = opts?.onStatusChange;
  const onError = opts?.onError;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const report = await checkRedisHealth();
      if (onStatusChange) onStatusChange(report);
    } catch (err) {
      if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
    },
    destroy() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
    },
  };
}

// ============================================================
// Route handler
// ============================================================

/**
 * GET /api/system/redis-status - Redis 状态查询
 *
 * 支持三种模式（对齐 app1）：
 *   - 默认：执行完整健康检查（3 项检测，约 100-500ms）
 *   - ?quick=1：仅执行 PING/PONG 测试（约 5-20ms）
 *   - ?stream=1：SSE 流式推送，每 8 秒自动刷新一次状态
 */
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const isStream = url.searchParams.get("stream") === "1";
  const isQuick = url.searchParams.get("quick") === "1";

  // ---- 模式 3: SSE 流式推送 ----
  if (isStream) {
    return createSSEResponse(request);
  }

  // ---- 模式 2: 快速 Ping ----
  if (isQuick) {
    try {
      const result = await quickPing();
      return Response.json(result);
    } catch (err) {
      return Response.json(
        {
          status: "unhealthy",
          latencyMs: 0,
          connected: false,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        },
        { status: 503 },
      );
    }
  }

  // ---- 模式 1: 完整检查（默认）----
  try {
    const report = await checkRedisHealth();
    const httpStatus =
      report.status === "healthy"
        ? 200
        : report.status === "degraded"
        ? 200
        : 503;
    return Response.json(report, { status: httpStatus });
  } catch (err) {
    return Response.json(
      {
        status: "unhealthy",
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}

/**
 * 创建 SSE 流式响应（对齐 app1）
 *
 * 每 8 秒推送一次完整的 Redis 健康检查结果，
 * 支持 heartbeat 保活和客户端断开检测。
 */
function createSSEResponse(request: NextRequest): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // 发送初始连接确认
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`,
        ),
      );

      // 启动轮询器
      const poller = createRedisPoller({
        intervalMs: 8000,
        onStatusChange(report) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "health_report", ...report })}\n\n`),
          );
        },
        onError(error) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", message: error.message, timestamp: new Date().toISOString() })}\n\n`,
            ),
          );
        },
      });

      poller.start();

      // 心跳保活（30秒间隔）
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`:heartbeat\n\n`));
      }, 30_000);

      // 清理函数
      request.signal.addEventListener("abort", () => {
        poller.destroy();
        clearInterval(heartbeat);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // 禁用 Nginx 缓冲
    },
  });
}
