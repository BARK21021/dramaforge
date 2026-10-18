import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 直接调用 NextAuth callback/provider，锁定“JWT 会话戳必须与数据库一致”的真实鉴权缝隙。
 * 测试不连接数据库，也不签发真实 JWT；token 形状与 NextAuth 解密后的载荷一致。
 */
describe('NextAuth active session stamp', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('only exposes the authenticated user when the JWT stamp matches the database', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ role: 'VIP' }],
      rowCount: 1,
    });
    vi.doMock('../../src/infra/pg', () => ({ query }));

    const { authOptions } = await import('../../src/infra/auth');
    const callback = authOptions.callbacks?.session;
    expect(callback).toBeTypeOf('function');

    const result = await callback!({
      session: {
        user: { name: '测试用户', email: 'user@example.com' },
        expires: '2099-01-01T00:00:00.000Z',
      },
      token: { id: 'user-1', stamp: 'stamp-current', role: 'FREE' },
    } as never);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"activeSessionStamp" = $2'),
      ['user-1', 'stamp-current'],
    );
    expect(result.user).toMatchObject({ id: 'user-1', role: 'VIP' });
    // 会话响应不得把可撤销凭据回传给浏览器。
    expect(JSON.stringify(result)).not.toContain('stamp-current');
  });

  it('rejects a superseded JWT without exposing whether the user still exists', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.doMock('../../src/infra/pg', () => ({ query }));

    const { authOptions } = await import('../../src/infra/auth');
    const callback = authOptions.callbacks?.session;
    const result = await callback!({
      session: {
        user: { name: '测试用户', email: 'user@example.com' },
        expires: '2099-01-01T00:00:00.000Z',
      },
      token: { id: 'user-1', stamp: 'stamp-old', role: 'VIP' },
    } as never);

    expect(result.user).not.toHaveProperty('id');
    expect(result.user).not.toHaveProperty('role');
  });

  it('fails closed for legacy JWTs without a stamp and avoids a needless query', async () => {
    const query = vi.fn();
    vi.doMock('../../src/infra/pg', () => ({ query }));

    const { authOptions } = await import('../../src/infra/auth');
    const callback = authOptions.callbacks?.session;
    const result = await callback!({
      session: {
        user: { name: '旧会话' },
        expires: '2099-01-01T00:00:00.000Z',
      },
      token: { id: 'user-1', role: 'FREE' },
    } as never);

    expect(query).not.toHaveBeenCalled();
    expect(result.user).not.toHaveProperty('id');
  });

  it('fails closed when the authoritative session lookup is unavailable', async () => {
    const query = vi.fn().mockRejectedValue(new Error('database unavailable'));
    vi.doMock('../../src/infra/pg', () => ({ query }));

    const { authOptions } = await import('../../src/infra/auth');
    const callback = authOptions.callbacks?.session;
    const result = await callback!({
      session: {
        user: { name: '测试用户', id: 'stale-id', role: 'ADMIN' },
        expires: '2099-01-01T00:00:00.000Z',
      },
      token: { id: 'user-1', stamp: 'stamp-current', role: 'ADMIN' },
    } as never);

    expect(result.user).not.toHaveProperty('id');
    expect(result.user).not.toHaveProperty('role');
  });

  it('atomically stores the login stamp before returning an authenticated user', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'user@example.com',
          name: '测试用户',
          role: 'FREE',
          passwordHash: '$2b$12$stored',
          activeSessionStamp: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 });
    vi.doMock('../../src/infra/pg', () => ({ query }));
    vi.doMock('@shared/utils', () => ({ genId: () => 'stamp-new' }));
    vi.doMock('bcryptjs', () => ({
      default: {
        compare: vi.fn().mockResolvedValue(true),
        getRounds: vi.fn().mockReturnValue(12),
        hash: vi.fn(),
      },
    }));

    const { authOptions } = await import('../../src/infra/auth');
    const provider = authOptions.providers[0] as unknown as {
      options: {
        authorize(credentials: Record<string, string>): Promise<unknown>;
      };
    };
    const loginResult = await provider.options.authorize({
      login: 'user@example.com',
      password: 'Current1',
    });

    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('WHERE id = $3 AND "passwordHash" = $4'),
      ['stamp-new', '$2b$12$stored', 'user-1', '$2b$12$stored'],
    );
    expect(loginResult).toMatchObject({ id: 'user-1', stamp: 'stamp-new' });
  });

  it('does not issue a usable login when the stamp CAS write fails', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'user@example.com',
          name: '测试用户',
          role: 'FREE',
          passwordHash: '$2b$12$stored',
          activeSessionStamp: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    vi.doMock('../../src/infra/pg', () => ({ query }));
    vi.doMock('@shared/utils', () => ({ genId: () => 'stamp-new' }));
    vi.doMock('bcryptjs', () => ({
      default: {
        compare: vi.fn().mockResolvedValue(true),
        getRounds: vi.fn().mockReturnValue(12),
        hash: vi.fn(),
      },
    }));

    const { authOptions } = await import('../../src/infra/auth');
    const provider = authOptions.providers[0] as unknown as {
      options: {
        authorize(credentials: Record<string, string>): Promise<unknown>;
      };
    };

    const loginResult = await provider.options.authorize({
      login: 'user@example.com',
      password: 'Current1',
    });
    expect(loginResult).toBeNull();
  });
});
