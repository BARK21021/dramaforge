// ============================================================
// ⑥ server/ai-worker/task-repo — 单测
// ============================================================
//
// 覆盖：
//   - markRunning：UPDATE tasks SET status='RUNNING' + workerId/startedAt
//   - markCompleted：UPDATE tasks SET status='COMPLETED' + output JSONB + model 字段
//   - markFailed：UPDATE tasks SET status='FAILED' + error
//   - getConcurrencyLimit：正常读取 / 用户不存在回退 3 / 查询异常回退 3
//   - updateShotMaterial：UPDATE shots SET currentMaterialUrl + videoStatus
//   - markShotsVideoStatus：批量更新（空数组 no-op）
//
// mock @server/infra 的 query：记录调用参数验证 SQL 与参数。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock @server/infra 的 query
const queryMock = vi.fn();
vi.mock('@server/infra', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import {
  markRunning,
  markCompleted,
  markFailed,
  updateTaskProgress,
  getConcurrencyLimit,
  getTaskStatus,
  updateShotMaterial,
  markShotsVideoStatus,
} from '../../src/ai-worker/task-repo';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('markRunning', () => {
  it('updates tasks to RUNNING with workerId', async () => {
    await markRunning('t1', 'worker-1');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status='RUNNING'");
    expect(sql).toContain('"workerId"=$1');
    expect(sql).toContain('"startedAt"=NOW()');
    // CAS 终态守卫：仅非终态任务才置 RUNNING
    expect(sql).toContain("status IN ('PENDING','QUEUED','RUNNING')");
    expect(params).toEqual(['worker-1', 't1']);
  });
});

describe('markCompleted', () => {
  it('updates tasks to COMPLETED with output JSONB and model info', async () => {
    const result = {
      output: { content: 'hello' },
      modelProvider: 'ark',
      modelName: 'ark/doubao',
    };
    await markCompleted('t1', result);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status='COMPLETED'");
    expect(sql).toContain('output=$1::jsonb');
    expect(sql).contains('"modelProvider"=$2');
    expect(sql).toContain('"modelName"=$3');
    expect(sql).toContain('"pendingCharge"=NULL');
    expect(params[0]).toBe(JSON.stringify({ content: 'hello' }));
    expect(params[1]).toBe('ark');
    expect(params[2]).toBe('ark/doubao');
    expect(params[3]).toBe('t1');
    // CAS 终态守卫 + RETURNING：仅未终态任务才置 COMPLETED
    expect(sql).toContain("status NOT IN ('COMPLETED','FAILED','CANCELLED')");
    expect(sql).toContain('RETURNING id');
  });

  it('returns true when a row was actually updated (non-terminal task)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
    const ok = await markCompleted('t1', { output: {} });
    expect(ok).toBe(true);
  });

  it('returns false when task already terminal (CAS guard, 0 rows)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const ok = await markCompleted('t1', { output: {} });
    expect(ok).toBe(false);
  });

  it('handles null output and missing model fields', async () => {
    await markCompleted('t2', { output: null });
    const params = queryMock.mock.calls[0][1];
    expect(params[0]).toBe(JSON.stringify(null));
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
    expect(params[3]).toBe('t2');
  });
});

describe('updateTaskProgress', () => {
  it('persists bounded progress and stage details', async () => {
    await updateTaskProgress('t1', 85, '保存图片中', 20);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('progress=$1');
    expect(sql).toContain('stage=$2');
    expect(sql).toContain('"stageProgress"=$3');
    expect(params).toEqual([85, '保存图片中', 20, 't1']);
  });
});

describe('markFailed', () => {
  it('updates tasks to FAILED with error message', async () => {
    await markFailed('t1', '生成失败');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status='FAILED'");
    expect(sql).toContain('error=$1');
    expect(sql).toContain('"completedAt"=NOW()');
    expect(params).toEqual(['生成失败', 't1']);
    // CAS 守卫：已 COMPLETED 的任务不覆盖为 FAILED
    expect(sql).toContain("status NOT IN ('COMPLETED','CANCELLED')");
  });
});

describe('getTaskStatus', () => {
  it('returns the status string for an existing task', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'RUNNING' }] });
    const s = await getTaskStatus('t1');
    expect(s).toBe('RUNNING');
  });

  it('returns null when task not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const s = await getTaskStatus('missing');
    expect(s).toBeNull();
  });
});

describe('getConcurrencyLimit', () => {
  it('returns maxConcurrent from users table', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ maxConcurrent: 5 }], rowCount: 1 });
    const limit = await getConcurrencyLimit('u1');
    expect(limit).toBe(5);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('SELECT "maxConcurrent" FROM users');
    expect(params).toEqual(['u1']);
  });

  it('defaults to 3 when user not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const limit = await getConcurrencyLimit('missing');
    expect(limit).toBe(3);
  });

  it('defaults to 3 when maxConcurrent is null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ maxConcurrent: null }], rowCount: 1 });
    const limit = await getConcurrencyLimit('u1');
    expect(limit).toBe(3);
  });

  it('defaults to 3 when query throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('DB down'));
    const limit = await getConcurrencyLimit('u1');
    expect(limit).toBe(3);
  });

  it('floors fractional maxConcurrent', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ maxConcurrent: 3.7 }], rowCount: 1 });
    const limit = await getConcurrencyLimit('u1');
    expect(limit).toBe(3);
  });
});

describe('updateShotMaterial', () => {
  it('updates shots currentMaterialUrl and videoStatus, 记代次历史防覆盖', async () => {
    await updateShotMaterial('shot-1', 'https://minio/video.mp4', 'COMPLETED');
    // 先 SELECT 旧 currentMaterialUrl（防覆盖丢老视频），再 UPDATE。找 UPDATE 那条。
    const updateCall = queryMock.mock.calls.find(
      ([s]) => String(s).includes('UPDATE shots'),
    ) as [string, unknown[]];
    expect(updateCall[0]).toContain('"currentMaterialUrl"=$1');
    expect(updateCall[0]).toContain('"videoStatus"=$2');
    const params = updateCall[1];
    expect(params[0]).toBe('https://minio/video.mp4');
    expect(params[1]).toBe('COMPLETED');
    expect(params[2]).toBe('shot-1');
    expect(params[3]).toEqual(expect.any(String)); // materialUpdatedAt ISO
    // videoGenerations 历史数组：新代次记进，不再裸覆盖
    expect(params[4]).toBeDefined();
    const gens = JSON.parse(String(params[4])) as Array<{ url: string }>;
    expect(gens[0].url).toBe('https://minio/video.mp4');
  });
});

describe('markShotsVideoStatus', () => {
  it('updates each shot in the list', async () => {
    await markShotsVideoStatus(['s1', 's2', 's3'], 'FAILED');
    expect(queryMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const [sql, params] = queryMock.mock.calls[i];
      expect(sql).toContain('"videoStatus"=$1');
      expect(params).toEqual(['FAILED', `s${i + 1}`]);
    }
  });

  it('is a no-op for empty shotIds', async () => {
    await markShotsVideoStatus([], 'COMPLETED');
    expect(queryMock).not.toHaveBeenCalled();
  });
});
