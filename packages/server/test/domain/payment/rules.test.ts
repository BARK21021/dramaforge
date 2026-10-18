// ============================================================
// payment/rules — 纯函数单测（yuanToRechargeCredits / validateAmountYuan）
// ============================================================
//
// validateAmountYuan 读 env 的 PAYMENT_ORDER_MIN/MAX_YUAN，mock @server/infra/env
// 提供固定边界 [1, 10000]。
// ============================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('@server/infra/env', () => ({
  env: () => ({
    PAYMENT_ORDER_MIN_YUAN: '1',
    PAYMENT_ORDER_MAX_YUAN: '10000',
  }),
}));

import { yuanToRechargeCredits, validateAmountYuan } from '../../../src/domain/payment/rules';

describe('yuanToRechargeCredits', () => {
  it('1 元 = 10 积分', () => {
    expect(yuanToRechargeCredits(1)).toBe(10);
    expect(yuanToRechargeCredits(0.5)).toBe(5);
    expect(yuanToRechargeCredits(100)).toBe(1000);
    expect(yuanToRechargeCredits(99.99)).toBe(1000); // round(999.9) = 1000
  });
});

describe('validateAmountYuan', () => {
  it('区间内合法 [1, 10000]', () => {
    expect(validateAmountYuan(1)).toEqual({ ok: true });
    expect(validateAmountYuan(10000)).toEqual({ ok: true });
    expect(validateAmountYuan(50.5)).toEqual({ ok: true });
  });

  it('低于下限 → ok:false', () => {
    const r = validateAmountYuan(0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('1');
  });

  it('高于上限 → ok:false', () => {
    const r = validateAmountYuan(10001);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('10000');
  });

  it('非有限数 → ok:false', () => {
    expect(validateAmountYuan(Number.NaN).ok).toBe(false);
    expect(validateAmountYuan(Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});
