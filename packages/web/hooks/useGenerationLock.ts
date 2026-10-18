// ============================================================
// 生成锁 store — 防止同集/同镜头并发触发生成（移植自 app1）
// ============================================================
//
// 文件职责：
//   维护「某 key 正在生成中」的客户端锁状态，避免用户连点按钮触发重复
//   API 调用。锁持久化到 localStorage（刷新页面不丢），3 天 stale 自动失效。
//
//   - useSyncExternalStore 订阅模块级 Map（内存）+ localStorage（持久层）
//   - 同一 prefix 的列表查询有快照缓存，避免每次渲染重算
//
// 与 app1 差异：
//   - 仅文件位置从 app/workspace/[projectId]/components/generation-lock-store.ts
//     迁到 dramaforge hooks/ 顶层（dramaforge 没有该项目内 components 目录，hooks 是
//     统一存放点）。
//   - 行为/契约不变。
// ============================================================

"use client";

import { useSyncExternalStore } from "react";

export interface GenerationLockEntry {
  key: string;
  scope: string;
  projectId?: string;
  episodeId?: string;
  taskId?: string | null;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

const STORAGE_KEY = "workspace_generation_locks_v1";
const STALE_MS = 1000 * 60 * 60 * 24 * 3; // 3 天

const locks = new Map<string, GenerationLockEntry>();
const subscribers = new Set<() => void>();
let hydrated = false;
let snapshotVersion = 0;
const prefixSnapshotCache = new Map<
  string,
  { version: number; value: GenerationLockEntry[] }
>();

function emitChange(): void {
  snapshotVersion += 1;
  prefixSnapshotCache.clear();
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function persist(): void {
  if (!canUseStorage()) return;
  const payload = Array.from(locks.values());
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function hydrate(): void {
  if (hydrated || !canUseStorage()) return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof item.key !== "string") continue;
      const entry = item as GenerationLockEntry;
      if (!entry.updatedAt || now - entry.updatedAt > STALE_MS) continue;
      locks.set(entry.key, entry);
    }
    persist();
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

/** 读取某个 key 的锁（非 Hook，可在任意位置调用） */
export function getGenerationLock(key: string): GenerationLockEntry | null {
  hydrate();
  return locks.get(key) || null;
}

/** 列出所有（或某 prefix 下）的锁（非 Hook） */
export function listGenerationLocks(prefix?: string): GenerationLockEntry[] {
  hydrate();
  const all = Array.from(locks.values());
  if (!prefix) return all;
  return all.filter((entry) => entry.key.startsWith(prefix));
}

/** 写入/更新一把锁 */
export function setGenerationLock(
  entry: Omit<GenerationLockEntry, "createdAt" | "updatedAt"> &
    Partial<Pick<GenerationLockEntry, "createdAt" | "updatedAt">>,
): void {
  hydrate();
  const current = locks.get(entry.key);
  const now = Date.now();
  locks.set(entry.key, {
    ...current,
    ...entry,
    createdAt: current?.createdAt || entry.createdAt || now,
    updatedAt: entry.updatedAt || now,
  });
  persist();
  emitChange();
}

/** 清除某把锁 */
export function clearGenerationLock(key: string): void {
  hydrate();
  if (!locks.has(key)) return;
  locks.delete(key);
  persist();
  emitChange();
}

/** 按 taskId 清除锁（任务终态时调用，避免遗留悬挂锁） */
export function clearGenerationLockByTaskId(taskId: string): void {
  if (!taskId) return;
  hydrate();
  let changed = false;
  for (const [key, entry] of locks.entries()) {
    if (entry.taskId === taskId) {
      locks.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  persist();
  emitChange();
}

function getEntrySnapshot(key: string): GenerationLockEntry | null {
  hydrate();
  return locks.get(key) || null;
}

function getPrefixSnapshot(prefix: string): GenerationLockEntry[] {
  hydrate();
  const cached = prefixSnapshotCache.get(prefix);
  if (cached && cached.version === snapshotVersion) {
    return cached.value;
  }
  const value = Array.from(locks.values()).filter((entry) =>
    entry.key.startsWith(prefix),
  );
  prefixSnapshotCache.set(prefix, { version: snapshotVersion, value });
  return value;
}

// SSR 快照：服务端永远返回「无锁」（不会有锁状态泄漏到首屏 HTML）
const serverEntrySnapshot: GenerationLockEntry | null = null;
const serverListSnapshot: GenerationLockEntry[] = [];

/** 该 key 是否被锁定 */
export function useGenerationLock(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!getEntrySnapshot(key),
    () => false,
  );
}

/** 该 key 的完整锁条目（null 表示未锁） */
export function useGenerationLockEntry(key: string): GenerationLockEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => getEntrySnapshot(key),
    () => serverEntrySnapshot,
  );
}

/** 某 prefix 下所有锁条目 */
export function useGenerationLocks(prefix: string): GenerationLockEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => getPrefixSnapshot(prefix),
    () => serverListSnapshot,
  );
}
