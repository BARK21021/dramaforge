// ============================================================
// GET /api/payment/orders/[id]/status — 路由回归测试（P6.2）
// ============================================================
// 防的是这次线上 bug:回跳页轮询带的是支付宝 out_trade_no(createOrder 时单独
// genId,与行 id 是两个不同 UUID),而 /status 原先 findById(按主键 id 查)→ 永远
// 404 → 页死转到超时。修复后:先 findByOutTradeNo、回退 findById,再用真实
// order.id 喂 syncOrderStatus。本测试锁死该解析顺序与 id 透传。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/payment/orders/[id]/status/route';
import { DEFAULT_SESSION, getServerSessionMock, serverMock } from './mocks';
import { makeParamsCtx, makeRequest } from './helpers';

describe('GET /api/payment/orders/[id]/status', () => {
  const syncOrderStatus = vi.fn();

  beforeEach(() => {
    getServerSessionMock.mockReset();
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.paymentOrderRepo.findByOutTradeNo.mockReset();
    serverMock.paymentOrderRepo.findById.mockReset();
    syncOrderStatus.mockReset();
    serverMock.getPaymentService.mockReturnValue({ syncOrderStatus });
  });

  it('未登录 → 401 且不查单', async () => {
    getServerSessionMock.mockResolvedValue(null);

    const res = await GET(
      makeRequest({ url: 'http://localhost/api/payment/orders/x/status' }),
      makeParamsCtx({ id: 'x' }),
    );

    expect(res.status).toBe(401);
    expect(serverMock.paymentOrderRepo.findByOutTradeNo).not.toHaveBeenCalled();
  });

  it('回归(P6.2):入参 out_trade_no 时按它解析,syncOrderStatus 拿真实 order.id(非 out_trade_no)', async () => {
    // 还原线上场景:URL 带 out_trade_no(otn-abc),它对应行的真实 id 是 real-id-123。
    const order = {
      id: 'real-id-123',
      userId: 'user-1',
      outTradeNo: 'otn-abc',
      status: 'PAID',
    };
    serverMock.paymentOrderRepo.findByOutTradeNo.mockResolvedValue(order);
    syncOrderStatus.mockResolvedValue({ status: 'PAID', credits: 10, amountYuan: 1 });

    const res = await GET(
      makeRequest({ url: 'http://localhost/api/payment/orders/otn-abc/status' }),
      makeParamsCtx({ id: 'otn-abc' }),
    );

    expect(res.status).toBe(200);
    expect(serverMock.paymentOrderRepo.findByOutTradeNo).toHaveBeenCalledWith('otn-abc');
    // out_trade_no 命中后不应回退 findById
    expect(serverMock.paymentOrderRepo.findById).not.toHaveBeenCalled();
    // ⚠ 核心:喂给 syncOrderStatus 的是真实行 id,绝不能是 out_trade_no
    expect(syncOrderStatus).toHaveBeenCalledWith('real-id-123');
    expect(syncOrderStatus).not.toHaveBeenCalledWith('otn-abc');
  });

  it('out_trade_no 查不到 → 回退 findById 命中', async () => {
    const order = { id: 'real-id-456', userId: 'user-1', status: 'PENDING' };
    serverMock.paymentOrderRepo.findByOutTradeNo.mockResolvedValue(null);
    serverMock.paymentOrderRepo.findById.mockResolvedValue(order);
    syncOrderStatus.mockResolvedValue({ status: 'PENDING' });

    const res = await GET(
      makeRequest({ url: 'http://localhost/api/payment/orders/real-id-456/status' }),
      makeParamsCtx({ id: 'real-id-456' }),
    );

    expect(res.status).toBe(200);
    expect(serverMock.paymentOrderRepo.findById).toHaveBeenCalledWith('real-id-456');
    expect(syncOrderStatus).toHaveBeenCalledWith('real-id-456');
  });

  it('两路都查不到 → 404 且不驱动查单', async () => {
    serverMock.paymentOrderRepo.findByOutTradeNo.mockResolvedValue(null);
    serverMock.paymentOrderRepo.findById.mockResolvedValue(null);

    const res = await GET(
      makeRequest({ url: 'http://localhost/api/payment/orders/ghost/status' }),
      makeParamsCtx({ id: 'ghost' }),
    );

    expect(res.status).toBe(404);
    expect(syncOrderStatus).not.toHaveBeenCalled();
  });

  it('订单属他人 → 同样 404(不泄漏存在性),不驱动查单', async () => {
    serverMock.paymentOrderRepo.findByOutTradeNo.mockResolvedValue({
      id: 'r',
      userId: 'user-2',
      status: 'PAID',
    });

    const res = await GET(
      makeRequest({ url: 'http://localhost/api/payment/orders/x/status' }),
      makeParamsCtx({ id: 'x' }),
    );

    expect(res.status).toBe(404);
    expect(syncOrderStatus).not.toHaveBeenCalled();
  });
});
