// ============================================================
// ToastProvider context value 引用稳定性回归测试
// ============================================================
//
// 背景（2026-07-23 生产事故）：ToastProvider 的 value 未 memo 时，任一
// toast.error 触发 setToasts → Provider 重渲染 → value 变成新对象 →
// lib/api.ts useApi 的 api（useCallback deps 含 toast）引用失效重建 →
// EpisodeWorkspace 全部 loadXxx 重建 → 数据加载 useEffect 自激重跑。
// web 502 时这个循环以 ~7次/秒 运转，请求风暴把 dramaforge-web 打到 cgroup OOM，
// 连锁导致 13 次一键出片失败（chainCompile HTTP 502）。
//
// 此测试锁住 "value 在 toasts 增删后引用不变" 这一不变量，防止有人将来
// 去掉 useMemo 或改坏 push 依赖链而无人察觉。
// ============================================================

import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import TestRenderer, { type ReactTestRenderer } from "react-test-renderer";
import { ToastProvider, useToast } from "./Toast";

// React act 环境标记：vitest 默认未设 IS_REACT_ACT_ENVIRONMENT，act() 会 warning。
// react-test-renderer 场景需显式开启，让 concurrent 模式下的状态更新在 act 内 flush。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToastProvider context value 稳定性", () => {
  it("push 触发 toasts 变化后，useToast() 返回的 value 仍是同一引用", () => {
    vi.useFakeTimers();

    // 收集每次 Consumer 渲染时拿到的 context value 引用
    const seen: Array<unknown> = [];
    let trigger: { error: (m: string) => void } | null = null;

    function Consumer() {
      seen.push(useToast());
      return null;
    }
    function Trigger() {
      trigger = useToast();
      return null;
    }

    // React 19 concurrent：initial render 必须包在 act 内 flush，
    // 否则 Consumer/Trigger 的赋值在 create 返回时尚未完成。
    let root: ReactTestRenderer | null = null;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        <ToastProvider>
          <Consumer />
          <Trigger />
        </ToastProvider>,
      );
    });

    const before = seen[seen.length - 1];
    expect(before).toBeDefined();

    // 触发 push → setToasts → Provider 重渲染 → Consumer 重渲染
    // 若 value 未 memo，Consumer 重渲染会拿到新对象 → after !== before
    TestRenderer.act(() => {
      trigger!.error("boom");
    });

    expect(seen[seen.length - 1]).toBe(before);

    root!.unmount();
    vi.useRealTimers();
  });

  it("连续多次 push（含相同消息去重）后 value 仍是同一引用", () => {
    vi.useFakeTimers();

    const seen: Array<unknown> = [];
    let trigger: { error: (m: string) => void; info: (m: string) => void } | null =
      null;

    function Consumer() {
      seen.push(useToast());
      return null;
    }
    function Trigger() {
      trigger = useToast();
      return null;
    }

    let root: ReactTestRenderer | null = null;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        <ToastProvider>
          <Consumer />
          <Trigger />
        </ToastProvider>,
      );
    });

    const before = seen[seen.length - 1];
    expect(before).toBeDefined();

    TestRenderer.act(() => {
      trigger!.error("a");
    });
    TestRenderer.act(() => {
      trigger!.error("a"); // 相同消息：shouldAddToast 去重，但 Provider 仍重渲染
    });
    TestRenderer.act(() => {
      trigger!.info("b");
    });

    expect(seen[seen.length - 1]).toBe(before);

    root!.unmount();
    vi.useRealTimers();
  });
});
