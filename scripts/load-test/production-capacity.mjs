import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.LOAD_BASE_URL || 'https://your-domain.example.com').replace(/\/$/, '');
const login = process.env.LOAD_LOGIN;
const password = process.env.LOAD_PASSWORD;
const resultPath = process.env.LOAD_RESULT_PATH || 'production-capacity-result.json';
const stageSpec = process.env.LOAD_STAGES || '1:20,5:25,10:25,20:30,35:30,50:30,75:30,100:30,150:30';
const thinkMinMs = Number(process.env.LOAD_THINK_MIN_MS || 550);
const thinkMaxMs = Number(process.env.LOAD_THINK_MAX_MS || 950);
const requestTimeoutMs = Number(process.env.LOAD_REQUEST_TIMEOUT_MS || 8000);
const userAgent = 'DramaForge-CapacityTest/1.1.6 Electron/43.0.0';

if (!login || !password) throw new Error('LOAD_LOGIN and LOAD_PASSWORD are required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function mergeCookies(target, headers) {
  for (const value of cookieValues(headers)) {
    const pair = value.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0) target.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

const cookieHeader = (cookies) => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

async function authenticate() {
  const cookies = new Map();
  const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`, {
    headers: { 'User-Agent': userAgent },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!csrfResponse.ok) throw new Error(`CSRF HTTP ${csrfResponse.status}`);
  mergeCookies(cookies, csrfResponse.headers);
  const csrf = await csrfResponse.json();
  const form = new URLSearchParams({
    csrfToken: csrf.csrfToken,
    login,
    password,
    callbackUrl: baseUrl,
    json: 'true',
  });
  const response = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
      Cookie: cookieHeader(cookies),
    },
    body: form,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status >= 400) throw new Error(`login HTTP ${response.status}`);
  mergeCookies(cookies, response.headers);
  const session = [...cookies].find(([name]) => name.endsWith('next-auth.session-token'));
  if (!session) throw new Error('login did not issue a session cookie');
  return `${session[0]}=${session[1]}`;
}

const endpoints = [
  ['/api/projects', 30],
  ['/api/tasks?status=ACTIVE', 25],
  ['/api/user/balance', 15],
  ['/api/films', 10],
  ['/api/health', 10],
  ['/api/client/update?version=1.1.6&os=win', 10],
];
const totalWeight = endpoints.reduce((sum, [, weight]) => sum + weight, 0);

function pickEndpoint() {
  let cursor = Math.random() * totalWeight;
  for (const [path, weight] of endpoints) {
    cursor -= weight;
    if (cursor <= 0) return path;
  }
  return endpoints.at(-1)[0];
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarise(samples, elapsedSeconds) {
  const latencies = samples.map((sample) => sample.ms);
  const failures = samples.filter((sample) => !sample.ok);
  const serverErrors = samples.filter((sample) => sample.status >= 500 || sample.status === 0);
  const timeouts = samples.filter((sample) => sample.error === 'TimeoutError');
  const byEndpoint = {};
  for (const sample of samples) {
    const row = byEndpoint[sample.path] ||= { requests: 0, failures: 0, latencies: [] };
    row.requests += 1;
    row.failures += sample.ok ? 0 : 1;
    row.latencies.push(sample.ms);
  }
  for (const row of Object.values(byEndpoint)) {
    row.p95Ms = Math.round(percentile(row.latencies, 95));
    delete row.latencies;
  }
  return {
    requests: samples.length,
    rps: Number((samples.length / Math.max(elapsedSeconds, 0.001)).toFixed(2)),
    failures: failures.length,
    failureRate: Number((failures.length / Math.max(samples.length, 1)).toFixed(4)),
    serverErrors: serverErrors.length,
    timeouts: timeouts.length,
    bytes: samples.reduce((sum, sample) => sum + sample.bytes, 0),
    p50Ms: Math.round(percentile(latencies, 50)),
    p95Ms: Math.round(percentile(latencies, 95)),
    p99Ms: Math.round(percentile(latencies, 99)),
    maxMs: Math.round(Math.max(0, ...latencies)),
    byEndpoint,
  };
}

async function oneRequest(path, authCookie) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { 'User-Agent': userAgent, Cookie: authCookie, Accept: 'application/json' },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = await response.arrayBuffer();
    return {
      path,
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      ms: performance.now() - started,
      bytes: body.byteLength,
    };
  } catch (error) {
    return {
      path,
      status: 0,
      ok: false,
      ms: performance.now() - started,
      bytes: 0,
      error: error?.name || 'Error',
    };
  }
}

async function runStage(vus, seconds, authCookie) {
  const samples = [];
  let stopped = false;
  let stopReason = null;
  let consecutiveLatencyBreaches = 0;
  const started = performance.now();
  const deadline = started + seconds * 1000;

  const workers = Array.from({ length: vus }, async () => {
    while (!stopped && performance.now() < deadline) {
      samples.push(await oneRequest(pickEndpoint(), authCookie));
      const think = thinkMinMs + Math.random() * Math.max(0, thinkMaxMs - thinkMinMs);
      await sleep(think);
    }
  });

  const watchdog = (async () => {
    let offset = 0;
    while (!stopped && performance.now() < deadline) {
      await sleep(5000);
      const window = samples.slice(offset);
      offset = samples.length;
      if (window.length < 10) continue;
      const summary = summarise(window, 5);
      const healthFailed = window.some((sample) => sample.path === '/api/health' && !sample.ok);
      if (healthFailed) stopReason = 'health endpoint failed';
      else if (summary.failureRate >= 0.02) stopReason = `5s failure rate ${(summary.failureRate * 100).toFixed(2)}%`;
      else if (summary.p99Ms >= requestTimeoutMs) stopReason = `5s p99 reached timeout (${summary.p99Ms}ms)`;
      else {
        consecutiveLatencyBreaches = summary.p95Ms >= 2500 ? consecutiveLatencyBreaches + 1 : 0;
        if (consecutiveLatencyBreaches >= 2) stopReason = `p95 >= 2500ms for two windows`;
      }
      if (stopReason) stopped = true;
    }
  })();

  await Promise.all(workers);
  stopped = true;
  await watchdog;
  const elapsedSeconds = (performance.now() - started) / 1000;
  return { vus, requestedSeconds: seconds, elapsedSeconds: Number(elapsedSeconds.toFixed(2)), stopReason, ...summarise(samples, elapsedSeconds) };
}

async function runSseProbe(authCookie, connections = 100, holdSeconds = 20) {
  const controllers = [];
  const readers = [];
  const opened = [];
  const started = performance.now();
  const firstEventTimeoutMs = Number(process.env.LOAD_SSE_FIRST_EVENT_TIMEOUT_MS || 5000);
  await Promise.all(Array.from({ length: connections }, async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const t0 = performance.now();
    try {
      const response = await fetch(`${baseUrl}/api/sse`, {
        headers: { 'User-Agent': userAgent, Cookie: authCookie, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok) {
        opened.push({ ok: false, status: response.status, ms: performance.now() - t0 });
        return;
      }
      const reader = response.body.getReader();
      readers.push(reader);
      const first = await Promise.race([
        reader.read().then((result) => ({ received: !result.done })),
        sleep(firstEventTimeoutMs).then(() => ({ received: false })),
      ]);
      opened.push({
        ok: true,
        firstEventReceived: first.received,
        status: response.status,
        ms: performance.now() - t0,
      });
    } catch (error) {
      if (error?.name !== 'AbortError') opened.push({ ok: false, status: 0, ms: performance.now() - t0, error: error?.name });
    }
  }));
  await sleep(holdSeconds * 1000);
  controllers.forEach((controller) => controller.abort());
  await Promise.allSettled(readers.map((reader) => reader.cancel()));
  await sleep(500);
  const successful = opened.filter((entry) => entry.ok);
  return {
    requestedConnections: connections,
    successfulConnections: successful.length,
    failures: opened.length - successful.length,
    firstEventReceived: successful.filter((entry) => entry.firstEventReceived).length,
    firstEventTimeoutMs,
    openP95Ms: Math.round(percentile(successful.map((entry) => entry.ms), 95)),
    holdSeconds,
    elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
  };
}

const authCookie = await authenticate();
const sessionCheck = await oneRequest('/api/projects', authCookie);
if (!sessionCheck.ok) throw new Error(`authenticated session check failed: HTTP ${sessionCheck.status}`);

const result = {
  startedAt: new Date().toISOString(),
  baseUrl,
  configuration: { stageSpec, thinkMinMs, thinkMaxMs, requestTimeoutMs },
  stages: [],
};

for (const rawStage of stageSpec.split(',')) {
  const [vusRaw, secondsRaw] = rawStage.split(':');
  const stage = await runStage(Number(vusRaw), Number(secondsRaw), authCookie);
  result.stages.push(stage);
  process.stdout.write(`${JSON.stringify({ event: 'stage', ...stage })}\n`);
  if (stage.stopReason || stage.failureRate >= 0.01 || stage.p95Ms >= 2000) {
    result.capacityStopReason = stage.stopReason || 'stage acceptance threshold exceeded';
    break;
  }
  await sleep(3000);
}

result.sse = await runSseProbe(authCookie, Number(process.env.LOAD_SSE_CONNECTIONS || 100), Number(process.env.LOAD_SSE_HOLD_SECONDS || 20));
result.finishedAt = new Date().toISOString();
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ event: 'complete', resultPath, sse: result.sse })}\n`);
