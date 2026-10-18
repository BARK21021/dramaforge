// Unit tests for ⑪ client/shell — machine-id persistence.
//
// Mocks `electron` so `app.getPath('userData')` returns a fresh real temp dir
// per test (so fs operations are exercised against the real filesystem). The
// factory is a bare vi.fn(); beforeEach sets the implementation to a new temp
// dir so each test starts from a clean state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(),
  },
}));

import { app } from 'electron';
import { loadOrCreateMachineId, getMachineIdPath } from '../../main/machine-id';

describe('loadOrCreateMachineId', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sf-mid-'));
    vi.mocked(app.getPath).mockImplementation((name: string) => {
      if (name === 'userData') return dir;
      return join(tmpdir(), `sf-${name}`);
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates + persists a new UUID when no file exists', () => {
    const id = loadOrCreateMachineId();

    // UUID v4 shape (8-4-4-4-12 hex).
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // File written with the id.
    const file = getMachineIdPath();
    expect(existsSync(file)).toBe(true);
    const data = JSON.parse(readFileSync(file, 'utf8')) as { machineId: string };
    expect(data.machineId).toBe(id);
  });

  it('returns the persisted id on a subsequent call (persistence)', () => {
    const first = loadOrCreateMachineId();
    const second = loadOrCreateMachineId();

    expect(second).toBe(first);
  });

  it('generates a new id when the file is corrupt JSON', () => {
    const first = loadOrCreateMachineId();
    // Corrupt the file.
    writeFileSync(getMachineIdPath(), '{ not valid json,,,', 'utf8');

    const second = loadOrCreateMachineId();

    expect(second).not.toBe(first);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // File rewritten with the new id.
    const data = JSON.parse(readFileSync(getMachineIdPath(), 'utf8')) as { machineId: string };
    expect(data.machineId).toBe(second);
  });

  it('generates a new id when the file has an empty machineId field', () => {
    writeFileSync(getMachineIdPath(), JSON.stringify({ machineId: '' }), 'utf8');

    const id = loadOrCreateMachineId();

    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('machineId persists across calls to different module imports (simulated reload)', () => {
    const first = loadOrCreateMachineId();
    // Simulate a "reload" by calling again — the file is the source of truth.
    const second = loadOrCreateMachineId();
    const third = loadOrCreateMachineId();

    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
