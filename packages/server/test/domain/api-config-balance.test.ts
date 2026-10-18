import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderBalance } from '../../src/domain/api-configs/balance';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider balance adapters', () => {
  it('normalizes DeepSeek CNY balance without exposing credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      balance_infos: [{ currency: 'CNY', total_balance: '12.34' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderBalance('deepseek', { apiKey: 'secret-key' });
    expect(result).toMatchObject({ balanceSupported: true, balance: 12.34, currency: 'CNY' });
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });

  it('normalizes Kimi nested available balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { available_balance: 56.78 },
    }), { status: 200 })));
    const result = await fetchProviderBalance('kimi', { apiKey: 'secret-key' });
    expect(result).toMatchObject({ balanceSupported: true, balance: 56.78, currency: 'CNY' });
  });

  it('marks providers without a safe balance endpoint as unsupported instead of showing a fake zero', async () => {
    const result = await fetchProviderBalance('ark', { apiKey: 'secret-key' });
    expect(result.balanceSupported).toBe(false);
    expect(result.balance).toBeUndefined();
  });

  it('returns a sanitized failure view on provider HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })));
    const result = await fetchProviderBalance('deepseek', { apiKey: 'secret-key' });
    expect(result.balanceSupported).toBe(true);
    expect(result.error).toContain('HTTP 401');
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
});
