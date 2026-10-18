import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withDeadline } from './deadline.js';

describe('withDeadline', () => {
  it('returns a completed operation', async () => {
    await assert.doesNotReject(async () => {
      const value = await withDeadline(async () => 42, { timeoutMs: 100 });
      assert.equal(value, 42);
    });
  });

  it('settles and aborts when an operation ignores its signal', async () => {
    const captured: { signal?: AbortSignal } = {};
    await assert.rejects(
      withDeadline(
        async (signal) => {
          captured.signal = signal;
          return new Promise<number>(() => undefined);
        },
        { timeoutMs: 5, label: 'stalled test' },
      ),
      /stalled test timed out/,
    );
    assert.equal(captured.signal?.aborted, true);
  });

  it('honors an external abort', async () => {
    const controller = new AbortController();
    const pending = withDeadline(
      async () => new Promise<number>(() => undefined),
      { timeoutMs: 1_000, signal: controller.signal, label: 'abort test' },
    );
    controller.abort(new Error('interrupted'));
    await assert.rejects(pending, /interrupted/);
  });
});
