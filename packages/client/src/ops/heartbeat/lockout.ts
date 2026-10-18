// Force-upgrade UI lockout.
//
// Once the heartbeat receives a `force_upgrade` response, the client shell must
// lock down to an "upgrade-only" screen. This module holds that single bit of
// state; the shell polls `isActive()` to decide which screen to render.
//
// The lock is terminal in normal production flow — only a successful upgrade
// (new build) clears it. `reset()` exists for tests / admin override only.

let locked = false;
let lockReason: string | null = null;

/** Lock the UI down. Idempotent. */
export function activate(reason: string = 'force_upgrade'): void {
  locked = true;
  lockReason = reason;
}

export function isActive(): boolean {
  return locked;
}

export function getLockReason(): string | null {
  return lockReason;
}

/** Test/admin-only: clear lockout state. Not invoked in normal production flow. */
export function reset(): void {
  locked = false;
  lockReason = null;
}
