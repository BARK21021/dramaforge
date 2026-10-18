import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('changeUserPassword', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns NOT_FOUND without hashing when the user does not exist', async () => {
    const compare = vi.fn();
    const hash = vi.fn();
    vi.doMock('bcryptjs', () => ({ default: { compare, hash } }));
    vi.doMock('../../src/infra/pg', () => ({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      tx: vi.fn(),
    }));

    const { changeUserPassword } = await import('../../src/infra/user');
    await expect(
      changeUserPassword('missing-user', 'Current1', 'Replacement2'),
    ).resolves.toEqual({ changed: false, reason: 'NOT_FOUND' });
    expect(compare).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects an invalid current password without updating the hash', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ passwordHash: '$2b$12$stored' }],
        rowCount: 1,
      });
    const compare = vi.fn().mockResolvedValue(false);
    const hash = vi.fn();
    vi.doMock('bcryptjs', () => ({ default: { compare, hash } }));
    vi.doMock('../../src/infra/pg', () => ({ query, tx: vi.fn() }));

    const { changeUserPassword } = await import('../../src/infra/user');
    await expect(
      changeUserPassword('user-1', 'Wrong1', 'Replacement2'),
    ).resolves.toEqual({
      changed: false,
      reason: 'INVALID_CURRENT_PASSWORD',
    });
    expect(hash).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('stores a fresh cost-12 hash after verifying the current password', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ passwordHash: '$2b$10$stored' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const compare = vi.fn().mockResolvedValue(true);
    const hash = vi.fn().mockResolvedValue('$2b$12$fresh');
    vi.doMock('bcryptjs', () => ({ default: { compare, hash } }));
    vi.doMock('@shared/utils', () => ({ genId: () => 'stamp-after-change' }));
    vi.doMock('../../src/infra/pg', () => ({ query, tx: vi.fn() }));

    const { changeUserPassword } = await import('../../src/infra/user');
    await expect(
      changeUserPassword('user-1', 'Current1', 'Replacement2'),
    ).resolves.toEqual({ changed: true });
    expect(compare).toHaveBeenCalledWith('Current1', '$2b$10$stored');
    expect(hash).toHaveBeenCalledWith('Replacement2', 12);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE users'),
      ['$2b$12$fresh', 'stamp-after-change', 'user-1', '$2b$10$stored'],
    );
    expect(query.mock.calls[1]?.[0]).toContain('"activeSessionStamp" = $2');
    expect(query.mock.calls[1]?.[0]).toContain('"passwordHash" = $4');
  });

  it('does not overwrite a password changed concurrently', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ passwordHash: '$2b$12$observed' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const compare = vi.fn().mockResolvedValue(true);
    const hash = vi.fn().mockResolvedValue('$2b$12$replacement');
    vi.doMock('bcryptjs', () => ({ default: { compare, hash } }));
    vi.doMock('@shared/utils', () => ({ genId: () => 'stamp-after-change' }));
    vi.doMock('../../src/infra/pg', () => ({ query, tx: vi.fn() }));

    const { changeUserPassword } = await import('../../src/infra/user');
    await expect(
      changeUserPassword('user-1', 'Current1', 'Replacement2'),
    ).resolves.toEqual({
      changed: false,
      reason: 'INVALID_CURRENT_PASSWORD',
    });
    expect(query.mock.calls[1]?.[1]).toEqual([
      '$2b$12$replacement',
      'stamp-after-change',
      'user-1',
      '$2b$12$observed',
    ]);
  });
});
