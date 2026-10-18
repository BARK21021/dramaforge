// ============================================================
// ③ server/domain/concurrency — 单测
// ============================================================
//
// 覆盖：
//   - acquireSlot：limit 内允许 / 超限拒绝并回滚 / limit<=0 拒绝 / 成功后 EXPIRE
//   - releaseSlot：DECR 正常 / floor 在 0（重复 release 不变负）
//   - getStatus：读取当前计数 / key 不存在返回 0 / 负数纠正为 0
//   - clearAll：DEL key
//
// mock @server/infra 的 getRedis：返回有状态 mock redis 客户端，
// 模拟 INCR/DECR/EXPIRE/SET/DEL/GET 语义，不依赖真实 Redis。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock @server/infra 的 getRedis
const mockRedisState = { counters: new Map<string, number>() };

function makeMockRedis() {
  // 每个测试前重置状态
  mockRedisState.counters = new Map();
  const calls: string[] = [];
  const redis = {
    async incr(key: string): Promise<number> {
      calls.push(`incr:${key}`);
      const v = (mockRedisState.counters.get(key) ?? 0) + 1;
      mockRedisState.counters.set(key, v);
      return v;
    },
    async decr(key: string): Promise<number> {
      calls.push(`decr:${key}`);
      const v = (mockRedisState.counters.get(key) ?? 0) - 1;
      mockRedisState.counters.set(key, v);
      return v;
    },
    async expire(key: string, ttl: number): Promise<number> {
      calls.push(`expire:${key}:${ttl}`);
      return 1;
    },
    async set(key: string, value: number | string): Promise<'OK'> {
      calls.push(`set:${key}:${value}`);
      mockRedisState.counters.set(key, Number(value));
      return 'OK';
    },
    async get(key: string): Promise<string | null> {
      calls.push(`get:${key}`);
      const v = mockRedisState.counters.get(key);
      return v === undefined ? null : String(v);
    },
    async del(key: string): Promise<number> {
      calls.push(`del:${key}`);
      const existed = mockRedisState.counters.has(key);
      mockRedisState.counters.delete(key);
      return existed ? 1 : 0;
    },
    async scan(_cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
      // 简化：忽略分页，一次性返回所有匹配 pattern 的 key（recomputeAllFromDb 用）
      const pattern = args.find((a) => typeof a === 'string' && a.includes('*')) as
        | string
        | undefined;
      const all = Array.from(mockRedisState.counters.keys());
      const prefix = pattern ? pattern.replace('*', '') : '';
      const matched = prefix ? all.filter((k) => k.startsWith(prefix)) : all;
      calls.push('scan');
      return ['0', matched];
    },
  };
  return { redis, calls };
}

let currentMock: ReturnType<typeof makeMockRedis>;

const queryMock = vi.fn();
vi.mock('@server/infra', () => ({
  getRedis: () => currentMock.redis,
  query: (...args: unknown[]) => queryMock(...args),
}));

import {
  acquireSlot,
  releaseSlot,
  getStatus,
  clearAll,
  recomputeAllFromDb,
} from '../../src/domain/concurrency';

describe('concurrency (Redis INCR/DECR mock)', () => {
  beforeEach(() => {
    currentMock = makeMockRedis();
  });

  // ----------------------------------------------------------
  // acquireSlot
  // ----------------------------------------------------------
  describe('acquireSlot', () => {
    it('allows when current < limit', async () => {
      const r1 = await acquireSlot('u-1', 3);
      expect(r1.allowed).toBe(true);
      expect(r1.current).toBe(1);
      expect(r1.max).toBe(3);

      const r2 = await acquireSlot('u-1', 3);
      expect(r2.allowed).toBe(true);
      expect(r2.current).toBe(2);

      const r3 = await acquireSlot('u-1', 3);
      expect(r3.allowed).toBe(true);
      expect(r3.current).toBe(3);
    });

    it('denies and rolls back when exceeding limit', async () => {
      // 占满 3 个槽
      await acquireSlot('u-1', 3);
      await acquireSlot('u-1', 3);
      await acquireSlot('u-1', 3);

      // 第 4 次应被拒绝并回滚
      const r = await acquireSlot('u-1', 3);
      expect(r.allowed).toBe(false);
      expect(r.current).toBe(3); // 回滚后仍为 3（满）
      expect(r.max).toBe(3);
      expect(r.reason).toContain('上限');

      // 实际计数仍是 3（INCR 后 DECR 回滚）
      const status = await getStatus('u-1');
      expect(status.current).toBe(3);
    });

    it('emits INCR then DECR (rollback) on denial', async () => {
      await acquireSlot('u-1', 1); // 占满
      currentMock.calls.length = 0; // 清空 calls

      await acquireSlot('u-1', 1); // 超限

      const incrCalls = currentMock.calls.filter((c) => c.startsWith('incr:'));
      const decrCalls = currentMock.calls.filter((c) => c.startsWith('decr:'));
      expect(incrCalls).toHaveLength(1);
      expect(decrCalls).toHaveLength(1); // 回滚 DECR
    });

    it('calls EXPIRE after successful acquire (safety TTL)', async () => {
      currentMock.calls.length = 0;
      await acquireSlot('u-1', 5);
      const expireCalls = currentMock.calls.filter((c) => c.startsWith('expire:'));
      expect(expireCalls).toHaveLength(1);
      // TTL = 2400 秒（40min，> 单任务最长 EPISODE_SPLIT 30min，防长任务运行中 TTL 到期致 2× 过并发）
      expect(expireCalls[0]).toBe('expire:concurrency:user:u-1:2400');
    });

    it('does NOT call EXPIRE on denial', async () => {
      await acquireSlot('u-1', 1); // 占满
      currentMock.calls.length = 0;

      await acquireSlot('u-1', 1); // 超限

      const expireCalls = currentMock.calls.filter((c) => c.startsWith('expire:'));
      expect(expireCalls).toHaveLength(0);
    });

    it('rejects when limit <= 0 without touching redis', async () => {
      const r = await acquireSlot('u-1', 0);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('非法');
      // 没有调用 redis（mock state 仍空）
      expect(mockRedisState.counters.size).toBe(0);

      const r2 = await acquireSlot('u-1', -1);
      expect(r2.allowed).toBe(false);
    });

    it('isolates users by separate keys', async () => {
      await acquireSlot('u-1', 2);
      await acquireSlot('u-1', 2);
      // u-2 独立计数
      const r = await acquireSlot('u-2', 2);
      expect(r.allowed).toBe(true);
      expect(r.current).toBe(1);

      const s1 = await getStatus('u-1');
      const s2 = await getStatus('u-2');
      expect(s1.current).toBe(2);
      expect(s2.current).toBe(1);
    });
  });

  // ----------------------------------------------------------
  // releaseSlot
  // ----------------------------------------------------------
  describe('releaseSlot', () => {
    it('decrements counter on release', async () => {
      await acquireSlot('u-1', 3);
      await acquireSlot('u-1', 3);
      expect((await getStatus('u-1')).current).toBe(2);

      await releaseSlot('u-1');
      expect((await getStatus('u-1')).current).toBe(1);
    });

    it('floors at 0 on over-release (no negative)', async () => {
      await acquireSlot('u-1', 3);
      expect((await getStatus('u-1')).current).toBe(1);

      // 重复 release 3 次（超过 acquire 次数）
      await releaseSlot('u-1');
      await releaseSlot('u-1');
      await releaseSlot('u-1');

      // 不应为负
      const s = await getStatus('u-1');
      expect(s.current).toBe(0);
    });

    it('release without prior acquire floors at 0', async () => {
      await releaseSlot('u-never');
      const s = await getStatus('u-never');
      expect(s.current).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // getStatus
  // ----------------------------------------------------------
  describe('getStatus', () => {
    it('returns 0 when key does not exist', async () => {
      const s = await getStatus('u-empty');
      expect(s.current).toBe(0);
    });

    it('returns current count after acquires', async () => {
      await acquireSlot('u-1', 5);
      await acquireSlot('u-1', 5);
      await acquireSlot('u-1', 5);
      expect((await getStatus('u-1')).current).toBe(3);
    });
  });

  // ----------------------------------------------------------
  // clearAll
  // ----------------------------------------------------------
  describe('clearAll', () => {
    it('resets user counter to 0', async () => {
      await acquireSlot('u-1', 5);
      await acquireSlot('u-1', 5);
      expect((await getStatus('u-1')).current).toBe(2);

      await clearAll('u-1');
      expect((await getStatus('u-1')).current).toBe(0);
    });

    it('does not affect other users', async () => {
      await acquireSlot('u-1', 5);
      await acquireSlot('u-2', 5);

      await clearAll('u-1');

      expect((await getStatus('u-1')).current).toBe(0);
      expect((await getStatus('u-2')).current).toBe(1);
    });
  });

  // ----------------------------------------------------------
  // acquire + release 综合循环
  // ----------------------------------------------------------
  describe('acquire + release cycle', () => {
    it('release frees a slot for re-acquire after denial', async () => {
      // 占满 limit=2
      await acquireSlot('u-1', 2);
      await acquireSlot('u-1', 2);
      // 第 3 次被拒
      const denied = await acquireSlot('u-1', 2);
      expect(denied.allowed).toBe(false);

      // release 一个
      await releaseSlot('u-1');
      // 现在可以再次 acquire
      const ok = await acquireSlot('u-1', 2);
      expect(ok.allowed).toBe(true);
      expect(ok.current).toBe(2);
    });
  });

  // ----------------------------------------------------------
  // recomputeAllFromDb（worker 启动重算）
  // ----------------------------------------------------------
  describe('recomputeAllFromDb', () => {
    beforeEach(() => {
      queryMock.mockReset();
    });

    it('Step1 重置孤儿 RUNNING → Step2 清所有虚高计数 key（新 2 步行为）', async () => {
      // 新断言对应新行为（slot-gate.ts recomputeAllFromDb）：
      //   - Step1：无条件 UPDATE 所有 status='RUNNING' → 'QUEUED'（单 worker 安全），
      //     reset = UPDATE 触到的行数（rowCount），不再按 user 维度重算。
      //   - Step2：SCAN concurrency:user:* key，对每个 user SELECT count(*) RUNNING；
      //     因 Step1 已把所有 RUNNING 重置为 QUEUED，SELECT 恒返回 0 → 全部 DEL。
      // 旧测试断言"按真值 SET 回 N"是旧实现（无 Step1）的语义，已陈旧。
      mockRedisState.counters.set('concurrency:user:u1', 5); // 崩溃残留虚高
      mockRedisState.counters.set('concurrency:user:u2', 3); // 残留
      queryMock.mockImplementation(async (sql: string) => {
        // Step1 的 UPDATE：模拟 DB 里有 1 个孤儿 RUNNING 任务被重置（rowCount=1）
        if (sql.trim().toUpperCase().startsWith('UPDATE')) {
          return { rows: [{ id: 'orphan-u1-task' }], rowCount: 1 };
        }
        // Step2 的 SELECT count(*) WHERE status='RUNNING'：Step1 之后 DB 已无 RUNNING → 0
        return { rows: [{ n: 0 }] };
      });

      const r = await recomputeAllFromDb();
      expect(r.checked).toBe(2);
      expect(r.reset).toBe(1); // Step1 UPDATE 触到 1 个孤儿 RUNNING
      expect(r.cleared).toBe(2); // Step2 SELECT 全 0 → 两个 key 都 DEL
      // 不再按真值 SET，两个虚高 key 都被 DEL
      expect(mockRedisState.counters.has('concurrency:user:u1')).toBe(false);
      expect(mockRedisState.counters.has('concurrency:user:u2')).toBe(false);
    });

    it('no counter keys → checked 0', async () => {
      // 提供 UPDATE 的空结果，避免 Step1 读取 undefined.rowCount 抛错污染 stderr
      queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
      const r = await recomputeAllFromDb();
      expect(r).toEqual({ checked: 0, reset: 0, cleared: 0 });
    });
  });
});
