// ============================================================
// PostgreSQL 连接池 + 事务封装
// ============================================================
//
// 文件职责：
//   1. pg.Pool 单例（懒加载，从 env.DATABASE_URL 初始化）
//   2. query(sql, params) — 顶层查询，直接走连接池
//   3. tx(fn) — 事务封装，BEGIN/COMMIT/ROLLBACK，fn 内的查询走同一 PoolClient
//   4. runInTransaction(client, fn) — 事务核心逻辑，可注入 mock client 便于单测
//
// 设计要点：
//   - 连接池懒加载：模块导入不建连，首次 query/tx 时才从 env() 读取 DATABASE_URL 建池
//   - 事务隔离：tx 持有独立 PoolClient，fn 内所有查询走同一连接，保证事务语义
//   - 可测试性：runInTransaction 接受任意 QueryFn（含 mock），tx 包装连接获取/释放
//
// 移植自 app1 src/core/config/database.ts 的连接池 + $transaction 语义，
// 去掉 Prisma 兼容 Proxy 层，仅保留底层 query/tx。
// ============================================================

import { Pool, type PoolClient } from 'pg';
import { env } from './env';

/** 查询结果（pg QueryResult 的最小子集，避免 any） */
export interface QueryResult {
  rows: unknown[];
  rowCount: number | null;
}

/** 可执行查询的客户端（Pool、PoolClient、mock 均可） */
export interface QueryFn {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

/** 连接池单例（懒加载） */
let _pool: Pool | null = null;

/**
 * 获取 pg 连接池单例
 *
 * 首次调用时从 env().DATABASE_URL 创建 Pool，并注册 error 监听
 * （空闲连接错误必须监听，否则触发 uncaughtException）。
 *
 * @returns pg.Pool 实例
 */
export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: env().PG_POOL_MAX,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    _pool.on('error', (err: Error) => {
      console.error('[pg] unexpected pool error:', err.message);
    });
  }
  return _pool;
}

/**
 * 执行查询（走连接池，无事务）
 *
 * @param sql - SQL 字符串（可用 $1/$2 占位符）
 * @param params - 参数数组（可选）
 * @returns 查询结果（rows + rowCount）
 */
export async function query(sql: string, params?: unknown[]): Promise<QueryResult> {
  return getPool().query(sql, params);
}

/**
 * 事务核心逻辑 — 在给定 client 上执行 BEGIN/fn/COMMIT（失败 ROLLBACK）
 *
 * 与连接获取解耦，便于单测注入 mock client 验证 BEGIN/COMMIT/ROLLBACK 顺序。
 * 不负责 client.release()（由调用方管理，见 tx()）。
 *
 * @param client - 已获取的查询客户端（Pool 或 PoolClient）
 * @param fn - 事务体，接收绑定到该 client 的 QueryFn
 * @returns fn 的返回值
 * @throws fn 抛出的原始错误（ROLLBACK 后重新抛出）
 */
export async function runInTransaction<T>(
  client: QueryFn,
  fn: (q: QueryFn) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 回滚本身失败不掩盖原始错误
    }
    throw err;
  }
}

/**
 * 在事务中执行函数
 *
 * 从连接池获取独立 PoolClient，BEGIN 后执行 fn（fn 内查询走此 client），
 * 成功 COMMIT、失败 ROLLBACK，最后释放连接。
 *
 * @param fn - 事务体，接收绑定到事务 client 的 QueryFn
 * @returns fn 的返回值
 * @throws fn 抛出的原始错误（ROLLBACK 后重新抛出）
 *
 * @example
 * ```ts
 * const result = await tx(async (q) => {
 *   await q.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [100, 'a']);
 *   await q.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [100, 'b']);
 *   return 'transferred';
 * });
 * ```
 */
export async function tx<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();
  try {
    return await runInTransaction(client, fn);
  } finally {
    client.release();
  }
}

/**
 * 关闭连接池（应用关闭/测试结束时调用）
 */
export async function endPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
