// ============================================================
// ② server/gateway — API Key 池纯逻辑单测（classifyKeyError 边界）
// ============================================================
// 不 mock DB（pick/recordFailure/reap 走 query，留集成/手动验）；仅锁纯函数：
//   - classifyKeyError：错误分类决定 cooldown 策略（分类错=熔断错，最关键）
//   - （LoadBalancer 已删：pick 改用 inFlight/weight 比值最小的并发感知策略）
// ============================================================

import { describe, it, expect } from 'vitest';
import { classifyKeyError } from '../../src/gateway/api-key-pool';

describe('classifyKeyError', () => {
  it('provider input/content HTTP 400 is a client error and must not cool down the key', () => {
    expect(classifyKeyError({
      status: 400,
      message: 'InputImageSensitiveContentDetected.PrivacyInformation',
    })).toBe('client_error');
  });

  it('401/403 → auth（永久禁用 invalid）', () => {
    expect(classifyKeyError({ status: 401 })).toBe('auth');
    expect(classifyKeyError({ status: 403 })).toBe('auth');
    expect(classifyKeyError({ response: { status: 403 } })).toBe('auth');
  });

  it('AccountOverdue 403 → quota（账户欠费，key 有效，30min 暂时关，不永久 invalid）', () => {
    // 真实错误形态：HTTP 403 + {"error":{"code":"AccountOverdueError",...}}
    expect(
      classifyKeyError({ status: 403, message: 'HTTP 403: {"error":{"code":"AccountOverdueError","message":"account overdue"}}' }),
    ).toBe('quota');
    expect(classifyKeyError({ status: 403, message: 'AccountOverdue' })).toBe('quota');
    expect(classifyKeyError({ status: 403, code: 'AccountOverdueError' })).toBe('quota');
    // 无余额权限（火山「无费用中心余额权限」）
    expect(classifyKeyError({ status: 403, message: 'no credit / insufficient balance' })).toBe('quota');
    // 反例：403 但不含欠费关键字 → 仍 auth（真·invalid key）
    expect(classifyKeyError({ status: 403, message: 'invalid api key' })).toBe('auth');
  });

  it('429 + quota/billing 关键字 → quota（30min cooldown）', () => {
    expect(classifyKeyError({ status: 429, message: 'insufficient quota' })).toBe('quota');
    expect(classifyKeyError({ status: 429, message: 'billing exhausted' })).toBe('quota');
  });

  it('429 无 quota 关键字 → rate_limit（60s cooldown）', () => {
    expect(classifyKeyError({ status: 429, message: 'too many requests' })).toBe('rate_limit');
    expect(classifyKeyError({ status: 429 })).toBe('rate_limit');
  });

  it('5xx → server_error', () => {
    expect(classifyKeyError({ status: 500 })).toBe('server_error');
    expect(classifyKeyError({ status: 503 })).toBe('server_error');
  });

  it('timeout 关键字 → timeout', () => {
    expect(classifyKeyError({ message: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyKeyError({ message: 'request aborted' })).toBe('timeout');
  });

  it('网络错误关键字 → network', () => {
    expect(classifyKeyError({ message: 'ECONNRESET' })).toBe('network');
    expect(classifyKeyError({ message: 'fetch failed' })).toBe('network');
  });

  it('无法分类 → 兜底 server_error', () => {
    expect(classifyKeyError({ message: 'something weird' })).toBe('server_error');
    expect(classifyKeyError({})).toBe('server_error');
  });
});
