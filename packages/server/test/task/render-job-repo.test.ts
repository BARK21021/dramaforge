// ============================================================
// ④ server/task/render-job-repo — 单测
// ============================================================
//
// 覆盖：
//   - create: INSERT with genId + 'PENDING'，返回映射后的 RenderJob
//   - claimNext: tx 内发 FOR UPDATE SKIP LOCKED 的 UPDATE，params=[machineId]
//                有行→映射 RenderJob；无行→null
//   - markRunning: UPDATE status='RUNNING'
//   - markResult: UPDATE status='COMPLETED' + result + completed_at
//   - markFailed: UPDATE status='FAILED' + error
//   - reapStale: UPDATE 重置 stale CLAIMED→PENDING，返回 rowCount
//   - getById: SELECT，有/无行
//   - mapRow: JSONB 解析（对象/字符串）+ 时间戳转 ISO
//
// mock @server/infra 的 query/tx 与 @shared/utils 的 genId：不依赖真实 PG。
// tx(fn) 直接以 mock QueryFn 调用 fn，验证事务内 SQL。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryFn, QueryResult } from '../../src/infra/pg';
import type { ConcatInput } from '@shared/render-job';

// mock @server/infra（query / tx），具体实现由每个测试注入
vi.mock('@server/infra', () => ({
  query: vi.fn(),
  tx: vi.fn(),
}));

// mock @shared/utils（genId），固定返回值便于断言
vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'gen-id-123'),
}));

import {
  renderJobRepo,
  create,
  createOrReuseChainGenerate,
  claimNext,
  markRunning,
  appendGroupClip,
  markResult,
  markFailed,
  reapStale,
  getById,
  listByUser,
  getByTaskId,
  cancel,
  retry,
  createRetryCopy,
  forceFail,
  sweepStuckShots,
  mapRow,
  maxClaimDurationSecondsForType,
  type RenderJobRow,
} from '../../src/task/render-job-repo';
import { query, tx } from '@server/infra';

// ============================================================
// 构造工具
// ============================================================

/** 一行 PENDING render_jobs 行（pg 风格：下划线列名，input/result 为对象） */
function pendingRow(overrides: Partial<RenderJobRow> = {}): RenderJobRow {
  return {
    id: 'job-1',
    task_id: 'task-1',
    user_id: 'user-1',
    type: 'CONCAT',
    input: { clips: [], outputUploadUrl: 'https://up' },
    status: 'PENDING',
    claimed_by: null,
    claim_token: null,
    created_at: new Date('2026-07-18T00:00:00Z'),
    claimed_at: null,
    heartbeat_at: null,
    completed_at: null,
    error: null,
    result: null,
    ...overrides,
  };
}

/** 构造 mock query 函数：记录所有调用，按 sql 关键字返回预设结果 */
function makeMockQuery(
  handler?: (sql: string, params?: unknown[]) => QueryResult,
): {
  qf: QueryFn;
  calls: { sql: string; params?: unknown[] }[];
} {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const qf: QueryFn = {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      calls.push({ sql, params });
      if (handler) return handler(sql, params);
      return { rows: [], rowCount: 0 };
    },
  };
  return { qf, calls };
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(tx).mockReset();
});

// ============================================================
// mapRow
// ============================================================

describe('mapRow', () => {
  it('maps snake_case columns to RenderJob camelCase fields', () => {
    const row = pendingRow();
    const job = mapRow(row);
    expect(job.id).toBe('job-1');
    expect(job.taskId).toBe('task-1');
    expect(job.userId).toBe('user-1');
    expect(job.type).toBe('CONCAT');
    expect(job.status).toBe('PENDING');
    expect(job.claimedBy).toBeNull();
    expect(job.claimToken).toBeNull();
    expect(job.error).toBeNull();
    expect(job.result).toBeNull();
    expect(job.claimedAt).toBeNull();
    expect(job.heartbeatAt).toBeNull();
    expect(job.completedAt).toBeNull();
  });

  it('parses JSONB input given as object', () => {
    const row = pendingRow({ input: { clips: [{ url: 'https://a' }], outputUploadUrl: 'https://up' } });
    expect(mapRow(row).input).toEqual({
      clips: [{ url: 'https://a' }],
      outputUploadUrl: 'https://up',
    });
  });

  it('parses JSONB input/result given as string', () => {
    const row = pendingRow({
      input: '{"clips":[],"outputUploadUrl":"https://up"}',
      result: '{"outputUrl":"https://out"}',
      status: 'COMPLETED',
    });
    const job = mapRow(row);
    expect(job.input).toEqual({ clips: [], outputUploadUrl: 'https://up' });
    expect(job.result).toEqual({ outputUrl: 'https://out' });
  });

  it('converts Date timestamps to ISO strings', () => {
    const row = pendingRow({
      status: 'CLAIMED',
      claimed_by: 'machine-7',
      claim_token: 'claim-7',
      created_at: new Date('2026-07-18T01:02:03Z'),
      claimed_at: new Date('2026-07-18T01:03:03Z'),
      heartbeat_at: new Date('2026-07-18T01:04:03Z'),
    });
    const job = mapRow(row);
    expect(job.createdAt).toBe('2026-07-18T01:02:03.000Z');
    expect(job.claimedAt).toBe('2026-07-18T01:03:03.000Z');
    expect(job.claimToken).toBe('claim-7');
    expect(job.heartbeatAt).toBe('2026-07-18T01:04:03.000Z');
  });

  it('passes through string timestamps as-is', () => {
    const row = pendingRow({ created_at: '2026-07-18T00:00:00Z' });
    expect(mapRow(row).createdAt).toBe('2026-07-18T00:00:00Z');
  });
});

// ============================================================
// create
// ============================================================

describe('create', () => {
  it('issues INSERT with genId + PENDING and returns mapped RenderJob', async () => {
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('INSERT INTO render_jobs')) {
        return { rows: [pendingRow({ id: 'gen-id-123', status: 'PENDING' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(query).mockImplementation(qf.query);

    const input = { clips: [{ url: 'https://a' }], outputUploadUrl: 'https://up' };
    const job = await create('task-1', 'user-1', 'CONCAT', input);

    expect(job.id).toBe('gen-id-123');
    expect(job.status).toBe('PENDING');
    expect(job.type).toBe('CONCAT');

    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO render_jobs'));
    expect(insert).toBeDefined();
    // params: [id=genId, taskId, userId, type, input(JSON.stringify)]
    expect(insert!.params).toEqual([
      'gen-id-123',
      'task-1',
      'user-1',
      'CONCAT',
      JSON.stringify(input),
    ]);
    // SQL asserts PENDING default + RETURNING *
    expect(insert!.sql).toContain("'PENDING'");
    expect(insert!.sql).toContain('RETURNING *');
  });

  it('renderJobRepo.create delegates to create', async () => {
    const { qf } = makeMockQuery(async () => ({
      rows: [pendingRow({ id: 'gen-id-123' })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    const job = await renderJobRepo.create('t', 'u', 'CONCAT', {
      clips: [],
      outputUploadUrl: 'https://up',
    });
    expect(job.id).toBe('gen-id-123');
  });
});

describe('createOrReuseChainGenerate', () => {
  const input = {
    groupResults: [{ url: '', shotIds: ['shot-1'] }],
    filmMeta: {
      projectId: 'proj-1',
      episodeId: 'ep-1',
      shotIds: ['shot-1'],
    },
  };

  it('holds a scope transaction lock while checking and inserting exactly one active job', async () => {
    const inserted = pendingRow({
      id: 'gen-id-123',
      task_id: 'new-task',
      type: 'CHAIN_COMPILE',
      input,
    });
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('INSERT INTO render_jobs')) {
        return { rows: [inserted], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const dispatched = await createOrReuseChainGenerate('new-task', 'user-1', input);

    expect(dispatched.reused).toBe(false);
    expect(dispatched.job.id).toBe('gen-id-123');
    expect(calls.map((call) => call.sql.trimStart().split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1,',
      'SELECT pg_advisory_xact_lock(hashtextextended($1,',
      'SELECT *',
      'INSERT INTO',
    ]);
    expect(calls[0].params?.[0]).toBe('episode-render-lifecycle:user-1:ep-1');
    expect(calls[1].params?.[0]).toContain('user-1:ep-1:["shot-1"]');
    expect(calls[2].sql).toContain("status IN ('PENDING', 'CLAIMED', 'RUNNING')");
    expect(calls[2].params).toEqual(['user-1', 'ep-1', JSON.stringify(['shot-1'])]);
  });

  it('returns the existing job and its original taskId without inserting again', async () => {
    const existing = pendingRow({
      id: 'active-job',
      task_id: 'active-task',
      type: 'CHAIN_COMPILE',
      input,
    });
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.includes("status IN ('PENDING', 'CLAIMED', 'RUNNING')")) {
        return { rows: [existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const dispatched = await createOrReuseChainGenerate('discarded-task', 'user-1', input);

    expect(dispatched).toMatchObject({ reused: true, job: { id: 'active-job', taskId: 'active-task' } });
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO render_jobs'))).toBe(false);
  });
});

// ============================================================
// claimNext
// ============================================================

describe('claimNext', () => {
  it('reaps this user stale leases then atomically claims with a fresh token', async () => {
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        return {
          rows: [pendingRow({
            status: 'CLAIMED',
            claimed_by: 'machine-1',
            claim_token: 'gen-id-123',
            claimed_at: new Date('2026-07-18T01:00:00Z'),
            heartbeat_at: new Date('2026-07-18T01:00:00Z'),
          })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const job = await claimNext('user-1', 'machine-1');

    // 返回映射后的 RenderJob
    expect(job).not.toBeNull();
    expect(job!.id).toBe('job-1');
    expect(job!.status).toBe('CLAIMED');
    expect(job!.claimedBy).toBe('machine-1');
    expect(job!.claimToken).toBe('gen-id-123');
    expect(job!.heartbeatAt).toBe('2026-07-18T01:00:00.000Z');

    // tx 被调用一次
    expect(vi.mocked(tx)).toHaveBeenCalledTimes(1);

    const reap = calls[0];
    expect(reap.sql).toContain("status IN ('CLAIMED', 'RUNNING')");
    expect(reap.sql).toContain('user_id=$1');
    expect(reap.sql).toContain('COALESCE(heartbeat_at, claimed_at)');
    expect(reap.sql).toContain('claim_token=NULL');
    expect(reap.sql).toContain('heartbeat_at=NULL');
    expect(reap.params).toEqual(['user-1', 120_000]);

    // SQL 断言：FOR UPDATE SKIP LOCKED + fresh claim token/heartbeat
    const upd = calls.find((c) => c.sql.includes('FOR UPDATE SKIP LOCKED'));
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(upd!.sql).toContain("status='CLAIMED'");
    expect(upd!.sql).toContain('claimed_by=$2');
    expect(upd!.sql).toContain('claim_token=$3');
    expect(upd!.sql).toContain('claimed_at=now()');
    expect(upd!.sql).toContain('heartbeat_at=now()');
    expect(upd!.sql).toContain('RETURNING *');
    // 子查询：PENDING + ORDER BY created_at
    expect(upd!.sql).toContain("status='PENDING'");
    expect(upd!.sql).toContain('user_id=$1');
    expect(upd!.sql).toContain('ORDER BY created_at');
    expect(upd!.params).toEqual(['user-1', 'machine-1', 'gen-id-123']);
  });

  it('returns null when no PENDING row available', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const job = await claimNext('user-1', 'machine-1');
    expect(job).toBeNull();
  });

  it('renderJobRepo.claimNext delegates to claimNext', async () => {
    const { qf } = makeMockQuery(async () => ({
      rows: [pendingRow({
        status: 'CLAIMED',
        claimed_by: 'm',
        claim_token: 'gen-id-123',
      })],
      rowCount: 1,
    }));
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const job = await renderJobRepo.claimNext('user-1', 'm');
    expect(job).not.toBeNull();
    expect(job!.claimedBy).toBe('m');
  });
});

// ============================================================
// markRunning
// ============================================================

describe('markRunning', () => {
  it('conditionally advances/heartbeats the matching active lease', async () => {
    const running = pendingRow({
      status: 'RUNNING', claimed_by: 'machine-1', claim_token: 'token-1',
      heartbeat_at: new Date('2026-07-18T01:00:00Z'),
    });
    const { qf, calls } = makeMockQuery(async () => ({ rows: [running], rowCount: 1 }));
    vi.mocked(query).mockImplementation(qf.query);

    const job = await markRunning('job-1', 'user-1', 'machine-1', 'token-1');

    const upd = calls.find((c) => c.sql.startsWith('UPDATE render_jobs'));
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain("status='RUNNING'");
    expect(upd!.sql).toContain("status IN ('CLAIMED', 'RUNNING')");
    expect(upd!.sql).toContain('heartbeat_at=now()');
    expect(upd!.sql).toContain('user_id=$2');
    expect(upd!.sql).toContain('claimed_by=$3');
    expect(upd!.sql).toContain('claim_token=$4');
    expect(upd!.sql).toContain('RETURNING *');
    expect(upd!.params).toEqual(['job-1', 'user-1', 'machine-1', 'token-1']);
    expect(job?.status).toBe('RUNNING');
  });

  it('returns null when the lease CAS does not match', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);
    expect(await markRunning('job-1', 'user-1', 'machine-1', 'wrong')).toBeNull();
  });

  it('persists progress + stage when provided (SET 占位在前，WHERE 在后)', async () => {
    const running = pendingRow({
      status: 'RUNNING', claimed_by: 'machine-1', claim_token: 'token-1',
    });
    const { qf, calls } = makeMockQuery(async () => ({ rows: [running], rowCount: 1 }));
    vi.mocked(query).mockImplementation(qf.query);

    await markRunning('job-1', 'user-1', 'machine-1', 'token-1', 42, '生成第 5/12 组');

    const upd = calls.find((c) => c.sql.startsWith('UPDATE render_jobs'))!;
    expect(upd.sql).toContain('progress=$1');
    expect(upd.sql).toContain('stage=$2');
    expect(upd.sql).toContain("status='RUNNING'");
    // progress/stage 占用 $1/$2 后，WHERE 占位顺移
    expect(upd.sql).toContain('user_id=$4');
    expect(upd.sql).toContain('claim_token=$6');
    expect(upd.params).toEqual([42, '生成第 5/12 组', 'job-1', 'user-1', 'machine-1', 'token-1']);
  });

  it('clamps progress to 0-100 and skips empty stage', async () => {
    const running = pendingRow({
      status: 'RUNNING', claimed_by: 'machine-1', claim_token: 'token-1',
    });
    const { qf, calls } = makeMockQuery(async () => ({ rows: [running], rowCount: 1 }));
    vi.mocked(query).mockImplementation(qf.query);

    await markRunning('job-1', 'user-1', 'machine-1', 'token-1', 150, '');

    const upd = calls.find((c) => c.sql.startsWith('UPDATE render_jobs'))!;
    expect(upd.params?.[0]).toBe(100); // 150 → 100
    expect(upd.sql).toContain('progress=$1');
    expect(upd.sql).not.toMatch(/\bstage=/);
  });
});

// ============================================================
// markResult
// ============================================================

describe('markResult', () => {
  const result = { outputUrl: 'https://out', durationSec: 12.5 };

  it('CAS-applies RUNNING -> COMPLETED and returns applied', async () => {
    const completed = pendingRow({
      status: 'COMPLETED', claimed_by: 'machine-1', claim_token: 'token-1',
      result, completed_at: new Date('2026-07-18T01:01:00Z'),
    });
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult('job-1', 'user-1', 'machine-1', 'token-1', result);

    expect(transition.outcome).toBe('applied');
    const upd = calls[0];
    expect(upd.sql).toContain("status='COMPLETED'");
    expect(upd.sql).toContain("status='RUNNING'");
    expect(upd.sql).toContain('completed_at=now()');
    expect(upd.sql).toContain('claim_token=$4');
    expect(upd.params).toEqual(['job-1', 'user-1', 'machine-1', 'token-1', JSON.stringify(result)]);
  });

  it('atomically persists trusted CHAIN_COMPILE group videos onto their shots', async () => {
    const chainResult = {
      outputUrl: 'sf-asset://job-1.mp4',
      meta: {
        localKey: 'job-1.mp4',
        groupClips: [
          {
            shotIds: ['shot-1', 'shot-2'],
            videoUrl: 'sf-asset://job-1-group-1.mp4',
            localKey: 'job-1-group-1.mp4',
          },
          {
            shotIds: ['shot-3'],
            videoUrl: 'sf-asset://job-1-group-2.mp4',
            localKey: 'job-1-group-2.mp4',
          },
        ],
      },
    };
    const completed = pendingRow({
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [
          { url: '', shotIds: ['shot-1', 'shot-2'], params: { prompt: 'g1' } },
          { url: '', shotIds: ['shot-3'], params: { prompt: 'g2' } },
        ],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
      result: chainResult,
      completed_at: new Date('2026-07-18T01:01:00Z'),
    });
    const { qf, calls } = makeMockQuery(async (sql, params) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      if (sql.startsWith('SELECT id FROM shots')) {
        return { rows: ['shot-1', 'shot-2', 'shot-3'].map((id) => ({ id })), rowCount: 3 };
      }
      // 每个组的镜头必须全部命中，模拟数据库按组写入成功。
      if (sql.startsWith('UPDATE shots')) {
        return { rows: [], rowCount: (params?.[1] as string[]).length };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult(
      'job-1',
      'user-1',
      'machine-1',
      'token-1',
      chainResult,
    );

    expect(transition.outcome).toBe('applied');
    const materialUpdates = calls.filter((call) => call.sql.startsWith('UPDATE shots AS target'));
    expect(materialUpdates).toHaveLength(2);
    expect(materialUpdates[0].sql).toContain('"currentMaterialUrl"=$1');
    expect(materialUpdates[0].sql).toContain('"videoStatus"=\'COMPLETED\'');
    expect(materialUpdates[0].params).toEqual([
      'sf-asset://job-1-group-1.mp4',
      ['shot-1', 'shot-2'],
      'proj-1',
      'ep-1',
      'user-1',
      'job-1',
      expect.any(String), // materialUpdatedAt ISO 时间戳
    ]);
    expect(materialUpdates[1].params).toEqual([
      'sf-asset://job-1-group-2.mp4',
      ['shot-3'],
      'proj-1',
      'ep-1',
      'user-1',
      'job-1',
      expect.any(String),
    ]);
    // G3-3: 每组素材落库后，实际下发 prompt 回写该组首镜 metadata（saveGroupPrompt 对齐）
    const promptUpdates = calls.filter((call) => call.sql.includes('seedanceGroupPrompt'));
    expect(promptUpdates).toHaveLength(2);
    // 写回必须带用户版保护：source='user' 且有正文的首镜不被任务完成回写覆盖。
    expect(promptUpdates[0].sql).toContain("IS DISTINCT FROM 'user'");
    expect(promptUpdates[0].params).toEqual([
      'g1', expect.any(String), 'shot-1', 'proj-1', 'ep-1',
    ]);
    expect(promptUpdates[1].params).toEqual([
      'g2', expect.any(String), 'shot-3', 'proj-1', 'ep-1',
    ]);
  });

  it('keeps a newer completed generation when an older result arrives late', async () => {
    const chainResult = {
      outputUrl: 'sf-asset://old-job.mp4',
      meta: {
        localKey: 'old-job.mp4',
        groupClips: [{
          shotIds: ['shot-1'],
          videoUrl: 'sf-asset://old-job-group-1.mp4',
          localKey: 'old-job-group-1.mp4',
        }],
      },
    };
    const completed = pendingRow({
      id: 'old-job',
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [{ url: '', shotIds: ['shot-1'] }],
        filmMeta: {
          projectId: 'proj-1', episodeId: 'ep-1', shotIds: ['shot-1'], shotCount: 1,
        },
      },
      result: chainResult,
    });
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      if (sql.startsWith('SELECT id FROM shots')) {
        return { rows: [{ id: 'shot-1' }], rowCount: 1 };
      }
      // 0 行表示 WHERE NOT EXISTS 发现同镜头已有创建时间更晚的成功任务。
      if (sql.startsWith('UPDATE shots')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT id,')) {
        return {
          rows: [{
            id: 'shot-1', videoStatus: 'PENDING', currentMaterialUrl: null, durationSeconds: 5,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult(
      'old-job', 'user-1', 'machine-1', 'token-1', chainResult,
    );

    expect(transition.outcome).toBe('applied');
    const shotUpdate = calls.find((call) => call.sql.startsWith('UPDATE shots'))!;
    expect(shotUpdate.sql).toContain("newer.status='COMPLETED'");
    expect(shotUpdate.sql).toContain('newer.created_at > current.created_at');
    expect(shotUpdate.sql).toContain("(newer_group -> 'shotIds') ? target.id");
    // stale 跳过不是归属错误，不能回滚已经合法完成的旧 job 终态。
    expect(shotUpdate.params?.slice(-3, -1)).toEqual(['user-1', 'old-job']);
  });

  it('queues one episode CONCAT when the last scoped group makes every shot complete', async () => {
    const chainResult = {
      outputUrl: 'sf-asset://group-job.mp4',
      meta: {
        localKey: 'group-job.mp4',
        groupClips: [{
          shotIds: ['shot-3'],
          videoUrl: 'sf-asset://group-job-group-1.mp4',
          localKey: 'group-job-group-1.mp4',
        }],
      },
    };
    const completed = pendingRow({
      id: 'group-job',
      task_id: 'group-task',
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [{ url: '', shotIds: ['shot-3'] }],
        filmMeta: {
          projectId: 'proj-1', episodeId: 'ep-1', shotIds: ['shot-3'], shotCount: 1,
        },
      },
      result: chainResult,
    });
    const { qf, calls } = makeMockQuery(async (sql, params) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      if (sql.startsWith('SELECT id FROM shots')) {
        return { rows: [{ id: 'shot-3' }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE shots')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT id,')) {
        return {
          rows: [
            { id: 'shot-1', videoStatus: 'COMPLETED', currentMaterialUrl: 'sf-asset://group-a.mp4', durationSeconds: 3 },
            { id: 'shot-2', videoStatus: 'COMPLETED', currentMaterialUrl: 'sf-asset://group-a.mp4', durationSeconds: 4 },
            { id: 'shot-3', videoStatus: 'COMPLETED', currentMaterialUrl: 'sf-asset://group-b.mp4', durationSeconds: 5 },
          ],
          rowCount: 3,
        };
      }
      if (sql.startsWith('SELECT id FROM render_jobs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM episodes AS e')) {
        return {
          rows: [{ episodeNumber: 1, episodeTitle: '第一集', projectTitle: '测试剧' }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('INSERT INTO render_jobs')) {
        return {
          rows: [pendingRow({
            id: 'gen-id-123',
            task_id: 'gen-id-123',
            type: 'CONCAT',
            input: JSON.parse(params?.[3] as string),
          })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult(
      'group-job', 'user-1', 'machine-1', 'token-1', chainResult,
    );

    expect(transition.outcome).toBe('applied');
    if (transition.outcome !== 'applied') throw new Error('expected applied transition');
    expect(transition.followUpJob).toMatchObject({
      id: 'gen-id-123',
      taskId: 'gen-id-123',
      type: 'CONCAT',
      status: 'PENDING',
    });
    const concatInput = transition.followUpJob?.input as {
      clips: Array<{ url: string; durationSec: number }>;
      autoCompiled: boolean;
      sourceRenderJobId: string;
      filmMeta: { shotCount: number; totalDuration: number; shotIds?: string[] };
    };
    expect(concatInput.clips).toEqual([
      { url: 'sf-asset://group-a.mp4', durationSec: 7 },
      { url: 'sf-asset://group-b.mp4', durationSec: 5 },
    ]);
    expect(concatInput).toMatchObject({
      autoCompiled: true,
      sourceRenderJobId: 'group-job',
      filmMeta: { shotCount: 3, totalDuration: 12 },
    });
    expect(concatInput.filmMeta.shotIds).toBeUndefined();
    expect(calls.filter((call) => call.sql.startsWith('INSERT INTO render_jobs'))).toHaveLength(1);
  });

  it('waits for a concurrent newer group task instead of freezing a stale episode snapshot', async () => {
    const chainResult = {
      outputUrl: 'sf-asset://first-group.mp4',
      meta: {
        localKey: 'first-group.mp4',
        groupClips: [{
          shotIds: ['shot-1'],
          videoUrl: 'sf-asset://first-job-group-1.mp4',
          localKey: 'first-job-group-1.mp4',
        }],
      },
    };
    const completed = pendingRow({
      id: 'first-job',
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [{ url: '', shotIds: ['shot-1'] }],
        filmMeta: {
          projectId: 'proj-1', episodeId: 'ep-1', shotIds: ['shot-1'], shotCount: 1,
        },
      },
      result: chainResult,
    });
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      if (sql.startsWith('SELECT id FROM shots')) {
        return { rows: [{ id: 'shot-1' }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE shots')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT id,')) {
        return {
          rows: [{
            id: 'shot-1', videoStatus: 'COMPLETED', currentMaterialUrl: 'sf-asset://first-group.mp4', durationSeconds: 5,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("type='CHAIN_COMPILE'") && sql.includes("status IN ('PENDING', 'CLAIMED', 'RUNNING')")) {
        return { rows: [{ id: 'newer-running-job' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult(
      'first-job', 'user-1', 'machine-1', 'token-1', chainResult,
    );

    expect(transition.outcome).toBe('applied');
    if (transition.outcome !== 'applied') throw new Error('expected applied transition');
    expect(transition.followUpJob).toBeUndefined();
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO render_jobs'))).toBe(false);
  });

  it('treats explicit all-shot scope as a group task and still creates the episode CONCAT', async () => {
    const chainResult = {
      outputUrl: 'sf-asset://scoped-whole.mp4',
      meta: {
        localKey: 'scoped-whole.mp4',
        groupClips: [{
          shotIds: ['only-shot'],
          videoUrl: 'sf-asset://scoped-whole-job-group-1.mp4',
          localKey: 'scoped-whole-job-group-1.mp4',
        }],
      },
    };
    const completed = pendingRow({
      id: 'scoped-whole-job',
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [{ url: '', shotIds: ['only-shot'] }],
        filmMeta: {
          projectId: 'proj-1',
          episodeId: 'ep-1',
          shotIds: ['only-shot'],
          shotCount: 1,
        },
      },
      result: chainResult,
    });
    const { qf } = makeMockQuery(async (sql, params) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      if (sql.startsWith('SELECT id FROM shots')) {
        return { rows: [{ id: 'only-shot' }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE shots')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT id,')) {
        return {
          rows: [{
            id: 'only-shot',
            videoStatus: 'COMPLETED',
            currentMaterialUrl: 'sf-asset://only-group.mp4',
            durationSeconds: 6,
          }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('SELECT id FROM render_jobs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM episodes AS e')) {
        return {
          rows: [{ episodeNumber: 1, episodeTitle: '第一集', projectTitle: '测试剧' }],
          rowCount: 1,
        };
      }
      if (sql.startsWith('INSERT INTO render_jobs')) {
        return {
          rows: [pendingRow({
            id: 'gen-id-123',
            task_id: 'gen-id-123',
            type: 'CONCAT',
            input: JSON.parse(params?.[3] as string),
          })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult(
      'scoped-whole-job', 'user-1', 'machine-1', 'token-1', chainResult,
    );

    expect(transition.outcome).toBe('applied');
    if (transition.outcome !== 'applied') throw new Error('expected applied transition');
    expect(transition.followUpJob?.type).toBe('CONCAT');
    expect((transition.followUpJob?.input as ConcatInput).filmMeta?.shotIds).toBeUndefined();
  });

  it('does not dispatch a redundant CONCAT after a whole-episode CHAIN_COMPILE', async () => {
    const chainResult = {
      outputUrl: 'sf-asset://whole-episode.mp4',
      meta: {
        localKey: 'whole-episode.mp4',
        groupClips: [{
          shotIds: ['shot-1', 'shot-2'],
          videoUrl: 'sf-asset://whole-episode-group-1.mp4',
          localKey: 'whole-episode-group-1.mp4',
        }],
      },
    };
    const completed = pendingRow({
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [{ url: '', shotIds: ['shot-1', 'shot-2'] }],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1', shotCount: 2 },
      },
      result: chainResult,
    });
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      if (sql.startsWith('SELECT id FROM shots')) {
        return { rows: [{ id: 'shot-1' }, { id: 'shot-2' }], rowCount: 2 };
      }
      if (sql.startsWith('UPDATE shots')) return { rows: [], rowCount: 2 };
      if (sql.startsWith('SELECT id,')) {
        return {
          rows: [
            { id: 'shot-1', videoStatus: 'COMPLETED', currentMaterialUrl: 'sf-asset://whole-group.mp4', durationSeconds: 4 },
            { id: 'shot-2', videoStatus: 'COMPLETED', currentMaterialUrl: 'sf-asset://whole-group.mp4', durationSeconds: 5 },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult(
      'job-1', 'user-1', 'machine-1', 'token-1', chainResult,
    );

    expect(transition.outcome).toBe('applied');
    if (transition.outcome !== 'applied') throw new Error('expected applied transition');
    expect(transition.followUpJob).toBeUndefined();
    expect(calls.some((call) => call.sql.startsWith('INSERT INTO render_jobs'))).toBe(false);
  });

  it('uses an old 1.1.6 result outputUrl only when the task contains exactly one group', async () => {
    const legacyResult = {
      outputUrl: 'sf-asset://job-legacy.mp4',
      meta: { localKey: 'job-legacy.mp4' },
    };
    const completed = pendingRow({
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [{ url: '', shotIds: ['shot-1', 'shot-2'], params: { prompt: 'g1' } }],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
      result: legacyResult,
    });
    const { qf, calls } = makeMockQuery(async (sql, params) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      if (sql.startsWith('SELECT id FROM shots')) {
        return { rows: [{ id: 'shot-1' }, { id: 'shot-2' }], rowCount: 2 };
      }
      // 旧客户端单组的整集输出与组片是同一段视频，可安全复用。
      if (sql.startsWith('UPDATE shots')) {
        return { rows: [], rowCount: (params?.[1] as string[]).length };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult(
      'job-1',
      'user-1',
      'machine-1',
      'token-1',
      legacyResult,
    );

    expect(transition.outcome).toBe('applied');
    const materialUpdates = calls.filter((call) => call.sql.startsWith('UPDATE shots AS target'));
    expect(materialUpdates).toHaveLength(1);
    expect(materialUpdates[0].params).toEqual([
      'sf-asset://job-legacy.mp4',
      ['shot-1', 'shot-2'],
      'proj-1',
      'ep-1',
      'user-1',
      'job-1',
      expect.any(String), // materialUpdatedAt ISO 时间戳
    ]);
    // G3-3: legacy 单组任务也回写 prompt（有 params.prompt 时）
    const promptUpdates = calls.filter((call) => call.sql.includes('seedanceGroupPrompt'));
    expect(promptUpdates).toHaveLength(1);
    expect(promptUpdates[0].params).toEqual([
      'g1', expect.any(String), 'shot-1', 'proj-1', 'ep-1',
    ]);
  });

  it('never assigns an old 1.1.6 whole-film outputUrl to a multi-group task', async () => {
    const legacyResult = {
      outputUrl: 'sf-asset://job-legacy.mp4',
      meta: { localKey: 'job-legacy.mp4' },
    };
    const completed = pendingRow({
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [
          { url: '', shotIds: ['shot-1'], params: { prompt: 'g1' } },
          { url: '', shotIds: ['shot-2'], params: { prompt: 'g2' } },
        ],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
      result: legacyResult,
    });
    const { qf, calls } = makeMockQuery(async (sql) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [completed], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult(
      'job-1',
      'user-1',
      'machine-1',
      'token-1',
      legacyResult,
    );

    expect(transition.outcome).toBe('applied');
    // 整集 URL 不代表任一独立组；旧客户端多组任务只完成 job，不伪造镜头素材。
    expect(calls.some((call) => call.sql.startsWith('UPDATE shots'))).toBe(false);
  });

  it('classifies same-token same-result retry as already_applied', async () => {
    const completed = {
      ...pendingRow({
        status: 'COMPLETED', claimed_by: 'machine-1', claim_token: 'token-1', result,
      }),
      payload_matches: true,
    };
    const { qf } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [], rowCount: 0 }
        : { rows: [completed], rowCount: 1 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult('job-1', 'user-1', 'machine-1', 'token-1', result);
    expect(transition.outcome).toBe('already_applied');
  });

  it('rejects a terminal conflict or mismatched lease', async () => {
    const completed = {
      ...pendingRow({
        status: 'COMPLETED', claimed_by: 'machine-1', claim_token: 'other-token',
        result: { outputUrl: 'https://other' },
      }),
      payload_matches: false,
    };
    const { qf } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [], rowCount: 0 }
        : { rows: [completed], rowCount: 1 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult('job-1', 'user-1', 'machine-1', 'token-1', result);
    expect(transition.outcome).toBe('rejected');
  });

  it('on gate failure persists successful groups COMPLETED and marks only missing shots FAILED', async () => {
    // strict 模式跳过被 AI 拒的组（group 2 [shot-3,shot-4] 缺失），客户端只上报成功组
    // → resultGroups(2) !== expectedGroups(3) → 门禁抛错 → failed_validation。
    // 修复：成功组回写 COMPLETED，只把缺失组标 FAILED；render_job FAILED+result=NULL（不造假成片库）。
    const partialResult = {
      outputUrl: 'sf-asset://job-1.mp4',
      meta: {
        localKey: 'job-1.mp4',
        groupClips: [
          { shotIds: ['shot-1', 'shot-2'], videoUrl: 'sf-asset://job-1-group-1.mp4', localKey: 'job-1-group-1.mp4' },
          { shotIds: ['shot-5'], videoUrl: 'sf-asset://job-1-group-3.mp4', localKey: 'job-1-group-3.mp4' },
        ],
      },
    };
    const completed = pendingRow({
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [
          { url: '', shotIds: ['shot-1', 'shot-2'] },
          { url: '', shotIds: ['shot-3', 'shot-4'] },
          { url: '', shotIds: ['shot-5'] },
        ],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
      result: partialResult,
    });
    const failed = pendingRow({
      ...completed,
      status: 'FAILED',
      error: '[CHAIN_COMPILE 组片校验失败] CHAIN_COMPILE 组片结果缺少完整的镜头映射',
      result: null,
    });
    const { qf, calls } = makeMockQuery(async (sql, params) => {
      if (sql.startsWith('UPDATE render_jobs') && sql.includes("status='COMPLETED'")) {
        return { rows: [completed], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE shots AS target')) {
        return { rows: [], rowCount: (params?.[1] as string[]).length };
      }
      if (sql.startsWith('UPDATE render_jobs') && sql.includes("status='FAILED'")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE shots') && sql.includes("'FAILED'")) {
        return { rows: [], rowCount: (params?.[0] as string[]).length };
      }
      if (sql.startsWith('SELECT * FROM render_jobs')) {
        return { rows: [failed], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult('job-1', 'user-1', 'machine-1', 'token-1', partialResult);

    expect(transition.outcome).toBe('partial_completed');
    // 成功组回写 COMPLETED（2 组：g1 + g3）
    const completedUpdates = calls.filter((c) => c.sql.startsWith('UPDATE shots AS target'));
    expect(completedUpdates).toHaveLength(2);
    expect(completedUpdates[0].params).toEqual([
      'sf-asset://job-1-group-1.mp4', ['shot-1', 'shot-2'], 'proj-1', 'ep-1', 'user-1', 'job-1',
      expect.any(String),
    ]);
    expect(completedUpdates[1].params).toEqual([
      'sf-asset://job-1-group-3.mp4', ['shot-5'], 'proj-1', 'ep-1', 'user-1', 'job-1',
      expect.any(String),
    ]);
    // 只把缺失组（shot-3,shot-4）标 FAILED；成功组不动
    const failedShotUpdate = calls.find(
      (c) => c.sql.startsWith('UPDATE shots') && c.sql.includes("'FAILED'"),
    );
    expect(failedShotUpdate).toBeDefined();
    expect(failedShotUpdate!.params).toEqual([['shot-3', 'shot-4']]);
    // 部分完成（≥1 组成功）→ job 判 COMPLETED（非 FAILED），不走 failed_validation 分支。
    const jobFailUpdate = calls.find(
      (c) => c.sql.startsWith('UPDATE render_jobs') && c.sql.includes("status='FAILED'"),
    );
    expect(jobFailUpdate).toBeUndefined();
  });

  it('on gate failure rejects tampered groupClips (non-whitelist shotIds / bad URL) and only persists valid groups', async () => {
    // 篡改客户端上报：一组 shotIds 不在服务端声明里（evil-shot）、一组 localKey 非 sf-asset://。
    // 都应被丢弃（不绑），其镜头归 FAILED；只有合法组回写 COMPLETED。安全不变量：无法注入任意镜头。
    const tamperedResult = {
      outputUrl: 'sf-asset://job-1.mp4',
      meta: {
        localKey: 'job-1.mp4',
        groupClips: [
          { shotIds: ['shot-1'], videoUrl: 'sf-asset://job-1-group-1.mp4', localKey: 'job-1-group-1.mp4' },
          // 篡改：shotIds 不在声明里 → 丢弃
          { shotIds: ['evil-shot'], videoUrl: 'sf-asset://evil.mp4', localKey: 'evil.mp4' },
          // 篡改：videoUrl 非 sf-asset:// → 丢弃
          { shotIds: ['shot-2'], videoUrl: 'https://evil.com/x.mp4', localKey: 'x.mp4' },
        ],
      },
    };
    const completed = pendingRow({
      type: 'CHAIN_COMPILE',
      status: 'COMPLETED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      input: {
        groupResults: [
          { url: '', shotIds: ['shot-1'] },
          { url: '', shotIds: ['shot-2'] },
        ],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
      result: tamperedResult,
    });
    const failed = pendingRow({ ...completed, status: 'FAILED', result: null });
    const { qf, calls } = makeMockQuery(async (sql, params) => {
      if (sql.startsWith('UPDATE render_jobs') && sql.includes("status='COMPLETED'")) {
        return { rows: [completed], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE shots AS target')) {
        return { rows: [], rowCount: (params?.[1] as string[]).length };
      }
      if (sql.startsWith('UPDATE render_jobs') && sql.includes("status='FAILED'")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE shots') && sql.includes("'FAILED'")) {
        return { rows: [], rowCount: (params?.[0] as string[]).length };
      }
      if (sql.startsWith('SELECT * FROM render_jobs')) {
        return { rows: [failed], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markResult('job-1', 'user-1', 'machine-1', 'token-1', tamperedResult);

    expect(transition.outcome).toBe('partial_completed');
    // 只有合法组 [shot-1] 回写 COMPLETED；evil-shot 与 bad-URL 组被拒
    const completedUpdates = calls.filter((c) => c.sql.startsWith('UPDATE shots AS target'));
    expect(completedUpdates).toHaveLength(1);
    expect(completedUpdates[0].params).toEqual([
      'sf-asset://job-1-group-1.mp4', ['shot-1'], 'proj-1', 'ep-1', 'user-1', 'job-1',
      expect.any(String),
    ]);
    // 缺失 = shot-2（bad-URL 被拒，未回写）；evil-shot 不在声明里，不进 missing 也不被绑
    const failedShotUpdate = calls.find(
      (c) => c.sql.startsWith('UPDATE shots') && c.sql.includes("'FAILED'"),
    );
    expect(failedShotUpdate).toBeDefined();
    expect(failedShotUpdate!.params).toEqual([['shot-2']]);
  });
});

// ============================================================
// markFailed
// ============================================================

describe('markFailed', () => {
  it('CAS-applies RUNNING -> FAILED, writes completed_at and returns applied', async () => {
    const failed = pendingRow({
      status: 'FAILED', claimed_by: 'machine-1', claim_token: 'token-1',
      error: 'ffmpeg exited with code 1', completed_at: new Date('2026-07-18T01:01:00Z'),
    });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [failed], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markFailed(
      'job-1', 'user-1', 'machine-1', 'token-1', 'ffmpeg exited with code 1',
    );

    expect(transition.outcome).toBe('applied');
    expect(calls[0].sql).toContain("status='FAILED'");
    expect(calls[0].sql).toContain("status='RUNNING'");
    expect(calls[0].sql).toContain('completed_at=now()');
    expect(calls[0].params).toEqual([
      'job-1', 'user-1', 'machine-1', 'token-1', 'ffmpeg exited with code 1',
    ]);
  });

  it('classifies same-token same-error retry as already_applied', async () => {
    const failed = pendingRow({
      status: 'FAILED', claimed_by: 'machine-1', claim_token: 'token-1', error: 'boom',
    });
    const { qf } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [], rowCount: 0 }
        : { rows: [failed], rowCount: 1 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markFailed('job-1', 'user-1', 'machine-1', 'token-1', 'boom');
    expect(transition.outcome).toBe('already_applied');
  });

  it('rejects conflicting terminal data', async () => {
    const failed = pendingRow({
      status: 'FAILED', claimed_by: 'machine-1', claim_token: 'token-1', error: 'other',
    });
    const { qf } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [], rowCount: 0 }
        : { rows: [failed], rowCount: 1 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markFailed('job-1', 'user-1', 'machine-1', 'token-1', 'boom');
    expect(transition.outcome).toBe('rejected');
  });

  it('marks all CHAIN_COMPILE shots as FAILED when the chain job fails', async () => {
    const failed = pendingRow({
      id: 'chain-job-1',
      type: 'CHAIN_COMPILE',
      status: 'FAILED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      error: 'group 2 generation failed',
      completed_at: new Date('2026-07-18T01:01:00Z'),
      input: {
        groupResults: [
          { url: '', shotIds: ['shot-1', 'shot-2'] },
          { url: '', shotIds: ['shot-3'] },
        ],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
    });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [failed], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markFailed(
      'chain-job-1', 'user-1', 'machine-1', 'token-1', 'group 2 generation failed',
    );

    expect(transition.outcome).toBe('applied');
    const shotFailUpdate = calls.find((call) => call.sql.startsWith('UPDATE shots'));
    expect(shotFailUpdate).toBeDefined();
    expect(shotFailUpdate!.sql).toContain('"videoStatus"=\'FAILED\'');
    expect(shotFailUpdate!.sql).toContain('id = ANY($1::text[])');
    expect(shotFailUpdate!.sql).toContain("IS DISTINCT FROM 'COMPLETED'");
    expect(shotFailUpdate!.params).toEqual([['shot-1', 'shot-2', 'shot-3']]);
  });

  it('preserves already-succeeded groups from progress_clips on CHAIN_COMPILE failure (Ep24/25 403 修复)', async () => {
    // 渐进回传的组视频已落 progress_clips（鉴权过的 /progress 写入）。chain 在 88%
    // 下载步骤失败时，markFailed 应把 progress_clips 里的成功组标 COMPLETED，只把
    // 缺失组标 FAILED；job 终态仍 FAILED。重跑时这些 COMPLETED 组被自动复用（省钱）。
    const failed = pendingRow({
      id: 'chain-job-1',
      type: 'CHAIN_COMPILE',
      status: 'FAILED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      error: 'downloadClips: HTTP 403',
      completed_at: new Date('2026-08-03T01:01:00Z'),
      input: {
        groupResults: [
          { url: '', shotIds: ['shot-1', 'shot-2'] },
          { url: '', shotIds: ['shot-3', 'shot-4'] },
          { url: '', shotIds: ['shot-5'] },
        ],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
      progress_clips: [
        { shotIds: ['shot-1', 'shot-2'], videoUrl: 'sf-asset://chain-job-1-group-1.mp4' },
        { shotIds: ['shot-5'], videoUrl: 'sf-asset://chain-job-1-group-3.mp4' },
      ],
    });
    const { qf, calls } = makeMockQuery(async (sql, params) => {
      if (sql.startsWith('UPDATE render_jobs')) return { rows: [failed], rowCount: 1 };
      if (sql.startsWith('UPDATE shots AS target')) {
        return { rows: [], rowCount: (params?.[1] as string[]).length };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markFailed(
      'chain-job-1', 'user-1', 'machine-1', 'token-1', 'downloadClips: HTTP 403',
    );

    expect(transition.outcome).toBe('applied');
    // 成功组(g1: shot-1,2 / g3: shot-5)回写 COMPLETED
    const completedUpdates = calls.filter((c) => c.sql.startsWith('UPDATE shots AS target'));
    expect(completedUpdates).toHaveLength(2);
    expect(completedUpdates[0].params).toEqual([
      'sf-asset://chain-job-1-group-1.mp4', ['shot-1', 'shot-2'],
      'proj-1', 'ep-1', 'user-1', 'chain-job-1', expect.any(String),
    ]);
    expect(completedUpdates[1].params).toEqual([
      'sf-asset://chain-job-1-group-3.mp4', ['shot-5'],
      'proj-1', 'ep-1', 'user-1', 'chain-job-1', expect.any(String),
    ]);
    // 缺失组(shot-3,4)标 FAILED；成功组不在 FAILED 列表里
    const failedShotUpdate = calls.find(
      (c) => c.sql.startsWith('UPDATE shots') && c.sql.includes("'FAILED'"),
    );
    expect(failedShotUpdate).toBeDefined();
    expect(failedShotUpdate!.params).toEqual([['shot-3', 'shot-4']]);
  });

  it('does not touch shots when a non-CHAIN_COMPILE job fails', async () => {
    const failed = pendingRow({
      status: 'FAILED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      error: 'ffmpeg failed',
    });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [failed], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const transition = await markFailed(
      'job-1', 'user-1', 'machine-1', 'token-1', 'ffmpeg failed',
    );

    expect(transition.outcome).toBe('applied');
    expect(calls.some((call) => call.sql.startsWith('UPDATE shots'))).toBe(false);
  });

  it('skips CHAIN_COMPILE shots FAILED write when groupResults lack shotIds', async () => {
    const failed = pendingRow({
      type: 'CHAIN_COMPILE',
      status: 'FAILED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      error: 'boom',
      input: { groupResults: [{ url: '' }] },
    });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [failed], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    await markFailed('job-1', 'user-1', 'machine-1', 'token-1', 'boom');

    // 无 shotIds 的旧版 groupResults 不具备安全标 FAILED 所需的镜头白名单。
    expect(calls.some((call) => call.sql.startsWith('UPDATE shots'))).toBe(false);
  });
});

// ============================================================
// reapStale
// ============================================================

describe('reapStale', () => {
  it('resets stale CLAIMED/RUNNING leases to PENDING and returns count', async () => {
    const { qf, calls } = makeMockQuery(async () => ({ rows: [], rowCount: 3 }));
    vi.mocked(query).mockImplementation(qf.query);

    const count = await reapStale(30_000);

    expect(count).toBe(3);
    const upd = calls.find((c) => c.sql.startsWith('UPDATE render_jobs'));
    expect(upd).toBeDefined();
    // 重置回 PENDING
    expect(upd!.sql).toContain("status='PENDING'");
    expect(upd!.sql).toContain('claimed_by=NULL');
    expect(upd!.sql).toContain('claim_token=NULL');
    expect(upd!.sql).toContain('claimed_at=NULL');
    expect(upd!.sql).toContain('heartbeat_at=NULL');
    // 条件：CLAIMED/RUNNING + latest heartbeat 超时
    expect(upd!.sql).toContain("status IN ('CLAIMED', 'RUNNING')");
    expect(upd!.sql).toContain('COALESCE(heartbeat_at, claimed_at)');
    // 参数：超时毫秒数
    expect(upd!.params).toEqual([30_000]);
  });

  it('returns 0 when no stale rows', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);
    expect(await reapStale(5_000)).toBe(0);
  });

  it('resets CHAIN_COMPILE shots to PENDING when reaping stale chain leases', async () => {
    const staleJob = pendingRow({
      id: 'chain-stale',
      type: 'CHAIN_COMPILE',
      status: 'RUNNING',
      input: { groupResults: [{ url: '', shotIds: ['shot-a', 'shot-b'] }] },
    });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('SELECT') ? { rows: [staleJob], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    vi.mocked(query).mockImplementation(qf.query);

    const count = await reapStale(30_000);

    expect(count).toBe(1);
    const shotUpd = calls.find((c) => c.sql.startsWith('UPDATE shots'));
    expect(shotUpd).toBeDefined();
    expect(shotUpd!.sql).toContain('"videoStatus"=\'PENDING\'');
    expect(shotUpd!.sql).toContain("IS DISTINCT FROM 'COMPLETED'");
    expect(shotUpd!.params).toEqual([['shot-a', 'shot-b']]);
  });

  it('does not touch shots when reaping non-CHAIN_COMPILE stale jobs', async () => {
    const staleJob = pendingRow({ id: 'concat-stale', type: 'CONCAT', status: 'RUNNING' });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('SELECT') ? { rows: [staleJob], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    vi.mocked(query).mockImplementation(qf.query);

    await reapStale(30_000);

    expect(calls.some((c) => c.sql.startsWith('UPDATE shots'))).toBe(false);
  });
});

// ============================================================
// getById
// ============================================================

describe('getById', () => {
  it('returns mapped RenderJob when row exists', async () => {
    const { qf } = makeMockQuery(async (sql) => {
      if (sql.startsWith('SELECT * FROM render_jobs')) {
        return { rows: [pendingRow({ id: 'job-9' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(query).mockImplementation(qf.query);

    const job = await getById('job-9');
    expect(job).not.toBeNull();
    expect(job!.id).toBe('job-9');
  });

  it('returns null when row missing', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);
    expect(await getById('ghost')).toBeNull();
  });
});

describe('getByTaskId', () => {
  it('scopes the lookup by taskId and userId', async () => {
    const { qf, calls } = makeMockQuery(async () => ({
      rows: [pendingRow({ id: 'job-latest', task_id: 'task-9' })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    const job = await getByTaskId('task-9', 'user-1');

    expect(job?.id).toBe('job-latest');
    expect(calls[0].sql).toContain('task_id=$1 AND user_id=$2');
    expect(calls[0].sql).toContain('ORDER BY created_at DESC');
    expect(calls[0].params).toEqual(['task-9', 'user-1']);
  });
});

describe('listByUser', () => {
  it('builds owner-scoped filters for status, type, and both projectId input shapes', async () => {
    const { qf, calls } = makeMockQuery(async () => ({
      rows: [pendingRow({ status: 'RUNNING', type: 'CHAIN_COMPILE' })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    const jobs = await listByUser('user-1', {
      status: 'RUNNING',
      type: 'CHAIN_COMPILE',
      projectId: 'project-1',
      limit: 50,
    });

    expect(jobs).toHaveLength(1);
    expect(calls[0].sql).toContain('user_id=$1');
    expect(calls[0].sql).toContain("input #>> '{filmMeta,projectId}'=$4");
    expect(calls[0].sql).toContain("input->>'projectId'=$4");
    expect(calls[0].params).toEqual([
      'user-1',
      'RUNNING',
      'CHAIN_COMPILE',
      'project-1',
      50,
    ]);
  });
});

describe('cancel', () => {
  it('CAS-transitions only active owner jobs to CANCELLED', async () => {
    const { qf, calls } = makeMockQuery(async () => ({
      rows: [pendingRow({ status: 'CANCELLED', error: '用户已取消' })],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    const job = await cancel('job-1', 'user-1');

    expect(job?.status).toBe('CANCELLED');
    expect(calls[0].sql).toContain("status IN ('PENDING', 'CLAIMED', 'RUNNING')");
    expect(calls[0].sql).toContain('user_id=$2');
    expect(calls[0].params).toEqual(['job-1', 'user-1']);
  });

  it('resets CHAIN_COMPILE shots to PENDING when cancelling a chain job', async () => {
    const cancelled = pendingRow({
      id: 'chain-cancel',
      type: 'CHAIN_COMPILE',
      status: 'CANCELLED',
      error: '用户已取消',
      input: { groupResults: [{ url: '', shotIds: ['shot-1', 'shot-2'] }] },
    });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs') ? { rows: [cancelled], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    vi.mocked(query).mockImplementation(qf.query);

    const job = await cancel('chain-cancel', 'user-1');

    expect(job?.status).toBe('CANCELLED');
    const shotUpd = calls.find((c) => c.sql.startsWith('UPDATE shots'));
    expect(shotUpd).toBeDefined();
    expect(shotUpd!.sql).toContain('"videoStatus"=\'PENDING\'');
    expect(shotUpd!.sql).toContain("IS DISTINCT FROM 'COMPLETED'");
    expect(shotUpd!.params).toEqual([['shot-1', 'shot-2']]);
  });
});

describe('retry', () => {
  it('requeues FAILED/CANCELLED and clears the previous lease and result', async () => {
    const { qf, calls } = makeMockQuery(async () => ({
      rows: [pendingRow()],
      rowCount: 1,
    }));
    vi.mocked(query).mockImplementation(qf.query);

    const job = await retry('job-1', 'user-1');

    expect(job?.status).toBe('PENDING');
    expect(calls[0].sql).toContain("status IN ('FAILED', 'CANCELLED')");
    expect(calls[0].sql).toContain('claim_token=NULL');
    expect(calls[0].sql).toContain('result=NULL');
    expect(calls[0].params).toEqual(['job-1', 'user-1']);
  });
});

// ============================================================
// forceFail（admin/运维强制失败，无 lease token，正确级联）
// ============================================================

describe('forceFail', () => {
  it('CAS-applies RUNNING -> FAILED WITHOUT lease token and cascades CHAIN_COMPILE shots', async () => {
    const failed = pendingRow({
      id: 'chain-job-1',
      type: 'CHAIN_COMPILE',
      status: 'FAILED',
      claimed_by: 'machine-1',
      claim_token: 'token-1',
      error: '运维强制失败',
      completed_at: new Date('2026-07-24T09:57:00Z'),
      input: {
        groupResults: [{ url: '', shotIds: ['shot-1', 'shot-2'] }],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
    });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [failed], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const r = await forceFail('chain-job-1', '运维强制失败');

    expect(r.outcome).toBe('applied');
    if (r.outcome !== 'applied') throw new Error('expected applied');
    expect(r.job.id).toBe('chain-job-1');
    expect(r.shotIds).toEqual(['shot-1', 'shot-2']);

    const upd = calls[0];
    expect(upd.sql).toContain("status='FAILED'");
    // 关键：从 PENDING/CLAIMED/RUNNING 任一非终态推进，无 user/machine/token 条件
    expect(upd.sql).toContain("status IN ('PENDING', 'CLAIMED', 'RUNNING')");
    expect(upd.sql).not.toContain('claim_token=$');
    // params 只有 [id, reason]（对比 markFailed 的 [id,user,machine,token,error]）
    expect(upd.params).toEqual(['chain-job-1', '运维强制失败']);

    // G3-1 镜头级联：shots → FAILED（已 COMPLETED 不动）
    const shotUpd = calls.find((c) => c.sql.startsWith('UPDATE shots'));
    expect(shotUpd).toBeDefined();
    expect(shotUpd!.sql).toContain('"videoStatus"=\'FAILED\'');
    expect(shotUpd!.sql).toContain('id = ANY($1::text[])');
    expect(shotUpd!.sql).toContain("IS DISTINCT FROM 'COMPLETED'");
    expect(shotUpd!.params).toEqual([['shot-1', 'shot-2']]);
  });

  it('accepts any non-terminal state (PENDING/CLAIMED/RUNNING) without a lease', async () => {
    // 假死 job 通常是 CLAIMED/RUNNING；PENDING 也应能直接失败。
    for (const st of ['PENDING', 'CLAIMED', 'RUNNING'] as const) {
      const failed = pendingRow({ id: 'job-1', status: 'FAILED', error: 'x' });
      const { qf, calls } = makeMockQuery(async (sql) =>
        sql.startsWith('UPDATE render_jobs')
          ? { rows: [failed], rowCount: 1 }
          : { rows: [], rowCount: 0 });
      vi.mocked(tx).mockImplementation(async (fn) => fn(qf));
      const r = await forceFail('job-1', 'x');
      expect(r.outcome).toBe('applied');
      expect(calls[0].sql).toContain(
        "status IN ('PENDING', 'CLAIMED', 'RUNNING')",
      );
      expect(calls[0].params).toEqual(['job-1', 'x']);
    }
  });

  it('returns already_terminal with the current job when CAS misses (already FAILED)', async () => {
    const failed = pendingRow({ id: 'job-1', status: 'FAILED', error: 'old' });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [], rowCount: 0 } // CAS miss（已是终态）
        : sql.startsWith('SELECT * FROM render_jobs')
          ? { rows: [failed], rowCount: 1 } // 回查当前行
          : { rows: [], rowCount: 0 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));

    const r = await forceFail('job-1', 'reason');
    expect(r.outcome).toBe('already_terminal');
    if (r.outcome !== 'already_terminal') throw new Error('expected already_terminal');
    expect(r.job?.status).toBe('FAILED');
    // 终态：不级联 shots
    expect(calls.some((c) => c.sql.startsWith('UPDATE shots'))).toBe(false);
  });

  it('returns already_terminal with null job when the id does not exist', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));
    const r = await forceFail('ghost', 'reason');
    expect(r.outcome).toBe('already_terminal');
    if (r.outcome !== 'already_terminal') throw new Error('expected already_terminal');
    expect(r.job).toBeNull();
  });

  it('does not cascade shots for a non-CHAIN_COMPILE job', async () => {
    const failed = pendingRow({ id: 'job-1', type: 'CONCAT', status: 'FAILED', error: 'x' });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [failed], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));
    const r = await forceFail('job-1', 'x');
    expect(r.outcome).toBe('applied');
    if (r.outcome !== 'applied') throw new Error('expected applied');
    expect(r.shotIds).toBeNull();
    expect(calls.some((c) => c.sql.startsWith('UPDATE shots'))).toBe(false);
  });

  it('renderJobRepo.forceFail delegates to forceFail', async () => {
    const failed = pendingRow({ id: 'job-1', status: 'FAILED' });
    const { qf } = makeMockQuery(async (sql) =>
      sql.startsWith('UPDATE render_jobs')
        ? { rows: [failed], rowCount: 1 }
        : { rows: [], rowCount: 0 });
    vi.mocked(tx).mockImplementation(async (fn) => fn(qf));
    const r = await renderJobRepo.forceFail('job-1', 'x');
    expect(r.outcome).toBe('applied');
  });
});

// ============================================================
// sweepStuckShots（终态级联兜底）
// ============================================================

describe('sweepStuckShots', () => {
  it('cascades GENERATING shots of terminal CHAIN_COMPILE jobs: FAILED→FAILED, CANCELLED→PENDING', async () => {
    const failedJob = pendingRow({
      id: 'jf',
      type: 'CHAIN_COMPILE',
      status: 'FAILED',
      completed_at: new Date('2026-07-24T09:57:00Z'),
      input: { groupResults: [{ url: '', shotIds: ['s1', 's2'] }] },
    });
    const cancelledJob = pendingRow({
      id: 'jc',
      type: 'CHAIN_COMPILE',
      status: 'CANCELLED',
      completed_at: new Date('2026-07-24T09:57:00Z'),
      input: { groupResults: [{ url: '', shotIds: ['s3'] }] },
    });
    const { qf, calls } = makeMockQuery(async (sql, params) => {
      if (sql.startsWith('SELECT * FROM render_jobs')) {
        return { rows: [failedJob, cancelledJob], rowCount: 2 };
      }
      if (sql.startsWith('UPDATE shots')) {
        return { rows: [], rowCount: (params?.[1] as string[]).length };
      }
      return { rows: [], rowCount: 0 };
    });
    vi.mocked(query).mockImplementation(qf.query);

    const n = await sweepStuckShots();

    expect(n).toBe(3); // 2 + 1
    // 只扫终态 CHAIN_COMPILE + 近 24h
    const sel = calls.find((c) => c.sql.startsWith('SELECT * FROM render_jobs'));
    expect(sel).toBeDefined();
    expect(sel!.sql).toContain("type='CHAIN_COMPILE'");
    expect(sel!.sql).toContain("status IN ('FAILED', 'CANCELLED')");
    expect(sel!.sql).toContain("completed_at > now() - interval '24 hours'");
    // 镜头级联：FAILED job→FAILED，CANCELLED job→PENDING；幂等只动 GENERATING
    const shotUpds = calls.filter((c) => c.sql.startsWith('UPDATE shots'));
    expect(shotUpds).toHaveLength(2);
    expect(shotUpds[0].sql).toContain('"videoStatus"=$1');
    expect(shotUpds[0].sql).toContain(`"videoStatus"='GENERATING'`);
    expect(shotUpds[0].params).toEqual(['FAILED', ['s1', 's2']]);
    expect(shotUpds[1].params).toEqual(['PENDING', ['s3']]);
  });

  it('skips non-CHAIN_COMPILE jobs and CHAIN_COMPILE jobs without shotIds', async () => {
    const concatJob = pendingRow({
      id: 'jx',
      type: 'CONCAT',
      status: 'FAILED',
      completed_at: new Date(),
    });
    const noShotsJob = pendingRow({
      id: 'jy',
      type: 'CHAIN_COMPILE',
      status: 'FAILED',
      completed_at: new Date(),
      input: { groupResults: [{ url: '' }] }, // 无 shotIds
    });
    const { qf, calls } = makeMockQuery(async (sql) =>
      sql.startsWith('SELECT')
        ? { rows: [concatJob, noShotsJob], rowCount: 2 }
        : { rows: [], rowCount: 0 });
    vi.mocked(query).mockImplementation(qf.query);

    const n = await sweepStuckShots();
    expect(n).toBe(0);
    expect(calls.some((c) => c.sql.startsWith('UPDATE shots'))).toBe(false);
  });

  it('returns 0 when no terminal CHAIN_COMPILE jobs exist', async () => {
    const { qf, calls } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);
    const n = await sweepStuckShots();
    expect(n).toBe(0);
    expect(calls.some((c) => c.sql.startsWith('UPDATE shots'))).toBe(false);
  });

  it('renderJobRepo.sweepStuckShots delegates to sweepStuckShots', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);
    const n = await renderJobRepo.sweepStuckShots();
    expect(n).toBe(0);
  });
});

describe('maxClaimDurationSecondsForType (F3: 防 LONG_VIDEO_REWRITE 被误回收)', () => {
  // 阈值必须 > 该类型编排最长耗时，否则仍在合法编排的 job 被 claimNext/reapStale 当
  // 卡死回收 → 原 client 下次 renewLease 收 409 → executionController.abort → 丢 in-flight LLM。
  it('LONG_VIDEO_REWRITE 阈值 = 12h（覆盖 1-6h 编排 + 余量）', () => {
    expect(maxClaimDurationSecondsForType('LONG_VIDEO_REWRITE')).toBe(12 * 60 * 60);
  });
  it('其他类型走默认 4h（CHAIN_COMPILE/CONCAT/SPLIT/未知）', () => {
    // strict 一键出片逐组串行 + 真实云端生成，典型 30-60min、大分集 ~1h+；
    // 阈值必须覆盖合法长链，只把「心跳始终新鲜但超 4h」判为卡死。
    expect(maxClaimDurationSecondsForType('CHAIN_COMPILE')).toBe(4 * 60 * 60);
    expect(maxClaimDurationSecondsForType('CONCAT')).toBe(4 * 60 * 60);
    expect(maxClaimDurationSecondsForType('UNKNOWN')).toBe(4 * 60 * 60);
  });
});

describe('countActiveClaims (per-user render 并发硬上限)', () => {
  it('SQL 按 user_id 统计 CLAIMED/RUNNING 行数', async () => {
    const { qf, calls } = makeMockQuery(async () => ({ rows: [{ n: 3 }], rowCount: 1 }));
    vi.mocked(query).mockImplementation(qf.query);

    const n = await renderJobRepo.countActiveClaims('user-1');

    expect(n).toBe(3);
    const q = calls.find((c) => c.sql.includes('count(*)'))!;
    expect(q.sql).toContain('user_id = $1');
    expect(q.sql).toContain("status IN ('CLAIMED','RUNNING')");
    expect(q.params).toEqual(['user-1']);
  });

  it('空结果返回 0', async () => {
    const { qf } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);

    const n = await renderJobRepo.countActiveClaims('user-1');
    expect(n).toBe(0);
  });
});

describe('appendGroupClip', () => {
  it('appends clip JSON to progress_clips scoped to owner + active job', async () => {
    const { qf, calls } = makeMockQuery(async () => ({ rows: [], rowCount: 0 }));
    vi.mocked(query).mockImplementation(qf.query);

    const clip = { shotIds: ['s1', 's2'], videoUrl: 'sf-asset://job-1-group-3.mp4' };
    await appendGroupClip('job-1', 'user-1', clip);

    const upd = calls.find((c) => c.sql.startsWith('UPDATE render_jobs'))!;
    expect(upd.sql).toContain('progress_clips = progress_clips || $3::jsonb');
    expect(upd.sql).toContain('id = $1');
    expect(upd.sql).toContain('user_id = $2');
    expect(upd.sql).toContain("status IN ('CLAIMED', 'RUNNING')");
    expect(upd.params).toEqual(['job-1', 'user-1', JSON.stringify([clip])]);
  });
});

describe('createRetryCopy (2026-08-03 历史版本：重试复制新 job 不覆盖旧版)', () => {
  it('copies a FAILED job into a brand-new job (new id/taskId), keeping the old record', async () => {
    vi.mocked(query).mockReset();
    const failed = pendingRow({
      id: 'job-old',
      task_id: 'task-old',
      status: 'FAILED',
      error: 'boom',
    });
    const fresh = pendingRow({ id: 'job-new', task_id: 'task-new', status: 'PENDING' });
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [failed], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fresh], rowCount: 1 });

    const job = await createRetryCopy('job-old', 'user-1');

    expect(job?.id).toBe('job-new'); // mapRow 取 INSERT RETURNING 行 id
    expect(job?.taskId).toBe('task-new');
    expect(job?.id).not.toBe('job-old'); // 与旧记录不同 = 不覆盖
    expect(job?.status).toBe('PENDING');
    expect(job?.input).toEqual(failed.input);
    const sqls = vi.mocked(query).mock.calls.map((call) => String(call[0]));
    expect(sqls[0]).toContain("status IN ('FAILED', 'CANCELLED')");
    expect(sqls[1]).toContain('INSERT INTO render_jobs');
    const insertParams = vi.mocked(query).mock.calls[1][1] as unknown[];
    expect(insertParams[0]).toBe('gen-id-123');
    expect(insertParams[1]).toBe('gen-id-123');
    expect(insertParams[3]).toBe('CONCAT');
  });

  it('returns null when the job is not FAILED/CANCELLED or not owned', async () => {
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const job = await createRetryCopy('job-x', 'user-1');

    expect(job).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('flips already-succeeded CHAIN_COMPILE groups to pass-through on retry (省钱)', async () => {
    vi.mocked(query).mockReset();
    const failed = pendingRow({
      id: 'job-old',
      task_id: 'task-old',
      type: 'CHAIN_COMPILE',
      status: 'FAILED',
      error: 'downloadClips: HTTP 403',
      input: {
        groupResults: [
          { url: '', shotIds: ['shot-1', 'shot-2'], params: { prompt: 'p1' } },
          { url: '', shotIds: ['shot-3', 'shot-4'], params: { prompt: 'p2' } },
        ],
        filmMeta: { projectId: 'proj-1', episodeId: 'ep-1' },
      },
    });
    const fresh = pendingRow({
      id: 'job-new', task_id: 'task-new', type: 'CHAIN_COMPILE', status: 'PENDING',
    });
    // 组1 全 COMPLETED + 同一 sf-asset:// (可复用)；组2 未完成 (重生成)
    const shotRows = [
      { id: 'shot-1', videoStatus: 'COMPLETED', currentMaterialUrl: 'sf-asset://job-old-group-1.mp4' },
      { id: 'shot-2', videoStatus: 'COMPLETED', currentMaterialUrl: 'sf-asset://job-old-group-1.mp4' },
      { id: 'shot-3', videoStatus: 'FAILED', currentMaterialUrl: null },
      { id: 'shot-4', videoStatus: 'GENERATING', currentMaterialUrl: null },
    ];
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [failed], rowCount: 1 })   // SELECT render_jobs
      .mockResolvedValueOnce({ rows: shotRows, rowCount: 4 })    // SELECT shots
      .mockResolvedValueOnce({ rows: [fresh], rowCount: 1 });    // INSERT

    await createRetryCopy('job-old', 'user-1');

    // INSERT 的第 5 个参数是序列化 input；断言组1 改 pass-through、组2 强制重生成
    const insertInput = JSON.parse(
      vi.mocked(query).mock.calls[2][1]![4] as string,
    );
    expect(insertInput.groupResults).toEqual([
      { shotIds: ['shot-1', 'shot-2'], url: 'sf-asset://job-old-group-1.mp4' },
      { shotIds: ['shot-3', 'shot-4'], params: { prompt: 'p2' }, url: '' },
    ]);
  });
});
