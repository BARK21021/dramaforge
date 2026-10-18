import { describe, it, expect } from 'vitest';
import { genId, withRetry, parseUrl } from '../src/utils';

describe('genId', () => {
  it('returns unique strings across 100 calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(genId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('withRetry', () => {
  it('succeeds when fn passes on 2nd call and returns the value', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('first fail');
      return 'ok';
    }, { tries: 3, backoffMs: 1 });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws after tries failures', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error(`fail ${calls}`);
      }, { tries: 3, backoffMs: 1 }),
    ).rejects.toThrow('fail 3');
    expect(calls).toBe(3);
  });
});

describe('parseUrl', () => {
  it('returns URL for valid url string', () => {
    const u = parseUrl('https://x.com/a');
    expect(u).not.toBeNull();
    expect(u!.hostname).toBe('x.com');
    expect(u!.pathname).toBe('/a');
  });

  it('returns null for invalid url string', () => {
    expect(parseUrl('not a url')).toBeNull();
  });
});
