import { describe, it, expect } from 'vitest';
import type {
  RenderJob,
  RenderJobType,
  RenderJobStatus,
  ConcatInput,
  ExtractFrameInput,
} from '../src/render-job';

describe('RenderJob CONCAT shape', () => {
  it('constructs a PENDING CONCAT job with 2 clips + outputUploadUrl', () => {
    const input: ConcatInput = {
      clips: [
        { url: 'https://minio.local/a.mp4', durationSec: 3.2 },
        { url: 'https://minio.local/b.mp4', durationSec: 5.0 },
      ],
      outputUploadUrl: 'https://minio.local/out/concat.mp4',
    };
    const job: RenderJob = {
      id: 'job_1',
      taskId: 'task_1',
      userId: 'user_1',
      type: 'CONCAT',
      status: 'PENDING',
      input,
      result: null,
      claimedBy: null,
      claimToken: null,
      error: null,
      createdAt: new Date().toISOString(),
      claimedAt: null,
      heartbeatAt: null,
      completedAt: null,
    };

    expect(job.type).toBe('CONCAT' as RenderJobType);
    expect(job.status).toBe('PENDING' as RenderJobStatus);
    expect((job.input as ConcatInput).clips).toHaveLength(2);
    expect((job.input as ConcatInput).clips[0].url).toBe('https://minio.local/a.mp4');
    expect((job.input as ConcatInput).clips[1].durationSec).toBe(5.0);
    expect((job.input as ConcatInput).outputUploadUrl).toBe('https://minio.local/out/concat.mp4');
    expect(job.result).toBeNull();
    expect(job.claimedBy).toBeNull();
  });
});

describe('ConcatInput outputKey', () => {
  it('accepts optional outputKey for stable downstream reference', () => {
    const input: ConcatInput = {
      clips: [{ url: 'https://minio.local/a.mp4' }],
      outputUploadUrl: 'https://minio.local/out/concat.mp4',
      outputKey: 'renders/user-1/job-1.mp4',
    };
    expect(input.outputKey).toBe('renders/user-1/job-1.mp4');
  });

  it('treats outputKey as optional (caller-minted URL, no server-side key)', () => {
    const input: ConcatInput = {
      clips: [{ url: 'https://minio.local/a.mp4' }],
      outputUploadUrl: 'https://minio.local/out/concat.mp4',
    };
    expect(input.outputKey).toBeUndefined();
  });
});

describe('RenderJob EXTRACT_FRAME shape', () => {
  it('constructs a PENDING EXTRACT_FRAME job', () => {
    const input: ExtractFrameInput = {
      videoUrl: 'https://minio.local/v.mp4',
      atSec: 12.5,
      outputUploadUrl: 'https://minio.local/out/frame.png',
    };
    const job: RenderJob = {
      id: 'job_2',
      taskId: 'task_2',
      userId: 'user_1',
      type: 'EXTRACT_FRAME',
      status: 'PENDING',
      input,
      result: null,
      claimedBy: null,
      claimToken: null,
      error: null,
      createdAt: new Date().toISOString(),
      claimedAt: null,
      heartbeatAt: null,
      completedAt: null,
    };

    expect(job.type).toBe('EXTRACT_FRAME');
    expect((job.input as ExtractFrameInput).videoUrl).toBe('https://minio.local/v.mp4');
    expect((job.input as ExtractFrameInput).atSec).toBe(12.5);
    expect((job.input as ExtractFrameInput).outputUploadUrl).toBe('https://minio.local/out/frame.png');
  });
});
