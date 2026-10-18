// ============================================================
// 修-C signup 安全修复 — 服务端新增/修改逻辑的回归测试
// ============================================================
//
// 覆盖：
//   - aliyun-sms: isDevMockMode（C3 正向信号 + production 强制拒绝）+ maskPhone（M3）
//   - sms-code.service: rateLimitAllow（C5 Lua 原子化）、verifyCode（M1 timing-safe）
//   - env: NODE_ENV enum（M2）+ production+SMS_MOCK_ENABLED 启动 throw（C3）
//   - user: BCRYPT_COST=12（I1）+ findUserByPhoneOrEmail 单格式查询（I7）+
//     createUserFromPhone 事务（I8）
//   - migrate: 0004-normalize-phone.sql 进入 migrations 目录
//
// 用 vi.mock 隔离 redis / pg / bcryptjs / genId 等外部依赖，测试逻辑本身。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ------------------------------------------------------------
// C3 + M3：aliyun-sms.isDevMockMode / maskPhone
// ------------------------------------------------------------

describe('aliyun-sms: isDevMockMode (C3 正向信号 + production 拒绝)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.SMS_MOCK_ENABLED = process.env.SMS_MOCK_ENABLED;
    saved.NODE_ENV = process.env.NODE_ENV;
    delete process.env.SMS_MOCK_ENABLED;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('默认不激活（SMS_MOCK_ENABLED 未设）', async () => {
    const { isDevMockMode } = await import('../../src/infra/sms/aliyun-sms');
    expect(isDevMockMode()).toBe(false);
  }, 15000);

  it('SMS_MOCK_ENABLED=true 且非 production → 激活', async () => {
    process.env.SMS_MOCK_ENABLED = 'true';
    process.env.NODE_ENV = 'development';
    const { isDevMockMode } = await import('../../src/infra/sms/aliyun-sms');
    expect(isDevMockMode()).toBe(true);
  });

  it('SMS_MOCK_ENABLED=true 且 production → 强制拒绝（false）', async () => {
    process.env.SMS_MOCK_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { isDevMockMode } = await import('../../src/infra/sms/aliyun-sms');
    expect(isDevMockMode()).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('SMS_MOCK_ENABLED 大小写不敏感（TRUE/True）', async () => {
    process.env.SMS_MOCK_ENABLED = 'TRUE';
    process.env.NODE_ENV = 'development';
    const { isDevMockMode } = await import('../../src/infra/sms/aliyun-sms');
    expect(isDevMockMode()).toBe(true);
  });

  it('SMS_MOCK_ENABLED=false / 任意非 true → 不激活', async () => {
    process.env.SMS_MOCK_ENABLED = 'false';
    process.env.NODE_ENV = 'development';
    const { isDevMockMode } = await import('../../src/infra/sms/aliyun-sms');
    expect(isDevMockMode()).toBe(false);
  });
});

describe('aliyun-sms: maskPhone (M3 脱敏)', () => {
  it('11 位手机号取首 3 末 4，中间 ****', async () => {
    const { maskPhone } = await import('../../src/infra/sms/aliyun-sms');
    expect(maskPhone('13800138000')).toBe('138****8000');
  });

  it('带 +86 前缀的国际格式同样脱敏', async () => {
    const { maskPhone } = await import('../../src/infra/sms/aliyun-sms');
    expect(maskPhone('+8613800138000')).toBe('+86****8000');
  });

  it('短于 7 位的输入返回 ***', async () => {
    const { maskPhone } = await import('../../src/infra/sms/aliyun-sms');
    expect(maskPhone('123')).toBe('***');
  });
});

// ------------------------------------------------------------
// C3 + M2：env.ts NODE_ENV enum + production+SMS_MOCK_ENABLED throw
// ------------------------------------------------------------

const FULL_ENV_BASE: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@h:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  MINIO_ENDPOINT: 'http://localhost:9000',
  MINIO_ACCESS_KEY: 'ak',
  MINIO_SECRET_KEY: 'sk',
  MINIO_BUCKET: 'dramaforge',
  NEXTAUTH_SECRET: 'secret',
  NEXTAUTH_URL: 'http://localhost:3000',
};

describe('env: NODE_ENV enum + production+SMS_MOCK_ENABLED throw (C3/M2)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of Object.keys(FULL_ENV_BASE)) saved[k] = process.env[k];
    saved.NODE_ENV = process.env.NODE_ENV;
    saved.SMS_MOCK_ENABLED = process.env.SMS_MOCK_ENABLED;
    for (const k of Object.keys(saved)) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  it('NODE_ENV 缺省 → development', async () => {
    const { loadEnv, _resetEnvCacheForTests } = await import('../../src/infra/env');
    _resetEnvCacheForTests();
    for (const [k, v] of Object.entries(FULL_ENV_BASE)) process.env[k] = v;
    const e = loadEnv();
    expect(e.NODE_ENV).toBe('development');
  });

  it('NODE_ENV 接受 production / development / test', async () => {
    const { loadEnv, _resetEnvCacheForTests } = await import('../../src/infra/env');
    for (const val of ['production', 'development', 'test']) {
      _resetEnvCacheForTests();
      for (const [k, v] of Object.entries(FULL_ENV_BASE)) process.env[k] = v;
      process.env.NODE_ENV = val;
      const e = loadEnv();
      expect(e.NODE_ENV).toBe(val);
    }
  });

  it('NODE_ENV 拒绝非 enum 值（如 prod / staging）', async () => {
    const { loadEnv, _resetEnvCacheForTests } = await import('../../src/infra/env');
    _resetEnvCacheForTests();
    for (const [k, v] of Object.entries(FULL_ENV_BASE)) process.env[k] = v;
    process.env.NODE_ENV = 'prod';
    expect(() => loadEnv()).toThrow();
  });

  it('production + SMS_MOCK_ENABLED=true → 启动 throw 阻止', async () => {
    const { loadEnv, _resetEnvCacheForTests } = await import('../../src/infra/env');
    _resetEnvCacheForTests();
    for (const [k, v] of Object.entries(FULL_ENV_BASE)) process.env[k] = v;
    process.env.NODE_ENV = 'production';
    process.env.SMS_MOCK_ENABLED = 'true';
    expect(() => loadEnv()).toThrow(/SMS_MOCK_ENABLED/);
  });

  it('production + 未设 SMS_MOCK_ENABLED → 正常启动', async () => {
    const { loadEnv, _resetEnvCacheForTests } = await import('../../src/infra/env');
    _resetEnvCacheForTests();
    for (const [k, v] of Object.entries(FULL_ENV_BASE)) process.env[k] = v;
    process.env.NODE_ENV = 'production';
    expect(() => loadEnv()).not.toThrow();
  });

  it('development + SMS_MOCK_ENABLED=true → 正常启动', async () => {
    const { loadEnv, _resetEnvCacheForTests } = await import('../../src/infra/env');
    _resetEnvCacheForTests();
    for (const [k, v] of Object.entries(FULL_ENV_BASE)) process.env[k] = v;
    process.env.NODE_ENV = 'development';
    process.env.SMS_MOCK_ENABLED = 'true';
    expect(() => loadEnv()).not.toThrow();
  });
});

// ------------------------------------------------------------
// C5 + M1：sms-code.service rateLimitAllow / verifyCode
// ------------------------------------------------------------

/**
 * 构造 mock redis：捕获 eval 调用（C5 验证原子化 Lua 路径）
 */
function makeMockRedis(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const evalCalls: { script: string; keys: string[]; args: string[] }[] = [];
  const incrCalls: { key: string }[] = [];

  const redis = {
    eval(script: string, numkeys: number, ...rest: (string | number)[]) {
      // 模拟 Lua 脚本行为：INCR + 首次 PEXPIRE
      const key = String(rest[0]);
      const windowMs = String(rest[1]);
      evalCalls.push({ script, keys: rest.slice(0, numkeys), args: rest.slice(numkeys) });
      const cur = Number(store.get(key) || '0') + 1;
      store.set(key, String(cur));
      // 不实际设 TTL，但记录脚本被执行
      void windowMs;
      return Promise.resolve(cur);
    },
    incr(key: string) {
      incrCalls.push({ key });
      const cur = Number(store.get(key) || '0') + 1;
      store.set(key, String(cur));
      return Promise.resolve(cur);
    },
    pexpire(_key: string, _ms: number) {
      return Promise.resolve(1);
    },
    get(key: string) {
      return Promise.resolve(store.get(key) ?? null);
    },
    set(key: string, val: string, _opt?: string, _ttl?: number) {
      store.set(key, val);
      return Promise.resolve('OK');
    },
    del(key: string) {
      store.delete(key);
      return Promise.resolve(1);
    },
    exists(key: string) {
      return Promise.resolve(store.has(key) ? 1 : 0);
    },
  };
  return { redis, store, evalCalls, incrCalls };
}

describe('sms-code.service: rateLimitAllow (C5 Lua 原子化)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('调用 redis.eval 执行 Lua 脚本（非 incr + pexpire 两步）', async () => {
    const { redis, evalCalls } = makeMockRedis();
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { rateLimitAllow } = await import('../../src/infra/sms/sms-code.service');
    await rateLimitAllow('test:key', 60_000, 10);
    expect(evalCalls.length).toBe(1);
    expect(evalCalls[0].script).toContain("redis.call('INCR'");
    expect(evalCalls[0].script).toContain("redis.call('PEXPIRE'");
    expect(evalCalls[0].script).toMatch(/if c == 1/);
    expect(evalCalls[0].keys).toEqual(['test:key']);
    expect(evalCalls[0].args).toEqual(['60000']);
  });

  it('窗口内未超阈值 → 允许', async () => {
    const { redis } = makeMockRedis();
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { rateLimitAllow } = await import('../../src/infra/sms/sms-code.service');
    expect(await rateLimitAllow('k1', 60_000, 5)).toBe(true);
    expect(await rateLimitAllow('k1', 60_000, 5)).toBe(true);
    expect(await rateLimitAllow('k1', 60_000, 5)).toBe(true);
  });

  it('超过阈值 → 拒绝', async () => {
    const { redis } = makeMockRedis();
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { rateLimitAllow } = await import('../../src/infra/sms/sms-code.service');
    expect(await rateLimitAllow('k2', 60_000, 2)).toBe(true);
    expect(await rateLimitAllow('k2', 60_000, 2)).toBe(true);
    expect(await rateLimitAllow('k2', 60_000, 2)).toBe(false);
  });
});

describe('sms-code.service: verifyCode (M1 timing-safe compare)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stored code 与 input 一致 → true 且清理 code/attempts key', async () => {
    const { redis, store } = makeMockRedis({
      'sms:code:13900000001': '123456',
      'sms:attempts:13900000001': '0',
    });
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { verifyCode } = await import('../../src/infra/sms/sms-code.service');
    const ok = await verifyCode('13900000001', '123456');
    expect(ok).toBe(true);
    expect(store.has('sms:code:13900000001')).toBe(false);
    expect(store.has('sms:attempts:13900000001')).toBe(false);
  });

  it('stored code 与 input 不一致 → false（保留 stored，便于下次校验）', async () => {
    const { redis, store } = makeMockRedis({
      'sms:code:13900000002': '123456',
      'sms:attempts:13900000002': '0',
    });
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { verifyCode } = await import('../../src/infra/sms/sms-code.service');
    const ok = await verifyCode('13900000002', '999999');
    expect(ok).toBe(false);
    // code 仍在（未消费）
    expect(store.get('sms:code:13900000002')).toBe('123456');
  });

  it('长度不等（input 不是 6 位）→ false', async () => {
    const { redis } = makeMockRedis({
      'sms:code:13900000003': '123456',
      'sms:attempts:13900000003': '0',
    });
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { verifyCode } = await import('../../src/infra/sms/sms-code.service');
    expect(await verifyCode('13900000003', '12345')).toBe(false);
    expect(await verifyCode('13900000003', '1234567')).toBe(false);
  });

  it('stored code 不存在（已过期或未发码）→ false', async () => {
    const { redis } = makeMockRedis({});
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { verifyCode } = await import('../../src/infra/sms/sms-code.service');
    expect(await verifyCode('13900000004', '123456')).toBe(false);
  });
});

// ------------------------------------------------------------
// 批1.5 补强：storeCode 写 3 键 + isResendLocked + verifyCode 超限作废
// 任务要求覆盖：发码限流 / 校验失败计数 / 过期（已发码 TTL 走 redis EX）
// ------------------------------------------------------------

describe('sms-code.service: storeCode 写 3 键（code + lock + attempts）', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('storeCode 写入 code/lock/attempts 三个 Redis key（各带 EX TTL）', async () => {
    const { redis, store } = makeMockRedis();
    // 捕获 set 调用的 TTL 参数以验证 EX 语义（防回归：忘加 TTL → 验证码永不过期）
    const setCalls: { key: string; val: string; opt?: string; ttl?: number }[] = [];
    const origSet = redis.set.bind(redis);
    redis.set = (key: string, val: string, opt?: string, ttl?: number) => {
      setCalls.push({ key, val, opt, ttl });
      return origSet(key, val, opt, ttl);
    };
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));

    const { storeCode } = await import('../../src/infra/sms/sms-code.service');
    await storeCode('13900000010', '654321');

    // 三个 key 都写入
    expect(store.has('sms:code:13900000010')).toBe(true);
    expect(store.has('sms:lock:13900000010')).toBe(true);
    expect(store.has('sms:attempts:13900000010')).toBe(true);
    // 值正确
    expect(store.get('sms:code:13900000010')).toBe('654321');
    expect(store.get('sms:lock:13900000010')).toBe('1');
    expect(store.get('sms:attempts:13900000010')).toBe('0');
    // 所有 set 调用都带 EX TTL（防回归：TTL 缺失会让 code/lock 永久占 Redis）
    expect(setCalls.length).toBe(3);
    for (const c of setCalls) {
      expect(c.opt).toBe('EX');
      expect(typeof c.ttl).toBe('number');
      expect(c.ttl! > 0).toBe(true);
    }
  });
});

describe('sms-code.service: isResendLocked (60s 重发锁)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('未发码 → 未锁定（可发）', async () => {
    const { redis } = makeMockRedis();
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { isResendLocked } = await import('../../src/infra/sms/sms-code.service');
    expect(await isResendLocked('13900000020')).toBe(false);
  });

  it('storeCode 后 → 锁定 60s 内禁止重发', async () => {
    const { redis } = makeMockRedis();
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { storeCode, isResendLocked } = await import(
      '../../src/infra/sms/sms-code.service'
    );
    await storeCode('13900000021', '111222');
    expect(await isResendLocked('13900000021')).toBe(true);
  });
});

describe('sms-code.service: 校验失败计数超限作废（C2 + M1）', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 默认 SMS_CODE_MAX_ATTEMPTS=5：前 5 次（含错码）可继续尝试，第 6 次起作废。
   * verifyCode 流程：先 incr → 超 max → del code/attempts → false。
   * 用 4 次错码 + 第 5 次错码 + 第 6 次正码验证"超过 max 后即便输入正确也 false"。
   */
  it('连续 N+1 次失败后即便输入正确 code 也作废（防暴力枚举）', async () => {
    const { redis, store } = makeMockRedis({
      'sms:code:13900000030': '42code',
      'sms:attempts:13900000030': '0',
    });
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    const { verifyCode } = await import('../../src/infra/sms/sms-code.service');

    // 前 5 次（maxAttempts=5）错码 → 全 false，code 仍在
    for (let i = 0; i < 5; i++) {
      const ok = await verifyCode('13900000030', '000000');
      expect(ok).toBe(false);
    }
    expect(store.get('sms:code:13900000030')).toBe('42code');

    // 第 6 次：即便输入正确 code 也作废，且 code/attempts key 被清理
    const ok6 = await verifyCode('13900000030', '42code');
    expect(ok6).toBe(false);
    expect(store.has('sms:code:13900000030')).toBe(false);
    expect(store.has('sms:attempts:13900000030')).toBe(false);
  });

  it('SMS_CODE_MAX_ATTEMPTS 自定义阈值被尊重', async () => {
    const { redis, store } = makeMockRedis({
      'sms:code:13900000031': '999999',
      'sms:attempts:13900000031': '0',
    });
    vi.doMock('../../src/infra/redis', () => ({ getRedis: () => redis }));
    process.env.SMS_CODE_MAX_ATTEMPTS = '2';
    try {
      const { verifyCode } = await import('../../src/infra/sms/sms-code.service');
      // 2 次错码后第 3 次即便正码也作废
      expect(await verifyCode('13900000031', '000000')).toBe(false);
      expect(await verifyCode('13900000031', '111111')).toBe(false);
      expect(await verifyCode('13900000031', '999999')).toBe(false);
      expect(store.has('sms:code:13900000031')).toBe(false);
    } finally {
      delete process.env.SMS_CODE_MAX_ATTEMPTS;
    }
  });
});

// ------------------------------------------------------------
// I1 + I7 + I8：user.ts
// ------------------------------------------------------------

describe('user: BCRYPT_COST=12 (I1)', () => {
  it('导出常量 = 12', async () => {
    const { BCRYPT_COST } = await import('../../src/infra/user');
    expect(BCRYPT_COST).toBe(12);
  });
});

describe('user: findUserByPhoneOrEmail 单格式查询 (I7)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('只查 phone = +8613xxx，不再多格式 OR', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    vi.doMock('../../src/infra/pg', () => ({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [], rowCount: 0 };
      },
      tx: async () => {
        throw new Error('should not be called');
      },
    }));
    const { findUserByPhoneOrEmail } = await import('../../src/infra/user');
    await findUserByPhoneOrEmail('13900000001');
    expect(calls.length).toBe(1);
    expect(calls[0].sql).not.toContain(' OR ');
    expect(calls[0].sql).toMatch(/WHERE phone = \$1/);
    expect(calls[0].params).toEqual(['+8613900000001']);
  });
});

describe('user: createUserFromPhone 事务 (I8)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('users + user_preferences 两步 INSERT 在同一事务内', async () => {
    const txCalls: string[] = [];
    let txBody: ((q: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) | null = null;
    vi.doMock('../../src/infra/pg', () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      tx: async <T,>(fn: (q: { query: (sql: string) => Promise<unknown> }) => Promise<T>): Promise<T> => {
        txBody = fn as typeof txBody;
        const q = {
          async query(sql: string) {
            txCalls.push(sql);
            return { rows: [], rowCount: 1 };
          },
        };
        return (txBody as typeof txBody)(q) as T;
      },
    }));
    vi.doMock('bcryptjs', () => ({
      default: { hash: async () => '$2b$12$mockhash' },
    }));
    vi.doMock('@shared/utils', () => ({ genId: () => 'mock-id' }));

    const { createUserFromPhone } = await import('../../src/infra/user');
    await createUserFromPhone('13900000001', 'password1', 'alice');

    // 两步 INSERT
    const inserts = txCalls.filter((s) => s.startsWith('INSERT INTO'));
    expect(inserts.length).toBe(2);
    expect(txCalls.some((s) => s.includes('INSERT INTO users'))).toBe(true);
    expect(txCalls.some((s) => s.includes('INSERT INTO user_preferences'))).toBe(true);
  });

  it('事务失败抛出（不再 swallow user_preferences 错误）', async () => {
    vi.doMock('../../src/infra/pg', () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      tx: async () => {
        throw new Error('tx failed');
      },
    }));
    vi.doMock('bcryptjs', () => ({
      default: { hash: async () => '$2b$12$mockhash' },
    }));
    vi.doMock('@shared/utils', () => ({ genId: () => 'mock-id' }));

    const { createUserFromPhone } = await import('../../src/infra/user');
    await expect(createUserFromPhone('13900000001', 'pw1')).rejects.toThrow('tx failed');
  });
});

// ------------------------------------------------------------
// I7：migrations 目录含 0004-normalize-phone.sql
// ------------------------------------------------------------

describe('migrate: 0004-normalize-phone.sql 在场 (I7)', () => {
  it('discoverMigrations 包含 0004-normalize-phone.sql', async () => {
    const { discoverMigrations } = await import('../../src/infra/migrate');
    const files = await discoverMigrations();
    const names = files.map((f) => f.name);
    expect(names).toContain('0004-normalize-phone.sql');
  });

  it('迁移内容含 UPDATE + CHECK 约束', async () => {
    const { discoverMigrations } = await import('../../src/infra/migrate');
    const files = await discoverMigrations();
    const m = files.find((f) => f.name === '0004-normalize-phone.sql');
    expect(m).toBeDefined();
    expect(m!.sql).toContain("UPDATE users");
    expect(m!.sql).toContain("'+86' || phone");
    expect(m!.sql).toMatch(/CHECK \(phone IS NULL OR phone LIKE '\+86%'\)/);
  });
});
