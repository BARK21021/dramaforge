// ============================================================
// payment-return-poll — 纯函数单测
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  classifyPollResponse,
  pollingMessage,
  paidMessage,
} from '../lib/payment-return-poll';

describe('classifyPollResponse', () => {
  it('PAID → paid（带 credits/amountYuan）', () => {
    const r = classifyPollResponse(200, {
      success: true,
      data: { status: 'PAID', credits: 10, amountYuan: 1 },
    });
    expect(r).toEqual({ kind: 'paid', credits: 10, amountYuan: 1 });
  });

  it('PENDING → pending', () => {
    const r = classifyPollResponse(200, { success: true, data: { status: 'PENDING' } });
    expect(r).toEqual({ kind: 'pending' });
  });

  it('CLOSED / FAILED → closed', () => {
    expect(classifyPollResponse(200, { success: true, data: { status: 'CLOSED' } })).toEqual({
      kind: 'closed',
    });
    expect(classifyPollResponse(200, { success: true, data: { status: 'FAILED' } })).toEqual({
      kind: 'closed',
    });
  });

  it('401 → auth-error（不论 body）', () => {
    expect(classifyPollResponse(401, { success: false, error: 'UNAUTHORIZED' })).toEqual({
      kind: 'auth-error',
    });
    expect(classifyPollResponse(401, null)).toEqual({ kind: 'auth-error' });
  });

  it('500 / 信封失败 / body null → transient-error（保持轮询）', () => {
    expect(classifyPollResponse(500, null)).toEqual({ kind: 'transient-error' });
    expect(classifyPollResponse(200, { success: false, error: 'boom' })).toEqual({
      kind: 'transient-error',
    });
    expect(classifyPollResponse(200, null)).toEqual({ kind: 'transient-error' });
  });

  it('未知 status → 当 pending（继续轮询，不误判失败）', () => {
    expect(classifyPollResponse(200, { success: true, data: { status: 'WEIRD' } })).toEqual({
      kind: 'pending',
    });
  });
});

describe('pollingMessage / paidMessage', () => {
  it('pollingMessage 带查询次数', () => {
    expect(pollingMessage(3)).toBe('正在确认支付结果…（已查询 3 次，通常几秒内到账）');
  });

  it('paidMessage 带积分', () => {
    expect(paidMessage(10)).toBe('充值成功！+10 积分，即将返回…');
  });

  it('paidMessage 无积分 → 兜底文案', () => {
    expect(paidMessage(undefined)).toBe('充值成功！即将返回…');
    expect(paidMessage(0)).toBe('充值成功！即将返回…');
  });
});
