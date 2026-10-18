// ============================================================
// Redis 状态指示器 - 实时显示 Redis 服务健康状态
// ============================================================
//
// @file components/features/RedisStatus.tsx
// @description 在工作区顶部显示 Redis 服务的实时状态，
//              包括连接状态、响应时间、队列负载等关键指标。
//              支持 8 秒间隔自动轮询，异常时显示警告并阻止任务执行。
//
// dramaforge 注：本组件 1:1 镜像 app1（F:\app1\src\components\features\RedisStatus.tsx），
//          视觉/交互/轮询/类型全部对齐。app1 中本组件挂在 workspace 顶部
//          （header → GlobalGenerationStatus → RedisStatusIndicator → main）；
//          dramaforge 决策（2026-07-21）改为挂在 /settings 页（AppHeader 与 main 之间），
//          因为 dramaforge 设置页是运维向状态卡集合（已有 ClientConnectionCard 等），
//          RedisStatus 放此处更契合。挂载位置变了，组件本身一行未改。
//
// 功能（与 app1 一致）：
//   - 绿色/黄色/红色状态指示灯
//   - 实时响应时间（毫秒）
//   - 队列任务数量统计
//   - 异常时显示详细错误信息
//   - 点击展开详细检测报告
//   - 8 秒间隔轮询 /api/system/redis-status?quick=1
// ============================================================

"use client";

import { useState, useEffect, useCallback } from "react";

// ============================================================
// 类型定义
// ============================================================

interface HealthCheckItem {
  name: string;
  passed: boolean;
  latencyMs: number;
  error?: string;
}

interface RedisHealthData {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  connection: {
    host: string;
    port: number;
    db: number;
    connected: boolean;
  };
  checks: HealthCheckItem[];
  summary: {
    totalChecks: number;
    passedChecks: number;
    avgLatencyMs: number;
    maxLatencyMs: number;
  };
  queues?: Record<string, {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }>;
  serverInfo?: {
    uptimeSeconds: number;
    connectedClients: number;
    usedMemoryHuman: string;
    opsPerSecond: number;
  };
}

// ============================================================
// 组件
// ============================================================

/**
 * Redis 状态指示器
 *
 * 显示在全局进度条下方或工作区工具栏中，
 * 提供实时的 Redis 服务健康状态反馈。
 */
export function RedisStatusIndicator() {
  const [health, setHealth] = useState<RedisHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // 轮询获取 Redis 状态（每 8 秒）
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/system/redis-status?quick=1");
      if (res.ok) {
        const data = await res.json();
        setHealth(data);
      }
    } catch {
      // 网络错误时保持上一次的状态
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 立即执行一次
    fetchStatus();

    // 每 8 秒轮询
    const interval = setInterval(fetchStatus, 8000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // 首次加载中不显示
  if (loading && !health) return null;

  // 无数据时不显示
  if (!health) return null;

  const isHealthy = health.status === "healthy";
  const isDegraded = health.status === "degraded";
  const isUnhealthy = health.status === "unhealthy";

  // 计算队列总负载
  const totalWaiting =
    Object.values(health.queues || {}).reduce((sum, q) => sum + q.waiting, 0) +
    Object.values(health.queues || {}).reduce((sum, q) => sum + q.active, 0);

  return (
    <div
      className={`px-4 py-1.5 border-b text-xs transition-colors ${
        isUnhealthy
          ? "bg-[var(--error-dim)] border-[var(--error)]/30"
          : isDegraded
          ? "bg-[var(--warning-dim)] border-[var(--warning)]/30"
          : "bg-[var(--bg-elevated)] border-[var(--border-light)]"
      }`}
    >
      <div className="flex items-center gap-2 max-w-screen-xl mx-auto">
        {/* 状态指示灯 */}
        <span
          className={`inline-flex items-center justify-center w-2 h-2 rounded-full ${
            isHealthy ? "bg-[var(--success)] shadow-sm shadow-[var(--success)]/40" :
            isDegraded ? "bg-[var(--warning)] animate-pulse" :
            "bg-[var(--error)] animate-pulse shadow-sm shadow-[var(--error)]/40"
          }`}
          title={isHealthy ? "Redis 正常" : isDegraded ? "Redis 降级" : "Redis 异常"}
        />

        {/* 状态文字 */}
        <span className="text-[var(--text-3)] font-medium">
          {isHealthy ? "Redis" : isDegraded ? "Redis 降级" : "Redis 异常"}
        </span>

        {/* 响应时间 */}
        {isHealthy && (
          <span className="text-[var(--text-3)] font-mono tabular-nums">
            {health.connection?.connected ? `${health.summary?.avgLatencyMs || 0}ms` : "未连接"}
          </span>
        )}

        {/* 队列负载 */}
        {totalWaiting > 0 && (
          <span className="text-[var(--text-3)] font-mono tabular-nums">
            队列 {totalWaiting}
          </span>
        )}

        {/* 错误信息 */}
        {isUnhealthy && (
          <span className="text-[var(--error)] truncate max-w-[200px]" title="点击查看详情">
            {health.connection?.connected === false ? "连接断开" : "服务不可用"}
          </span>
        )}

        {/* 展开按钮 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-auto text-[var(--text-3)] hover:text-[var(--text)] transition-colors cursor-pointer bg-transparent border-none p-0"
          title="查看详细报告"
        >
          {expanded ? "收起" : "详情"}
        </button>
      </div>

      {/* 展开的详细信息 */}
      {expanded && (
        <RedisDetailPanel health={health} />
      )}
    </div>
  );
}

/**
 * 详细检测报告面板
 */
function RedisDetailPanel({ health }: { health: RedisHealthData }) {
  return (
    <div className="mt-2 pt-2 border-t border-[var(--border-light)] grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
      {/* 左列：连接信息 */}
      <div>
        <h4 className="font-medium text-[var(--text-2)] mb-1.5">连接信息</h4>
        <dl className="space-y-1 font-mono">
          <div className="flex justify-between">
            <dt className="text-[var(--text-3)]">地址</dt>
            <dd className="text-[var(--text)]">{health.connection?.host}:{health.connection?.port}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--text-3)]">数据库</dt>
            <dd className="text-[var(--text)]">db{health.connection?.db}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--text-3)]">状态</dt>
            <dd className={health.connection?.connected ? "text-[var(--success)]" : "text-[var(--error)]"}>
              {health.connection?.connected ? "已连接" : "未连接"}
            </dd>
          </div>
        </dl>
      </div>

      {/* 中列：检测结果 */}
      <div>
        <h4 className="font-medium text-[var(--text-2)] mb-1.5">检测结果</h4>
        <dl className="space-y-1">
          {(health.checks || []).map((check, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${check.passed ? "bg-[var(--success)]" : "bg-[var(--error)]"}`} />
              <span className="text-[var(--text-3)] flex-1 truncate">{check.name}</span>
              <span className="font-mono text-[var(--text-3)] tabular-nums">
                {check.passed ? `${check.latencyMs}ms` : check.error?.substring(0, 20)}
              </span>
            </div>
          ))}
        </dl>
        <div className="mt-1.5 pt-1.5 border-t border-[var(--border-light)] text-[var(--text-3)]">
          通过 {health.summary?.passedChecks ?? 0}/{health.summary?.totalChecks ?? 0} · 平均延迟 {health.summary?.avgLatencyMs ?? 0}ms
        </div>
      </div>

      {/* 右列：服务器信息 */}
      <div>
        <h4 className="font-medium text-[var(--text-2)] mb-1.5">服务器</h4>
        {health.serverInfo ? (
          <dl className="space-y-1 font-mono">
            <div className="flex justify-between">
              <dt className="text-[var(--text-3)]">运行时间</dt>
              <dd className="text-[var(--text)]">{formatUptime(health.serverInfo.uptimeSeconds)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--text-3)]">客户端数</dt>
              <dd className="text-[var(--text)]">{health.serverInfo.connectedClients}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--text-3)]">内存占用</dt>
              <dd className="text-[var(--text)]">{health.serverInfo.usedMemoryHuman}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--text-3)]">QPS</dt>
              <dd className="text-[var(--text)]">{health.serverInfo.opsPerSecond.toFixed(1)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-[var(--text-3)]">暂无服务器信息</p>
        )}

        {/* 队列状态 */}
        {health.queues && Object.keys(health.queues).length > 0 && (
          <>
            <h4 className="font-medium text-[var(--text-2)] mt-2 mb-1.5">队列负载</h4>
            <dl className="space-y-1 font-mono">
              {Object.entries(health.queues).map(([name, q]) => (
                <div key={name} className="flex justify-between">
                  <dt className="text-[var(--text-3)]">{name.replace("tasks-", "")}</dt>
                  <dd className="text-[var(--text)]">
                    {q.waiting + q.active > 0 ? (
                      <span className="text-[var(--warning)]">{q.waiting}等待/{q.active}执行</span>
                    ) : (
                      <span className="text-[var(--success)]/60">空闲</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>

      {/* 检测时间 */}
      <div className="col-span-full pt-1.5 border-t border-[var(--border-light)] text-[var(--text-3)] text-right">
        最后检测: {new Date(health.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}

/** 格式化运行时间为人类可读格式 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  const days = Math.floor(seconds / 86400);
  return `${days}d${Math.floor((seconds % 86400) / 3600)}h`;
}
