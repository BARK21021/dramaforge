// ============================================================
// payment/client — AlipaySdk 封装（隔离 alipay-sdk 版本差异）
// ============================================================
// 移植自 app1 src/core/payment/client.ts；唯一差异：env import 从
// @core/config/env → @server/infra/env（getEnv → env）。
//
// 仅本文件 import alipay-sdk；service.ts 依赖 AlipayClient 接口（单测 mock 它）。
// 适配 alipay-sdk@4：AlipaySdk 为 NAMED 导出（无 default）；pageExec(method,
// httpMethod, bizParams) 同步返回签名 URL（GET）；exec 调服务端 OpenAPI；
// checkNotifySign 异步通知验签。公钥模式仅需 appId/privateKey/alipayPublicKey/
// signType/gateway（无证书路径）。
// ============================================================

import { AlipaySdk } from 'alipay-sdk';
import { env } from '@server/infra/env';

/** page.pay 下单结果 */
export interface CreatePaymentResult {
  payUrl: string;
}

/** trade.query 返回的归一化状态 */
export interface QueryTradeResult {
  tradeStatus:
    | 'WAIT_BUYER_PAY'
    | 'TRADE_CLOSED'
    | 'TRADE_SUCCESS'
    | 'TRADE_FINISHED'
    | null;
  tradeNo: string | null;
}

/** 支付宝客户端抽象（service 依赖此接口；单测 mock 它） */
export interface AlipayClient {
  /** alipay.trade.page.pay → 跳转收银台的签名 URL */
  createPaymentUrl(params: {
    outTradeNo: string;
    totalAmount: string; // 元，字符串，两位小数
    subject: string;
    returnUrl?: string;
    notifyUrl?: string;
  }): Promise<CreatePaymentResult>;
  /** alipay.trade.query → 查订单状态 */
  queryTrade(outTradeNo: string): Promise<QueryTradeResult>;
  /** alipay.trade.close → 关单 */
  closeTrade(outTradeNo: string): Promise<void>;
  /** 异步通知验签（alipay-sdk checkNotifySign） */
  verifyNotify(postData: Record<string, unknown>): boolean;
}

let _client: AlipayClient | null = null;

/** 获取全局支付宝客户端单例 */
export function getAlipayClient(): AlipayClient {
  if (!_client) _client = createAlipayClient();
  return _client;
}

/** 测试注入：传 null 清除缓存 */
export function setAlipayClient(client: AlipayClient | null): void {
  _client = client;
}

function createAlipayClient(): AlipayClient {
  const e = env();
  // 公钥模式：仅需 app 私钥 + 支付宝公钥（非证书模式）。
  // 三项密钥缺失时也允许构造（实际调用由 createOrder 的 config-guard 先拦）；
  // gateway 缺省回退生产网关（沙箱场景必须显式配 ALIPAY_GATEWAY）。
  const sdk = new AlipaySdk({
    appId: e.ALIPAY_APP_ID ?? '',
    privateKey: e.ALIPAY_APP_PRIVATE_KEY ?? '',
    alipayPublicKey: e.ALIPAY_PUBLIC_KEY ?? '',
    signType: 'RSA2',
    gateway: e.ALIPAY_GATEWAY ?? 'https://openapi.alipay.com/gateway.do',
  });

  return {
    async createPaymentUrl({ outTradeNo, totalAmount, subject, returnUrl, notifyUrl }) {
      // pageExec 3-arg 形式：GET 同步返回可直接跳转的签名网关 URL。
      // 注意：alipay-sdk v4 的 sign 会对 params 内所有键 toString()，
      // 传 undefined/null 会抛 TypeError，故仅当 returnUrl/notifyUrl 非空才写入。
      const params: Record<string, unknown> = {
        bizContent: {
          out_trade_no: outTradeNo,
          total_amount: totalAmount,
          subject,
          product_code: 'FAST_INSTANT_TRADE_PAY',
        },
      };
      if (returnUrl) params.returnUrl = returnUrl;
      if (notifyUrl) params.notifyUrl = notifyUrl;
      const url = sdk.pageExec('alipay.trade.page.pay', 'GET', params);
      return { payUrl: url };
    },

    async queryTrade(outTradeNo) {
      // exec 返回 AlipaySdkCommonResult（camelcase 默认 true）。同时读驼峰/下划线
      // 两种 key 兼容 camelcase 选项差异。
      const res = (await sdk.exec('alipay.trade.query', {
        bizContent: { out_trade_no: outTradeNo },
      })) as Record<string, unknown>;
      const tradeStatus = (res.tradeStatus ?? res.trade_status ?? null) as QueryTradeResult['tradeStatus'];
      const tradeNo = (res.tradeNo ?? res.trade_no ?? null) as string | null;
      return { tradeStatus, tradeNo };
    },

    async closeTrade(outTradeNo) {
      await sdk.exec('alipay.trade.close', {
        bizContent: { out_trade_no: outTradeNo },
      });
    },

    verifyNotify(postData) {
      return sdk.checkNotifySign(postData);
    },
  };
}
