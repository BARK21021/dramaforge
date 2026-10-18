import { describe, expect, it, vi } from 'vitest';
import { finishPasswordChange } from '../components/ui/change-password-session';

describe('finishPasswordChange', () => {
  it('closes the modal and clears the revoked NextAuth session', async () => {
    const onClose = vi.fn();
    const signOut = vi.fn().mockResolvedValue(undefined);

    await finishPasswordChange(onClose, signOut);

    expect(onClose).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledWith({
      callbackUrl: '/auth/signin',
      redirect: true,
    });
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      signOut.mock.invocationCallOrder[0]!,
    );
  });
});
