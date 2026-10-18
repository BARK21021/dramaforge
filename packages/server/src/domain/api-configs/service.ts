// ============================================================
// ③ server/domain/api-configs — 平台级 API Key 池 CRUD（admin 管理）
// ============================================================
//
// 文件职责：
//   api_configs 表平台级 key 的 CRUD。GC-1 / dramaforge-keys-cloud-server-only：
//   AI key 是平台云端服务器的（非 BYOK）→ 平台 key 用 "userId" IS NULL 标识，
//   admin 后台经此服务增删改查 key 池。
//
//   函数：
//     - listPlatformConfigs()                          — 列表（apiKey 掩码）
//     - revealPlatformConfigKey(id)                    — 管理员主动查看单条明文
//     - createPlatformConfig({provider, apiKey, ...})  — 新建平台 key
//     - updatePlatformConfig(id, patch)                — 部分更新
//     - deletePlatformConfig(id)                       — 删除
//     - resetConfigStatus(id)                          — 重置 keyStatus='active'
//     - testConfig(id)                                 — 轻量 ping 验证可用性
//
// 安全约束（GC-1）：
//   - 列表与 CRUD 响应始终掩码；明文只由 admin-only 单条查看接口按需读取
//   - apiKey 永不进日志：testConfig 读取后直接放入 fetch 头，不 log
//   - 平台作用域：所有 UPDATE/DELETE/单读 SQL 都 WHERE "userId" IS NULL
//     防止误改/误删用户 BYOK 行（即使 id 被恶意构造也只命中平台池）
//
// 列名约定：驼峰列加双引号（"userId"/"apiKey"/"keyStatus"/"isEnabled"/
// "createdAt"/"updatedAt"/"lastUsedAt"/"disabledUntil"/"lastErrorMessage"），
// snake_case 列（provider/baseurl 等）不加引号——对齐 domain/admin 与 project。
// 风格：函数式 + 末尾聚合对象，不 try/catch（异常 bubble 给 route 层 handleApiError）。
// 零 ffmpeg。
// ============================================================

import { query, tx } from '@server/infra';
import { genId } from '@shared/utils';
import { fetchProviderBalance, type ProviderBalanceView } from './balance';

/**
 * 统一 provider 标识。Key 池本身不绑死供应商枚举，管理员可随时新增后续适配器所需的
 * provider；这里只限制为适合 URL/日志/数据库索引的安全短标识。
 */
function normalizeProvider(provider: unknown): string {
  const normalized = String(provider ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error('provider 只能包含小写字母、数字、点、下划线或短横线，且最长 64 位');
  }
  return normalized;
}

/**
 * 规范化单 key 并发上限：正整数 floor；否则（null/undefined/非正/非有限数）→ null。
 *
 * 与运行时 api-key-pool.ts pick() 的 `r.maxConcurrent ?? Infinity` 语义一致：
 * NULL = 不限（该 key 不受并发上限约束，如 DeepSeek/Kimi 这类账号级高并发 provider）。
 * 仅 ark 视频这类硬并发瓶颈的 provider 才需要显式设正整数（如 3）。
 */
function normalizeMaxConcurrent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.floor(v);
}

/**
 * 平台 API key 配置的视图（admin 后台返回给前端的形态）。
 *
 * **apiKey 已掩码**（首 4 + '…' + 尾 4，长度 < 8 → '****'）；
 * 永不返回原始 apiKey（GC-1 安全约束）。
 */
export interface ApiConfigView {
  id: string;
  provider: string;
  label: string | null;
  /** 掩码后的 apiKey（首 4 + '…' + 尾 4）；长度 < 8 → '****' */
  apiKeyMasked: string;
  baseUrl: string | null;
  weight: number;
  isEnabled: boolean;
  keyStatus: string;
  lastUsedAt: string | null;
  errorCount: number;
  consecutiveFailures: number;
  disabledUntil: string | null;
  lastErrorMessage: string | null;
  /** 单 key 并发上限覆盖；null=不限（运行时 pick() 按 `?? Infinity` 放行） */
  maxConcurrent: number | null;
}

/** 管理后台的单 Key 余额视图；不包含原始 Key。 */
export interface ApiConfigBalanceView extends ProviderBalanceView {
  configId: string;
}

/** api_configs 表原始 pg 行（驼峰列直接透传）。 */
interface ApiConfigRow {
  id: string;
  userId: string | null;
  provider: string;
  apiKey: string;
  baseUrl: string | null;
  isEnabled: boolean;
  createdAt: unknown;
  updatedAt: unknown;
  label: string | null;
  weight: number;
  keyStatus: string;
  lastUsedAt: unknown;
  errorCount: number;
  consecutiveFailures: number;
  disabledUntil: unknown;
  lastErrorMessage: string | null;
  maxConcurrent: number | null;
}

/**
 * 掩码 apiKey：首 4 + '…' + 尾 4；长度 < 8 → '****'。
 *
 * 示例：
 *   'sk-abcde12345f6789' → 'sk-a…f6789'
 *   'short'              → '****'
 *   '' / null            → '****'
 */
function maskApiKey(apiKey: string | null | undefined): string {
  if (!apiKey) return '****';
  if (apiKey.length < 8) return '****';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

/** TIMESTAMPTZ → ISO 字符串；null 透传。pg 默认返 Date，mock 可能返 Date/string/null。 */
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** pg 行 → ApiConfigView（掩码 + 时间戳标准化）。 */
function mapRow(row: ApiConfigRow): ApiConfigView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    apiKeyMasked: maskApiKey(row.apiKey),
    baseUrl: row.baseUrl,
    weight: row.weight,
    isEnabled: row.isEnabled,
    keyStatus: row.keyStatus,
    lastUsedAt: toIsoOrNull(row.lastUsedAt),
    errorCount: row.errorCount,
    consecutiveFailures: row.consecutiveFailures,
    disabledUntil: toIsoOrNull(row.disabledUntil),
    lastErrorMessage: row.lastErrorMessage,
    maxConcurrent: row.maxConcurrent ?? null,
  };
}

/** SELECT 列清单（所有 list/create/update/reset 末尾 RETURNING 用）。 */
const SELECT_COLS = `id, "userId", provider, "apiKey", "baseUrl", "isEnabled",
  "createdAt", "updatedAt", label, weight, "maxConcurrent", "keyStatus", "lastUsedAt",
  "errorCount", "consecutiveFailures", "disabledUntil", "lastErrorMessage"`;

/**
 * 列出所有平台级 API key（"userId" IS NULL）。
 *
 * 按 provider ASC、"createdAt" ASC 排序，便于 admin 后台按服务商分组浏览。
 * 返回的 apiKey 已掩码。
 */
export async function listPlatformConfigs(): Promise<ApiConfigView[]> {
  const { rows } = await query(
    `SELECT ${SELECT_COLS}
       FROM api_configs
      WHERE "userId" IS NULL
      ORDER BY provider ASC, "createdAt" ASC`,
  );
  return (rows as ApiConfigRow[]).map(mapRow);
}

/**
 * 读取一条平台 Key 的明文，专供已通过 requireAdmin 的单条查看接口调用。
 * 此函数不记录 Key、不批量返回，并以平台作用域条件阻止读取历史用户记录。
 */
export async function revealPlatformConfigKey(id: string): Promise<string> {
  const { rows } = await query(
    `SELECT "apiKey"
       FROM api_configs
      WHERE id = $1 AND "userId" IS NULL
      LIMIT 1`,
    [id],
  );
  const apiKey = (rows[0] as { apiKey?: string } | undefined)?.apiKey;
  if (!apiKey) throw new Error(`平台 API key 不存在: ${id}`);
  return apiKey;
}

/**
 * 查询平台池全部 Key 的余额。并发上限为 3，避免管理员刷新一次就同时打满
 * 所有供应商余额接口；单个 Key 失败只落在该行，不影响其余结果。
 */
export async function listPlatformConfigBalances(): Promise<ApiConfigBalanceView[]> {
  const { rows } = await query(
    `SELECT id, provider, "apiKey", "baseUrl"
       FROM api_configs
      WHERE "userId" IS NULL
      ORDER BY provider ASC, "createdAt" ASC`,
  );
  const configs = rows as Array<{ id: string; provider: string; apiKey: string; baseUrl: string | null }>;
  const results: ApiConfigBalanceView[] = [];

  for (let index = 0; index < configs.length; index += 3) {
    const chunk = configs.slice(index, index + 3);
    // 每一小批并行、批次之间串行：既减少总等待，又给外部余额接口留出余量。
    const chunkResults = await Promise.all(chunk.map(async (config) => ({
      configId: config.id,
      ...await fetchProviderBalance(config.provider, {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      }),
    })));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * 新建平台级 API key。
 *
 * - "userId" 强制为 NULL（平台 key 标识）
 * - id 用 genId()（对齐 dramaforge 全仓 UUID 生成方式，无 'cfg-' 前缀）
 * - 默认 "keyStatus"='active'、"isEnabled"=true
 * - "createdAt"/"updatedAt"=NOW()（DB 时间戳，避免 JS 时区偏差）
 *
 * @throws Error provider/apiKey 为空
 */
export async function createPlatformConfig(input: {
  provider: string;
  apiKey: string;
  label?: string | null;
  weight?: number;
  baseUrl?: string | null;
  maxConcurrent?: number | null;
}): Promise<ApiConfigView> {
  const provider = normalizeProvider(input.provider);
  const apiKey = String(input.apiKey ?? '').trim();
  if (!apiKey) throw new Error('apiKey 不能为空');

  const label =
    input.label != null && String(input.label).trim() ? String(input.label).trim() : null;
  const weight =
    typeof input.weight === 'number' &&
    Number.isFinite(input.weight) &&
    input.weight > 0
      ? Math.floor(input.weight)
      : 1;
  const baseUrl =
    input.baseUrl != null && String(input.baseUrl).trim()
      ? String(input.baseUrl).trim()
      : null;
  const maxConcurrent = normalizeMaxConcurrent(input.maxConcurrent);

  const id = genId();
  const { rows } = await query(
    `INSERT INTO api_configs
       (id, "userId", provider, "apiKey", "baseUrl", "isEnabled",
        label, weight, "maxConcurrent", "keyStatus", "createdAt", "updatedAt")
      VALUES ($1, NULL, $2, $3, $4, TRUE, $5, $6, $7, 'active', NOW(), NOW())
      RETURNING ${SELECT_COLS}`,
    [id, provider, apiKey, baseUrl, label, weight, maxConcurrent],
  );
  if (rows.length === 0) {
    throw new Error('创建平台 API key 失败：数据库未返回新行');
  }
  return mapRow(rows[0] as ApiConfigRow);
}

export interface PlatformConfigImportItem {
  provider: string;
  apiKey: string;
  label?: string | null;
  weight?: number;
  baseUrl?: string | null;
  maxConcurrent?: number | null;
}

/**
 * 批量导入平台 Key。事务内按 provider+apiKey 去重；结果只返回掩码视图与跳过数，
 * 不回显任何输入明文。单批最多 100 个，防止误把任意大文件当 Key 清单上传。
 */
export async function importPlatformConfigs(
  items: PlatformConfigImportItem[],
): Promise<{ imported: ApiConfigView[]; skippedDuplicates: number }> {
  if (!Array.isArray(items) || items.length === 0) throw new Error('没有可导入的 API Key');
  if (items.length > 100) throw new Error('单次最多导入 100 个 API Key');

  return tx(async (q) => {
    const imported: ApiConfigView[] = [];
    let skippedDuplicates = 0;
    for (const item of items) {
      const provider = normalizeProvider(item.provider);
      const apiKey = String(item.apiKey ?? '').trim();
      if (!provider || apiKey.length < 12) throw new Error('导入项 provider 或 apiKey 无效');
      const duplicate = await q.query(
        `SELECT id FROM api_configs
          WHERE "userId" IS NULL AND provider = $1 AND "apiKey" = $2 LIMIT 1`,
        [provider, apiKey],
      );
      if (duplicate.rows.length > 0) {
        skippedDuplicates += 1;
        continue;
      }
      const label = item.label && String(item.label).trim() ? String(item.label).trim() : null;
      const weight = Number.isFinite(item.weight) && Number(item.weight) > 0
        ? Math.floor(Number(item.weight))
        : 1;
      const baseUrl = item.baseUrl && String(item.baseUrl).trim() ? String(item.baseUrl).trim() : null;
      const maxConcurrent = normalizeMaxConcurrent(item.maxConcurrent);
      const { rows } = await q.query(
        `INSERT INTO api_configs
          (id, "userId", provider, "apiKey", "baseUrl", "isEnabled", label, weight,
           "maxConcurrent", "keyStatus", "createdAt", "updatedAt")
         VALUES ($1, NULL, $2, $3, $4, TRUE, $5, $6, $7, 'active', NOW(), NOW())
         RETURNING ${SELECT_COLS}`,
        [genId(), provider, apiKey, baseUrl, label, weight, maxConcurrent],
      );
      imported.push(mapRow(rows[0] as ApiConfigRow));
    }
    return { imported, skippedDuplicates };
  });
}

/**
 * 部分更新平台级 key。
 *
 * 仅更新 patch 中显式提供的字段 + "updatedAt"=NOW()。
 * apiKey 仅在管理员显式提交非空值时替换；返回值始终掩码，不回显明文。
 * WHERE "userId" IS NULL 守卫确保只命中平台池。
 *
 * @throws Error id 不存在（或属于用户 BYOK 行）
 */
export async function updatePlatformConfig(
  id: string,
  patch: {
    label?: string | null;
    weight?: number;
    isEnabled?: boolean;
    baseUrl?: string | null;
    apiKey?: string;
    maxConcurrent?: number | null;
  },
): Promise<ApiConfigView> {
  const fragments: string[] = [];
  const values: unknown[] = [];
  const add = (col: string, val: unknown): void => {
    fragments.push(`${col} = $${values.length + 1}`);
    values.push(val);
  };

  if (patch.label !== undefined) {
    add(
      'label',
      patch.label != null && String(patch.label).trim()
        ? String(patch.label).trim()
        : null,
    );
  }
  if (patch.weight !== undefined) {
    const w =
      typeof patch.weight === 'number' &&
      Number.isFinite(patch.weight) &&
      patch.weight > 0
        ? Math.floor(patch.weight)
        : 1;
    add('weight', w);
  }
  if (patch.isEnabled !== undefined) {
    add('"isEnabled"', Boolean(patch.isEnabled));
  }
  if (patch.baseUrl !== undefined) {
    add(
      '"baseUrl"',
      patch.baseUrl != null && String(patch.baseUrl).trim()
        ? String(patch.baseUrl).trim()
        : null,
    );
  }
  if (patch.maxConcurrent !== undefined) {
    // null=清空（不限）；正整数 floor；与 create 同一 normalizeMaxConcurrent。
    add('"maxConcurrent"', normalizeMaxConcurrent(patch.maxConcurrent));
  }
  if (patch.apiKey !== undefined) {
    const replacement = String(patch.apiKey).trim();
    if (replacement.length < 12) throw new Error('新的 apiKey 长度无效');
    // 替换凭证后清空旧 Key 的熔断状态，管理员可立即测试并投入轮询。
    add('"apiKey"', replacement);
    add('"keyStatus"', 'active');
    add('"errorCount"', 0);
    add('"consecutiveFailures"', 0);
    add('"disabledUntil"', null);
    add('"lastErrorMessage"', null);
  }

  // NOW() 字面内联（非参数化），DB 算时间戳；无注入风险
  fragments.push('"updatedAt" = NOW()');

  const setClause = fragments.join(', ');
  const { rows } = await query(
    `UPDATE api_configs SET ${setClause}
      WHERE id = $${values.length + 1} AND "userId" IS NULL
      RETURNING ${SELECT_COLS}`,
    [...values, id],
  );
  if (rows.length === 0) {
    throw new Error(`平台 API key 不存在: ${id}`);
  }
  return mapRow(rows[0] as ApiConfigRow);
}

/**
 * 删除平台级 key。
 *
 * WHERE "userId" IS NULL 守卫：绝不会误删用户 BYOK 行（GC-1）。
 *
 * @throws Error id 不存在（或属于用户 BYOK 行）
 */
export async function deletePlatformConfig(id: string): Promise<void> {
  const { rowCount } = await query(
    'DELETE FROM api_configs WHERE id = $1 AND "userId" IS NULL',
    [id],
  );
  if ((rowCount ?? 0) === 0) {
    throw new Error(`平台 API key 不存在: ${id}`);
  }
}

/**
 * 重置 key 状态为 active（清除 cooldown/invalid 标记）。
 *
 * 用于 admin 手动把 invalid/cooldown 的 key 重置回池中：
 *   - "keyStatus"='active'
 *   - "disabledUntil"=NULL
 *   - "consecutiveFailures"=0
 *   - "lastErrorMessage"=NULL
 *
 * @throws Error id 不存在（或属于用户 BYOK 行）
 */
export async function resetConfigStatus(id: string): Promise<ApiConfigView> {
  const { rows } = await query(
    `UPDATE api_configs SET
        "keyStatus" = 'active',
        "disabledUntil" = NULL,
        "consecutiveFailures" = 0,
        "lastErrorMessage" = NULL,
        "updatedAt" = NOW()
      WHERE id = $1 AND "userId" IS NULL
      RETURNING ${SELECT_COLS}`,
    [id],
  );
  if (rows.length === 0) {
    throw new Error(`平台 API key 不存在: ${id}`);
  }
  return mapRow(rows[0] as ApiConfigRow);
}

/**
 * 各 provider 的 /models 端点默认 baseUrl（仅用于连通测试 ping）。
 *
 * 取自 gateway/providers/*.ts 的真实默认值，确保 admin 未填 baseUrl 时也能 ping。
 */
const TEST_DEFAULT_BASE_URL: Record<string, string> = {
  kimi: 'https://api.moonshot.cn/v1',
  ark: 'https://ark.cn-beijing.volces.com/api/v3',
  deepseek: 'https://api.deepseek.com/v1',
};

/**
 * 轻量 ping 验证 key 可用性。
 *
 * 流程：
 *   1. 读平台 key 行的 provider + apiKey + baseUrl（**永不 log apiKey**）
 *   2. 支持的 provider：GET `${baseUrl||default}/models` Bearer 认证
 *      - 8s 超时；ok = HTTP<400
 *      - fetch 异常（网络/超时/abort）→ ok=false，message 含原因
 *   3. 不支持的 provider → ok=false，并明确标记“未执行真实测试”
 *
 * 支持的 provider：kimi / ark / deepseek。
 *
 * @throws Error id 不存在（或属于用户 BYOK 行）
 */
export async function testConfig(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const { rows } = await query(
    `SELECT provider, "apiKey", "baseUrl" FROM api_configs
      WHERE id = $1 AND "userId" IS NULL`,
    [id],
  );
  if (rows.length === 0) {
    throw new Error(`平台 API key 不存在: ${id}`);
  }
  const row = rows[0] as { provider: string; apiKey: string; baseUrl: string | null };
  const provider = row.provider;
  const apiKey = row.apiKey;
  const baseUrl =
    row.baseUrl && String(row.baseUrl).trim()
      ? String(row.baseUrl).trim().replace(/\/+$/, '')
      : TEST_DEFAULT_BASE_URL[provider];

  // 未实现探针绝不能伪装成“测试成功”；后台必须明确告诉管理员该结果未验证。
  if (!(provider in TEST_DEFAULT_BASE_URL)) {
    return { ok: false, message: '该 provider 暂无可用的连通性探针，未执行真实测试' };
  }

  // 拼接 /models 端点（baseUrl 已去尾斜杠）
  const url = `${baseUrl}/models`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (resp.status < 400) {
      return { ok: true, message: '连接成功' };
    }
    return { ok: false, message: `连接失败: HTTP ${resp.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `连接失败: ${msg}` };
  }
}

/** 平台 API key 池仓储聚合对象（便于整体注入/mock）。 */
export const apiConfigRepo = {
  list: listPlatformConfigs,
  listBalances: listPlatformConfigBalances,
  create: createPlatformConfig,
  import: importPlatformConfigs,
  update: updatePlatformConfig,
  delete: deletePlatformConfig,
  resetStatus: resetConfigStatus,
  test: testConfig,
};
