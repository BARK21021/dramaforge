// Pure utilities — no I/O, no server-only deps. Safe for client + server.
// Uses the Web Crypto API global (`crypto.randomUUID`), available in Node 18+
// and modern browsers/Electron. Typed via the `DOM` lib in tsconfig.base.json.

/** Generate a random ID (UUID v4). */
export function genId(): string {
  return globalThis.crypto.randomUUID();
}

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `fn` with exponential backoff.
 * - On success, returns the resolved value.
 * - On failure, retries up to `opts.tries` total attempts.
 * - Throws the last error after all attempts are exhausted.
 * Backoff: opts.backoffMs * 2^(attemptIndex-1) before attempt N>=2.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries: number; backoffMs: number },
): Promise<T> {
  const { tries, backoffMs } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Parse a URL string. Returns null if invalid (instead of throwing).
 * Uses the WHATWG URL parser via `new URL(s)`; any parse error yields null.
 */
export function parseUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}
