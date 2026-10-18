// ⑮ ops-logger — rolling local log + lazy upload.
//
// Each log call appends a line to a daily file `${logDir}/${YYYY-MM-DD}.log`.
// Line format: `ISO ts \t level \t msg \t JSON ctx\n` (ctx field is empty when
// no context is supplied; the 4-field shape is always preserved so parsing is
// uniform and msg may itself contain tabs).
//
// On `error()`, a lazy upload of the current day's log is auto-triggered,
// debounced so a burst of errors produces a single upload. `flush(taskId)`
// uploads the day's entries to `${apiBase}/api/client/logs` as a ClientLogBatch
// and prunes log files older than `maxDays`.
//
// All upload paths swallow network errors — logging must never crash the app.

import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ClientLogBatch, ClientLogEntry } from '@dramaforge/shared';
import { uploadLogs } from './uploader';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LoggerOptions {
  machineId: string;
  logDir: string;
  /** Retention window in days. Files with mtime older than this are pruned on flush(). Default 7. */
  maxDays?: number;
  /** Server base URL. When set, error() triggers a debounced upload and flush() uploads the day's log. */
  apiBase?: string;
  /** Debounce window (ms) for the lazy upload triggered by error(). Default 2000. */
  lazyUploadDebounceMs?: number;
}

export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  flush(taskId?: string): Promise<void>;
}

const DEFAULT_MAX_DAYS = 7;
const DEFAULT_DEBOUNCE_MS = 2000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Format a Date as YYYY-MM-DD in local time (used for the daily filename). */
export function formatDayStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Path of the daily log file for a given stamp (default: today). */
export function dailyLogPath(logDir: string, stamp: string = formatDayStamp()): string {
  return join(logDir, `${stamp}.log`);
}

/** Format a single log line: `ISO ts \t level \t msg \t JSON ctx`. */
export function formatLine(level: LogLevel, msg: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const ctxJson = ctx && Object.keys(ctx).length > 0 ? JSON.stringify(ctx) : '';
  return [ts, level, msg, ctxJson].join('\t');
}

/** Parse a log line back into a ClientLogEntry. Returns null if malformed. */
export function parseLine(line: string): ClientLogEntry | null {
  if (!line) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const ts = parts[0];
  const level = parts[1] as LogLevel;
  if (level !== 'info' && level !== 'warn' && level !== 'error') return null;
  // If a 4th field (ctx json) is present, msg is everything between level and
  // ctx; otherwise msg is the remainder. This tolerates tabs inside msg.
  const msg = parts.length >= 4 ? parts.slice(2, -1).join('\t') : parts.slice(2).join('\t');
  return { ts, level, msg };
}

/** Read all entries from the day's log file (default: today). Returns [] if the file is absent. */
export function readDayEntries(logDir: string, stamp: string = formatDayStamp()): ClientLogEntry[] {
  const path = dailyLogPath(logDir, stamp);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const entries: ClientLogEntry[] = [];
  for (const line of content.split('\n')) {
    const e = parseLine(line);
    if (e) entries.push(e);
  }
  return entries;
}

/** Delete log files whose mtime is older than maxDays. Returns the deleted file paths. */
export function pruneOldLogs(logDir: string, maxDays: number): string[] {
  if (!existsSync(logDir)) return [];
  const cutoff = Date.now() - maxDays * MS_PER_DAY;
  const deleted: string[] = [];
  for (const f of readdirSync(logDir)) {
    if (!f.endsWith('.log')) continue;
    const full = join(logDir, f);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        unlinkSync(full);
        deleted.push(full);
      }
    } catch {
      // stat/unlink failure on a single file — skip it, keep pruning others.
      continue;
    }
  }
  return deleted;
}

export function createLogger(opts: LoggerOptions): Logger {
  const {
    machineId,
    logDir,
    maxDays = DEFAULT_MAX_DAYS,
    apiBase,
    lazyUploadDebounceMs = DEFAULT_DEBOUNCE_MS,
  } = opts;

  // Ensure logDir exists before any append.
  mkdirSync(logDir, { recursive: true });

  let uploadTimer: ReturnType<typeof setTimeout> | null = null;
  // Serialize uploads so a lazy upload + an explicit flush() don't race.
  let pendingUpload: Promise<void> = Promise.resolve();

  function appendLine(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    appendFileSync(dailyLogPath(logDir), formatLine(level, msg, ctx) + '\n', 'utf8');
  }

  function cancelTimer(): void {
    if (uploadTimer !== null) {
      clearTimeout(uploadTimer);
      uploadTimer = null;
    }
  }

  function buildBatch(taskId: string | undefined): ClientLogBatch {
    return { machineId, taskId, logs: readDayEntries(logDir) };
  }

  /** Schedule a debounced lazy upload of today's log. No-op when apiBase is unset. */
  function scheduleLazyUpload(): void {
    if (!apiBase) return;
    cancelTimer();
    uploadTimer = setTimeout(() => {
      uploadTimer = null;
      const batch = buildBatch(undefined);
      pendingUpload = pendingUpload
        .catch(() => {})
        .then(() => uploadLogs(apiBase, batch).catch(() => {}));
    }, lazyUploadDebounceMs);
  }

  function info(msg: string, ctx?: Record<string, unknown>): void {
    appendLine('info', msg, ctx);
  }

  function warn(msg: string, ctx?: Record<string, unknown>): void {
    appendLine('warn', msg, ctx);
  }

  function error(msg: string, ctx?: Record<string, unknown>): void {
    appendLine('error', msg, ctx);
    scheduleLazyUpload();
  }

  async function flush(taskId?: string): Promise<void> {
    // An in-flight debounced lazy upload would be redundant — cancel it and
    // let this explicit upload take its place.
    cancelTimer();
    if (apiBase) {
      const batch = buildBatch(taskId);
      pendingUpload = pendingUpload
        .catch(() => {})
        .then(() => uploadLogs(apiBase, batch).catch(() => {}));
      await pendingUpload;
    }
    pruneOldLogs(logDir, maxDays);
  }

  return { info, warn, error, flush };
}
