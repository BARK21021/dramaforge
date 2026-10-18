// ============================================================
// POST /api/client/logs — 客户端日志批量上报
// ============================================================
//
// ⑮ client/ops-logger 懒上报日志批次。web 收取后存到 MinIO（③ storage 的
// getStorage()）键 sf-clients/{machineId}/{taskId||'no-task'}/{ts}-{rand}.json。
// ⑱ uploader 对非 2xx swallow，故本路由失败也不影响客户端。
//
// 鉴权：**无 session**。⑮ uploader.ts 用 bare fetch 不带 Cookie——日志上报
// 在登录前/未登录态都可能触发，必须允许未登录访问。
//
// 请求体：ClientLogBatch { machineId, taskId?, logs: [{ts, level, msg}] }
// 响应：200 { ok: true, key } / 400 / 413 / 500
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { genId } from '@dramaforge/shared';
import { getStorage } from '@dramaforge/server';
import { apiError, apiOk } from '@web/lib/response';
import { readBodyWithLimit } from '@web/lib/sms-security';

/** 日志批次最大 512 KiB，避免未登录入口被大请求拖垮。 */
const MAX_BODY_BYTES = 512 * 1024;
/** machineId/taskId 会进入对象存储 key，只允许安全的单路径段。 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const logEntrySchema = z.object({
  ts: z.string().min(1).max(64),
  level: z.enum(['info', 'warn', 'error']),
  msg: z.string().max(8192),
});

const logBatchSchema = z.object({
  machineId: z.string().regex(SAFE_SEGMENT_RE),
  taskId: z.string().regex(SAFE_SEGMENT_RE).optional(),
  logs: z.array(logEntrySchema).min(1).max(1000),
});

export async function POST(req: NextRequest): Promise<Response> {
  let body: z.infer<typeof logBatchSchema>;
  try {
    // 此入口允许未登录客户端 best-effort 上报，因此必须先限制请求体再做字段校验。
    const bodyResult = await readBodyWithLimit<unknown>(req, MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      return apiError(bodyResult.payload.error, bodyResult.status, {
        code: bodyResult.payload.code,
      });
    }
    body = logBatchSchema.parse(bodyResult.body);
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.message : '无效 JSON';
    return apiError(`body 校验失败: ${msg}`, 400);
  }

  // 存储键：sf-clients/{machineId}/{taskId||'no-task'}/{ts}-{rand}.json
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const taskSegment = body.taskId ?? 'no-task';
  const key = `sf-clients/${body.machineId}/${taskSegment}/${ts}-${genId()}.json`;

  try {
    const storage = getStorage();
    const buf = Buffer.from(JSON.stringify(body), 'utf-8');
    const result = await storage.upload(key, buf, 'application/json');
    return apiOk({ ok: true, key: result.key });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`日志存储失败: ${msg}`, 500);
  }
}
