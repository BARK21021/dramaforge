import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startHeartbeat, fetchHeartbeatOnce } from './heartbeat';
import * as lockout from './lockout';
import type { HeartbeatResponse } from '@dramaforge/shared';

const okResp: HeartbeatResponse = {
  status: 'ok',
  minVersion: '1.0.0',
  latestVersion: '1.0.0',
  downloadUrl: '',
  signature: '',
  sha256: '',
};

const forceResp: HeartbeatResponse = {
  status: 'force_upgrade',
  minVersion: '1.5.0',
  latestVersion: '1.5.0',
  downloadUrl: 'https://example.com/dl/dramaforge-1.5.0.exe',
  signature: '',
  sha256: '',
};

function makeResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('startHeartbeat', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    lockout.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('POSTs to /api/client/heartbeat at the default 30s interval (1 call after 30s)', async () => {
    // mockImplementation returns a fresh Response per call (Response bodies are
    // single-use, so mockResolvedValue would break on the 2nd tick's res.json()).
    fetchMock.mockImplementation(async () => makeResponse(okResp));
    const handle = startHeartbeat({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
      onForceUpgrade: () => {},
    });

    // No immediate fire.
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/client/heartbeat',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"version":"1.0.0"'),
      }),
    );

    handle.stop();
  });

  it('sends a HeartbeatRequest body with version, os:"win", machineId', async () => {
    fetchMock.mockImplementation(async () => makeResponse(okResp));
    const handle = startHeartbeat({
      version: '2.3.4',
      machineId: 'machine-42',
      apiBase: 'https://api.example.com',
      onForceUpgrade: () => {},
    });

    await vi.advanceTimersByTimeAsync(30_000);

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body).toEqual({ version: '2.3.4', os: 'win', machineId: 'machine-42' });

    handle.stop();
  });

  it('calls onForceUpgrade and activates lockout on a force_upgrade response', async () => {
    fetchMock.mockImplementation(async () => makeResponse(forceResp));
    const onForce = vi.fn();
    const handle = startHeartbeat({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
      onForceUpgrade: onForce,
    });

    expect(lockout.isActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(onForce).toHaveBeenCalledTimes(1);
    expect(onForce).toHaveBeenCalledWith(forceResp);
    expect(lockout.isActive()).toBe(true);
    expect(lockout.getLockReason()).toBe('force_upgrade');

    handle.stop();
  });

  it('stop() cancels further fetches', async () => {
    fetchMock.mockImplementation(async () => makeResponse(okResp));
    const handle = startHeartbeat({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
      onForceUpgrade: () => {},
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    handle.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not crash when fetch rejects (resilient) and keeps heartbeating', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const onForce = vi.fn();
    const handle = startHeartbeat({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
      onForceUpgrade: onForce,
    });

    // First tick — fetch rejects, but tick swallows it (no throw).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onForce).not.toHaveBeenCalled();
    expect(lockout.isActive()).toBe(false);

    // Heartbeat continues on the next interval despite the prior failure.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('respects a custom intervalMs', async () => {
    fetchMock.mockImplementation(async () => makeResponse(okResp));
    const handle = startHeartbeat({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
      intervalMs: 5_000,
      onForceUpgrade: () => {},
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('does not fire before the first interval elapses', async () => {
    fetchMock.mockImplementation(async () => makeResponse(okResp));
    const handle = startHeartbeat({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
      intervalMs: 30_000,
      onForceUpgrade: () => {},
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('times out a stalled response body and never overlaps heartbeat requests', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: () => new Promise<HeartbeatResponse>(() => undefined),
    }));
    const handle = startHeartbeat({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
      intervalMs: 10,
      requestTimeoutMs: 25,
      onForceUpgrade: () => {},
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The first request times out at t=35; the t=40 cadence may start request 2.
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('stop aborts the active request and suppresses late callbacks', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const onForce = vi.fn();
    const handle = startHeartbeat({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
      intervalMs: 10,
      requestTimeoutMs: 100,
      onForceUpgrade: onForce,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(false);
    handle.stop();

    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onForce).not.toHaveBeenCalled();
  });
});

describe('fetchHeartbeatOnce', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('单发成功返回 HeartbeatResponse（含 renderJobSlots 透传）', async () => {
    const resp: HeartbeatResponse = {
      status: 'ok',
      minVersion: '1.0.0',
      latestVersion: '1.0.0',
      downloadUrl: '',
      signature: '',
      sha256: '',
      renderJobSlots: 5,
    };
    fetchMock.mockImplementation(async () => makeResponse(resp));

    const result = await fetchHeartbeatOnce({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
    });

    expect(result).toEqual(resp);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/client/heartbeat',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('非 ok 响应返回 null（不抛错）', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 500 }));

    const result = await fetchHeartbeatOnce({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
    });

    expect(result).toBeNull();
  });

  it('网络错误返回 null（不抛错）', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await fetchHeartbeatOnce({
      version: '1.0.0',
      machineId: 'm1',
      apiBase: 'https://api.example.com',
    });

    expect(result).toBeNull();
  });
});
