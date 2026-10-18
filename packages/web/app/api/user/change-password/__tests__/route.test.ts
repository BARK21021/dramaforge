import { beforeEach, describe, expect, it } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../test/helpers';
import { POST } from '../route';

describe('POST /api/user/change-password', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.rateLimitAllow.mockReset().mockResolvedValue(true);
    serverMock.changeUserPassword.mockReset().mockResolvedValue({ changed: true });
  });

  it('rejects unauthenticated requests', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const response = await POST(makeRequest({ method: 'POST', body: {} }));
    expect(response.status).toBe(401);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'UNAUTHORIZED',
    });
  });

  it('validates the current and new passwords before touching storage', async () => {
    const response = await POST(
      makeRequest({
        method: 'POST',
        body: { oldPassword: 'old-password', newPassword: 'short' },
      }),
    );
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'WEAK_PASSWORD',
    });
    expect(serverMock.changeUserPassword).not.toHaveBeenCalled();
  });

  it('rate limits password verification attempts per authenticated user', async () => {
    serverMock.rateLimitAllow.mockResolvedValue(false);
    const response = await POST(
      makeRequest({
        method: 'POST',
        body: { oldPassword: 'OldPassword1', newPassword: 'NewPassword2' },
      }),
    );
    expect(response.status).toBe(429);
    expect(serverMock.rateLimitAllow).toHaveBeenCalledWith(
      'auth:change-password:user:user-1',
      60_000,
      5,
    );
  });

  it('returns a stable error when the current password is wrong', async () => {
    serverMock.changeUserPassword.mockResolvedValue({
      changed: false,
      reason: 'INVALID_CURRENT_PASSWORD',
    });
    const response = await POST(
      makeRequest({
        method: 'POST',
        body: { oldPassword: 'OldPassword1', newPassword: 'NewPassword2' },
      }),
    );
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'INVALID_CURRENT_PASSWORD',
    });
  });

  it('changes the password and returns the UI envelope', async () => {
    const response = await POST(
      makeRequest({
        method: 'POST',
        body: { oldPassword: 'OldPassword1', newPassword: 'NewPassword2' },
      }),
    );
    expect(response.status).toBe(200);
    expect(serverMock.changeUserPassword).toHaveBeenCalledWith(
      'user-1',
      'OldPassword1',
      'NewPassword2',
    );
    expect(await readJson(response)).toEqual({
      success: true,
      data: { changed: true },
    });
  });
});
