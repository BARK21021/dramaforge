// Unit tests for ⑪ client/shell — auth-cookie refresher.
//
// The pure helpers (findSessionCookie / cookiesToHeader) need no mocks.
// startCookieRefresher takes an injectable CookieStore (no Electron dependency),
// so tests pass a controllable async store. electronCookieStore is tested with
// a plain structural session stub.

import { describe, it, expect, vi } from 'vitest';
import {
  findSessionCookie,
  cookiesToHeader,
  startCookieRefresher,
  electronCookieStore,
  type SfCookie,
  type CookieStore,
} from '../../main/auth-cookie';

function cookie(name: string, value: string, domain = 'your-domain.example.com'): SfCookie {
  return { name, value, domain };
}

describe('findSessionCookie', () => {
  it('finds the __Secure-next-auth.session-token (prod HTTPS variant)', () => {
    const cookies = [
      cookie('_ga', 'GA1.2.xxx'),
      cookie('__Secure-next-auth.session-token', 'prod-token-abc'),
      cookie('csrftoken', 'zzz'),
    ];
    expect(findSessionCookie(cookies)?.value).toBe('prod-token-abc');
  });

  it('finds next-auth.session-token (dev HTTP variant) when no __Secure variant', () => {
    const cookies = [cookie('_ga', 'x'), cookie('next-auth.session-token', 'dev-token-xyz')];
    expect(findSessionCookie(cookies)?.value).toBe('dev-token-xyz');
  });

  it('returns undefined when no session cookie is present', () => {
    const cookies = [cookie('_ga', 'x'), cookie('csrftoken', 'y')];
    expect(findSessionCookie(cookies)).toBeUndefined();
  });
});

describe('cookiesToHeader', () => {
  it('renders "name=value" for the session cookie', () => {
    const cookies = [cookie('__Secure-next-auth.session-token', 'tok-123')];
    expect(cookiesToHeader(cookies)).toBe('__Secure-next-auth.session-token=tok-123');
  });

  it('returns undefined when no session cookie is present', () => {
    expect(cookiesToHeader([cookie('_ga', 'x')])).toBeUndefined();
  });

  it('returns undefined for an empty cookie list', () => {
    expect(cookiesToHeader([])).toBeUndefined();
  });
});

describe('startCookieRefresher', () => {
  it('getAuthCookie returns undefined before the first refresh resolves', () => {
    // A store that never resolves — the cache stays undefined.
    const store: CookieStore = {
      get: () => new Promise<SfCookie[]>(() => {}),
    };
    const refresher = startCookieRefresher(store, 'your-domain.example.com', 60_000);
    expect(refresher.getAuthCookie()).toBeUndefined();
    refresher.stop();
  });

  it('caches the cookie after refreshNow resolves', async () => {
    const store: CookieStore = {
      get: vi.fn().mockResolvedValue([
        cookie('__Secure-next-auth.session-token', 'cached-tok'),
      ]),
    };
    const refresher = startCookieRefresher(store, 'your-domain.example.com', 60_000);
    await refresher.refreshNow();

    expect(refresher.getAuthCookie()).toBe('__Secure-next-auth.session-token=cached-tok');
    refresher.stop();
  });

  it('picks up cookie changes on subsequent refreshNow calls (login/logout mid-job)', async () => {
    let current = 'old-tok';
    const store: CookieStore = {
      get: vi.fn(async () => [
        cookie('__Secure-next-auth.session-token', current),
      ]),
    };
    const refresher = startCookieRefresher(store, 'your-domain.example.com', 60_000);
    await refresher.refreshNow();
    expect(refresher.getAuthCookie()).toBe('__Secure-next-auth.session-token=old-tok');

    // User re-logs in → new session token.
    current = 'new-tok-after-relogin';
    await refresher.refreshNow();
    expect(refresher.getAuthCookie()).toBe('__Secure-next-auth.session-token=new-tok-after-relogin');

    refresher.stop();
  });

  it('returns undefined after refresh when the user has logged out (no session cookie)', async () => {
    const store: CookieStore = {
      get: vi.fn().mockResolvedValue([cookie('_ga', 'x')]), // no session cookie
    };
    const refresher = startCookieRefresher(store, 'your-domain.example.com', 60_000);
    await refresher.refreshNow();
    expect(refresher.getAuthCookie()).toBeUndefined();
    refresher.stop();
  });

  it('swallows store errors without crashing (retains previous cache)', async () => {
    let shouldFail = false;
    const store: CookieStore = {
      get: vi.fn(async () => {
        if (shouldFail) throw new Error('session unavailable');
        return [cookie('__Secure-next-auth.session-token', 'stable-tok')];
      }),
    };
    const refresher = startCookieRefresher(store, 'your-domain.example.com', 60_000);
    await refresher.refreshNow();
    expect(refresher.getAuthCookie()).toBe('__Secure-next-auth.session-token=stable-tok');

    // Next refresh throws — the cache is retained (not cleared to undefined).
    shouldFail = true;
    await refresher.refreshNow();
    expect(refresher.getAuthCookie()).toBe('__Secure-next-auth.session-token=stable-tok');

    refresher.stop();
  });

  it('stop() halts further refreshes', async () => {
    const storeGet = vi.fn().mockResolvedValue([
      cookie('__Secure-next-auth.session-token', 'tok'),
    ]);
    const store: CookieStore = { get: storeGet };
    const refresher = startCookieRefresher(store, 'your-domain.example.com', 60_000);
    await refresher.refreshNow();
    const callsBefore = storeGet.mock.calls.length;

    refresher.stop();
    await refresher.refreshNow(); // no-op after stop

    expect(storeGet.mock.calls.length).toBe(callsBefore);
  });
});

describe('electronCookieStore', () => {
  it('maps an Electron-like session.cookies.get result to SfCookie[]', async () => {
    const sessionStub = {
      cookies: {
        get: vi.fn().mockResolvedValue([
          { name: '__Secure-next-auth.session-token', value: 'v1', domain: 'your-domain.example.com' },
          { name: '_ga', value: 'GA1.2.x', domain: 'your-domain.example.com' },
        ]),
      },
    };
    const store = electronCookieStore(sessionStub);
    const result = await store.get({ domain: 'your-domain.example.com' });

    expect(sessionStub.cookies.get).toHaveBeenCalledWith({ domain: 'your-domain.example.com' });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: '__Secure-next-auth.session-token',
      value: 'v1',
      domain: 'your-domain.example.com',
    });
  });
});
