// ============================================================
// /api/generate/text — 转绘 X1 Kimi 视频理解 route 测试
// ============================================================
//
// 覆盖（multipart/form-data 流式契约，批1 OOM 修复后）：
//   - 401 未登录
//   - 400 缺视频文件 / 空文件 / 坏类型
//   - 200 happy：FormData 视频 → Buffer，callAI video_understanding，
//     返回 { success:true, data:{ content, fileId } }
//   - 默认 model=kimi-k2.6，显式 model 透传
//   - GatewayError → status + retryable（429 可重试 / null status→502）
//
// mock：@dramaforge/server（callAI=vi.fn / GatewayError 真实 class）+ getServerSession
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getServerSessionMock, serverMock, DEFAULT_SESSION } from './mocks';
import { readJson } from './helpers';
import { POST } from '../app/api/generate/text/route';

const { GatewayError } = serverMock;

/** 构造带视频 Blob 的 multipart NextRequest（file 省略 → 测无文件分支）。 */
function videoRequest(
  file?: Blob,
  fields: Record<string, string> = {},
  filename = 'seg-0.mp4',
): NextRequest {
  const fd = new FormData();
  if (file) fd.append('video', file, filename);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new NextRequest('http://localhost/api/generate/text', {
    method: 'POST',
    body: fd,
  });
}

/** "hello" 5 字节视频 Blob，便于断言 videoBytes 解码正确。 */
const helloVideo = () =>
  new Blob([new Uint8Array(Buffer.from('hello'))], { type: 'video/mp4' });

describe('POST /api/generate/text (转绘 X1 Kimi 视频理解)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.callAI.mockReset();
  });

  it('401 未登录时不调 callAI', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(videoRequest(helloVideo()));
    expect(res.status).toBe(401);
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('400 缺视频文件', async () => {
    const res = await POST(videoRequest(undefined));
    expect(res.status).toBe(400);
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('400 空文件', async () => {
    const empty = new Blob([new Uint8Array(0)], { type: 'video/mp4' });
    const res = await POST(videoRequest(empty));
    expect(res.status).toBe(400);
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('400 坏类型（非视频扩展名 + 非 video MIME）', async () => {
    const txt = new Blob([new Uint8Array(Buffer.from('x'))], { type: 'text/plain' });
    const res = await POST(videoRequest(txt, {}, 'not-a-video.txt'));
    expect(res.status).toBe(400);
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('200 happy：FormData 视频→Buffer 调 video_understanding，返回 content+fileId', async () => {
    serverMock.callAI.mockResolvedValue({
      url: '',
      meta: { content: '剧情事实稿…', fileId: 'fid-123' },
    });
    const res = await POST(
      videoRequest(helloVideo(), {
        segmentIndex: '0',
        segmentCount: '3',
        startSec: '0',
        endSec: '600',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      success: boolean;
      data: { content: string; fileId: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.content).toBe('剧情事实稿…');
    expect(body.data.fileId).toBe('fid-123');

    expect(serverMock.callAI).toHaveBeenCalledTimes(1);
    const [, model, payload] = serverMock.callAI.mock.calls[0];
    expect(model).toBe('kimi-k2.6');
    expect(payload.capability).toBe('video_understanding');
    expect(Buffer.isBuffer(payload.input.videoBytes)).toBe(true);
    expect((payload.input.videoBytes as Buffer).toString()).toBe('hello');
    expect(payload.input.filename).toBe('seg-0.mp4');
    expect(payload.input.segmentIndex).toBe(0);
    expect(payload.input.segmentCount).toBe(3);
  });

  it('默认 model=kimi-k2.6；显式 model 透传', async () => {
    serverMock.callAI.mockResolvedValue({ url: '', meta: { content: 'c' } });
    await POST(videoRequest(helloVideo(), { model: 'kimi-k2.5' }));
    expect(serverMock.callAI.mock.calls[0][1]).toBe('kimi-k2.5');
  });

  it('GatewayError 429 → status 429 + retryable:true + PROVIDER_ERROR', async () => {
    serverMock.callAI.mockRejectedValue(
      new GatewayError('kimi', 'rate limited', 429, 5000),
    );
    const res = await POST(videoRequest(helloVideo()));
    expect(res.status).toBe(429);
    const body = (await readJson(res)) as {
      success: boolean;
      retryable?: boolean;
      code?: string;
    };
    expect(body.success).toBe(false);
    expect(body.retryable).toBe(true);
    expect(body.code).toBe('PROVIDER_ERROR');
  });

  it('GatewayError null status → 502', async () => {
    serverMock.callAI.mockRejectedValue(new GatewayError('kimi', 'oops', null, null));
    const res = await POST(videoRequest(helloVideo()));
    expect(res.status).toBe(502);
  });
});
