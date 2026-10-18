// ============================================================
// inline AI task — 同步媒体流任务复用 tasks/SSE 的生命周期测试
// ============================================================
// 验证：只持久化脱敏元数据；阶段进度先写 PG 再发 task:events；完成输出只存摘要。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const publishTaskEventMock = vi.fn();

vi.mock('@server/infra', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

vi.mock('../../src/task/dispatch', () => ({
  dispatchAiTask: vi.fn(),
}));

vi.mock('../../src/task/event-publisher', () => ({
  publishTaskEvent: (...args: unknown[]) => publishTaskEventMock(...args),
}));

import {
  startInlineAiTask,
  reportInlineAiTaskProgress,
  completeInlineAiTask,
  failInlineAiTask,
  enqueueAiTask,
  cancelAiTask,
} from '../../src/task/ai-task-repo';
import { dispatchAiTask } from '../../src/task/dispatch';

const taskRow = {
  id: 'task-1',
  userId: 'user-1',
  projectId: 'project-1',
  type: 'VIDEO_TO_SCRIPT',
  status: 'RUNNING',
  progress: 8,
  stage: '正在上传视频',
  stageProgress: 0,
  input: {},
  output: null,
  error: null,
  createdAt: new Date('2026-07-22T00:00:00Z'),
  updatedAt: new Date('2026-07-22T00:00:00Z'),
};

beforeEach(() => {
  queryMock.mockReset();
  publishTaskEventMock.mockReset();
  publishTaskEventMock.mockResolvedValue(undefined);
});

describe('cancelAiTask', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('CAS 翻 CANCELLED 并返回视图（PENDING/QUEUED/RUNNING 才允许）', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ ...taskRow, status: 'CANCELLED', error: '用户已取消' }],
    });
    const task = await cancelAiTask('task-1', 'user-1');
    expect(task).not.toBeNull();
    expect(task?.status).toBe('CANCELLED');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status='CANCELLED'");
    expect(sql).toContain("status IN ('PENDING','QUEUED','RUNNING')");
    expect(sql).toContain('"userId"=$2'); // 防越权取消他人任务
    expect(params).toEqual(['task-1', 'user-1']);
  });

  it('已终态/不存在/非本人返回 null（CAS 0 rows）', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const task = await cancelAiTask('task-1', 'user-1');
    expect(task).toBeNull();
  });
});

describe('inline AI task lifecycle', () => {
  it('创建任务时只持久化调用方提供的脱敏文件元数据并发布 RUNNING', async () => {
    queryMock.mockResolvedValueOnce({ rows: [taskRow] });
    const storedInput = {
      episodeId: 'episode-1',
      filename: '视频.mp4',
      mimeType: 'video/mp4',
      videoSize: 1024,
    };

    const task = await startInlineAiTask({
      id: 'task-1',
      userId: 'user-1',
      projectId: 'project-1',
      type: 'VIDEO_TO_SCRIPT',
      progress: 8,
      stage: '正在上传视频',
      storedInput,
    });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("'RUNNING'");
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(JSON.parse(String(params[6]))).toEqual({ ...storedInput, __inline: true });
    expect(String(params[6])).not.toMatch(/apiKey|videoStream|videoBytes/i);
    expect(task.id).toBe('task-1');
    expect(publishTaskEventMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      userId: 'user-1',
      status: 'RUNNING',
      type: 'status_change',
      progress: 8,
      stage: '正在上传视频',
      stageProgress: 0,
    });
  });

  it('进度、完成和失败更新都带 userId 守卫，并只在命中任务后发事件', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'task-1' }] });

    await reportInlineAiTaskProgress('task-1', 'user-1', 35, '正在提取角色和场景', 0);
    await completeInlineAiTask('task-1', 'user-1', {
      episodeId: 'episode-1',
      scriptLength: 6474,
    });
    await failInlineAiTask('task-1', 'user-1', '视频转剧本失败，请重试');

    for (const [sql] of queryMock.mock.calls as Array<[string, unknown[]]>) {
      expect(sql).toContain('"userId"');
      expect(sql).toContain('RETURNING id');
    }
    expect(publishTaskEventMock.mock.calls.map((call) => call[0].status)).toEqual([
      'RUNNING',
      'COMPLETED',
      'FAILED',
    ]);
    const completedParams = queryMock.mock.calls[1][1] as unknown[];
    expect(JSON.parse(String(completedParams[0]))).toEqual({
      episodeId: 'episode-1',
      scriptLength: 6474,
    });
  });

  it('任务已进入终态时不再发布迟到的进度事件', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await reportInlineAiTaskProgress('task-1', 'user-1', 65, '正在生成剧本', 0);

    expect(publishTaskEventMock).not.toHaveBeenCalled();
  });
});

describe('enqueueAiTask', () => {
  const fullRow = {
    id: 't-x',
    userId: 'u1',
    projectId: 'p1',
    type: 'IMAGE_GENERATE',
    status: 'QUEUED',
    progress: 0,
    stage: null,
    stageProgress: 0,
    input: {},
    output: null,
    error: null,
    createdAt: '2026-07-22T00:00:00Z',
    updatedAt: '2026-07-22T00:00:00Z',
  };

  beforeEach(() => {
    queryMock.mockReset();
    publishTaskEventMock.mockReset();
    publishTaskEventMock.mockResolvedValue(undefined);
    vi.mocked(dispatchAiTask).mockReset();
    vi.mocked(dispatchAiTask).mockResolvedValue('bull-job-1');
  });

  it('dedupes: reuses existing active task, no INSERT / no dispatch', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...fullRow, id: 'existing' }] });

    const r = await enqueueAiTask({
      userId: 'u1',
      projectId: 'p1',
      type: 'IMAGE_GENERATE',
      queueName: 'image',
      payload: { prompt: 'x' },
    });

    expect(r.reused).toBe(true);
    expect(r.task.id).toBe('existing');
    expect(queryMock).toHaveBeenCalledTimes(1); // 仅 SELECT，无 INSERT
    expect(vi.mocked(dispatchAiTask)).not.toHaveBeenCalled();
  });

  it('chain resume: 复用已 COMPLETED 的 chainMode task（不重生成）', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ ...fullRow, id: 'done-1', type: 'VIDEO_GENERATE', status: 'COMPLETED', input: { chainMode: true } }],
    });

    const r = await enqueueAiTask({
      userId: 'u1',
      projectId: 'p1',
      type: 'VIDEO_GENERATE',
      queueName: 'video',
      payload: { prompt: 'x', chainMode: true },
      dedupeKey: 'job-1:0',
      leanBullMQ: true,
    });

    expect(r.reused).toBe(true);
    expect(r.task.id).toBe('done-1');
    expect(queryMock).toHaveBeenCalledTimes(1); // 仅 SELECT，无 INSERT/无重派
    expect(vi.mocked(dispatchAiTask)).not.toHaveBeenCalled();
  });

  it('dedupeKey 分支 SQL 匹配 COMPLETED chainMode（resume 作用域）', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT（dedupeKey 分支）：无复用 → 继续 INSERT
      .mockResolvedValueOnce({ rows: [{ ...fullRow, id: 'n1', status: 'PENDING' }] })
      .mockResolvedValueOnce({ rows: [{ ...fullRow, id: 'n1', status: 'QUEUED' }] });

    await enqueueAiTask({
      userId: 'u1',
      projectId: 'p1',
      type: 'VIDEO_GENERATE',
      queueName: 'video',
      payload: { prompt: 'x', chainMode: true },
      dedupeKey: 'job-1:0',
      leanBullMQ: true,
    });

    const selectSql = (queryMock.mock.calls[0] as [string, unknown[]])[0];
    expect(selectSql).toContain("status = 'COMPLETED'");
    expect(selectSql).toContain('chainMode');
    expect(selectSql).toContain("'PENDING', 'QUEUED', 'RUNNING'");
  });

  it('no-dedupeKey 分支 SQL 保持只匹配活跃（不误复用 COMPLETED）', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...fullRow, id: 'n2', status: 'PENDING' }] })
      .mockResolvedValueOnce({ rows: [{ ...fullRow, id: 'n2', status: 'QUEUED' }] });

    await enqueueAiTask({
      userId: 'u1',
      projectId: 'p1',
      type: 'IMAGE_GENERATE',
      queueName: 'image',
      payload: { prompt: 'x' },
      // 无 dedupeKey → no-dedupeKey 分支（图片等无幂等作用域的任务，保持活跃-only）
    });

    const selectSql = (queryMock.mock.calls[0] as [string, unknown[]])[0];
    expect(selectSql).not.toContain('COMPLETED');
    expect(selectSql).toContain("'PENDING', 'QUEUED', 'RUNNING'");
  });

  it('marks FAILED + rethrows when dispatch throws (防永久 PENDING)', async () => {
    const newRow = { ...fullRow, id: 'new-1', status: 'PENDING' };
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT active: 无
      .mockResolvedValueOnce({ rows: [newRow] }) // INSERT PENDING
      .mockResolvedValueOnce({ rows: [] }); // UPDATE FAILED
    vi.mocked(dispatchAiTask).mockRejectedValueOnce(new Error('入队失败'));

    await expect(
      enqueueAiTask({
        userId: 'u1',
        projectId: 'p1',
        type: 'IMAGE_GENERATE',
        queueName: 'image',
        payload: { prompt: 'x' },
      }),
    ).rejects.toThrow('入队失败');

    const calls = queryMock.mock.calls as Array<[string, unknown[]]>;
    const lastSql = calls[calls.length - 1][0];
    expect(lastSql).toContain("status = 'FAILED'");
  });

  it('leanBullMQ=true omits input from BullMQ job data (base64 留 PG，Redis 精简)', async () => {
    const newRow = { ...fullRow, id: 'new-lean', status: 'PENDING' };
    const queuedRow = { ...fullRow, id: 'new-lean', status: 'QUEUED' };
    queryMock
      .mockResolvedValueOnce({ rows: [] })          // SELECT active: 无复用
      .mockResolvedValueOnce({ rows: [newRow] })     // INSERT PENDING
      .mockResolvedValueOnce({ rows: [queuedRow] }); // UPDATE QUEUED
    vi.mocked(dispatchAiTask).mockResolvedValueOnce('bull-lean');

    await enqueueAiTask({
      userId: 'u1',
      projectId: 'p1',
      type: 'VIDEO_GENERATE',
      queueName: 'video',
      payload: { prompt: 'x', characterReferenceImageUrls: ['data:image/png;base64,BIG'] },
      leanBullMQ: true,
    });

    // BullMQ job data 不带 input（精简，避免 base64 撑爆 Redis）；只带 projectId。
    // taskId 是 genId() 随机生成，只断言第 5 参 data。
    expect(vi.mocked(dispatchAiTask)).toHaveBeenCalledTimes(1);
    const dataArg = vi.mocked(dispatchAiTask).mock.calls[0][4];
    expect(dataArg).toEqual({ projectId: 'p1' });
    expect(dataArg).not.toHaveProperty('input');
  });

  it('default (no leanBullMQ) keeps full input in BullMQ job data', async () => {
    const newRow = { ...fullRow, id: 'new-fat', status: 'PENDING' };
    const queuedRow = { ...fullRow, id: 'new-fat', status: 'QUEUED' };
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [newRow] })
      .mockResolvedValueOnce({ rows: [queuedRow] });
    vi.mocked(dispatchAiTask).mockResolvedValueOnce('bull-fat');

    const payload = { prompt: 'x' };
    await enqueueAiTask({
      userId: 'u1',
      projectId: 'p1',
      type: 'IMAGE_GENERATE',
      queueName: 'image',
      payload,
    });

    // 默认行为不变：BullMQ job data 带 input（generate-image 等靠此，PG 可脱敏）。
    expect(vi.mocked(dispatchAiTask)).toHaveBeenCalledTimes(1);
    const dataArg = vi.mocked(dispatchAiTask).mock.calls[0][4];
    expect(dataArg).toEqual({ input: payload, projectId: 'p1' });
  });

  it('竞态安全：worker 抢先 markRunning 后，QUEUED 收尾 UPDATE 不得把 RUNNING 砸回 QUEUED', async () => {
    // 复现生产假死根因（19d0ca7c 等 25 任务/3 天）：
    //   enqueueAiTask 流程是 INSERT(PENDING) → dispatchAiTask(入 BullMQ) → UPDATE status='QUEUED'。
    //   dispatchAiTask 一旦把 job 暴露给队列，worker 可能立即拾取并 markRunning(PENDING→RUNNING)，
    //   随后那条「无 CAS 的 UPDATE status='QUEUED'」才执行 → 把 RUNNING 砸回 QUEUED。
    //   结果：任务实际在跑、DB 却是 QUEUED；task-heal-sweep 5min 后按「卡死 QUEUED」每 60s 重派，
    //   每次重派发一个伪 QUEUED 事件，污染客户端进度流 → UI 假死卡在最后看到的 progress。
    const newRow = { ...fullRow, id: 'race-1', status: 'PENDING' };
    const runningRow = { ...fullRow, id: 'race-1', status: 'RUNNING', progress: 12 };
    queryMock
      .mockResolvedValueOnce({ rows: [] })            // SELECT active：无复用
      .mockResolvedValueOnce({ rows: [newRow] })      // INSERT PENDING
      .mockResolvedValueOnce({ rows: [] })            // UPDATE status='QUEUED' CAS：0 行（worker 已 RUNNING）
      .mockResolvedValueOnce({ rows: [runningRow] }); // 回读真实状态
    vi.mocked(dispatchAiTask).mockResolvedValueOnce('bull-race');

    const r = await enqueueAiTask({
      userId: 'u1',
      projectId: 'p1',
      type: 'IMAGE_GENERATE',
      queueName: 'image',
      payload: { prompt: 'x' },
    });

    // 收尾 UPDATE 必须带 CAS：仅 PENDING→QUEUED，绝不覆盖 worker 已设的 RUNNING。
    const updateCall = queryMock.mock.calls[2] as [string, unknown[]];
    expect(updateCall[0]).toContain("status = 'QUEUED'");
    expect(updateCall[0]).toMatch(/WHERE id = \$1 AND status = 'PENDING'/);
    // 竞态时返回 worker 写入的真实 RUNNING（含其 progress），而非被砸回的 QUEUED。
    expect(r.task.status).toBe('RUNNING');
    expect(r.task.progress).toBe(12);
    expect(r.reused).toBe(false);
  });
});
