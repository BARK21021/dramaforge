// ============================================================
// ④ server/task/dispatch — 单测
// ============================================================
//
// 覆盖：
//   - dispatchFilmExport → renderJobRepo.create('CONCAT')，input 原样透传
//     (P5: 成品客户端本地，服务器不签 MinIO URL、不 outputKey)
//   - dispatchVideoSplit → 'SPLIT_BY_DURATION' (durationSec) / 'SPLIT_EVENLY' (segments)
//   - dispatchChainGenerate → 'CHAIN_COMPILE'
//   - dispatchLongVideoRewrite → 'LONG_VIDEO_REWRITE'
//   - dispatchAiTask → addJob(queueName, jobName, {...data, taskId, userId})
//
// 批2 SSE QUEUED 补全（recon §3.2）：每个 dispatch 函数在 create/addJob 成功后
// 发 `publishTaskEvent({ taskId, userId, status:'QUEUED', type:'status_change' })`，
// 让前端 useSSE 立即感知任务已入队（高优先级，不被 progress 缓冲淘汰）。
//
// mock ./render-job-repo（renderJobRepo.create）+ ./queues（addJob）
// + ../ai-worker/event-publisher（publishTaskEvent）：不依赖真实 PG/Redis。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock 依赖：render-job-repo 的 renderJobRepo.create + queues 的 addJob
vi.mock('../../src/task/render-job-repo', () => ({
  renderJobRepo: {
    create: vi.fn(),
    createOrReuseChainGenerate: vi.fn(),
  },
}));

vi.mock('../../src/task/queues', () => ({
  addJob: vi.fn(),
  QUEUE_NAMES: {
    text: 'tasks-text',
    image: 'tasks-image',
    video: 'tasks-video',
    voice: 'tasks-voice',
  },
}));

// mock @shared/utils 的 genId：固定返回值便于断言 jobId（成品文件名 = <jobId>.mp4）
vi.mock('@shared/utils', () => ({
  genId: vi.fn(),
}));

// mock event-publisher 的 publishTaskEvent：dispatch.ts 用相对路径引入
// （绕过 ai-worker/index.ts barrel 的 worker-bootstrap 副作用，recon §5.5）
vi.mock('../../src/ai-worker/event-publisher', () => ({
  publishTaskEvent: vi.fn(),
}));

import {
  dispatchFilmExport,
  dispatchVideoSplit,
  dispatchChainGenerate,
  dispatchChainGenerateOnce,
  dispatchLongVideoRewrite,
  dispatchAiTask,
} from '../../src/task/dispatch';
import { renderJobRepo } from '../../src/task/render-job-repo';
import { addJob } from '../../src/task/queues';
import { genId } from '@shared/utils';
import { publishTaskEvent } from '../../src/ai-worker/event-publisher';

const fakeJob = {
  id: 'job-1',
  taskId: 't1',
  userId: 'u1',
  type: 'CONCAT',
  status: 'PENDING',
  input: {},
  result: null,
  claimedBy: null,
  error: null,
  createdAt: '2026-07-18T00:00:00.000Z',
  claimedAt: null,
  completedAt: null,
};

beforeEach(() => {
  vi.mocked(renderJobRepo.create).mockReset();
  vi.mocked(renderJobRepo.createOrReuseChainGenerate).mockReset();
  vi.mocked(addJob).mockReset();
  vi.mocked(renderJobRepo.create).mockResolvedValue(fakeJob);
  vi.mocked(renderJobRepo.createOrReuseChainGenerate).mockResolvedValue({
    job: fakeJob,
    reused: false,
  });
  vi.mocked(addJob).mockResolvedValue('bull-job-id');
  vi.mocked(genId).mockReset();
  vi.mocked(publishTaskEvent).mockReset();
  vi.mocked(publishTaskEvent).mockResolvedValue(undefined);
});

// ============================================================
// 通道 A：客户端 ffmpeg 任务 → render_jobs
// ============================================================

describe('dispatchFilmExport', () => {
  it('creates a CONCAT render_job with input verbatim + pre-gen jobId (films client-local)', async () => {
    vi.mocked(genId).mockReturnValue('job-id-fixed');
    const input = {
      clips: [{ url: 'https://a' }, { url: 'https://b' }],
    };
    const job = await dispatchFilmExport('t1', 'u1', input);
    expect(job).toBe(fakeJob);
    // P5: films are client-local — NO MinIO minting. Input passes through
    // verbatim; the render-worker writes userData/clips/<jobId>.mp4 locally.
    expect(renderJobRepo.create).toHaveBeenCalledWith(
      't1',
      'u1',
      'CONCAT',
      { clips: [{ url: 'https://a' }, { url: 'https://b' }] },
      'job-id-fixed',
    );
  });

  it('does NOT mint any MinIO URL / outputKey (dramaforge-assets-client-local)', async () => {
    // Constraint lock: the server stores ZERO media bytes for films. dispatch
    // must not presign-upload nor attach outputUploadUrl/outputKey to the input.
    vi.mocked(genId).mockReturnValue('job-id-x');
    await dispatchFilmExport('t1', 'u1', { clips: [{ url: 'https://a' }] });
    const callArgs = vi.mocked(renderJobRepo.create).mock.calls[0];
    const inputArg = callArgs[3];
    expect(inputArg).toEqual({ clips: [{ url: 'https://a' }] });
    expect(inputArg).not.toHaveProperty('outputUploadUrl');
    expect(inputArg).not.toHaveProperty('outputKey');
  });

  it('publishes a QUEUED task event after create (recon 批2 §3.2)', async () => {
    vi.mocked(genId).mockReturnValue('job-id-q');
    await dispatchFilmExport('tQ', 'uQ', { clips: [{ url: 'https://a' }] });
    expect(publishTaskEvent).toHaveBeenCalledTimes(1);
    expect(publishTaskEvent).toHaveBeenCalledWith({
      taskId: 'tQ',
      userId: 'uQ',
      status: 'QUEUED',
      type: 'status_change',
    });
  });
});

describe('dispatchVideoSplit', () => {
  it('dispatches SPLIT_BY_DURATION when input has durationSec', async () => {
    const input = {
      videoUrl: 'https://v',
      durationSec: 10,
      outputPrefix: 'seg-',
    };
    await dispatchVideoSplit('t1', 'u1', input);
    expect(renderJobRepo.create).toHaveBeenCalledWith(
      't1',
      'u1',
      'SPLIT_BY_DURATION',
      input,
    );
  });

  it('dispatches SPLIT_EVENLY when input has segments', async () => {
    const input = {
      videoUrl: 'https://v',
      segments: 4,
      outputPrefix: 'seg-',
    };
    await dispatchVideoSplit('t1', 'u1', input);
    expect(renderJobRepo.create).toHaveBeenCalledWith(
      't1',
      'u1',
      'SPLIT_EVENLY',
      input,
    );
  });

  it('publishes a QUEUED task event after create (recon 批2 §3.2)', async () => {
    await dispatchVideoSplit('tQ', 'uQ', {
      videoUrl: 'https://v',
      durationSec: 10,
      outputPrefix: 'seg-',
    });
    expect(publishTaskEvent).toHaveBeenCalledTimes(1);
    expect(publishTaskEvent).toHaveBeenCalledWith({
      taskId: 'tQ',
      userId: 'uQ',
      status: 'QUEUED',
      type: 'status_change',
    });
  });
});

describe('dispatchChainGenerate', () => {
  it('creates a CHAIN_COMPILE render_job', async () => {
    const input = {
      groupResults: [{ url: 'https://g1' }, { url: 'https://g2' }],
      outputUploadUrl: 'https://up',
    };
    await dispatchChainGenerate('t1', 'u1', input);
    expect(renderJobRepo.create).toHaveBeenCalledWith(
      't1',
      'u1',
      'CHAIN_COMPILE',
      input,
    );
  });

  it('publishes a QUEUED task event after create (recon 批2 §3.2)', async () => {
    await dispatchChainGenerate('tQ', 'uQ', {
      groupResults: [{ url: 'https://g1' }],
      outputUploadUrl: 'https://up',
    });
    expect(publishTaskEvent).toHaveBeenCalledTimes(1);
    expect(publishTaskEvent).toHaveBeenCalledWith({
      taskId: 'tQ',
      userId: 'uQ',
      status: 'QUEUED',
      type: 'status_change',
    });
  });
});

describe('dispatchChainGenerateOnce', () => {
  it('publishes QUEUED only when the atomic repository call created a job', async () => {
    const input = { groupResults: [{ url: 'https://g1' }] };
    await dispatchChainGenerateOnce('new-task', 'u1', input);

    expect(renderJobRepo.createOrReuseChainGenerate).toHaveBeenCalledWith(
      'new-task',
      'u1',
      input,
    );
    expect(publishTaskEvent).toHaveBeenCalledWith({
      taskId: 'new-task',
      userId: 'u1',
      status: 'QUEUED',
      type: 'status_change',
    });
  });

  it('does not publish a duplicate QUEUED event when an active job is reused', async () => {
    vi.mocked(renderJobRepo.createOrReuseChainGenerate).mockResolvedValue({
      job: { ...fakeJob, taskId: 'existing-task' },
      reused: true,
    });

    const dispatched = await dispatchChainGenerateOnce('discarded-task', 'u1', {
      groupResults: [{ url: 'https://g1' }],
    });

    expect(dispatched.job.taskId).toBe('existing-task');
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });
});

describe('dispatchLongVideoRewrite', () => {
  it('creates a LONG_VIDEO_REWRITE render_job', async () => {
    const input = {
      videoUrl: 'https://v',
      segments: 3,
      projectId: 'project-1',
      totalDurationSec: 1_800,
      totalBytes: 120 * 1024 * 1024,
      outputUploadUrl: 'https://up',
    };
    await dispatchLongVideoRewrite('t1', 'u1', input);
    expect(renderJobRepo.create).toHaveBeenCalledWith(
      't1',
      'u1',
      'LONG_VIDEO_REWRITE',
      input,
    );
  });

  it('publishes a QUEUED task event after create (recon 批2 §3.2)', async () => {
    await dispatchLongVideoRewrite('tQ', 'uQ', {
      videoUrl: 'https://v',
      segments: 3,
      projectId: 'project-Q',
      totalDurationSec: 1_800,
      totalBytes: 120 * 1024 * 1024,
      outputUploadUrl: 'https://up',
    });
    expect(publishTaskEvent).toHaveBeenCalledTimes(1);
    expect(publishTaskEvent).toHaveBeenCalledWith({
      taskId: 'tQ',
      userId: 'uQ',
      status: 'QUEUED',
      type: 'status_change',
    });
  });
});

// ============================================================
// 通道 B：服务器端 AI 任务 → BullMQ 队列
// ============================================================

describe('dispatchAiTask', () => {
  it('calls addJob with the right queue and merged taskId/userId', async () => {
    const data = { prompt: 'a cat running' };
    const id = await dispatchAiTask('t1', 'u1', 'video', 'VIDEO_GENERATE', data);

    expect(id).toBe('bull-job-id');
    expect(addJob).toHaveBeenCalledTimes(1);
    // P0-1：dispatchAiTask 现在传第 4 参 taskId 作 BullMQ jobId（去重，杜绝 task-heal
    // 重派每 tick 新建重复 job 烧 key）。断言末尾需带 taskId。
    expect(addJob).toHaveBeenCalledWith(
      'video',
      'VIDEO_GENERATE',
      { prompt: 'a cat running', taskId: 't1', userId: 'u1' },
      't1',
    );
  });

  it('routes single video generation to the video queue', async () => {
    await dispatchAiTask('t2', 'u2', 'video', 'VIDEO_GENERATE', { prompt: 'x' });
    // P0-1：第 4 参 taskId 作 BullMQ jobId
    expect(addJob).toHaveBeenCalledWith(
      'video',
      'VIDEO_GENERATE',
      expect.objectContaining({ taskId: 't2', userId: 'u2' }),
      't2',
    );
  });

  it('routes image tasks to the image queue', async () => {
    await dispatchAiTask('t3', 'u3', 'image', 'IMAGE_GENERATE', { prompt: 'y' });
    // P0-1：第 4 参 taskId 作 BullMQ jobId
    expect(addJob).toHaveBeenCalledWith(
      'image',
      'IMAGE_GENERATE',
      expect.objectContaining({ taskId: 't3', userId: 'u3' }),
      't3',
    );
  });

  it('routes voice tasks to the voice queue', async () => {
    await dispatchAiTask('t4', 'u4', 'voice', 'VOICE_GENERATE', { text: 'hi' });
    // P0-1：第 4 参 taskId 作 BullMQ jobId
    expect(addJob).toHaveBeenCalledWith(
      'voice',
      'VOICE_GENERATE',
      expect.objectContaining({ taskId: 't4', userId: 'u4' }),
      't4',
    );
  });

  it('routes text tasks to the text queue', async () => {
    await dispatchAiTask('t5', 'u5', 'text', 'LLM_CHAT', { msg: 'hello' });
    // P0-1：第 4 参 taskId 作 BullMQ jobId
    expect(addJob).toHaveBeenCalledWith(
      'text',
      'LLM_CHAT',
      expect.objectContaining({ taskId: 't5', userId: 'u5' }),
      't5',
    );
  });

  it('publishes a QUEUED task event after addJob, using input taskId (not bullJobId, recon §5.7)', async () => {
    // Critical: dispatchAiTask returns BullMQ Job ID ('bull-job-id'), but the
    // QUEUED event must carry the INPUT taskId ('tQ') — frontend trackTaskId
    // tracks the input taskId, not the BullMQ jobId.
    const id = await dispatchAiTask('tQ', 'uQ', 'video', 'VIDEO_GENERATE', { prompt: 'x' });
    expect(id).toBe('bull-job-id');
    expect(publishTaskEvent).toHaveBeenCalledTimes(1);
    expect(publishTaskEvent).toHaveBeenCalledWith({
      taskId: 'tQ', // ← NOT 'bull-job-id'
      userId: 'uQ',
      status: 'QUEUED',
      type: 'status_change',
    });
  });
});
