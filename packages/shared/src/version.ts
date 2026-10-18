// Client version comparison — used by ops-heartbeat force_upgrade lockout
// and by /api/client/heartbeat to gate outdated clients.

/**
 * Returns true only if `v` is strictly below `min`.
 * Compares dotted numeric version strings segment-by-segment.
 * Missing segments are treated as 0.
 */
export function isVersionBelow(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}
