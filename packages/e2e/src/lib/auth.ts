// NextAuth credentials login helper for local E2E scripts.

import { withDeadline } from './deadline.js';

const ELECTRON_UA = 'DramaForge-E2E Electron/43.0.0';

function setCookieValues(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === 'function') return extended.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function mergeCookies(target: Map<string, string>, headers: Headers): void {
  for (const value of setCookieValues(headers)) {
    // Node 24 exposes getSetCookie(), so each value normally contains exactly
    // one cookie. The fallback still safely captures the first name/value.
    const pair = value.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0) target.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function asCookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Log the seeded E2E user in through the real NextAuth credentials flow. */
export async function loginE2eUser(
  apiBase: string,
  login: string,
  password: string,
  signal?: AbortSignal,
): Promise<string> {
  const cookies = new Map<string, string>();
  const csrfBody = await withDeadline(async (requestSignal) => {
    const csrfResponse = await fetch(`${apiBase}/api/auth/csrf`, {
      headers: { 'User-Agent': ELECTRON_UA },
      signal: requestSignal,
    });
    if (!csrfResponse.ok) {
      throw new Error(`NextAuth CSRF request failed: HTTP ${csrfResponse.status}`);
    }
    mergeCookies(cookies, csrfResponse.headers);
    return (await csrfResponse.json()) as { csrfToken?: unknown };
  }, { signal, label: 'NextAuth CSRF request' });
  if (typeof csrfBody.csrfToken !== 'string' || csrfBody.csrfToken.length === 0) {
    throw new Error('NextAuth CSRF response did not contain csrfToken');
  }

  const form = new URLSearchParams({
    csrfToken: csrfBody.csrfToken,
    login,
    password,
    callbackUrl: apiBase,
    json: 'true',
  });
  await withDeadline(async (requestSignal) => {
    const loginResponse = await fetch(`${apiBase}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': ELECTRON_UA,
        Cookie: asCookieHeader(cookies),
      },
      body: form,
      signal: requestSignal,
    });
    if (loginResponse.status >= 400) {
      throw new Error(`NextAuth credentials login failed: HTTP ${loginResponse.status}`);
    }
    mergeCookies(cookies, loginResponse.headers);
  }, { signal, label: 'NextAuth credentials login' });

  const sessionCookie = [...cookies].find(([name]) =>
    name.endsWith('next-auth.session-token'),
  );
  if (!sessionCookie) throw new Error('NextAuth login did not issue a session cookie');
  return `${sessionCookie[0]}=${sessionCookie[1]}`;
}
