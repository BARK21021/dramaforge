/**
 * PG Pool replacement backed by better-sqlite3.
 * Drop-in compatible with the 'pg' module's Pool interface.
 * Automatically translates PG SQL ¡ú SQLite at runtime.
 */
import Database from 'better-sqlite3';
import { translateSql, type PgResult } from './pg-sql-translator';

let _db: Database.Database | null = null;

/** Initialize the SQLite database. Call once at startup. */
export function initSqlite(dbPath: string): Database.Database {
  if (_db) return _db;
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  return _db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('SQLite not initialized ¡ª call initSqlite() first');
  return _db;
}

export function closeSqlite(): void {
  if (_db) { _db.close(); _db = null; }
}

/** Normalize JS values for SQLite storage. */
function normalizeParam(p: unknown): unknown {
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (p instanceof Date) return p.toISOString();
  if (typeof p === 'object' && p !== null && !Array.isArray(p) && !(p instanceof Buffer)) {
    return JSON.stringify(p);
  }
  return p;
}

/** Execute SQL and return PG-compatible result. */
function execSqlite(sql: string, params?: unknown[]): PgResult {
  const db = getDb();
  const sqliteSql = translateSql(sql);
  const normalizedParams = (params ?? []).map(normalizeParam);
  const trimmed = sqliteSql.trim().toUpperCase();

  if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('EXPLAIN')) {
    const rows = db.prepare(sqliteSql).all(...normalizedParams) as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  } else {
    const info = db.prepare(sqliteSql).run(...normalizedParams);
    return { rows: [], rowCount: info.changes };
  }
}

/** Fake PoolClient ¡ª uses SQLite transactions. */
class SqlitePoolClient {
  query(sql: string, params?: unknown[]): Promise<PgResult> {
    return Promise.resolve(execSqlite(sql, params));
  }
  release(): void { /* no-op for SQLite */ }
}

/** PG Pool replacement backed by SQLite. */
export class Pool {
  on(_event: string, _cb: (...args: unknown[]) => void): this { return this; }

  async query(sql: string, params?: unknown[]): Promise<PgResult> {
    return execSqlite(sql, params);
  }

  async connect(): Promise<SqlitePoolClient> {
    return new SqlitePoolClient();
  }

  async end(): Promise<void> {
    closeSqlite();
  }
}

export { Pool as default };