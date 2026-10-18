// ============================================================
// useInFlightGeneration — 同步直连路由的轻量 in-flight 生命周期层
// ============================================================
//
// 背景（批9 轻量方案，不反转 P7.3 同步直连）：
//   app1 的生成走 BullMQ 异步任务，有完整 taskId + SSE + task_events 持久化 +
//   snapshot/replay，前端刷新/关 tab 都能恢复 in-flight 状态。dramaforge 在 P7.3/P7.4
//   rush 砍了这套（1690 行 MVP），同步直连路由（analyze/storyboard/asset/image）
//   只在 HTTP handler 里 block，**刷新页面 = 丢 in-flight 状态**（local state 重置、
//   按钮可重复触发、用户不知后端还在跑）。
//
// 本 hook 在不引入异步任务系统的前提下补回「刷新不丢」：
//   - 复用已移植的 useGenerationLock substrate（localStorage，3 天 stale TTL）做
//     in-flight 标记。sync-direct 阶段此前**既不写也不读**——本 hook 接上写+读。
//   - 生成 handler：start() 写锁（fetch 前）→ end() 清锁（finally，成功/失败都清）。
//     正常完成时锁被 finally 清掉；**只有刷新中断（finally 没跑）时锁才残留**。
//   - mount reconcile：读残留锁 → 查现有 DB 状态（episode.status / shots 数 /
//     asset.imageUrl）判 running/done/failed → done/failed 自动清锁 + onCompleted。
//     pollMs > 0 时周期复查（gen 完成后自动收尾），maxPolls 防悬挂锁无限轮询。
//
// 与 app1 的差异（接受）：
//   - 无进度 %（同步直连无中间信号，pulse 保留）。
//   - 非 analyze 路由 running/failed 不可分（DB 无 GENERATING 状态，靠「结果是否
//     出现」判 done，靠 reset() 逃逸悬挂）。
//   - 无 SSE / task_events 持久化 / snapshot replay（那是完整批9 的范围）。
//
// 纯客户端，无后端改动，无 DB schema 改动。GC-5 ✓ GC-7（行为等价：刷新不丢）✓
// ============================================================

"use client";

import { useEffect, useRef } from "react";
import {
  useGenerationLockEntry,
  setGenerationLock,
  clearGenerationLock,
  type GenerationLockEntry,
} from "./useGenerationLock";

/** reconcile 判定：running 留锁；done/failed 清锁并触发 onCompleted。null = 跳过。 */
export type ReconcileResult = "running" | "done" | "failed";

export interface UseInFlightGenerationOpts {
  /** 锁 key，如 `storyboard:${episodeId}` / `analyze:${episodeId}`。 */
  key: string;
  /** 锁 scope（与 useGenerationLock 一致，便于按 prefix 列举）。 */
  scope: string;
  projectId?: string | null;
  episodeId?: string | null;
  /**
   * 对照 DB 判定 in-flight 状态。返回 done/failed 自动清锁；running 留锁继续轮询；
   * null 跳过本轮（DB 还没信号）。抛错按 null 处理（不崩）。
   */
  reconcile?: () => Promise<ReconcileResult | null>;
  /** reconcile 返回 done/failed 后调用（锁已清），如 onRefresh 刷数据 / 失败 toast。 */
  onCompleted?: (result: ReconcileResult) => void;
  /** 锁活时轮询间隔 ms。0 = 仅 mount 一次性 reconcile（不轮询）。 */
  pollMs?: number;
  /** 最大轮询次数，防悬挂锁无限轮询。默认 30（8s × 30 = 4min）。 */
  maxPolls?: number;
}

export interface UseInFlightGenerationHandle {
  /** 锁是否存在（刷新不丢，跨 tab/重开存活）。 */
  isGenerating: boolean;
  /** 完整锁条目（null 表示未锁），可读 metadata。 */
  entry: GenerationLockEntry | null;
  /** 写锁——生成 fetch 前调用。metadata 存 beforeCount 等供 reconcile 对比。 */
  start: (metadata?: Record<string, unknown>) => void;
  /** 清锁——finally 里调用（成功/失败都清）。正常完成路径。 */
  end: () => void;
  /** 清锁——用户主动重置/重试逃逸悬挂锁（非正常路径）。 */
  reset: () => void;
}

export function useInFlightGeneration(
  opts: UseInFlightGenerationOpts,
): UseInFlightGenerationHandle {
  const {
    key,
    scope,
    projectId,
    episodeId,
    reconcile,
    onCompleted,
    pollMs = 0,
    maxPolls = 30,
  } = opts;
  const entry = useGenerationLockEntry(key);
  const isGenerating = !!entry;

  // ref 持有最新回调，避免 effect 依赖频繁重建（reconcile/onCompleted 多为内联闭包）。
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  const start = (metadata?: Record<string, unknown>) => {
    setGenerationLock({
      key,
      scope,
      projectId: projectId ?? undefined,
      episodeId: episodeId ?? undefined,
      metadata,
    });
  };
  const end = () => clearGenerationLock(key);
  const reset = () => clearGenerationLock(key);

  // mount + 锁存活期间 reconcile；done/failed 自动清锁。
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let polls = 0;

    const run = async () => {
      const fn = reconcileRef.current;
      if (!fn) return;
      let r: ReconcileResult | null;
      try {
        r = await fn();
      } catch {
        r = null; // reconcile 失败不崩，留锁等下一轮/用户 reset。
      }
      if (cancelled) return;
      if (r === "done" || r === "failed") {
        clearGenerationLock(key);
        onCompletedRef.current?.(r);
      }
    };

    void run();
    if (pollMs > 0) {
      timer = setInterval(() => {
        polls += 1;
        if (polls > maxPolls) {
          if (timer) clearInterval(timer);
          return; // 超过上限停止轮询；锁仍留，靠用户 reset 逃逸。
        }
        void run();
      }, pollMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [entry, key, pollMs, maxPolls]);

  return { isGenerating, entry, start, end, reset };
}
