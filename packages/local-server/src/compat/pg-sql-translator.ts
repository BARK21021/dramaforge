/**
 * PG¡úSQLite SQL translator.
 */

export interface PgResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  command?: string;
}

function convertParams(sql: string): string {
  return sql.replace(/\$(\d+)/g, '?');
}

function convertTypeCasts(sql: string): string {
  return sql
    .replace(/::jsonb/g, '')
    .replace(/::text/g, '')
    .replace(/::int(eger)?\b/gi, '')
    .replace(/::boolean\b/gi, '')
    .replace(/::(?:float|numeric|decimal|bigint)\b/gi, '')
    .replace(/::timestamptz\b/gi, '')
    .replace(/::timestamp\b/gi, '');
}

function convertTimeFunctions(sql: string): string {
  let r = sql;
  r = r.replace(/\bNOW\(\)/gi, "datetime('now')");
  r = r.replace(/\bCURRENT_TIMESTAMP\b/gi, "datetime('now')");
  // datetime('now') - INTERVAL '20 hours' ¡ú datetime('now', '-20 hours')
  r = r.replace(
    /datetime\('now'\)\s*-\s*INTERVAL\s*'(\d+)\s*(\w+)'/gi,
    (_m, n, u) => `datetime('now', '-${n} ${u}')`
  );
  r = r.replace(
    /datetime\('now'\)\s*\+\s*INTERVAL\s*'(\d+)\s*(\w+)'/gi,
    (_m, n, u) => `datetime('now', '+${n} ${u}')`
  );
  // now() + ($N * INTERVAL '1 millisecond') ¡ú datetime('now', '+N milliseconds')
  r = r.replace(
    /datetime\('now'\)\s*\+\s*\(\s*(\$\d+|\?)\s*\*\s*INTERVAL\s*'1 millisecond'\s*\)/gi,
    (_m, param) => `datetime('now', '+' || ${param} || ' milliseconds')`
  );
  // EXTRACT(EPOCH FROM (A - B)) ¡ú approximate
  r = r.replace(
    /EXTRACT\(EPOCH FROM \(([^)]+)\)\)/gi,
    (_m, inner) => {
      const parts = inner.split(/\s*-\s*/);
      if (parts.length === 2) {
        return `(unixepoch(${parts[0].trim()}) - unixepoch(${parts[1].trim()}))`;
      }
      return `unixepoch(${inner.trim()})`;
    }
  );
  return r;
}

function convertMisc(sql: string): string {
  let r = sql;
  // ILIKE ¡ú LIKE
  r = r.replace(/\bILIKE\b/gi, 'LIKE');
  // jsonb_array_length ¡ú json_array_length
  r = r.replace(/\bjsonb_array_length\b/gi, 'json_array_length');
  // TRUE/FALSE
  r = r.replace(/\bTRUE\b/g, '1');
  r = r.replace(/\bFALSE\b/g, '0');
  // $1::text[] ¡ú just $1 (for ANY())
  r = r.replace(/\$\d+::text\[\]/g, (m) => m.replace('::text[]', ''));
  // RETURNING * is supported by SQLite 3.35+
  // ON CONFLICT is supported by SQLite
  // COALESCE, LEFT, etc. are standard SQL
  return r;
}

export function translateSql(sql: string): string {
  let r = sql;
  r = convertTypeCasts(r);
  r = convertTimeFunctions(r);
  r = convertMisc(r);
  r = convertParams(r);
  return r;
}