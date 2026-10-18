// ============================================================
// 幂等迁移执行器
// ============================================================
//
// 文件职责：
//   1. 发现 migrations/*.sql 文件（按文件名排序）
//   2. 在 _migrations 表中追踪已执行的迁移
//   3. 按顺序执行未应用的迁移，每个迁移包在事务内（BEGIN/SQL/INSERT/COMMIT）
//   4. 失败 ROLLBACK 并抛出，停止后续迁移
//
// 设计要点：
//   - 幂等：_migrations 表记录已执行文件名，重复运行只执行新增文件
//   - 可测试性：runMigrations 接受 queryFn + migrationsDir 注入，单测用 mock pg
//   - discoverMigrations / computePending 为纯函数，单独可测
//   - 每个 .sql 文件作为整体执行（pg 简单查询协议支持多语句），与 app1 一致
//
// _migrations 表由 ensureMigrationsTable 创建（CREATE IF NOT EXISTS），
// 不放在 0001-init.sql 中，避免迁移表本身尚未创建时的引导问题。
// ============================================================

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type QueryFn } from './pg';

/** migrations 目录（相对于本模块文件） */
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/** 已发现的迁移文件 */
export interface MigrationFile {
  /** 文件名（如 0001-init.sql），作为唯一标识 */
  name: string;
  /** SQL 内容 */
  sql: string;
}

/**
 * 发现目录中的 .sql 迁移文件并按文件名升序排列
 *
 * @param dir - 迁移目录绝对路径，默认为本模块同级的 migrations/
 * @returns 排序后的 MigrationFile 数组
 */
export async function discoverMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of sqlFiles) {
    const sql = await readFile(join(dir, name), 'utf8');
    files.push({ name, sql });
  }
  return files;
}

/**
 * 计算待执行的迁移（纯函数）
 *
 * @param applied - 已应用的迁移文件名列表
 * @param files - 已发现的迁移文件
 * @returns 尚未应用的迁移文件（保持原顺序）
 */
export function computePending(applied: string[], files: MigrationFile[]): MigrationFile[] {
  const appliedSet = new Set(applied);
  return files.filter((f) => !appliedSet.has(f.name));
}

/** 确保 _migrations 追踪表存在（幂等） */
async function ensureMigrationsTable(q: QueryFn): Promise<void> {
  await q.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  );
}

/** 查询已应用的迁移文件名（按名排序） */
async function getApplied(q: QueryFn): Promise<string[]> {
  const result = await q.query('SELECT name FROM _migrations ORDER BY name');
  return result.rows.map((r) => (r as { name: string }).name);
}

/** runMigrations 的可注入选项（测试用） */
export interface RunMigrationsOptions {
  /** 查询函数，默认使用 pg.query（真实 PG） */
  queryFn?: QueryFn;
  /** 迁移目录，默认为本模块同级 migrations/ */
  migrationsDir?: string;
}

/**
 * 执行所有未应用的迁移
 *
 * 流程：
 *   1. 确保 _migrations 表存在
 *   2. 读取已应用迁移名
 *   3. 发现 migrations 目录下的 .sql 文件（排序）
 *   4. 对每个未应用文件：BEGIN → 执行 SQL → INSERT _migrations → COMMIT
 *   5. 任一迁移失败：ROLLBACK 并抛出，停止后续
 *
 * @returns 本次执行的迁移文件名列表（按顺序）
 * @throws 迁移 SQL 执行失败时抛出原始错误（已 ROLLBACK）
 */
export async function runMigrations(opts: RunMigrationsOptions = {}): Promise<string[]> {
  const q: QueryFn = opts.queryFn ?? { query };
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;

  await ensureMigrationsTable(q);
  const applied = await getApplied(q);
  const files = await discoverMigrations(dir);
  const pending = computePending(applied, files);

  const executed: string[] = [];
  for (const m of pending) {
    await q.query('BEGIN');
    try {
      await q.query(m.sql);
      await q.query('INSERT INTO _migrations(name) VALUES ($1)', [m.name]);
      await q.query('COMMIT');
      executed.push(m.name);
    } catch (err) {
      try {
        await q.query('ROLLBACK');
      } catch {
        // 回滚失败不掩盖原始错误
      }
      throw err;
    }
  }
  return executed;
}
