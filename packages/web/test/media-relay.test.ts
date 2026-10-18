import { describe, expect, it } from 'vitest';
import {
  registerMediaRelay,
  releaseMediaRelay,
  takeMediaRelay,
} from '../lib/media-relay';

describe('one-shot media relay', () => {
  it('preserves bytes and allows exactly one provider consumer', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const token = registerMediaRelay({ stream, contentType: 'image/png', maxBytes: 8 });
    const relay = takeMediaRelay(token);

    expect(relay?.contentType).toBe('image/png');
    expect([...new Uint8Array(await new Response(relay!.stream).arrayBuffer())]).toEqual([1, 2, 3, 4]);
    // token 在第一次 claim 时即删除，供应商或攻击者都不能重放。
    expect(takeMediaRelay(token)).toBeNull();
  });

  it('aborts the consumer stream once the byte limit is exceeded', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    const token = registerMediaRelay({ stream, contentType: 'image/png', maxBytes: 3 });
    const relay = takeMediaRelay(token);
    await expect(new Response(relay!.stream).arrayBuffer()).rejects.toThrow(/超过/);
    releaseMediaRelay(token);
  });
});
