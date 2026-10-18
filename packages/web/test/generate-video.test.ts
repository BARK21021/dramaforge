// ============================================================
// /api/generate/video — 契约测试（UI-facing envelope，GC-4）
// ============================================================
//
// 覆盖：
//   - 200 { success:true, data:{ url, meta } } when callAI 成功
//   - callAI 收到拆分后的 provider + 完整 model 字符串
//   - payload.capability='video_generation', input=body 透传, userId 注入
//   - 502 { success:false, error, code:'AI_GATEWAY_ERROR', retryable:true } when callAI 抛 GatewayError
//   - 400 envelope when body 缺 model / model 无 provider 前缀
//   - 401 envelope { code:'UNAUTHORIZED' } when 未登录
//
// mock：@dramaforge/server.callAI + GatewayError + getServerSession
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from './mocks';
import { makeRequest, readJson } from './helpers';
import { POST } from '../app/api/generate/video/route';

describe('POST /api/generate/video', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.callAI.mockReset();
    serverMock.chargeAggregatedTaskCost.mockReset();
  });

  it('returns 200 envelope { success:true, data:{ url, meta } } and splits provider/model', async () => {
    serverMock.callAI.mockResolvedValue({
      url: 'https://minio/out.mp4',
      meta: { duration: 5, width: 1080 },
    });
    const req = makeRequest({
      method: 'POST',
      body: {
        model: 'ark/doubao-seedance-2-0',
        prompt: 'a cat playing',
        duration: 5,
        aspectRatio: '16:9',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { url: string; meta: { duration: number } };
    };
    expect(body.success).toBe(true);
    expect(body.data.url).toBe('https://minio/out.mp4');
    expect(body.data.meta.duration).toBe(5);
    expect(serverMock.callAI).toHaveBeenCalledWith(
      'ark',
      'ark/doubao-seedance-2-0',
      expect.objectContaining({
        capability: 'video_generation',
        input: expect.objectContaining({ prompt: 'a cat playing' }),
        userId: 'user-1',
      }),
    );
  });

  it('forwards referenceImageBase64 verbatim in input', async () => {
    serverMock.callAI.mockResolvedValue({ url: 'https://up', meta: {} });
    const req = makeRequest({
      method: 'POST',
      body: {
        model: 'fal/kling-v1',
        prompt: 'p',
        referenceImageBase64: 'data:image/png;base64,iVBOR...',
      },
    });
    await POST(req);
    const payload = serverMock.callAI.mock.calls[0][2] as { input: { referenceImageBase64: string } };
    expect(payload.input.referenceImageBase64).toBe('data:image/png;base64,iVBOR...');
  });

  it('uses task-level aggregate billing fields without forwarding them to ARK', async () => {
    serverMock.callAI.mockResolvedValue({ url: 'https://up', cost: 0.04, meta: {} });
    const req = makeRequest({
      method: 'POST',
      body: {
        model: 'ark/doubao-seedance-2-0-mini-260615',
        prompt: 'p',
        billingTaskId: 'render-1',
        billingUnitId: '2',
      },
    });

    await POST(req);

    const payload = serverMock.callAI.mock.calls[0][2] as { input: Record<string, unknown> };
    expect(payload.input.billingTaskId).toBeUndefined();
    expect(payload.input.billingUnitId).toBeUndefined();
    expect(serverMock.chargeAggregatedTaskCost).toHaveBeenCalledWith(
      'user-1', 'render-1', '2', 0.04, '镜头视频生成',
    );
  });

  it('coalesces concurrent retries for the same task unit into one provider call', async () => {
    let finish!: (value: { url: string; cost: number; meta: object }) => void;
    const providerResult = new Promise<{ url: string; cost: number; meta: object }>((resolve) => {
      finish = resolve;
    });
    serverMock.callAI.mockReturnValue(providerResult);
    const body = {
      model: 'ark/doubao-seedance-2-0',
      prompt: 'same unit',
      billingTaskId: 'render-dedup',
      billingUnitId: '0',
    };

    const first = POST(makeRequest({ method: 'POST', body }));
    const second = POST(makeRequest({ method: 'POST', body }));
    // 两个 HTTP 请求都在等待同一个供应商 Promise，不会创建第二个孤儿视频。
    await vi.waitFor(() => {
      expect(serverMock.callAI).toHaveBeenCalledTimes(1);
    });

    finish({ url: 'https://up/video.mp4', cost: 0.04, meta: {} });
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it('returns retryable rate-limit semantics for provider HTTP 429', async () => {
    const GatewayError = serverMock.GatewayError as unknown as new (
      provider: string,
      message: string,
      status?: number | null,
      retryAfter?: number | null,
    ) => Error;
    serverMock.callAI.mockRejectedValue(new GatewayError('ark', 'rate limited', 429));
    const req = makeRequest({
      method: 'POST',
      body: { model: 'ark/doubao-seedance-2-0', prompt: 'p' },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = (await readJson(res)) as {
      success: boolean;
      error: string;
      code: string;
      category?: string;
      retryable?: boolean;
    };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/rate limited/);
    expect(body.error).toMatch(/ark/);
    expect(body.code).toBe('PROVIDER_RATE_LIMIT');
    expect(body.category).toBe('provider');
    expect(body.retryable).toBe(true);
  });

  it('returns a non-retryable content-policy error for provider HTTP 400', async () => {
    const GatewayError = serverMock.GatewayError as unknown as new (
      provider: string,
      message: string,
      status?: number | null,
      retryAfter?: number | null,
    ) => Error;
    serverMock.callAI.mockRejectedValue(new GatewayError(
      'ark',
      'HTTP 400: {"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation"}}',
      400,
    ));

    const res = await POST(makeRequest({
      method: 'POST',
      body: { model: 'ark/doubao-seedance-2-0', prompt: 'p' },
    }));
    const body = (await readJson(res)) as {
      success: boolean;
      code: string;
      category?: string;
      retryable?: boolean;
    };

    // 内容安全拒绝不会因换 Key 或原样重试而恢复，必须把真实语义交给客户端。
    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.code).toBe('PROVIDER_CONTENT_REJECTED');
    expect(body.category).toBe('content_policy');
    expect(body.retryable).toBe(false);
  });

  it('maps ark pollAsync 轮询超时 to 504 non-retryable (防 chain 假死重试放大)', async () => {
    const GatewayError = serverMock.GatewayError as unknown as new (
      provider: string,
      message: string,
      status?: number | null,
      retryAfter?: number | null,
    ) => Error;
    // ark.ts:180 pollAsync 20min 总超时 → http.ts:140 抛 plain Error → callAI toGatewayError
    // 包成 GatewayError(status=null, msg='...轮询超时...')。重试只会再等 20min，必须 non-retryable。
    serverMock.callAI.mockRejectedValue(
      new GatewayError('ark', 'Seedance (ARK) 轮询超时（1200s）)'),
    );
    const res = await POST(makeRequest({
      method: 'POST',
      body: { model: 'ark/doubao-seedance-2-0', prompt: 'p' },
    }));
    const body = (await readJson(res)) as {
      success: boolean;
      code: string;
      category?: string;
      retryable?: boolean;
    };
    expect(res.status).toBe(504);
    expect(body.success).toBe(false);
    expect(body.code).toBe('AI_GATEWAY_TIMEOUT');
    expect(body.category).toBe('provider');
    expect(body.retryable).toBe(false);
  });

  it('still treats fetchJson 请求超时 as 502 retryable (不误判为轮询超时)', async () => {
    const GatewayError = serverMock.GatewayError as unknown as new (
      provider: string,
      message: string,
      status?: number | null,
      retryAfter?: number | null,
    ) => Error;
    // http.ts:81 fetchJson 瞬时网络超时用「请求超时」，是抖动，值得重试，不落入轮询超时分支。
    serverMock.callAI.mockRejectedValue(
      new GatewayError('ark', '请求超时（180s）: https://ark.cn/contents/generations/tasks'),
    );
    const res = await POST(makeRequest({
      method: 'POST',
      body: { model: 'ark/doubao-seedance-2-0', prompt: 'p' },
    }));
    const body = (await readJson(res)) as {
      success: boolean;
      code: string;
      retryable?: boolean;
    };
    expect(res.status).toBe(502);
    expect(body.code).toBe('AI_GATEWAY_ERROR');
    expect(body.retryable).toBe(true);
  });

  it('returns 400 envelope when model missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { prompt: 'p' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; error: string; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('MISSING_MODEL');
  });

  it('returns 400 envelope when model has no provider prefix', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { model: 'doubao-seedance-2-0', prompt: 'p' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('BAD_MODEL');
  });

  it('returns 401 envelope with UNAUTHORIZED code when not authenticated', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const req = makeRequest({
      method: 'POST',
      body: { model: 'ark/x', prompt: 'p' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { success: boolean; error: string; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns 402 INSUFFICIENT_BALANCE and skips callAI when user has 0 credits', async () => {
    serverMock.getBalance.mockResolvedValueOnce({
      userId: 'user-1',
      credits: 0,
      frozenCredits: 0,
      availableCredits: 0,
      unlimited: false,
    });
    const req = makeRequest({
      method: 'POST',
      body: { model: 'ark/doubao-seedance-2-0', prompt: 'p' },
    });
    const res = await POST(req);
    expect(res.status).toBe(402);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('lets ADMIN (unlimited) through the balance gate even at 0 credits', async () => {
    serverMock.getBalance.mockResolvedValueOnce({
      userId: 'user-1',
      credits: 0,
      frozenCredits: 0,
      availableCredits: 0,
      unlimited: true,
    });
    serverMock.callAI.mockResolvedValue({ url: 'https://up', meta: {} });
    const req = makeRequest({
      method: 'POST',
      body: { model: 'ark/doubao-seedance-2-0', prompt: 'p' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(serverMock.callAI).toHaveBeenCalled();
  });

  it('withholds the result (402 INSUFFICIENT_BALANCE) when the real-cost charge fails', async () => {
    // 余额 > 0 → 前置门放行；callAI 成功；但按真实成本扣费时余额不够 → billDirectGeneration
    // 重抛 BillingError(402) → handleApiError → 402，不返回 url（"不够扣就不让用"）。
    serverMock.callAI.mockResolvedValue({ url: 'https://up', cost: 0.04, meta: {} });
    const BillingError = serverMock.BillingError as new (
      message: string,
      statusCode?: number,
    ) => Error;
    serverMock.chargeCredits.mockRejectedValueOnce(
      new BillingError('积分余额不足，请充值后重试', 402),
    );
    const req = makeRequest({
      method: 'POST',
      body: { model: 'ark/doubao-seedance-2-0', prompt: 'p' },
    });
    const res = await POST(req);
    expect(res.status).toBe(402);
    const body = (await readJson(res)) as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
  });
});
