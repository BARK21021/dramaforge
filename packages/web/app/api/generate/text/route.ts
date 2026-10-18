// ============================================================
// POST /api/generate/text — 长视频片段 Kimi 视频理解（转绘 X1）
// ============================================================
//
// client/orchestrators/long-video-rewrite.ts 把本地 ffmpeg 切出的视频段以
// multipart/form-data 流式上传到此端点；server 持 Kimi key 上传文件 + SSE
// 视频理解，返回该段剧情事实稿 content（连续性锚点 + 逐场剧本），供后续
// 拼接/重写。
//
// C/S 铁律：
//   - GC-1：Kimi key 只在 server（callAI cred 直传），绝不下发 client
//   - dramaforge-assets-client-local：视频字节只在 server RAM 透传给 Kimi Files
//     API，不落服务器磁盘（透传 ≠ 存储）。
//   - 流式接力（批1 OOM 修复）：multipart/form-data 不 base64、不
//     JSON.stringify，单段峰值 RAM 从 ~250MB（base64 string + parsed JSON
//     双份）降到 ~48-96MB（单份 Buffer），384MB web 容器安全。
//
// Body (multipart/form-data):
//   video:         File (mp4/webm/mov/mkv, ≤100MB)
//   segmentIndex?: string (0-based)
//   segmentCount?: string
//   startSec?:     string
//   endSec?:       string
//   model?:        string (默认 kimi-k2.6；vision-preview 系列只支持图像不支持视频)
// 响应: 200 { success:true, data:{ content, fileId } }
//       400 NO_FILE / FILE_TOO_LARGE / INVALID_FILE_TYPE / 401 / 429|5xx retryable / 500
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import { Buffer } from 'node:buffer';
import type { NextRequest } from 'next/server';
import { callAI, GatewayError } from '@dramaforge/server';
import { requireUser } from '@web/lib/auth';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export const runtime = 'nodejs';
export const maxDuration = 600;
export const dynamic = 'force-dynamic';

/** 与 X2 video-to-script 一致；Kimi Files API 单文件 100MiB 上限。 */
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const ALLOWED_VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv'];

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) return apiFail({ error: '未登录或登录已过期', code: 'UNAUTHORIZED' }, 401);

    // 余额前置预检（对齐 app1 precheckBalance）：0 积分挡在昂贵 AI 调用之前。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;

    const formData = await req.formData();
    const file = formData.get('video') as File | null;
    if (!file) {
      return apiFail({ error: '未提供视频文件', code: 'NO_FILE' }, 400);
    }

    // 类型校验（扩展名优先，mkv 的 MIME 常缺失）
    const lowerName = file.name.toLowerCase();
    const okExt = ALLOWED_VIDEO_EXT.some((ext) => lowerName.endsWith(ext));
    const okMime = typeof file.type === 'string' && file.type.startsWith('video/');
    if (!okExt && !okMime) {
      return apiFail(
        { error: '仅支持 MP4 / WebM / MOV / MKV 视频', code: 'INVALID_FILE_TYPE' },
        400,
      );
    }
    if (file.size > MAX_VIDEO_SIZE) {
      return apiFail(
        {
          error: `视频过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大支持 100MB`,
          code: 'FILE_TOO_LARGE',
        },
        400,
      );
    }
    if (file.size === 0) {
      return apiFail({ error: '视频文件为空', code: 'INVALID_FILE_TYPE' }, 400);
    }

    const modelField = formData.get('model');
    const model =
      typeof modelField === 'string' && modelField.trim().length > 0
        ? modelField.trim()
        : 'kimi-k2.6';

    const videoBytes = Buffer.from(await file.arrayBuffer());
    const result = await callAI('kimi', model, {
      capability: 'video_understanding',
      userId: auth.userId,
      input: {
        videoBytes,
        filename: file.name || 'segment.mp4',
        mimeType: file.type || 'video/mp4',
        segmentIndex: Number(formData.get('segmentIndex') ?? 0),
        segmentCount: Number(formData.get('segmentCount') ?? 1),
        startSec: Number(formData.get('startSec') ?? 0),
        endSec: Number(formData.get('endSec') ?? 0),
      },
    });

    const meta = (result.meta ?? {}) as Record<string, unknown>;
    const content = typeof meta.content === 'string' ? meta.content : '';

    // 成功后扣费（对齐 generate-image / long-video-text）：video_understanding 已纳入
    // callAI 成本归因（token 单价），余额不足重抛 402 → 不交付（"不够扣就不让用"）。
    await billDirectGeneration({
      userId: auth.userId,
      result,
      description: '长视频分段视频理解',
      taskType: 'VIDEO_UNDERSTANDING',
    });

    return apiSuccess({ content, fileId: meta.fileId ?? null });
  } catch (err) {
    if (err instanceof GatewayError) {
      const status = err.status ?? 502;
      const retryable = err.retryAfter !== null || status === 429 || status >= 500;
      // 观测性：provider 上游错误必须落 docker logs（与 video-to-script 对齐），
      // 否则长视频分段理解的 502 在 web 容器里完全静默。
      console.error('[generate/text] provider error', {
        status,
        message: err.message,
        retryAfter: err.retryAfter,
      });
      return apiFail(
        {
          error: err.message,
          code: 'PROVIDER_ERROR',
          category: 'provider',
          retryable,
        },
        status,
      );
    }
    return handleApiError(err, 'POST /api/generate/text');
  }
}
