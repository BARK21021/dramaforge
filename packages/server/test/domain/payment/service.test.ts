// ============================================================
// payment/service — 单测（穿透 repo 的真实 SQL，验状态机 + 幂等语义）
// ============================================================
//
// 移植自 app1 service.test.ts；差异：
//   - mock @server/infra 的 query（stateful，模拟 payment_orders 表 + 原子 claimPaid）
//     而非 app1 的 prisma.paymentOrder；保留"穿透真实 SQL 验幂等"的核心价值。
//   - mock ../billing 的 creditPurchase（记录调用，隔离 billing 内部）。
//   - mock @server/infra/env（rules + service assertAlipayConfigured + client）。
//
// 幂等核心：stateful query 的 claimPaid 分支仅当 status='PENDING' 才 RETURNING 行，
// 第一次调用把 status 改 PAID 后，第二次/并发调用找不到 PENDING 行 → 返回空 →
// service 跳过 creditPurchase。与真实 DB 的 `UPDATE WHERE status='PENDING'` 语义一致。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from '../../../src/infra/pg';
import type { AlipayClient, QueryTradeResult } from '../../../src/domain/payment/client';

// ============================================================
// 可变测试状态（vi.hoisted 保证 vi.mock 工厂能引用）
// ============================================================
const state = vi.hoisted(() => ({
  // payment_orders 内存表（snake_case 行，对齐 repo.PaymentOrderRow）
  rows: [] as Array<Record<string, unknown>>,
  // billing creditPurchase 记录
  creditCalls: [] as Array<{ userId: string; credits: number; orderId: string }>,
  balances: {} as Record<string, number>,
  // env 配置（个别用例改写以测 config guard）
  env: {
    ALIPAY_APP_ID: 'test-app-id',
    ALIPAY_APP_PRIVATE_KEY: 'test-private-key',
    ALIPAY_PUBLIC_KEY: 'test-public-key',
    ALIPAY_GATEWAY: 'https://openapi.alipay.com/gateway.do',
    ALIPAY_RETURN_URL: 'http://localhost:3000/payment/return',
    ALIPAY_NOTIFY_URL: undefined as string | undefined,
    PAYMENT_ORDER_MIN_YUAN: '1',
    PAYMENT_ORDER_MAX_YUAN: '10000',
  } as Record<string, unknown>,
}));

// mock @server/infra（query；repo 用 query 读写 payment_orders）
vi.mock('@server/infra', () => ({
  query: vi.fn(),
}));

// mock @shared/utils（genId → outTradeNo + 订单 id）
vi.mock('@shared/utils', () => ({
  genId: vi.fn(() => 'gen-' + Math.random().toString(36).slice(2, 10)),
}));

// mock @server/infra/env（rules + service + client 共用）
vi.mock('@server/infra/env', () => ({
  env: () => state.env,
}));

// mock ../billing（creditPurchase 记录调用 + 余额；隔离 billing 内部）
vi.mock('../../../src/domain/billing', () => ({
  creditPurchase: vi.fn(async (userId: string, credits: number, orderId: string) => {
    state.creditCalls.push({ userId, credits, orderId });
    state.balances[userId] = (state.balances[userId] ?? 0) + credits;
    return { id: `ledger-${state.creditCalls.length}`, userId, orderId };
  }),
}));

// 被测（vi.mock 自动提升，此处已生效）
import { PaymentService, PaymentError } from '../../../src/domain/payment/service';
import { query } from '@server/infra';

// ============================================================
// stateful mock：模拟 payment_orders 表的所有 SQL
// ============================================================
function setupStatefulRepo(): void {
  async function execQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    // INSERT INTO payment_orders (...) RETURNING *
    if (sql.startsWith('INSERT INTO payment_orders')) {
      const [id, outTradeNo, userId, amountYuan, credits] = params as [
        string,
        string,
        string,
        number,
        number,
      ];
      const row: Record<string, unknown> = {
        id,
        out_trade_no: outTradeNo,
        user_id: userId,
        amount_yuan: amountYuan,
        credits,
        status: 'PENDING',
        trade_no: null,
        pay_url: null,
        paid_at: null,
        credited_at: null,
        ledger_id: null,
        metadata: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      state.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    // SELECT * FROM payment_orders WHERE id = $1
    if (sql.startsWith('SELECT * FROM payment_orders WHERE id =')) {
      const r = state.rows.find((r) => r.id === params![0]);
      return { rows: r ? [{ ...r }] : [], rowCount: r ? 1 : 0 };
    }
    // SELECT * FROM payment_orders WHERE out_trade_no = $1
    if (sql.startsWith('SELECT * FROM payment_orders WHERE out_trade_no')) {
      const r = state.rows.find((r) => r.out_trade_no === params![0]);
      return { rows: r ? [{ ...r }] : [], rowCount: r ? 1 : 0 };
    }
    // claimPaid：UPDATE ... SET status='PAID' ... WHERE id=$2 AND status='PENDING' RETURNING *
    if (sql.startsWith("UPDATE payment_orders\n       SET status = 'PAID'")) {
      const [tradeNo, id] = params as [string | null, string];
      const r = state.rows.find((r) => r.id === id && r.status === 'PENDING');
      if (!r) return { rows: [], rowCount: 0 };
      r.status = 'PAID';
      r.trade_no = tradeNo;
      r.paid_at = new Date();
      r.updated_at = new Date();
      return { rows: [{ ...r }], rowCount: 1 };
    }
    // updatePayUrl：UPDATE ... SET pay_url = $1 ... WHERE id = $2
    if (sql.startsWith('UPDATE payment_orders SET pay_url')) {
      const r = state.rows.find((r) => r.id === params![1]);
      if (r) r.pay_url = params![0];
      return { rows: [], rowCount: 1 };
    }
    // markClosed：UPDATE ... SET status = 'CLOSED' ... WHERE id = $1
    if (sql.startsWith("UPDATE payment_orders SET status = 'CLOSED'")) {
      const r = state.rows.find((r) => r.id === params![0]);
      if (r) r.status = 'CLOSED';
      return { rows: [], rowCount: 1 };
    }
    // updateAfterCredit：UPDATE ... SET ledger_id = $1 ... WHERE id = $2
    if (sql.startsWith('UPDATE payment_orders SET ledger_id')) {
      const r = state.rows.find((r) => r.id === params![1]);
      if (r) {
        r.ledger_id = params![0];
        r.credited_at = new Date();
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  vi.mocked(query).mockImplementation(execQuery);
}

// ============================================================
// fake AlipayClient
// ============================================================
function fakeClient(overrides: Partial<AlipayClient> = {}): AlipayClient {
  return {
    createPaymentUrl: async () => ({ payUrl: 'https://openapi.alipay.com/FAKE' }),
    queryTrade: async () =>
      ({ tradeStatus: 'TRADE_SUCCESS', tradeNo: '2026-trade-1' }) as QueryTradeResult,
    closeTrade: async () => {},
    verifyNotify: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  state.rows.length = 0;
  state.creditCalls.length = 0;
  state.balances = {};
  state.env.ALIPAY_APP_ID = 'test-app-id';
  state.env.ALIPAY_APP_PRIVATE_KEY = 'test-private-key';
  state.env.ALIPAY_PUBLIC_KEY = 'test-public-key';
  setupStatefulRepo();
});

// ============================================================
// createOrder
// ============================================================
describe('PaymentService.createOrder', () => {
  it('校验通过 → 建 PENDING 单 + 返回 payUrl + 积分换算（1 元 = 10 积分）', async () => {
    const service = new PaymentService(fakeClient());
    const { order, payUrl } = await service.createOrder({ userId: 'u1', amountYuan: 100 });
    expect(order.status).toBe('PENDING');
    expect(order.credits).toBe(1000);
    expect(order.userId).toBe('u1');
    expect(order.outTradeNo).toBeTruthy();
    expect(payUrl).toContain('FAKE');
  });

  it('金额低于下限 → 抛 PaymentError(400)，未建单未发积分', async () => {
    const service = new PaymentService(fakeClient());
    await expect(service.createOrder({ userId: 'u1', amountYuan: 0.5 })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(state.rows).toHaveLength(0);
    expect(state.creditCalls).toHaveLength(0);
  });

  it('支付宝密钥缺失 → 抛 PaymentError(500)（config 守卫），未建单未发积分', async () => {
    state.env.ALIPAY_APP_PRIVATE_KEY = '';
    const service = new PaymentService(fakeClient());
    await expect(service.createOrder({ userId: 'u1', amountYuan: 10 })).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(state.rows).toHaveLength(0);
    expect(state.creditCalls).toHaveLength(0);
  });

  it('PaymentError 携带正确 name 与 message', () => {
    const e = new PaymentError('boom', 400);
    expect(e.name).toBe('PaymentError');
    expect(e.message).toBe('boom');
    expect(e.statusCode).toBe(400);
  });
});

// ============================================================
// syncOrderStatus 幂等到账
// ============================================================
describe('PaymentService.syncOrderStatus 幂等到账', () => {
  it('PENDING + TRADE_SUCCESS → 置 PAID + 发积分一次', async () => {
    const service = new PaymentService(fakeClient());
    const { order } = await service.createOrder({ userId: 'u1', amountYuan: 10 });
    const r = await service.syncOrderStatus(order.id);
    expect(r.status).toBe('PAID');
    expect(r.credits).toBe(100);
    expect(state.creditCalls).toHaveLength(1);
    expect(state.balances['u1']).toBe(100);
  });

  it('并发两次 syncOrderStatus → 积分只发一次（幂等核心）', async () => {
    const service = new PaymentService(fakeClient());
    const { order } = await service.createOrder({ userId: 'u1', amountYuan: 10 });
    await Promise.all([
      service.syncOrderStatus(order.id),
      service.syncOrderStatus(order.id),
    ]);
    expect(state.creditCalls).toHaveLength(1);
    expect(state.balances['u1']).toBe(100);
  });

  it('顺序再查已 PAID 的单 → 不重复发积分（幂等）', async () => {
    const service = new PaymentService(fakeClient());
    const { order } = await service.createOrder({ userId: 'u1', amountYuan: 10 });
    await service.syncOrderStatus(order.id);
    const r2 = await service.syncOrderStatus(order.id);
    const r3 = await service.syncOrderStatus(order.id);
    expect(r2.status).toBe('PAID');
    expect(r3.status).toBe('PAID');
    expect(state.creditCalls).toHaveLength(1);
    expect(state.balances['u1']).toBe(100);
  });

  it('TRADE_CLOSED → 置 CLOSED，不发积分', async () => {
    const service = new PaymentService(
      fakeClient({
        queryTrade: async () =>
          ({ tradeStatus: 'TRADE_CLOSED', tradeNo: null }) as QueryTradeResult,
      }),
    );
    const { order } = await service.createOrder({ userId: 'u1', amountYuan: 10 });
    const r = await service.syncOrderStatus(order.id);
    expect(r.status).toBe('CLOSED');
    expect(state.creditCalls).toHaveLength(0);
    expect(state.balances['u1'] ?? 0).toBe(0);
  });

  it('订单不存在 → 抛 PaymentError(404)', async () => {
    const service = new PaymentService(fakeClient());
    await expect(service.syncOrderStatus('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ============================================================
// handleNotify（异步回调）
// ============================================================
describe('PaymentService.handleNotify', () => {
  it('验签通过 + TRADE_SUCCESS → 幂等到账，返回 true', async () => {
    const service = new PaymentService(fakeClient());
    const { order } = await service.createOrder({ userId: 'u1', amountYuan: 5 });
    const ok = await service.handleNotify({
      out_trade_no: order.outTradeNo,
      trade_status: 'TRADE_SUCCESS',
      trade_no: 't-9',
    });
    expect(ok).toBe(true);
    expect(state.creditCalls).toHaveLength(1);
    expect(state.balances['u1']).toBe(50);
  });

  it('验签失败 → 返回 false，不发积分', async () => {
    const service = new PaymentService(fakeClient({ verifyNotify: () => false }));
    const { order } = await service.createOrder({ userId: 'u1', amountYuan: 5 });
    const ok = await service.handleNotify({
      out_trade_no: order.outTradeNo,
      trade_status: 'TRADE_SUCCESS',
    });
    expect(ok).toBe(false);
    expect(state.creditCalls).toHaveLength(0);
  });

  it('notify 对同一单重复到达 → 积分只发一次（幂等）', async () => {
    const service = new PaymentService(fakeClient());
    const { order } = await service.createOrder({ userId: 'u1', amountYuan: 5 });
    const params = {
      out_trade_no: order.outTradeNo,
      trade_status: 'TRADE_SUCCESS',
      trade_no: 't-9',
    };
    const [a, b] = await Promise.all([
      service.handleNotify(params),
      service.handleNotify(params),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(state.creditCalls).toHaveLength(1);
    expect(state.balances['u1']).toBe(50);
  });

  it('trade_status 非 SUCCESS/FINISHED → 不发积分，返回 true', async () => {
    const service = new PaymentService(fakeClient());
    const { order } = await service.createOrder({ userId: 'u1', amountYuan: 5 });
    const ok = await service.handleNotify({
      out_trade_no: order.outTradeNo,
      trade_status: 'WAIT_BUYER_PAY',
    });
    expect(ok).toBe(true);
    expect(state.creditCalls).toHaveLength(0);
  });
});
