// ============================================================
// ③ server/domain/api-configs — 单测
// ============================================================
//
// 覆盖：
//   - listPlatformConfigs：apiKey 全列掩码（明文永不返回）；WHERE "userId" IS NULL
//   - createPlatformConfig：INSERT 强制 "userId"=NULL（平台 key 标识，GC-1）+
//     "keyStatus"='active' / "isEnabled"=TRUE / NOW() 时间戳
//   - updatePlatformConfig：只更新显式提供的字段（patch 白名单）
//   - deletePlatformConfig：WHERE "userId" IS NULL 守卫（不会误删 BYOK）
//   - resetConfigStatus：清零 failure/cooldown 字段
//
// mock @server/infra.query：按 SQL pattern 路由返固定结果，状态化模拟 api_configs 表。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@shared/utils', () => ({ genId: vi.fn(() => 'uuid-mock-1') }));
vi.mock('@server/infra', () => ({
  query: vi.fn(),
  tx: vi.fn(),
}));

import {
  listPlatformConfigs,
  revealPlatformConfigKey,
  createPlatformConfig,
  updatePlatformConfig,
  deletePlatformConfig,
  resetConfigStatus,
} from '../../src/domain/api-configs';
import { query } from '@server/infra';

type QueryCall = { sql: string; params?: unknown[] };

/** 平台 key 行的种子形状（DB 原始列名）。 */
function seedRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'c-1',
    userId: null,
    provider: 'kimi',
    apiKey: 'sk-xxxxxxxxxxxx',
    baseUrl: null,
    isEnabled: true,
    label: null,
    weight: 1,
    keyStatus: 'active',
    lastUsedAt: null,
    errorCount: 0,
    consecutiveFailures: 0,
    disabledUntil: null,
    lastErrorMessage: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

/**
 * 状态化 mock：模拟 api_configs 表（仅平台行 userId=null）。
 *
 * 实现要点：
 *   - 先 `sql.replace(/\s+/g, ' ')` 归一化空白，避免多行 SQL 让 `.` 跨行失败
 *   - 按 SQL pattern 路由：SELECT list / SELECT single(testConfig 用) / INSERT / UPDATE
 *     (含 resetStatus 专属分支) / DELETE
 *   - UPDATE 用 `col = $N` regex 解析参数化片段；resetStatus 走固定字段赋值分支
 */
function setupStatefulMock(initial: Array<Record<string, unknown>> = []): {
  calls: QueryCall[];
  state: { rows: Array<Record<string, unknown>> };
} {
  const calls: QueryCall[] = [];
  const state = { rows: initial.slice() };

  vi.mocked(query).mockImplementation(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    // INSERT
    if (/INSERT INTO api_configs/.test(s)) {
      const newId = params?.[0] as string;
      const newRow = seedRow({
        id: newId,
        provider: params?.[1],
        apiKey: params?.[2],
        baseUrl: params?.[3],
        label: params?.[4],
        weight: params?.[5],
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
      });
      state.rows.push(newRow);
      return { rows: [{ ...newRow }], rowCount: 1 };
    }

    // DELETE
    if (/DELETE FROM api_configs/.test(s)) {
      const idParam = params?.[0] as string;
      const idx = state.rows.findIndex((r) => r.id === idParam && r.userId == null);
      if (idx < 0) return { rows: [], rowCount: 0 };
      state.rows.splice(idx, 1);
      return { rows: [], rowCount: 1 };
    }

    // UPDATE resetStatus：SQL 含 "keyStatus" = 'active'（字面值，非 $N）
    if (/UPDATE api_configs SET/.test(s) && /"keyStatus" = 'active'/.test(s)) {
      const idParam = params?.[params.length - 1] as string;
      const row = state.rows.find((r) => r.id === idParam && r.userId == null);
      if (!row) return { rows: [], rowCount: 0 };
      row.keyStatus = 'active';
      row.disabledUntil = null;
      row.consecutiveFailures = 0;
      row.lastErrorMessage = null;
      row.updatedAt = '2026-07-21T12:00:00.000Z';
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // UPDATE 通用：解析 `col = $N` 片段（参数化）
    if (/UPDATE api_configs SET/.test(s)) {
      const idParam = params?.[params.length - 1] as string;
      const row = state.rows.find((r) => r.id === idParam && r.userId == null);
      if (!row) return { rows: [], rowCount: 0 };
      const setMatch = s.match(/SET (.+?) WHERE/);
      if (setMatch) {
        for (const frag of setMatch[1].split(', ')) {
          const m = frag.match(/^("?[\w]+"?) = \$(\d+)$/);
          if (m) {
            const col = m[1].replace(/"/g, '');
            const idx = parseInt(m[2], 10) - 1;
            row[col] = params?.[idx];
          }
        }
      }
      row.updatedAt = '2026-07-21T12:00:00.000Z';
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // SELECT single（testConfig 用，只取 3 字段）
    if (/SELECT provider, "apiKey", "baseUrl" FROM api_configs/.test(s)) {
      const idParam = params?.[0] as string;
      const row = state.rows.find((r) => r.id === idParam && r.userId == null);
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [
          { provider: row.provider, apiKey: row.apiKey, baseUrl: row.baseUrl },
        ],
        rowCount: 1,
      };
    }

    // SELECT single secret（管理员主动查看一条完整 Key）。
    if (/SELECT "apiKey" FROM api_configs/.test(s)) {
      const idParam = params?.[0] as string;
      const row = state.rows.find((item) => item.id === idParam && item.userId == null);
      return row
        ? { rows: [{ apiKey: row.apiKey }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    // SELECT list（WHERE "userId" IS NULL）
    if (/FROM api_configs/.test(s) && /WHERE "userId" IS NULL/.test(s) && /^SELECT/.test(s)) {
      return { rows: state.rows.map((r) => ({ ...r })), rowCount: state.rows.length };
    }

    return { rows: [], rowCount: 0 };
  });

  return { calls, state };
}

// ============================================================
// listPlatformConfigs — apiKey 全列掩码
// ============================================================

describe('listPlatformConfigs — apiKey masking + platform scope', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('masks every apiKey: first 4 + … + last 4 (full key never returned)', async () => {
    setupStatefulMock([
      seedRow({
        id: 'c-1',
        provider: 'kimi',
        apiKey: 'sk-abcXYZ1234567d890', // 19 chars → 首尾各 4
        baseUrl: 'https://api.moonshot.cn/v1',
        label: '主号',
      }),
      seedRow({
        id: 'c-2',
        provider: 'deepseek',
        apiKey: 'short', // 5 chars < 8 → '****'
        baseUrl: null,
        isEnabled: false,
        label: null,
        weight: 2,
        keyStatus: 'cooldown',
        lastUsedAt: new Date('2026-07-20T10:00:00Z'),
        errorCount: 3,
        consecutiveFailures: 2,
        disabledUntil: new Date('2026-07-21T10:00:00Z'),
        lastErrorMessage: 'rate limit',
      }),
    ]);

    const list = await listPlatformConfigs();
    expect(list).toHaveLength(2);

    // 长 key（19 字符）：首 4 + … + 尾 4，明文不可见
    expect(list[0].apiKeyMasked).toBe('sk-a…d890');
    expect(list[0].apiKeyMasked).not.toContain('XYZ1234567');

    // 短 key（5 字符 < 8）：'****'
    expect(list[1].apiKeyMasked).toBe('****');

    // 字段完整性
    expect(list[0].id).toBe('c-1');
    expect(list[0].provider).toBe('kimi');
    expect(list[0].label).toBe('主号');
    expect(list[0].baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(list[0].weight).toBe(1);
    expect(list[0].keyStatus).toBe('active');
    expect(list[0].lastUsedAt).toBeNull();

    expect(list[1].keyStatus).toBe('cooldown');
    expect(list[1].errorCount).toBe(3);
    expect(list[1].consecutiveFailures).toBe(2);
    expect(list[1].disabledUntil).toBe('2026-07-21T10:00:00.000Z');
    expect(list[1].lastErrorMessage).toBe('rate limit');
    expect(list[1].lastUsedAt).toBe('2026-07-20T10:00:00.000Z');
  });

  it('emits SELECT with WHERE "userId" IS NULL + ORDER BY provider, "createdAt"', async () => {
    const { calls } = setupStatefulMock([]);
    await listPlatformConfigs();
    const selectCall = calls.find(
      (c) => c.sql.includes('FROM api_configs') && c.sql.includes('SELECT'),
    );
    expect(selectCall).toBeDefined();
    expect(selectCall!.sql).toContain('WHERE "userId" IS NULL');
    expect(selectCall!.sql).toContain('ORDER BY provider ASC, "createdAt" ASC');
  });

  it('handles empty pool → []', async () => {
    setupStatefulMock([]);
    const list = await listPlatformConfigs();
    expect(list).toEqual([]);
  });
});

// ============================================================
// revealPlatformConfigKey — 管理员按条查看
// ============================================================

describe('revealPlatformConfigKey — single platform secret', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('returns one full key with the platform-scope guard', async () => {
    const { calls } = setupStatefulMock([
      seedRow({ id: 'c-1', apiKey: 'sk-full-secret-123456' }),
    ]);

    await expect(revealPlatformConfigKey('c-1')).resolves.toBe('sk-full-secret-123456');
    const selectCall = calls.find((call) => call.sql.includes('SELECT "apiKey"'));
    expect(selectCall?.sql).toContain('id = $1 AND "userId" IS NULL');
    expect(selectCall?.params).toEqual(['c-1']);
  });

  it('rejects an unknown or non-platform id', async () => {
    setupStatefulMock([]);
    await expect(revealPlatformConfigKey('missing')).rejects.toThrow(/不存在/);
  });
});

// ============================================================
// createPlatformConfig — 平台 key 标识 userId=NULL
// ============================================================

describe('createPlatformConfig — INSERT platform key (userId=NULL)', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('INSERTs row with userId=NULL literal + keyStatus=active + isEnabled=TRUE', async () => {
    const { calls, state } = setupStatefulMock([]);

    const created = await createPlatformConfig({
      provider: 'kimi',
      apiKey: 'sk-brand-new-key-12345',
      label: '主号',
      weight: 3,
      baseUrl: 'https://api.moonshot.cn/v1',
    });

    // INSERT 调用应在 SQL 文本里字面写 NULL（非 $N 参数）
    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO api_configs'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toMatch(/VALUES\s*\(\s*\$1,\s*NULL,\s*\$2/);
    expect(insertCall!.sql).toContain("'active'");
    expect(insertCall!.sql).toContain('TRUE');
    expect(insertCall!.sql).toContain('NOW(), NOW()');

    // params: [id, provider, apiKey, baseUrl, label, weight, maxConcurrent] —— userId 不在 params
    expect(insertCall!.params).toEqual([
      'uuid-mock-1',
      'kimi',
      'sk-brand-new-key-12345',
      'https://api.moonshot.cn/v1',
      '主号',
      3,
      null, // maxConcurrent 未提供 → null（运行时 pick 视为 Infinity 不限）
    ]);

    // 返回的视图已掩码
    expect(created.apiKeyMasked).toBe('sk-b…2345');
    expect(created.id).toBe('uuid-mock-1');
    expect(created.provider).toBe('kimi');
    expect(created.keyStatus).toBe('active');
    expect(created.isEnabled).toBe(true);

    // state 也确实落了 userId=null
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].userId).toBeNull();
    expect(state.rows[0].apiKey).toBe('sk-brand-new-key-12345');
  });

  it('rejects empty provider / empty apiKey', async () => {
    setupStatefulMock([]);
    await expect(
      createPlatformConfig({ provider: '', apiKey: 'sk-x' }),
    ).rejects.toThrow(/provider/);
    await expect(
      createPlatformConfig({ provider: 'kimi', apiKey: '' }),
    ).rejects.toThrow(/apiKey/);
  });

  it('defaults weight=1 when weight missing/non-positive', async () => {
    const { calls } = setupStatefulMock([]);
    await createPlatformConfig({ provider: 'kimi', apiKey: 'sk-xxxxxxxxxxxx' });
    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO api_configs'));
    expect(insertCall!.params?.[5]).toBe(1); // weight default
  });
});

// ============================================================
// updatePlatformConfig — patch 白名单 + platform scope
// ============================================================

describe('updatePlatformConfig — patch whitelist', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('only updates provided fields + updatedAt=NOW()', async () => {
    const { calls } = setupStatefulMock([
      seedRow({
        id: 'c-1',
        provider: 'deepseek',
        apiKey: 'sk-original',
        baseUrl: 'https://api.deepseek.com/v1',
        label: 'old',
        weight: 1,
        isEnabled: true,
      }),
    ]);

    const updated = await updatePlatformConfig('c-1', {
      weight: 5,
      isEnabled: false,
    });
    expect(updated.weight).toBe(5);
    expect(updated.isEnabled).toBe(false);
    // 未 patch 的字段保留
    expect(updated.label).toBe('old');
    expect(updated.baseUrl).toBe('https://api.deepseek.com/v1');

    const updateCall = calls.find((c) => c.sql.includes('UPDATE api_configs SET'));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain('weight = $');
    expect(updateCall!.sql).toContain('"isEnabled" = $');
    expect(updateCall!.sql).toContain('"updatedAt" = NOW()');
    // 守卫：WHERE "userId" IS NULL
    expect(updateCall!.sql).toContain('AND "userId" IS NULL');
  });

  it('replaces a key without returning plaintext and resets stale failure state', async () => {
    const { calls, state } = setupStatefulMock([
      seedRow({
        id: 'c-1',
        provider: 'kimi',
        apiKey: 'sk-old-secret-1234',
        keyStatus: 'invalid',
        consecutiveFailures: 3,
        disabledUntil: '2026-07-30T00:00:00.000Z',
        lastErrorMessage: '旧 Key 已失效',
      }),
    ]);

    const updated = await updatePlatformConfig('c-1', {
      apiKey: 'sk-new-secret-5678',
    });

    // 管理员可替换 Key，但响应仍只有掩码，旧的冷却/失效状态会一并清理。
    expect(updated.apiKeyMasked).toBe('sk-n…5678');
    expect(JSON.stringify(updated)).not.toContain('sk-new-secret-5678');
    expect(state.rows[0].apiKey).toBe('sk-new-secret-5678');
    const updateCall = calls.find((c) => c.sql.includes('UPDATE api_configs SET'));
    expect(updateCall?.sql).toContain('"apiKey" = $');
    expect(updateCall?.sql).toContain('"keyStatus" =');
  });

  it('allows an admin to extend the pool with a safe provider id', async () => {
    const { state } = setupStatefulMock([]);
    const created = await createPlatformConfig({
      provider: 'New.Provider-V2',
      apiKey: 'sk-new-provider-1234',
    });
    expect(created.provider).toBe('new.provider-v2');
    expect(state.rows[0].provider).toBe('new.provider-v2');
  });

  it('rejects unsafe provider ids instead of relying on a hardcoded enum', async () => {
    setupStatefulMock([]);
    await expect(
      createPlatformConfig({ provider: '../bad provider', apiKey: 'sk-not-safe-1234' }),
    ).rejects.toThrow(/provider/);
  });

  it('throws when id not found in platform pool', async () => {
    setupStatefulMock([]);
    await expect(updatePlatformConfig('missing-id', {})).rejects.toThrow(
      /平台 API key 不存在/,
    );
  });
});

// ============================================================
// deletePlatformConfig — platform scope guard
// ============================================================

describe('deletePlatformConfig — platform scope guard', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('emits DELETE with WHERE id = $1 AND "userId" IS NULL', async () => {
    const { calls, state } = setupStatefulMock([
      seedRow({ id: 'c-1', apiKey: 'sk-to-delete' }),
    ]);
    await deletePlatformConfig('c-1');
    const deleteCall = calls.find((c) => c.sql.includes('DELETE FROM api_configs'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.sql).toContain('WHERE id = $1 AND "userId" IS NULL');
    expect(state.rows).toHaveLength(0);
  });

  it('throws when id missing (refuses to touch BYOK rows)', async () => {
    setupStatefulMock([]);
    await expect(deletePlatformConfig('missing')).rejects.toThrow(
      /平台 API key 不存在/,
    );
  });
});

// ============================================================
// resetConfigStatus — 清零 failure / cooldown
// ============================================================

describe('resetConfigStatus — clears failure state', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('sets keyStatus=active + clears all failure fields', async () => {
    const { calls } = setupStatefulMock([
      seedRow({
        id: 'c-1',
        provider: 'ark',
        apiKey: 'ark-xxx',
        keyStatus: 'cooldown',
        errorCount: 5,
        consecutiveFailures: 3,
        disabledUntil: '2026-07-21T10:00:00.000Z',
        lastErrorMessage: 'rate limit exceeded',
      }),
    ]);

    const reset = await resetConfigStatus('c-1');
    expect(reset.keyStatus).toBe('active');
    expect(reset.consecutiveFailures).toBe(0);
    expect(reset.disabledUntil).toBeNull();
    expect(reset.lastErrorMessage).toBeNull();
    // errorCount 不被 reset（历史累计，仅 consecutive 被清零）
    expect(reset.errorCount).toBe(5);

    const updateCall = calls.find((c) => c.sql.includes('UPDATE api_configs SET'));
    expect(updateCall!.sql).toContain("\"keyStatus\" = 'active'");
    expect(updateCall!.sql).toContain('"disabledUntil" = NULL');
    expect(updateCall!.sql).toContain('"consecutiveFailures" = 0');
    expect(updateCall!.sql).toContain('"lastErrorMessage" = NULL');
  });
});
