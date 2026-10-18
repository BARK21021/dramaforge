// Polling helpers for the e2e harness.

import { sleep } from '@dramaforge/shared';

// Re-export so existing `import { sleep } from './lib/wait'` callers keep working.
export { sleep };

/**
 * Poll `fn` every `intervalMs` until it returns a value (truthy or non-null),
 * or `timeoutMs` elapses. Returns the first non-null value, or null on timeout.
 */
export async function pollFor<T>(
  fn: () => Promise<T> | T,
  opts: { intervalMs: number; timeoutMs: number },
  onTick?: (attempt: number) => void,
): Promise<T | null> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < opts.timeoutMs) {
    attempt++;
    onTick?.(attempt);
    const result = await fn();
    if (result !== null && result !== undefined) return result;
    await sleep(opts.intervalMs);
  }
  return null;
}
