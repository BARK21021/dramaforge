import { describe, expect, it } from 'vitest';
import { resolveWorkerConcurrency } from './worker-concurrency';

describe('resolveWorkerConcurrency', () => {
  it('只提高图片默认并发，保留其他高内存队列的保守值', () => {
    expect(resolveWorkerConcurrency({})).toEqual({
      text: 2,
      image: 4,
      video: 1,
      voice: 1,
    });
  });

  it('支持每个队列独立覆盖并限制异常过大的配置', () => {
    expect(resolveWorkerConcurrency({
      WORKER_CONCURRENCY: '2',
      WORKER_IMAGE_CONCURRENCY: '99',
      WORKER_VIDEO_CONCURRENCY: 'invalid',
      WORKER_VOICE_CONCURRENCY: '3',
    })).toEqual({
      text: 2,
      image: 16,
      video: 2,
      voice: 3,
    });
  });
});
