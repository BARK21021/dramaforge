// ============================================================
// POST /api/client/heartbeat — 客户端心跳 + 版本强制淘汰判定
// ============================================================
//
// ⑬ client/ops-heartbeat 每 30s POST {version, os, machineId}。web 读
// system_configs.CLIENT_VERSIONS_MANIFEST，用 isVersionBelow 判定是否
// force_upgrade。force_upgrade 时客户端锁死 UI + 静默升级。
//
// 鉴权：**无 session**。⑬ heartbeat.ts 用 bare fetch 不带 Cookie——心跳在
// 用户登录前就启动（shell bootstrap 即开始），必须允许未登录访问。
// machineId 在 body 中（HeartbeatRequest 契约）。
//
// 请求体：HeartbeatRequest { version, os, machineId }
// 响应：200 HeartbeatResponse { status, minVersion, latestVersion, downloadUrl }
//      400 — body 校验失败
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { isVersionBelow } from '@dramaforge/shared';
import { getVersionsManifest, downloadUrlForOs } from '@web/lib/versions';
import { getRenderJobSlots } from '@web/lib/render-job-slots';
import { apiError, apiOk } from '@web/lib/response';

const heartbeatSchema = z.object({
  version: z.string().min(1),
  os: z.enum(['win', 'mac', 'linux']),
  machineId: z.string().min(1),
});

export async function POST(req: NextRequest): Promise<Response> {
  let body: z.infer<typeof heartbeatSchema>;
  try {
    const raw = (await req.json()) as unknown;
    body = heartbeatSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.message : '无效 JSON';
    return apiError(`body 校验失败: ${msg}`, 400);
  }

  const manifest = await getVersionsManifest();
  const forceUpgrade = isVersionBelow(body.version, manifest.minVersion);
  const downloadUrl = downloadUrlForOs(manifest, body.os);
  // 槽位数是全局提示（本路由无鉴权，无法按用户区分）；per-user 真上限由
  // /api/render/jobs/next 按 users."maxConcurrent" 硬强制。老客户端忽略新字段。
  const renderJobSlots = await getRenderJobSlots();

  return apiOk({
    status: forceUpgrade ? 'force_upgrade' : 'ok',
    minVersion: manifest.minVersion,
    latestVersion: manifest.latestVersion,
    downloadUrl,
    signature: manifest.signature,
    sha256: manifest.sha256,
    renderJobSlots,
  });
}
