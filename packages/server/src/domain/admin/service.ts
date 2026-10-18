// ============================================================
// ③ server/domain/admin — 管理员用户管理查询（对齐 app1 admin/*）
// ============================================================
//
// 文件职责：
//   admin 后台只读查询 + 手动充值的服务层。移植自 app1 src/app/api/admin/users/*
//   与 src/app/api/user/recharge，从 Prisma 改原生 pg query。
//
//   函数：
//     - getUserRoleById(userId)              — DB 权威角色（requireAdmin 防越权重查）
//     - listUsersForAdmin({q,page,pageSize})  — 用户列表（搜索 email/phone/name）
//     - getUserDetailForAdmin(userId)         — 用户详情 + 积分汇总（按 credits 正负号）
//     - listLedgerForAdmin(userId,{filter,…}) — 账本明细（tab 全部/充值/消耗 + 分页）
//     - listUserFilmsForAdmin(userId)         — 用户成片（render_jobs COMPLETED）
//     - getAdminStats()                       — 平台 4 指标（消耗/充值/氪金/利润）+ 总用户
//
// 与 app1 差异：
//   - app1 搜索是 Prisma JS 端 filter（5000 上限）；dramaforge 原生 pg 用 ILIKE（无上限）
//   - app1 成片查 task 表(FILM_EXPORT/CHAIN_GENERATE)；dramaforge C/S 成片在 render_jobs 表
//     (CONCAT/CHAIN_COMPILE)，input.filmMeta / result.outputUrl 提取字段
//   - 积分汇总逻辑不变：按 billing_ledger.credits 正负号（+充值/-消耗），不按 type
//
// 列名约定：users/billing_ledger 驼峰列加双引号；payment_orders/render_jobs snake_case。
// 零 ffmpeg。异常 bubble 给 route 层 handleApiError。
// ============================================================

import { query } from '@server/infra';
import { getEpisodesCompletionMap } from '../storyboard/service';

/** 列表用户行（对齐 app1 USER_PUBLIC_FIELDS list 版） */
export interface AdminUserListRow {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role: string;
  credits: number;
  createdAt: string;
  lastLoginAt: string | null;
  phone: string | null;
}

/** 详情用户行（list 版 + updatedAt + maxConcurrent） */
export interface AdminUserDetailRow extends AdminUserListRow {
  updatedAt: string;
  maxConcurrent: number;
}

/** 账本明细行（metadata 不返，避免大 JSON 泄漏） */
export interface AdminLedgerEntry {
  id: string;
  type: string;
  amount: number;
  credits: number;
  balance: number;
  description: string | null;
  createdAt: string;
  taskId: string | null;
}

/** 用户成片（admin 只读，对齐 films route FilmRecord） */
export interface AdminFilm {
  id: string;
  type: string;
  projectId: string | null;
  outputUrl: string | null;
  localKey: string | null;
  episodeId: string | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  projectTitle: string | null;
  shotCount: number | null;
  totalDuration: number | null;
  createdAt: string;
}

/**
 * 充值类型（tab=recharge 过滤用，对齐 app1 RECHARGE_TYPES）。
 *
 * 同时列入 'REFUND_CREDIT'（app1 命名）与 'REFUND'（dramaforge `creditRefund` 实际写入的 type）
 * ——dramaforge 的 creditRefund 写 'REFUND' 而非 app1 的 'REFUND_CREDIT'，故两者都列入以兼容
 * 历史数据 + 对齐 app1 命名。其他四个 type 与 app1 一致。
 */
const RECHARGE_TYPES = [
  'PURCHASE_CREDIT',
  'ADMIN_CREDIT',
  'QUOTA_CREDIT',
  'REFUND_CREDIT',
  'REFUND',
];

/** Date/字符串 → ISO 字符串（pg TIMESTAMPTZ 默认返 Date） */
function toIso(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * 按 id 查用户 DB 权威角色（requireAdmin 用，防 JWT 角色 stale 越权）。
 * @returns 角色字符串或 null（用户不存在）
 */
export async function getUserRoleById(userId: string): Promise<string | null> {
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) return null;
  return (rows[0] as { role: string }).role;
}

/**
 * 管理员用户列表（搜索 + 分页）。
 *
 * q 非空：ILIKE 模糊匹配 email/phone/name（原生 pg，无 app1 的 5000 扫描上限）。
 * q 空：纯分页。ORDER BY createdAt DESC。
 */
export async function listUsersForAdmin(opts: {
  q?: string;
  page: number;
  pageSize: number;
}): Promise<{ users: AdminUserListRow[]; total: number; page: number; pageSize: number }> {
  const { q: rawQ, page, pageSize } = opts;
  const q = (rawQ ?? '').trim();
  const offset = (page - 1) * pageSize;

  if (q) {
    const like = `%${q}%`;
    const [listRes, countRes] = await Promise.all([
      query(
        `SELECT id, email, name, "avatarUrl", role, credits, "createdAt", "lastLoginAt", phone
           FROM users
          WHERE email ILIKE $1 OR phone ILIKE $1 OR name ILIKE $1
          ORDER BY "createdAt" DESC
          LIMIT $2 OFFSET $3`,
        [like, pageSize, offset],
      ),
      query(
        `SELECT COUNT(*)::int AS total FROM users
          WHERE email ILIKE $1 OR phone ILIKE $1 OR name ILIKE $1`,
        [like],
      ),
    ]);
    return {
      users: (listRes.rows as AdminUserListRow[]).map((u) => ({
        ...u,
        createdAt: toIso(u.createdAt),
        lastLoginAt: u.lastLoginAt == null ? null : toIso(u.lastLoginAt),
      })),
      total: (countRes.rows[0] as { total: number }).total,
      page,
      pageSize,
    };
  }

  const [listRes, countRes] = await Promise.all([
    query(
      `SELECT id, email, name, "avatarUrl", role, credits, "createdAt", "lastLoginAt", phone
         FROM users
        ORDER BY "createdAt" DESC
        LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
    query('SELECT COUNT(*)::int AS total FROM users'),
  ]);
  return {
    users: (listRes.rows as AdminUserListRow[]).map((u) => ({
      ...u,
      createdAt: toIso(u.createdAt),
      lastLoginAt: u.lastLoginAt == null ? null : toIso(u.lastLoginAt),
    })),
    total: (countRes.rows[0] as { total: number }).total,
    page,
    pageSize,
  };
}

/**
 * 用户详情 + 积分汇总。
 *
 * 积分汇总按 billing_ledger.credits 正负号（+充值/-消耗），不按 type 命名
 * （对齐 app1，独立于 type 完整性）。当前余额 = user.credits（非账本派生）。
 */
export async function getUserDetailForAdmin(
  userId: string,
): Promise<{ user: AdminUserDetailRow; summary: { totalRecharged: number; totalConsumed: number } } | null> {
  const userRes = await query(
    `SELECT id, email, name, "avatarUrl", role, credits, "createdAt", "updatedAt", "lastLoginAt", phone, "maxConcurrent"
       FROM users WHERE id = $1`,
    [userId],
  );
  if (userRes.rows.length === 0) return null;
  const u = userRes.rows[0] as AdminUserDetailRow;

  const sumRes = await query(
    `SELECT
       COALESCE(SUM(credits) FILTER (WHERE credits > 0), 0)::bigint AS total_recharged,
       COALESCE(SUM(-credits) FILTER (WHERE credits < 0), 0)::bigint AS total_consumed
       FROM billing_ledger WHERE "userId" = $1`,
    [userId],
  );
  const s = sumRes.rows[0] as { total_recharged: string; total_consumed: string };

  return {
    user: {
      ...u,
      createdAt: toIso(u.createdAt),
      updatedAt: toIso(u.updatedAt),
      lastLoginAt: u.lastLoginAt == null ? null : toIso(u.lastLoginAt),
    },
    summary: {
      totalRecharged: Number(s.total_recharged) || 0,
      totalConsumed: Number(s.total_consumed) || 0,
    },
  };
}

/**
 * 管理员调参用户并发上限（users."maxConcurrent"）。
 *
 * 该字段同时是两条并发链的唯一旋钮：
 *   ① ai-worker BullMQ 任务槽（getConcurrencyLimit → acquireSlot）
 *   ② render_jobs 每用户认领硬上限（/api/render/jobs/next 的 countActiveClaims 闸）
 * 范围 1-64（route 层校验）；调低会立即收紧新任务（进行中的任务不受影响）。
 *
 * @returns 更新后的 { id, maxConcurrent }；用户不存在返回 null
 */
export async function updateUserConcurrency(
  userId: string,
  maxConcurrent: number,
): Promise<{ id: string; maxConcurrent: number } | null> {
  const r = await query(
    `UPDATE users
        SET "maxConcurrent" = $2, "updatedAt" = NOW()
      WHERE id = $1
      RETURNING id, "maxConcurrent"`,
    [userId, maxConcurrent],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as { id: string; maxConcurrent: number };
  return { id: row.id, maxConcurrent: row.maxConcurrent };
}

/**
 * 用户账本明细（tab 过滤 + 分页）。
 *
 * filter: '' 全部 | 'recharge' (type IN RECHARGE_TYPES) | 'consume' (type='TASK_DEBIT')
 * ORDER BY createdAt DESC。total 用同一 where（反映当前 tab）。
 */
export async function listLedgerForAdmin(
  userId: string,
  opts: { filter?: string; page: number; pageSize: number },
): Promise<{ entries: AdminLedgerEntry[]; total: number; page: number; pageSize: number }> {
  const filter = (opts.filter ?? '').trim();
  const offset = (opts.page - 1) * opts.pageSize;

  let whereSql = 'WHERE "userId" = $1';
  const params: unknown[] = [userId];
  if (filter === 'recharge') {
    const placeholders = RECHARGE_TYPES.map((_, i) => `$${i + 2}`).join(', ');
    whereSql += ` AND type IN (${placeholders})`;
    params.push(...RECHARGE_TYPES);
  } else if (filter === 'consume') {
    whereSql += ` AND type = 'TASK_DEBIT'`;
  }

  const [listRes, countRes] = await Promise.all([
    query(
      `SELECT id, type, amount, credits, balance, description, "createdAt", "taskId"
         FROM billing_ledger ${whereSql}
        ORDER BY "createdAt" DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.pageSize, offset],
    ),
    query(`SELECT COUNT(*)::int AS total FROM billing_ledger ${whereSql}`, params),
  ]);

  return {
    entries: (listRes.rows as AdminLedgerEntry[]).map((e) => ({
      ...e,
      createdAt: toIso(e.createdAt),
    })),
    total: (countRes.rows[0] as { total: number }).total,
    page: opts.page,
    pageSize: opts.pageSize,
  };
}

interface FilmMetaRow {
  projectId?: string;
  episodeId?: string;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
  projectTitle?: string | null;
  shotIds?: unknown;
  shotCount?: number;
  totalDuration?: number;
}

interface RenderJobRow {
  id: string;
  type: string;
  input: unknown;
  result: unknown;
  created_at: unknown;
}

function readFilmMeta(input: unknown): FilmMetaRow | null {
  if (!input || typeof input !== 'object') return null;
  const meta = (input as { filmMeta?: unknown }).filmMeta;
  if (!meta || typeof meta !== 'object') return null;
  return meta as FilmMetaRow;
}

function readFilmResult(result: unknown): { outputUrl: string | null; localKey: string | null } {
  if (!result || typeof result !== 'object') return { outputUrl: null, localKey: null };
  const r = result as { outputUrl?: string | null; meta?: { localKey?: string | null } | null };
  return {
    outputUrl: typeof r.outputUrl === 'string' ? r.outputUrl : null,
    localKey: r.meta && typeof r.meta.localKey === 'string' ? r.meta.localKey : null,
  };
}

/**
 * 用户全部成片（admin 只读，跨项目）。
 *
 * 查 render_jobs COMPLETED CONCAT/CHAIN_COMPILE 候选，并按 app1 口径只保留整集完成、
 * 覆盖镜头数与分集总数一致的最终成片。这里不按 projectId 过滤，前端按 projectTitle 分组。
 */
export async function listUserFilms(userId: string): Promise<AdminFilm[]> {
  const { rows } = await query(
    `SELECT id, type, input, result, created_at
       FROM render_jobs
      WHERE user_id = $1
        AND type IN ('CONCAT', 'CHAIN_COMPILE')
        AND status = 'COMPLETED'
      ORDER BY created_at DESC`,
    [userId],
  );
  // 先批量核验每个候选分集的真实镜头完成度，复用 app1 的成片库门禁口径。
  const episodeIds = Array.from(new Set((rows as RenderJobRow[]).flatMap((row) => {
    const meta = readFilmMeta(row.input);
    if (
      !meta
      || typeof meta.episodeId !== 'string'
    ) {
      return [];
    }
    return [meta.episodeId];
  })));
  const completionMap = await getEpisodesCompletionMap(episodeIds);

  const films: AdminFilm[] = [];
  for (const row of rows as RenderJobRow[]) {
    const meta = readFilmMeta(row.input);
    const r = readFilmResult(row.result);
    if (!r.outputUrl) continue; // 无可播放地址不入列表
    // 全局/admin 成片库同样只收有明确分集归属的最终成片；无分集历史合片留在
    // render_jobs 审计记录中，不进入用户看到的“每集成片”。
    if (!meta || typeof meta.episodeId !== 'string' || meta.episodeId.length === 0) continue;
    // 显式非空 shotIds 代表镜头组范围；即使刚好覆盖全体镜头，也不能冒充每集成片。
    if (Array.isArray(meta.shotIds) && meta.shotIds.length > 0) continue;
    const completion = completionMap.get(meta.episodeId);
    // 已产出的最终成片保留展示，不因当前镜头状态（重跑 reset）而隐藏（对齐 films route
    // 修复：原 complete 门禁是「重跑后成片库全没了」根因）。仅保留计数门禁防旧成片冒充；
    // 分集已删除（completion 缺失）则不再展示。
    if (
      !completion
      || (typeof meta.shotCount === 'number' && meta.shotCount !== completion.total)
    ) {
      continue;
    }
    films.push({
      id: row.id,
      type: row.type,
      projectId: meta && typeof meta.projectId === 'string' ? meta.projectId : null,
      outputUrl: r.outputUrl,
      localKey: r.localKey,
      episodeId: meta && typeof meta.episodeId === 'string' ? meta.episodeId : null,
      episodeNumber: meta && typeof meta.episodeNumber === 'number' ? meta.episodeNumber : null,
      episodeTitle: meta && typeof meta.episodeTitle === 'string' ? meta.episodeTitle : null,
      projectTitle: meta && typeof meta.projectTitle === 'string' ? meta.projectTitle : null,
      shotCount: meta && typeof meta.shotCount === 'number' ? meta.shotCount : null,
      totalDuration: meta && typeof meta.totalDuration === 'number' ? meta.totalDuration : null,
      createdAt: toIso(row.created_at),
    });
  }
  return films;
}

/** 管理员查询沿用同一深模块；鉴权仍由 admin route 负责。 */
export const listUserFilmsForAdmin = listUserFilms;

/** 平台 4 指标 + 总用户数（admin 顶部汇总卡用）。 */
export interface AdminStats {
  totalUsers: number;
  totalConsumedCredits: number;
  totalRechargedCredits: number;
  totalSpentYuan: number; // 用户氪金总金额（payment_orders PAID 的 amount_yuan 之和）
  totalCostYuan: number; // AI 实际成本（billing_ledger TASK_DEBIT metadata.cost 之和）
  profitYuan: number; // 利润 = 氪金 − 成本
}

/**
 * 平台指标聚合。
 *
 * - 消耗/充值积分：billing_ledger.credits 正负号（与单用户汇总同口径）
 * - 氪金金额：SUM(payment_orders.amount_yuan WHERE status='PAID')（手动充值不花钱，不计入 ✓）
 * - AI 成本：同步生成写 metadata.cost，Worker 写 metadata.platformCostYuan；两条链统一汇总。
 *   部署前没有成本元数据的历史消耗无法反推供应商账单，因此不编造成本。
 * - 利润 = 氪金 − 成本
 */
export async function getAdminStats(): Promise<AdminStats> {
  const [creditsRes, spentRes, costRes, usersRes] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(credits) FILTER (WHERE credits > 0), 0)::bigint AS recharged,
         COALESCE(SUM(-credits) FILTER (WHERE credits < 0), 0)::bigint AS consumed
         FROM billing_ledger`,
    ),
    query(`SELECT COALESCE(SUM(amount_yuan), 0)::numeric AS spent FROM payment_orders WHERE status = 'PAID'`),
    query(
      `SELECT COALESCE(SUM(COALESCE(
           (metadata->>'cost')::numeric,
           (metadata->>'platformCostYuan')::numeric,
           0
         )), 0)::numeric AS cost
         FROM billing_ledger WHERE type = 'TASK_DEBIT'`,
    ),
    query('SELECT COUNT(*)::int AS total FROM users'),
  ]);
  const c = creditsRes.rows[0] as { recharged: string; consumed: string };
  const spent = Number((spentRes.rows[0] as { spent: string }).spent) || 0;
  const cost = Number((costRes.rows[0] as { cost: string }).cost) || 0;
  const totalUsers = (usersRes.rows[0] as { total: number }).total;

  return {
    totalUsers,
    totalRechargedCredits: Number(c.recharged) || 0,
    totalConsumedCredits: Number(c.consumed) || 0,
    totalSpentYuan: Math.round(spent * 100) / 100,
    totalCostYuan: Math.round(cost * 100) / 100,
    profitYuan: Math.round((spent - cost) * 100) / 100,
  };
}
