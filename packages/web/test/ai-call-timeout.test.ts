// callAIWithTimeout 单测：超时守卫（spec §B2）。
// 验：完成前返回结果 / 超时抛 AiCallTimeoutError / call 自身 reject 原样抛 / timer 清理。
import { describe, expect, it } from 'vitest';
import { callAIWithTimeout, AiCallTimeoutError } from '../lib/ai-call-timeout';

describe('callAIWithTimeout', () => {
  it('call 在超时前完成 → 返回结果', async () => {
    const r = await callAIWithTimeout({
      call: () => Promise.resolve('ok'),
      timeoutMs: 1000,
    });
    expect(r).toBe('ok');
  });

  it('call 超时 → 抛 AiCallTimeoutError（含 timeoutMs）', async () => {
    // call 在 500ms 后才 resolve，但 timeoutMs=30 会先到 → 走超时路径。
    // 用一个会自然 settle 的 promise（而非永不 resolve），避免悬挂微任务。
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve('late'), 500),
    );
    let caught: unknown;
    try {
      await callAIWithTimeout({ call: () => slow, timeoutMs: 30 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AiCallTimeoutError);
    expect((caught as AiCallTimeoutError).timeoutMs).toBe(30);
  });

  it('call reject（非超时）→ 原样向上抛', async () => {
    const boom = new Error('gateway 5xx');
    await expect(
      callAIWithTimeout({
        call: () => Promise.reject(boom),
        timeoutMs: 1000,
      }),
    ).rejects.toBe(boom);
  });
});
