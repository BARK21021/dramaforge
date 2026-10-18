// ============================================================
// 用户仓储 helper — 注册/查找（手机号注册流程用）
// ============================================================
//
// 文件职责：
//   把手机号注册流程中需要 bcrypt + SQL 的部分封装在 server 层，避免 web
//   直接 import bcryptjs（与 dramaforge 既有模式一致：next-auth authorize 的
//   bcrypt 校验也封装在 server/infra/auth.ts）。
//
// 函数：
//   - findUserByPhone(phone)         — 查找用户（手机号或 email 匹配手机号）
//   - createUserFromPhone(phone, password, name?) — 创建手机号用户
//
// 与 app1 的差异：
//   - app1 用 Prisma；dramaforge 用原生 pg query
//   - dramaforge users.phone 字段统一存 +86 国际格式（与 infra/auth.ts 的
//     normalizePhone 写入保持一致），故此处的 phone 参数期望为 +86... 形态
//
// 安全约束：零 ffmpeg 依赖；密钥/哈希只在 server 层处理。
// ============================================================

import bcrypt from 'bcryptjs';
import { genId } from '@shared/utils';
import { query, tx } from './pg';

/**
 * bcrypt cost factor（I1：OWASP 2023 ≥12）
 *
 * 历史 cost=10 在现代 GPU 下已不达 OWASP 2023 推荐；提到 12 显著增加破解
 * 成本而单次哈希仍在可接受延迟内（~250ms）。verify 路径用存储 hash 的 cost
 * 自动适配，平滑升级在 auth.ts 登录时检测旧 cost 重哈希。
 */
export const BCRYPT_COST = 12;

/** phone 用户行（findUserByPhone 返回） */
export interface PhoneUserRow {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: string;
}

/**
 * 按 11 位国内手机号查找用户
 *
 * I7 改造：迁移 0004-normalize-phone.sql 后所有手机号统一存 +86 国际格式，
 * 表上 CHECK 约束保证 phone IS NULL OR phone LIKE '+86%'。此函数只需单值匹配，
 * 不再做多格式 OR（历史 11 位 / email-as-phone 已被迁移收敛）。
 *
 * @param normalizedPhone normalizePhone 返回的 11 位国内手机号
 * @returns 用户行或 null
 */
export async function findUserByPhoneOrEmail(
  normalizedPhone: string,
): Promise<PhoneUserRow | null> {
  const phoneInternational = `+86${normalizedPhone}`;
  const { rows } = await query(
    `SELECT id, email, phone, name, role
     FROM users
     WHERE phone = $1
     LIMIT 1`,
    [phoneInternational],
  );
  if (rows.length === 0) return null;
  return rows[0] as PhoneUserRow;
}

/** 创建手机号用户结果 */
export interface CreatePhoneUserResult {
  id: string;
  phone: string;
  name: string;
  credits: number;
}

/** 修改密码结果；调用方据此区分用户不存在与旧密码错误。 */
export type ChangeUserPasswordResult =
  | { changed: true }
  | { changed: false; reason: 'NOT_FOUND' | 'INVALID_CURRENT_PASSWORD' };

/**
 * 验证当前密码并更新为新密码。
 *
 * 明文密码只在本函数调用期间存在；查询、bcrypt 比对和新哈希均留在 server
 * 模块内，web route 不接触 passwordHash。密码与 activeSessionStamp 由同一条
 * CAS UPDATE 原子更新：成功后此前签发的全部 JWT 会因印章不匹配立即失效。
 */
export async function changeUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangeUserPasswordResult> {
  const { rows } = await query(
    `SELECT "passwordHash" FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = rows[0] as { passwordHash: string | null } | undefined;
  if (!row?.passwordHash) {
    return { changed: false, reason: 'NOT_FOUND' };
  }

  const currentPasswordValid = await bcrypt.compare(
    currentPassword,
    row.passwordHash,
  );
  if (!currentPasswordValid) {
    return { changed: false, reason: 'INVALID_CURRENT_PASSWORD' };
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const activeSessionStamp = genId();
  const updateResult = await query(
    `UPDATE users
        SET "passwordHash" = $1,
            "activeSessionStamp" = $2,
            "updatedAt" = NOW()
      WHERE id = $3 AND "passwordHash" = $4
      RETURNING id`,
    [passwordHash, activeSessionStamp, userId, row.passwordHash],
  );
  if (updateResult.rowCount !== 1 && updateResult.rows.length !== 1) {
    // 并发改密或用户删除时不覆盖后来者；统一按凭据已变化处理，避免泄露记录状态。
    return { changed: false, reason: 'INVALID_CURRENT_PASSWORD' };
  }
  return { changed: true };
}

/**
 * 创建手机号用户
 *
 * - bcrypt 哈希密码（cost = BCRYPT_COST=12，I1）
 * - 写入 users 表（email=NULL, phone=+86 国际格式, role=FREE, provider=CREDENTIALS）
 * - 写入默认 user_preferences（I8：与 users 同事务，任一失败 ROLLBACK）
 *
 * @param normalizedPhone 11 位国内手机号
 * @param password 明文密码（调用方校验长度+策略；本函数不再二次校验）
 * @param name 显示名（可选，默认"用户" + 手机号后 4 位）
 * @returns 创建结果（含 id、phone、name、credits）
 */
export async function createUserFromPhone(
  normalizedPhone: string,
  password: string,
  name?: string,
): Promise<CreatePhoneUserResult> {
  const userId = genId();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const displayName = name || `用户${normalizedPhone.slice(-4)}`;
  const credits = readFreeQuotaCredits();
  const phoneInternational = `+86${normalizedPhone}`;
  const prefId = genId();

  // I8：users + user_preferences 同事务，避免半成品用户（users 成功 / preferences 失败
  // 导致响应 201 但用户进入工作台后无偏好）。事务失败 ROLLBACK 抛出，由调用方
  // 兜底（register-phone route 的 23505 catch + handleApiError）。
  await tx(async (q) => {
    await q.query(
      `INSERT INTO users (id, email, phone, "passwordHash", name, credits, role, provider)
       VALUES ($1, NULL, $2, $3, $4, $5, 'FREE', 'CREDENTIALS')`,
      [userId, phoneInternational, passwordHash, displayName, credits],
    );
    await q.query(
      `INSERT INTO user_preferences (id, "userId", locale, theme)
       VALUES ($1, $2, 'zh', 'dark')`,
      [prefId, userId],
    );
  });

  return { id: userId, phone: normalizedPhone, name: displayName, credits };
}

/** 默认初始积分（未配 FREE_QUOTA_CREDITS 时使用，与 app1 默认一致：不赠送） */
const DEFAULT_FREE_QUOTA_CREDITS = 0;

/** 读取新用户初始积分 */
function readFreeQuotaCredits(): number {
  const v = Number(process.env.FREE_QUOTA_CREDITS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_FREE_QUOTA_CREDITS;
}
