// ⑮ ops-logger — lazy uploader.
//
// POSTs a ClientLogBatch to `${apiBase}/api/client/logs` using the global
// `fetch` (Node 18+ / Electron). Network errors and non-2xx responses are
// SWALLOWED: lazy upload is best-effort and must never crash the client app.

import type { ClientLogBatch } from '@dramaforge/shared';

const LOGS_PATH = '/api/client/logs';

/**
 * Upload a batch of client log entries to the server.
 *
 * Resolves normally on any network error or non-2xx response — lazy upload
 * is best-effort. Callers do not need to wrap this in try/catch.
 */
export async function uploadLogs(apiBase: string, batch: ClientLogBatch): Promise<void> {
  const url = `${apiBase}${LOGS_PATH}`;
  try {
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      // Best-effort: ignore non-2xx. The server may be unavailable or rejecting.
      return;
    }
  } catch {
    // Network error / fetch rejection — swallow. Lazy upload must not crash.
  }
}
