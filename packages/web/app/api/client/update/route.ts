// ============================================================
// GET /api/client/update — 客户端静默更新检查
// ============================================================
//
// ⑭ client/ops-updater 每 1h GET /api/client/update?version=&os=。web 读
// 版本清单，返回 {latestVersion, downloadUrl, force}。latestVersion 高于
// 当前版本时客户端静默下载；force=true 时强提示重启。
//
// 鉴权：**无 session**。⑭ updater.ts 用 bare fetch 不带 Cookie——更新检查
// 在登录前就启动，必须允许未登录访问。
//
// 查询参数：version (string), os ('win'|'mac'|'linux')
// 响应：200 UpdateCheckResponse { latestVersion, downloadUrl, force }
//      400 — 缺参数
//
// web 禁止 import 任何 ffmpeg 模块。
// ============================================================

import type { NextRequest } from 'next/server';
import { isVersionBelow } from '@dramaforge/shared';
import { getVersionsManifest, downloadUrlForOs } from '@web/lib/versions';
import { apiError, apiOk } from '@web/lib/response';

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const version = url.searchParams.get('version')?.trim();
  const osRaw = url.searchParams.get('os')?.trim();
  if (!version) {
    return apiError('缺少 version 查询参数', 400);
  }
  if (osRaw !== 'win' && osRaw !== 'mac' && osRaw !== 'linux') {
    return apiError('os 查询参数需为 win|mac|linux', 400);
  }

  const manifest = await getVersionsManifest();
  const force = isVersionBelow(version, manifest.minVersion);
  const downloadUrl = downloadUrlForOs(manifest, osRaw);

  return apiOk({
    latestVersion: manifest.latestVersion,
    downloadUrl,
    force,
    signature: manifest.signature,
    sha256: manifest.sha256,
  });
}
