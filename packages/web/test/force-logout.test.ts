import { describe, expect, it } from 'vitest';
import {
  FORCE_LOGOUT_REASON_KEY,
  isProtectedPath,
  isAuthEndpoint,
  shouldForceLogoutOn401,
} from '../lib/force-logout';

describe('isProtectedPath', () => {
  it('treats the landing page and auth routes as non-protected (no force-logout loop)', () => {
    expect(isProtectedPath('/')).toBe(false);
    expect(isProtectedPath('/auth/signin')).toBe(false);
    expect(isProtectedPath('/auth/signup')).toBe(false);
    expect(isProtectedPath('/auth')).toBe(false);
  });

  it('treats workspace / settings / admin as protected', () => {
    expect(isProtectedPath('/workspace')).toBe(true);
    expect(isProtectedPath('/workspace/abc-123')).toBe(true);
    expect(isProtectedPath('/workspace/abc/episodes/ep1')).toBe(true);
    expect(isProtectedPath('/settings')).toBe(true);
    expect(isProtectedPath('/admin/users')).toBe(true);
  });

  it('is defensive on null/undefined/empty', () => {
    expect(isProtectedPath(null)).toBe(false);
    expect(isProtectedPath(undefined)).toBe(false);
    expect(isProtectedPath('')).toBe(false);
  });
});

describe('isAuthEndpoint', () => {
  it('flags NextAuth internal endpoints', () => {
    expect(isAuthEndpoint('/api/auth/signin')).toBe(true);
    expect(isAuthEndpoint('/api/auth/callback/credentials')).toBe(true);
    expect(isAuthEndpoint('/api/auth/session')).toBe(true);
    expect(isAuthEndpoint('/api/auth/signout')).toBe(true);
  });

  it('passes through ordinary API routes', () => {
    expect(isAuthEndpoint('/api/projects/123')).toBe(false);
    expect(isAuthEndpoint('/api/tasks?status=RUNNING')).toBe(false);
    expect(isAuthEndpoint('/api/health')).toBe(false);
  });
});

describe('shouldForceLogoutOn401', () => {
  it('forces logout on a 401 to a protected business route', () => {
    expect(shouldForceLogoutOn401(401, '/api/projects/123', '/workspace')).toBe(true);
  });

  it('does NOT force logout on NextAuth internal 401 (login flow, avoid loop)', () => {
    expect(
      shouldForceLogoutOn401(401, '/api/auth/callback/credentials', '/auth/signin'),
    ).toBe(false);
    expect(
      shouldForceLogoutOn401(401, '/api/auth/session', '/workspace'),
    ).toBe(false);
  });

  it('does NOT force logout when already on a public page (avoid logged-out loop)', () => {
    expect(shouldForceLogoutOn401(401, '/api/projects/123', '/')).toBe(false);
    expect(shouldForceLogoutOn401(401, '/api/projects/123', '/auth/signin')).toBe(false);
  });

  it('ignores non-401 statuses', () => {
    expect(shouldForceLogoutOn401(200, '/api/projects/123', '/workspace')).toBe(false);
    expect(shouldForceLogoutOn401(403, '/api/projects/123', '/workspace')).toBe(false);
    expect(shouldForceLogoutOn401(500, '/api/projects/123', '/workspace')).toBe(false);
  });
});

describe('FORCE_LOGOUT_REASON_KEY', () => {
  it('is a stable, namespaced storage key shared by guard and landing', () => {
    expect(FORCE_LOGOUT_REASON_KEY).toBe('sf_force_logout_reason');
  });
});
