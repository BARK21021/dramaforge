import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createLogger,
  pruneOldLogs,
  formatLine,
  parseLine,
  dailyLogPath,
} from './logger';
import { uploadLogs } from './uploader';

/** Unique temp dir per test (logger-test-<timestamp>-<rand>) to avoid collisions. */
function makeTempDir(): string {
  const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpdir(), `sf-logger-test-${rand}`);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const originalFetch = globalThis.fetch;

describe('formatLine / parseLine', () => {
  it('formatLine produces 4 tab-separated fields: ts \\t level \\t msg \\t ctxJson', () => {
    const line = formatLine('info', 'hello', { foo: 'bar' });
    const parts = line.split('\t');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO ts
    expect(parts[1]).toBe('info');
    expect(parts[2]).toBe('hello');
    expect(JSON.parse(parts[3])).toEqual({ foo: 'bar' });
  });

  it('formatLine emits an empty ctx field when no ctx is supplied', () => {
    const line = formatLine('warn', 'hi');
    const parts = line.split('\t');
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe('');
  });

  it('parseLine round-trips a formatted line without ctx', () => {
    const line = formatLine('error', 'boom');
    const e = parseLine(line);
    expect(e).not.toBeNull();
    expect(e!.level).toBe('error');
    expect(e!.msg).toBe('boom');
    expect(e!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('parseLine round-trips a message that itself contains a tab', () => {
    const line = formatLine('info', 'a\tb', { k: 1 });
    const e = parseLine(line);
    expect(e).not.toBeNull();
    expect(e!.msg).toBe('a\tb');
  });

  it('parseLine returns null for malformed lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('only\tone-field')).toBeNull();
    expect(parseLine('ts\tbogus-level\tmsg')).toBeNull();
  });
});

describe('createLogger append', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('info/warn/error append correctly-formatted lines to today\'s file', () => {
    const logger = createLogger({ machineId: 'm1', logDir: dir });
    logger.info('hello', { a: 1 });
    logger.warn('careful');
    logger.error('boom', { code: 42 });

    const content = readFileSync(dailyLogPath(dir), 'utf8').trim();
    const lines = content.split('\n');
    expect(lines).toHaveLength(3);

    const e0 = parseLine(lines[0]);
    const e1 = parseLine(lines[1]);
    const e2 = parseLine(lines[2]);
    expect(e0!.level).toBe('info');
    expect(e0!.msg).toBe('hello');
    expect(e1!.level).toBe('warn');
    expect(e1!.msg).toBe('careful');
    expect(e2!.level).toBe('error');
    expect(e2!.msg).toBe('boom');
  });

  it('creates logDir (nested) if missing', () => {
    const missing = join(dir, 'nested', 'deep');
    const logger = createLogger({ machineId: 'm1', logDir: missing });
    logger.info('hi');
    expect(existsSync(dailyLogPath(missing))).toBe(true);
  });
});

describe('pruneOldLogs', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes .log files older than maxDays (by mtime) and keeps recent ones', () => {
    const oldFile = join(dir, '2020-01-01.log');
    writeFileSync(oldFile, 'old\n');
    const oldDate = new Date(Date.now() - 30 * MS_PER_DAY);
    utimesSync(oldFile, oldDate, oldDate);

    const recentFile = join(dir, 'recent.log');
    writeFileSync(recentFile, 'recent\n');
    const recentDate = new Date();
    utimesSync(recentFile, recentDate, recentDate);

    const deleted = pruneOldLogs(dir, 7);
    expect(deleted).toContain(oldFile);
    expect(deleted).not.toContain(recentFile);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recentFile)).toBe(true);
  });

  it('returns an empty array when logDir does not exist', () => {
    const missing = join(dir, 'does-not-exist');
    expect(pruneOldLogs(missing, 7)).toEqual([]);
  });

  it('ignores non-.log files even when old', () => {
    const txt = join(dir, 'old.txt');
    writeFileSync(txt, 'x\n');
    const oldDate = new Date(Date.now() - 30 * MS_PER_DAY);
    utimesSync(txt, oldDate, oldDate);

    const deleted = pruneOldLogs(dir, 7);
    expect(deleted).not.toContain(txt);
    expect(existsSync(txt)).toBe(true);
  });
});

describe('createLogger error() lazy upload (debounced)', () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('error() triggers a debounced upload — multiple errors coalesce into one upload', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const logger = createLogger({
      machineId: 'm1',
      logDir: dir,
      apiBase: 'https://api.example.com',
      lazyUploadDebounceMs: 10,
    });

    logger.error('boom1');
    logger.error('boom2');
    logger.error('boom3');

    // Wait for the debounce window + the upload microtask chain to flush.
    await new Promise<void>((r) => setTimeout(r, 60));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.example.com/api/client/logs');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string) as {
      machineId: string;
      taskId?: string;
      logs: { level: string; msg: string }[];
    };
    expect(body.machineId).toBe('m1');
    expect(body.taskId).toBeUndefined();
    // The lazy upload batches today's file — all 3 errors are present.
    expect(body.logs).toHaveLength(3);
    expect(body.logs.every((e) => e.level === 'error')).toBe(true);
  });

  it('does NOT upload when apiBase is unset', async () => {
    const logger = createLogger({
      machineId: 'm1',
      logDir: dir,
      lazyUploadDebounceMs: 10,
    });
    logger.error('boom');
    await new Promise<void>((r) => setTimeout(r, 60));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createLogger flush(taskId)', () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('flush(taskId) sends a ClientLogBatch with the day\'s entries to /api/client/logs', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const logger = createLogger({
      machineId: 'm1',
      logDir: dir,
      apiBase: 'https://api.example.com',
    });
    logger.info('hello');
    logger.warn('careful');
    logger.error('boom');

    await logger.flush('task-42');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.example.com/api/client/logs');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(call[1].body as string) as {
      machineId: string;
      taskId: string;
      logs: { level: string; msg: string }[];
    };
    expect(body.machineId).toBe('m1');
    expect(body.taskId).toBe('task-42');
    expect(body.logs).toHaveLength(3);
    expect(body.logs.map((e) => `${e.level}:${e.msg}`).sort()).toEqual(
      ['error:boom', 'info:hello', 'warn:careful'].sort(),
    );
  });

  it('flush() without apiBase still prunes old files and does not throw', async () => {
    const oldFile = join(dir, '2020-01-01.log');
    writeFileSync(oldFile, 'old\n');
    const oldDate = new Date(Date.now() - 30 * MS_PER_DAY);
    utimesSync(oldFile, oldDate, oldDate);

    const logger = createLogger({ machineId: 'm1', logDir: dir, maxDays: 7 });
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(oldFile)).toBe(false);
  });

  it('flush() cancels a pending lazy upload so only one upload fires', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const logger = createLogger({
      machineId: 'm1',
      logDir: dir,
      apiBase: 'https://api.example.com',
      lazyUploadDebounceMs: 10,
    });
    logger.error('boom'); // schedules a lazy upload at +10ms
    await logger.flush('task-1'); // should cancel the lazy timer and upload once
    // Wait past the original debounce window to be sure no second upload fires.
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('uploadLogs error swallowing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not throw when fetch rejects (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(
      uploadLogs('https://api.example.com', {
        machineId: 'm1',
        logs: [{ ts: 't', level: 'info', msg: 'x' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('does not throw when fetch returns non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }));
    await expect(
      uploadLogs('https://api.example.com', { machineId: 'm1', logs: [] }),
    ).resolves.toBeUndefined();
  });

  it('POSTs to ${apiBase}/api/client/logs with a JSON ClientLogBatch body', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const batch = {
      machineId: 'm1',
      taskId: 't1',
      logs: [{ ts: '2026-07-18T00:00:00.000Z', level: 'info' as const, msg: 'x' }],
    };
    await uploadLogs('https://api.example.com', batch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/client/logs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(batch),
      }),
    );
  });
});
