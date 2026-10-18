// ============================================================
// ③ server/domain/seedance-presets — 用户级 Seedance 参数预设
// ============================================================
//
// 文件职责：
//   - 读写 seedance_presets 表，并把所有查询限定在当前 userId。
//   - 复用 Seedance 参数白名单清洗，避免把任意 JSON 当成生成参数保存。
//   - 创建或更新默认模板时锁定用户行，在同一事务中取消旧默认并写入新默认。
//
// 安全边界：按 id 的更新和删除始终同时匹配 id + userId；调用方即使传入
// 其他用户的模板 id，也只能得到 NOT_FOUND，不能读取或修改该模板。
// ============================================================

import { query, tx, type QueryFn } from '@server/infra';
import { genId } from '@shared/utils';
import { sanitizeSeedanceParams } from '../storyboard/seedance-params';

/** 单个用户允许保存的模板数量，与旧项目接口保持一致。 */
export const MAX_SEEDANCE_PRESETS_PER_USER = 50;

/** 模板名称的最大字符数，与旧项目接口保持一致。 */
export const MAX_SEEDANCE_PRESET_NAME_LENGTH = 60;

/** 对外返回的 Seedance 参数预设。 */
export interface SeedancePreset {
  id: string;
  userId: string;
  name: string;
  params: Record<string, unknown>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 创建参数保留 unknown 类型，由服务层统一完成边界校验。 */
export interface CreateSeedancePresetInput {
  name: unknown;
  params: unknown;
  isDefault?: unknown;
}

/** 更新参数保留 unknown 类型，便于服务层识别并拒绝错误类型。 */
export interface UpdateSeedancePresetInput {
  name?: unknown;
  params?: unknown;
  isDefault?: unknown;
}

/** 预设子域的稳定错误码，供 Web 路由映射 HTTP 响应。 */
export type SeedancePresetErrorCode =
  | 'VALIDATION_ERROR'
  | 'PRESET_LIMIT_REACHED'
  | 'DUPLICATE_PRESET_NAME'
  | 'PRESET_NOT_FOUND';

/** 带 HTTP 状态与稳定 code 的领域错误。 */
export class SeedancePresetError extends Error {
  readonly statusCode: number;
  readonly code: SeedancePresetErrorCode;

  constructor(message: string, statusCode: number, code: SeedancePresetErrorCode) {
    super(message);
    this.name = 'SeedancePresetError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** PostgreSQL 返回的原始行；时间字段可能是 Date，也可能是测试中的字符串。 */
interface SeedancePresetRow {
  id: string;
  userId: string;
  name: string;
  params: Record<string, unknown>;
  isDefault: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

/** 所有返回语句共用同一列清单，避免不同操作的响应形状漂移。 */
const RETURNING_COLUMNS = `id, "userId", name, params, "isDefault", "createdAt", "updatedAt"`;

/** 把数据库时间统一序列化为 API 可直接返回的 ISO 字符串。 */
function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** 把 PostgreSQL 行转换成稳定的领域对象。 */
function mapPreset(row: SeedancePresetRow): SeedancePreset {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    params: row.params,
    isDefault: row.isDefault,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/** 规范化名称；旧接口会截断到 60 个字符，因此迁移后保持相同行为。 */
function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SeedancePresetError('模板名称不能为空', 400, 'VALIDATION_ERROR');
  }
  return value.trim().slice(0, MAX_SEEDANCE_PRESET_NAME_LENGTH);
}

/** 清洗参数并确保至少保留一个 Seedance 白名单字段。 */
function normalizeParams(value: unknown): Record<string, unknown> {
  const cleaned = sanitizeSeedanceParams(value);
  if (!cleaned) {
    throw new SeedancePresetError(
      'params 无效，至少需要一项有效参数',
      400,
      'VALIDATION_ERROR',
    );
  }
  return cleaned;
}

/** 严格校验布尔值，避免字符串 "true" 被静默解释成 false。 */
function normalizeIsDefault(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new SeedancePresetError('isDefault 必须是布尔值', 400, 'VALIDATION_ERROR');
  }
  return value;
}

/** 判断对象是否显式提供某字段，区分“未传”与“传入 undefined”。 */
function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** 将 PostgreSQL 唯一约束冲突识别为可稳定返回的重名错误。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code) === '23505'
  );
}

/** 锁定用户行，使同一用户的默认模板切换在并发请求间串行执行。 */
async function lockUser(q: QueryFn, userId: string): Promise<void> {
  const result = await q.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if ((result.rowCount ?? result.rows.length) === 0) {
    throw new SeedancePresetError('用户不存在', 404, 'PRESET_NOT_FOUND');
  }
}

/** 查询当前用户的全部模板，默认模板置顶，其余按最近更新时间排序。 */
export async function listSeedancePresets(userId: string): Promise<SeedancePreset[]> {
  const { rows } = await query(
    `SELECT ${RETURNING_COLUMNS}
       FROM seedance_presets
      WHERE "userId" = $1
      ORDER BY "isDefault" DESC, "updatedAt" DESC`,
    [userId],
  );
  return (rows as SeedancePresetRow[]).map(mapPreset);
}

/**
 * 为当前用户创建模板。
 *
 * 默认模板切换与 INSERT 位于同一事务；若插入失败，旧默认状态会一并回滚。
 */
export async function createSeedancePreset(
  userId: string,
  input: CreateSeedancePresetInput,
): Promise<SeedancePreset> {
  const name = normalizeName(input.name);
  const params = normalizeParams(input.params);
  const isDefault = normalizeIsDefault(input.isDefault, false);

  try {
    return await tx(async (q) => {
      // 用户行充当每用户互斥锁，保护数量、重名和默认切换检查。
      await lockUser(q, userId);

      const countResult = await q.query(
        'SELECT COUNT(*)::int AS count FROM seedance_presets WHERE "userId" = $1',
        [userId],
      );
      const count = Number((countResult.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
      if (count >= MAX_SEEDANCE_PRESETS_PER_USER) {
        throw new SeedancePresetError(
          `模板数量已达上限（${MAX_SEEDANCE_PRESETS_PER_USER} 个），请先删除旧模板`,
          400,
          'PRESET_LIMIT_REACHED',
        );
      }

      // 先给出友好的重名错误；数据库唯一约束仍作为最终并发防线。
      const duplicate = await q.query(
        'SELECT id FROM seedance_presets WHERE "userId" = $1 AND name = $2 LIMIT 1',
        [userId, name],
      );
      if (duplicate.rows.length > 0) {
        throw new SeedancePresetError(
          `模板“${name}”已存在，请更换名称`,
          409,
          'DUPLICATE_PRESET_NAME',
        );
      }

      if (isDefault) {
        // 在写入新默认前清除旧默认；同一事务失败时会自动恢复旧状态。
        await q.query(
          `UPDATE seedance_presets
              SET "isDefault" = FALSE, "updatedAt" = NOW()
            WHERE "userId" = $1 AND "isDefault" = TRUE`,
          [userId],
        );
      }

      const { rows } = await q.query(
        `INSERT INTO seedance_presets
           (id, "userId", name, params, "isDefault", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING ${RETURNING_COLUMNS}`,
        [genId(), userId, name, params, isDefault],
      );
      return mapPreset(rows[0] as SeedancePresetRow);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SeedancePresetError(
        `模板“${name}”已存在，请更换名称`,
        409,
        'DUPLICATE_PRESET_NAME',
      );
    }
    throw error;
  }
}

/**
 * 按 id 部分更新当前用户模板。
 *
 * name、params、isDefault 至少提供一项；设置新默认时会在同一事务中清除旧默认。
 */
export async function updateSeedancePreset(
  userId: string,
  presetId: string,
  input: UpdateSeedancePresetInput,
): Promise<SeedancePreset> {
  const fragments: string[] = [];
  const values: unknown[] = [];
  let normalizedName: string | undefined;
  let setAsDefault = false;

  // 动态 SET 仅接受三项白名单字段，未知字段不会进入 SQL。
  if (hasOwn(input, 'name')) {
    normalizedName = normalizeName(input.name);
    values.push(normalizedName);
    fragments.push(`name = $${values.length}`);
  }
  if (hasOwn(input, 'params')) {
    values.push(normalizeParams(input.params));
    fragments.push(`params = $${values.length}`);
  }
  if (hasOwn(input, 'isDefault')) {
    const normalized = normalizeIsDefault(input.isDefault, false);
    setAsDefault = normalized;
    values.push(normalized);
    fragments.push(`"isDefault" = $${values.length}`);
  }
  if (fragments.length === 0) {
    throw new SeedancePresetError('没有需要更新的字段', 400, 'VALIDATION_ERROR');
  }

  try {
    return await tx(async (q) => {
      // 更新也锁定用户行，和并发创建共用同一串行边界。
      await lockUser(q, userId);
      const existing = await q.query(
        'SELECT id FROM seedance_presets WHERE id = $1 AND "userId" = $2 FOR UPDATE',
        [presetId, userId],
      );
      if (existing.rows.length === 0) {
        throw new SeedancePresetError('模板不存在', 404, 'PRESET_NOT_FOUND');
      }

      if (normalizedName !== undefined) {
        // 排除自身后检查同用户重名，避免把其他用户的名称纳入冲突范围。
        const duplicate = await q.query(
          `SELECT id FROM seedance_presets
            WHERE "userId" = $1 AND name = $2 AND id <> $3
            LIMIT 1`,
          [userId, normalizedName, presetId],
        );
        if (duplicate.rows.length > 0) {
          throw new SeedancePresetError(
            `模板“${normalizedName}”已存在，请更换名称`,
            409,
            'DUPLICATE_PRESET_NAME',
          );
        }
      }

      if (setAsDefault) {
        // 只清除同用户的其他默认模板，目标模板由后续 UPDATE 设为 true。
        await q.query(
          `UPDATE seedance_presets
              SET "isDefault" = FALSE, "updatedAt" = NOW()
            WHERE "userId" = $1 AND id <> $2 AND "isDefault" = TRUE`,
          [userId, presetId],
        );
      }

      fragments.push('"updatedAt" = NOW()');
      const idPosition = values.length + 1;
      const userPosition = values.length + 2;
      const { rows } = await q.query(
        `UPDATE seedance_presets
            SET ${fragments.join(', ')}
          WHERE id = $${idPosition} AND "userId" = $${userPosition}
          RETURNING ${RETURNING_COLUMNS}`,
        [...values, presetId, userId],
      );
      if (rows.length === 0) {
        throw new SeedancePresetError('模板不存在', 404, 'PRESET_NOT_FOUND');
      }
      return mapPreset(rows[0] as SeedancePresetRow);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SeedancePresetError(
        `模板“${normalizedName ?? ''}”已存在，请更换名称`,
        409,
        'DUPLICATE_PRESET_NAME',
      );
    }
    throw error;
  }
}

/** 按 id 删除当前用户模板；id 属于其他用户时同样返回 NOT_FOUND。 */
export async function deleteSeedancePreset(
  userId: string,
  presetId: string,
): Promise<void> {
  const { rows } = await query(
    `DELETE FROM seedance_presets
      WHERE id = $1 AND "userId" = $2
      RETURNING id`,
    [presetId, userId],
  );
  if (rows.length === 0) {
    throw new SeedancePresetError('模板不存在', 404, 'PRESET_NOT_FOUND');
  }
}

/** 聚合对象便于测试或未来依赖注入，同时保留具名函数导出。 */
export const seedancePresetRepo = {
  list: listSeedancePresets,
  create: createSeedancePreset,
  update: updateSeedancePreset,
  delete: deleteSeedancePreset,
};
