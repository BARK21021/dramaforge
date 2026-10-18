// ============================================================
// ⑪ client/shell — NextAuth session-cookie refresher
// ============================================================
//
// Acquires the user's NextAuth session cookie from the BrowserWindow's Electron
// session (after they log into your-domain.example.com) and exposes it as a cookie
// header string for the render-worker.
//
// DESIGN — why a background refresher + sync getter:
//   The render-worker's `opts.authCookie` is a STATIC `string | undefined`
//   (read synchronously via `opts.authCookie` in ⑨'s loop.ts on each poll).
//   But Electron's `session.defaultSession.cookies.get()` is ASYNC. To bridge
//   this WITHOUT modifying ⑨'s committed code, we run a background refresher
//   that reads the cookie on an interval and caches it; `getAuthCookie()` then
//   returns the cached value synchronously. The render-worker's opts object
//   uses a property getter `get authCookie()` (constructed in main/index.ts)
//   that reads this cache on each access — so every poll cycle carries the
//   latest cookie, and a login/logout mid-job is picked up within one refresh
//   interval (default 5s, matching the render-worker poll cadence).
//
// The refresher is resilient: any read error is swallowed (the user may be
// mid-login or the session may be temporarily unavailable) — the previously
// cached cookie (if any) is retained until a successful refresh replaces it.

/** Minimal cookie shape (structurally compatible with Electron.Cookie). */
export interface SfCookie {
  name: string;
  value: string;
  domain?: string;
}

/** NextAuth session-token cookie names (prod HTTPS + dev HTTP variants). */
const SESSION_COOKIE_NAMES = [
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
] as const;

/**
 * Find the NextAuth session-token cookie among a cookie list.
 * Prefers the `__Secure-` (production HTTPS) variant when both are present.
 */
export function findSessionCookie(cookies: SfCookie[]): SfCookie | undefined {
  for (const name of SESSION_COOKIE_NAMES) {
    const found = cookies.find((c) => c.name === name);
    if (found) return found;
  }
  return undefined;
}

/** Render a `name=value` cookie header from a cookie list, or undefined. */
export function cookiesToHeader(cookies: SfCookie[]): string | undefined {
  const session = findSessionCookie(cookies);
  return session ? `${session.name}=${session.value}` : undefined;
}

/** Abstraction over an Electron session's cookie store (for testability). */
export interface CookieStore {
  get(filter: { domain: string }): Promise<SfCookie[]>;
}

/** Handle returned by `startCookieRefresher`. */
export interface CookieRefresher {
  /** Sync read of the cached cookie header. `undefined` if not yet loaded or logged out. */
  getAuthCookie(): string | undefined;
  /** Force an immediate refresh; resolves when the refresh attempt completes. */
  refreshNow(): Promise<void>;
  /** Stop the background refresh interval. Idempotent. */
  stop(): void;
}

const DEFAULT_REFRESH_MS = 5_000;

/**
 * Start a background cookie refresher that reads the NextAuth session cookie
 * from a CookieStore on an interval and caches it for sync access.
 *
 * @param store   Cookie source (wrap an Electron session via `electronCookieStore`).
 * @param domain  Cookie domain to filter by (e.g. 'your-domain.example.com').
 * @param refreshMs  Refresh interval. Default 5s (matches render-worker poll cadence).
 */
export function startCookieRefresher(
  store: CookieStore,
  domain: string,
  refreshMs: number = DEFAULT_REFRESH_MS,
): CookieRefresher {
  let current: string | undefined = undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refreshNow(): Promise<void> {
    if (stopped) return;
    try {
      const cookies = await store.get({ domain });
      current = cookiesToHeader(cookies);
    } catch {
      // Swallow — cookie read failure must not crash the app. The previously
      // cached value (if any) is retained until a successful refresh.
    }
  }

  function getAuthCookie(): string | undefined {
    return current;
  }

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Initial fire-and-forget load so the cache is populated ASAP.
  void refreshNow();
  timer = setInterval(() => {
    void refreshNow();
  }, refreshMs);

  return { getAuthCookie, refreshNow, stop };
}

/**
 * Build a CookieStore adapter over an Electron-like session object.
 *
 * Accepts a structural type (anything with `cookies.get({domain})`) so the
 * auth-cookie module stays decoupled from the Electron type import — the main
 * entry passes `session.defaultSession` here.
 */
export function electronCookieStore(
  s: { cookies: { get(filter: { domain: string }): Promise<ReadonlyArray<SfCookie>> } },
): CookieStore {
  return {
    async get(filter): Promise<SfCookie[]> {
      // Array.from converts the readonly result to a mutable SfCookie[].
      return Array.from(await s.cookies.get(filter));
    },
  };
}
