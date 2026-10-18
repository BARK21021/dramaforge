// ============================================================
// ⑪ client/shell — stable machineId persistence
// ============================================================
//
// Generates + persists a stable per-machine id (crypto.randomUUID) in
// `app.getPath('userData')/machine-id.json`. The id is created on first launch
// and re-read on every subsequent launch — it identifies this install to the
// cloud server (heartbeat, render-job claim, log upload).
//
// Resilience: a corrupt or unreadable file is treated as "absent" and a new id
// is generated. A write failure (e.g. read-only userData) is swallowed — the
// in-memory id is still returned so startup never crashes; the next launch will
// simply generate a new id.

import { app } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const MACHINE_ID_FILE = 'machine-id.json';

/** Shape of the persisted JSON file. */
interface MachineIdFile {
  machineId: string;
}

/** Resolve the machine-id file path under Electron's userData dir. */
export function getMachineIdPath(): string {
  return join(app.getPath('userData'), MACHINE_ID_FILE);
}

/**
 * Load the persisted machineId, or create + persist a new one (crypto.randomUUID)
 * if absent/corrupt. Always returns a non-empty string.
 *
 * - File present + valid → returns the persisted id.
 * - File absent / corrupt / unreadable → generates a new UUID, best-effort
 *   persists it, returns it. A persist failure is swallowed (startup-critical).
 */
export function loadOrCreateMachineId(): string {
  const path = getMachineIdPath();

  // 1. Try to load an existing id.
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<MachineIdFile>;
      if (typeof data.machineId === 'string' && data.machineId.length > 0) {
        return data.machineId;
      }
    }
  } catch {
    // Corrupt JSON / unreadable file — fall through and (re)create.
  }

  // 2. Generate + best-effort persist.
  const machineId = randomUUID();
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(path, JSON.stringify({ machineId } satisfies MachineIdFile), 'utf8');
  } catch {
    // Persist failure must not crash startup — return the in-memory id.
  }
  return machineId;
}
