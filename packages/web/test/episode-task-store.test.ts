import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDraft,
  setDraft,
  clearDraft,
  getTaskId,
  setTaskId,
  clearTaskId,
} from "../lib/episode-task-store";

// vitest environment is 'node'（见 vitest.config.ts）—— 无 localStorage。
// 提供 in-memory stub 让 store 能真正读写（验证 round-trip 语义）。
class MemStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).localStorage = new MemStorage();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe("episode-task-store draft", () => {
  it("draft 按 projectId+episodeId 隔离读写清", () => {
    setDraft("p1", "e1", "hello");
    expect(getDraft("p1", "e1")).toBe("hello");
    expect(getDraft("p1", "e2")).toBeNull();
    expect(getDraft("p2", "e1")).toBeNull();
    clearDraft("p1", "e1");
    expect(getDraft("p1", "e1")).toBeNull();
  });

  it("setDraft 覆盖旧值", () => {
    setDraft("p1", "e1", "first");
    setDraft("p1", "e1", "second");
    expect(getDraft("p1", "e1")).toBe("second");
  });

  it("clearDraft 不存在的 key 不报错", () => {
    expect(() => clearDraft("p", "e")).not.toThrow();
  });
});

describe("episode-task-store taskId", () => {
  it("taskId 按 type+episodeId 隔离", () => {
    setTaskId("STORY_ANALYZE", "e1", "t1");
    expect(getTaskId("STORY_ANALYZE", "e1")).toBe("t1");
    expect(getTaskId("SHOT_AI", "e1")).toBeNull();
    expect(getTaskId("STORY_ANALYZE", "e2")).toBeNull();
  });

  it("clearTaskId 只清对应 type+episodeId", () => {
    setTaskId("STORY_ANALYZE", "e1", "t1");
    setTaskId("SHOT_AI", "e1", "t2");
    clearTaskId("STORY_ANALYZE", "e1");
    expect(getTaskId("STORY_ANALYZE", "e1")).toBeNull();
    expect(getTaskId("SHOT_AI", "e1")).toBe("t2");
  });

  it("keys prefixed with dramaforge:", () => {
    setDraft("p1", "e1", "text");
    setTaskId("STORY_ANALYZE", "e1", "t1");
    expect(localStorage.getItem("dramaforge:draft:p1:e1")).toBe("text");
    expect(localStorage.getItem("dramaforge:task:STORY_ANALYZE:e1")).toBe("t1");
  });
});

describe("episode-task-store SSR safety", () => {
  it("localStorage undefined 时所有函数不抛错且返回 null", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(() => getDraft("p", "e")).not.toThrow();
    expect(() => setDraft("p", "e", "x")).not.toThrow();
    expect(() => clearDraft("p", "e")).not.toThrow();
    expect(() => getTaskId("STORY_ANALYZE", "e")).not.toThrow();
    expect(() => setTaskId("STORY_ANALYZE", "e", "t")).not.toThrow();
    expect(() => clearTaskId("STORY_ANALYZE", "e")).not.toThrow();
    expect(getDraft("p", "e")).toBeNull();
    expect(getTaskId("STORY_ANALYZE", "e")).toBeNull();
  });
});
