// ============================================================
// ② server/gateway — Kimi video_understanding 单测（转绘 X1）
// ============================================================
// 验证 callKimi 视频理解链：uploadVideoFile(POST /files purpose=video) +
// analyzeVideoSegmentStream(SSE chat + 连续性锚点 prompt)。mock global fetch，
// 绝不真发请求。
// ============================================================

import { Buffer } from 'node:buffer';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { callKimi } from '../../src/gateway/providers/kimi';
import { mockFetch, jsonResponse, bodyJson, header } from './_helpers';

/** 构造 SSE 流 Response：把若干 delta 拼成 data: 行；末段可带 usage（include_usage）+ [DONE] */
function sseResponse(
  deltas: string[],
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number },
): Response {
  const lines = deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}`)
    .concat(usage ? [`data: ${JSON.stringify({ choices: [], usage })}`] : [])
    .concat(['data: [DONE]']);
  return new Response(lines.join('\n\n') + '\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const videoBytes = (): Buffer => Buffer.from('fake-video-bytes');
const cred = { apiKey: 'kimi-key', baseUrl: 'https://api.moonshot.cn/v1' };

describe('callKimi video_understanding (转绘 X1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('upload(/files) → analyze(/chat SSE) → 返回拼接 content + fileId', async () => {
    const { calls } = mockFetch([
      {
        match: '/files',
        response: jsonResponse({ id: 'file-1', filename: 'seg-0.mp4', status: 'ready' }),
      },
      { match: '/chat/completions', response: sseResponse(['剧情事实', '稿…']) },
    ]);

    const r = await callKimi(
      'kimi/kimi-k2.6',
      {
        capability: 'video_understanding',
        input: {
          videoBytes: videoBytes(),
          filename: 'seg-0.mp4',
          mimeType: 'video/mp4',
          segmentIndex: 0,
          segmentCount: 3,
          startSec: 0,
          endSec: 600,
        },
      },
      cred,
    );

    expect(r.url).toBe('');
    expect(r.meta?.content).toBe('剧情事实稿…');
    expect(r.meta?.fileId).toBe('file-1');

    // 先上传后分析，顺序正确
    expect(calls[0].url).toBe('https://api.moonshot.cn/v1/files');
    expect(calls[0].init?.method).toBe('POST');
    expect(header(calls[0], 'Authorization')).toBe('Bearer kimi-key');
    expect(calls[1].url).toBe('https://api.moonshot.cn/v1/chat/completions');
  });

  it('chat body: model + stream + thinking disabled + video_url 引用 ms://fileId', async () => {
    const { calls } = mockFetch([
      { match: '/files', response: jsonResponse({ id: 'f' }) },
      { match: '/chat/completions', response: sseResponse(['x']) },
    ]);

    await callKimi(
      'kimi/kimi-k2.6',
      {
        capability: 'video_understanding',
        input: {
          videoBytes: videoBytes(),
          segmentIndex: 2,
          segmentCount: 5,
          startSec: 1200,
          endSec: 1800,
        },
      },
      cred,
    );

    const chatBody = bodyJson(calls[1]);
    expect(chatBody.model).toBe('kimi-k2.6');
    expect(chatBody.stream).toBe(true);
    expect(chatBody.thinking).toEqual({ type: 'disabled' });
    expect(chatBody.max_completion_tokens).toBe(262144);
    // 不带 include_usage 则 SSE 不返 usage → 计费漏扣（P0-3）。
    expect(chatBody.stream_options).toEqual({ include_usage: true });
    const messages = chatBody.messages as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === 'user');
    const content = userMsg?.content as Array<{
      type: string;
      video_url?: { url: string };
      text?: string;
    }>;
    const videoPart = content?.find((p) => p.type === 'video_url');
    expect(videoPart?.video_url?.url).toBe('ms://f');
  });

  it('video_understanding 需要 input.videoBytes 为 Buffer，否则抛', async () => {
    mockFetch([{ match: '/files', response: jsonResponse({ id: 'f' }) }]);

    await expect(
      callKimi(
        'kimi/kimi-k2.6',
        { capability: 'video_understanding', input: { filename: 'a.mp4' } },
        cred,
      ),
    ).rejects.toThrow(/videoBytes/);
  });

  it('上传 200 但无 file_id → 抛', async () => {
    mockFetch([{ match: '/files', response: jsonResponse({}) }]);

    await expect(
      callKimi(
        'kimi/kimi-k2.6',
        { capability: 'video_understanding', input: { videoBytes: videoBytes() } },
        cred,
      ),
    ).rejects.toThrow(/file_id/);
  });

  it('把 SSE usage 写入 meta.tokensUsed 供成本归因（P0-3）', async () => {
    mockFetch([
      { match: '/files', response: jsonResponse({ id: 'fu' }) },
      {
        match: '/chat/completions',
        response: sseResponse(['剧情…'], {
          prompt_tokens: 8_000,
          completion_tokens: 1_200,
          prompt_cache_hit_tokens: 2_000,
          prompt_cache_miss_tokens: 6_000,
        }),
      },
    ]);

    const r = await callKimi(
      'kimi/kimi-k2.6',
      {
        capability: 'video_understanding',
        input: { videoBytes: videoBytes() },
      },
      cred,
    );

    expect(r.meta?.tokensUsed).toEqual({
      input: 8_000,
      output: 1_200,
      cacheHit: 2_000,
      cacheMiss: 6_000,
    });
  });
});

describe('callKimi video_to_script (转绘 X2 单集)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('extract(角色/场景 JSON) → generate(剧本) 两步串行 → 返回 script+characters+fileId', async () => {
    let chatIdx = 0;
    const { calls } = mockFetch([
      { match: '/files', response: jsonResponse({ id: 'fv', status: 'ready' }) },
      {
        match: '/chat/completions',
        response: () => {
          chatIdx += 1;
          if (chatIdx === 1) {
            // 第 1 次 chat：extractVideoContext 返回角色/场景/时代 JSON
            return sseResponse([
              '{"characters":[{"name":"Alice","description":"主角，黑发"},{"name":"Bob","description":"配角，眼镜"}],"locations":["咖啡馆","街道"],"timePeriod":"现代"}',
            ]);
          }
          // 第 2 次 chat：generateScriptFromVideo 返回剧本
          return sseResponse(['# 场景1\n咖啡馆内。', 'Alice：你好。']);
        },
      },
    ]);

    const r = await callKimi(
      'kimi/kimi-k2.6',
      {
        capability: 'video_to_script',
        input: { videoBytes: videoBytes(), filename: 'e1.mp4', mimeType: 'video/mp4' },
      },
      cred,
    );

    expect(r.meta?.script).toBe('# 场景1\n咖啡馆内。Alice：你好。');
    expect(r.meta?.fileId).toBe('fv');
    const chars = r.meta?.characters as Array<{ name: string }>;
    expect(chars.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(r.meta?.locations).toEqual(['咖啡馆', '街道']);
    expect(r.meta?.timePeriod).toBe('现代');
    // 1 上传 + 2 chat（extract + generate）
    expect(calls.filter((c) => c.url.includes('/files')).length).toBe(1);
    expect(calls.filter((c) => c.url.includes('/chat/completions')).length).toBe(2);
  });

  it('按真实执行边界上报文件接收、角色场景提取和剧本生成阶段', async () => {
    let chatIdx = 0;
    mockFetch([
      { match: '/files', response: jsonResponse({ id: 'progress-file', status: 'ready' }) },
      {
        match: '/chat/completions',
        response: () => (++chatIdx === 1
          ? sseResponse(['{"characters":[],"locations":[]}'])
          : sseResponse(['阶段剧本'])),
      },
    ]);
    const stages: string[] = [];

    await callKimi(
      'kimi/kimi-k2.6',
      {
        capability: 'video_to_script',
        input: {
          videoBytes: videoBytes(),
          filename: 'episode.mp4',
          mimeType: 'video/mp4',
          // 回调只接收枚举阶段，不应携带文件、模型正文或凭证。
          onProgress: async (event: { stage: string }) => {
            stages.push(event.stage);
          },
        },
      },
      cred,
    );

    expect(stages).toEqual([
      'file_received',
      'extracting_context',
      'context_extracted',
      'generating_script',
      'script_generated',
    ]);
  });

  it('extract 返回非 JSON → 角色空，generate 仍跑 → 返回剧本', async () => {
    let chatIdx = 0;
    mockFetch([
      { match: '/files', response: jsonResponse({ id: 'fv' }) },
      {
        match: '/chat/completions',
        response: () => {
          chatIdx += 1;
          return chatIdx === 1 ? sseResponse(['这不是 JSON，模型跑偏了']) : sseResponse(['剧本…']);
        },
      },
    ]);

    const r = await callKimi(
      'kimi/kimi-k2.6',
      { capability: 'video_to_script', input: { videoBytes: videoBytes() } },
      cred,
    );

    expect(r.meta?.characters).toEqual([]);
    expect(r.meta?.locations).toEqual([]);
    expect(r.meta?.script).toBe('剧本…');
  });

  it('accepts a one-shot ReadableStream and forwards multipart without buffering', async () => {
    let chatIdx = 0;
    const { calls } = mockFetch([
      { match: '/files', response: jsonResponse({ id: 'stream-file' }) },
      {
        match: '/chat/completions',
        response: () => (++chatIdx === 1
          ? sseResponse(['{"characters":[],"locations":[]}'])
          : sseResponse(['流式剧本'])),
      },
    ]);
    const bytes = new TextEncoder().encode('streamed-video');
    const videoStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const result = await callKimi(
      'kimi/kimi-k2.6',
      {
        capability: 'video_to_script',
        input: {
          videoStream,
          videoSize: bytes.byteLength,
          filename: '中文.mp4',
          mimeType: 'video/mp4',
        },
      },
      cred,
    );

    expect(result.meta?.script).toBe('流式剧本');
    expect(header(calls[0], 'Content-Type')).toContain('multipart/form-data; boundary=');
    expect(Number(header(calls[0], 'Content-Length'))).toBeGreaterThan(bytes.byteLength);
    // Node fetch 接收的是背压 Readable，不是复制整段视频形成的 Blob/FormData。
    const body = calls[0].init?.body as NodeJS.ReadableStream & AsyncIterable<Uint8Array>;
    expect(typeof body?.pipe).toBe('function');

    // 真实消费 multipart 流，锁住生产事故：Moonshot 会把带中文 filename* 的
    // Content-Disposition 当成没有 file part，并返回 400 "http: no such file"。
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const multipartBytes = Buffer.concat(chunks);
    const multipartHeader = multipartBytes.subarray(0, 1024).toString('utf8');
    expect(multipartHeader).toContain('name="file"; filename="video.mp4"');
    expect(multipartHeader).not.toContain('filename*=');
    expect(multipartHeader).not.toContain(encodeURIComponent('中文.mp4'));
    expect(multipartBytes.byteLength).toBe(Number(header(calls[0], 'Content-Length')));
  });

  it('video_to_script 也要求 input.videoBytes 为 Buffer', async () => {
    await expect(
      callKimi(
        'kimi/kimi-k2.6',
        { capability: 'video_to_script', input: { filename: 'a.mp4' } },
        cred,
      ),
    ).rejects.toThrow(/videoBytes/);
  });

  it('累加 extract + generate 两次 chat 的 token 用量写入 meta.tokensUsed（P0-3）', async () => {
    let chatIdx = 0;
    mockFetch([
      { match: '/files', response: jsonResponse({ id: 'fv' }) },
      {
        match: '/chat/completions',
        response: () => {
          chatIdx += 1;
          // 第 1 次 chat（extract）usage；第 2 次 chat（generate）usage
          return chatIdx === 1
            ? sseResponse(['{"characters":[],"locations":[]}'], {
                prompt_tokens: 4_000,
                completion_tokens: 500,
                prompt_cache_hit_tokens: 1_000,
                prompt_cache_miss_tokens: 3_000,
              })
            : sseResponse(['剧本…'], {
                prompt_tokens: 6_000,
                completion_tokens: 2_000,
                prompt_cache_hit_tokens: 500,
                prompt_cache_miss_tokens: 5_500,
              });
        },
      },
    ]);

    const r = await callKimi(
      'kimi/kimi-k2.6',
      { capability: 'video_to_script', input: { videoBytes: videoBytes() } },
      cred,
    );

    // 两次 chat input/output/cache 累加；callAI 据此归因平台成本。
    expect(r.meta?.tokensUsed).toEqual({
      input: 10_000, // 4000 + 6000
      output: 2_500, // 500 + 2000
      cacheHit: 1_500, // 1000 + 500
      cacheMiss: 8_500, // 3000 + 5500
    });
    expect(r.meta?.script).toBe('剧本…');
  });
});
