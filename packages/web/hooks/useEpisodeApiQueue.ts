// ============================================================
// 按分集串行、跨集并行的 API 调用队列（移植自 app1）
// ============================================================
//
// 文件职责：
//   为每个 episodeId 维护一条 Promise 链，同集请求依次排队执行，
//   不同集之间互不阻塞。用于「多集标签页并行」场景下保证同一集内的
//   API 调用（analyze / generate-storyboard / chain-generate / shots 等）
//   不会并发，避免后端 409 或数据竞争。
//
// 与 app1 差异：无。原样移植，baseApi 类型保留 any（与 app1 一致，
//   避免引入泛型把调用方类型传播复杂化）。
// ============================================================

"use client";

import { useRef, useCallback, useEffect } from "react";

/**
 * 按分集串行、跨集并行的 API 调用队列
 *
 * @param baseApi 基础 API 调用函数（page.tsx 的 api 封装）
 * @returns
 *   - queuedApi(episodeId, url, opts?): 同集串行、跨集并行的 API 调用
 *   - clearEpisodeQueue(episodeId): 清理某集队列状态（关闭 tab 时调用）
 */
export function useEpisodeApiQueue(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseApi: (url: string, options?: RequestInit) => Promise<any>,
) {
  // 每个 episodeId 对应一条 Promise 链（尾节点）
  const chainsRef = useRef<Map<string, Promise<unknown>>>(new Map());

  const queuedApi = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (episodeId: string, url: string, options?: RequestInit): Promise<any> => {
      const prev = chainsRef.current.get(episodeId) ?? Promise.resolve();
      // 当前请求排队在前一个之后执行
      const current = prev.then(() => baseApi(url, options));
      // 更新链尾：无论成功失败都推进，避免后续请求被挂死
      chainsRef.current.set(
        episodeId,
        current.then(
          () => undefined,
          () => undefined,
        ),
      );
      return current;
    },
    [baseApi],
  );

  /** 清理某集的队列状态（关闭 tab 时调用，避免内存泄漏） */
  const clearEpisodeQueue = useCallback((episodeId: string) => {
    chainsRef.current.delete(episodeId);
  }, []);

  // M3 — unmount 兜底:组件卸载时把整张 chainsRef Map 清空,防止调用方
  // 忘了在关 tab 时逐个 clearEpisodeQueue 导致 episodeId → settled Promise
  // 的常驻引用泄漏(目前在 repo 内暂无调用方,但 hook 一旦被挂上就生效)。
  // 空依赖:只在 unmount 跑一次,clear() 是幂等的无副作用操作(pending
  // Promise 本身继续跑,Map 仅是状态跟踪)。
  useEffect(() => {
    return () => {
      chainsRef.current.clear();
    };
  }, []);

  return { queuedApi, clearEpisodeQueue };
}
