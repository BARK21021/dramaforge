// ============================================================
// web/lib/versions — 客户端版本清单读取
// ============================================================
//
// 文件职责：
//   getVersionsManifest() — 从 system_configs 表读 CLIENT_VERSIONS_MANIFEST
//   一行（JSON value），返回 { minVersion, latestVersion, downloadUrls }。
//   供 /api/client/heartbeat（force_upgrade 判定）与 /api/client/update
//   （最新版检查）共用。
//
// 设计要点：
//   - 单行 JSON 清单：原子读写，避免多次 query；open-question 4 裁决选
//     system_configs（MinIO-hosted versions.json 是备选方案，后续可加 CDN）。
//   - 表缺失或行不存在时回退 SAFE_DEFAULT：不锁死任何客户端（minVersion=
//     '0.0.0' 永远 ok），便于首次部署未种子数据时的容错。
//   - downloadUrls 缺某 OS 时回退空串（客户端 updater 会 swallow）。
//
// web 禁止 import 任何 ffmpeg 模块；本模块仅做 pg query + JSON 解析。
// ============================================================

import { query } from '@dramaforge/server';

/** 客户端版本清单（存储在 system_configs.CLIENT_VERSIONS_MANIFEST 的 JSON value） */
export interface VersionsManifest {
  /** 最低允许版本；低于此版本触发 force_upgrade 锁死 */
  minVersion: string;
  /** 最新可用版本 */
  latestVersion: string;
  /** 各 OS 的安装包下载 URL（MinIO presigned 或 CDN） */
  downloadUrls: {
    win: string;
    mac: string;
    linux: string;
  };
  /**
   * latestVersion 安装包的 Ed25519 签名（base64）。客户端下载后用硬编码公钥验签，
   * 防供应链投毒（服务器沦陷 → 换 .exe → 客户端验不过拒绝安装）。
   * 由 scripts/publish-client.sh 调 scripts/sign-client.mjs 生成。
   */
  signature: string;
  /** latestVersion 安装包的 sha256（hex）；传输完整性兜底 + 诊断。 */
  sha256: string;
}

/** 安全回退清单：不锁死任何客户端（min=0.0.0 永远 ok） */
const SAFE_DEFAULT: VersionsManifest = {
  minVersion: '0.0.0',
  latestVersion: '0.0.0',
  downloadUrls: { win: '', mac: '', linux: '' },
  signature: '',
  sha256: '',
};

/** system_configs 中的清单键名 */
const MANIFEST_KEY = 'CLIENT_VERSIONS_MANIFEST';

/**
 * 读取客户端版本清单。
 *
 * 查 system_configs WHERE key='CLIENT_VERSIONS_MANIFEST'，解析 value JSON。
 * 任何错误（表缺失/行缺失/JSON 解析失败）均回退 SAFE_DEFAULT，不抛错——
 * 版本检查是 ops 心跳路径，绝不能因配置缺失让所有客户端锁死。
 *
 * @returns VersionsManifest（始终非 null）
 */
export async function getVersionsManifest(): Promise<VersionsManifest> {
  try {
    const result = await query(
      `SELECT value FROM system_configs WHERE key = $1 LIMIT 1`,
      [MANIFEST_KEY],
    );
    const row = result.rows[0] as { value?: string | null } | undefined;
    if (!row || !row.value) return SAFE_DEFAULT;
    const parsed = JSON.parse(row.value) as Partial<VersionsManifest>;
    return {
      minVersion: typeof parsed.minVersion === 'string' ? parsed.minVersion : SAFE_DEFAULT.minVersion,
      latestVersion:
        typeof parsed.latestVersion === 'string' ? parsed.latestVersion : SAFE_DEFAULT.latestVersion,
      downloadUrls: {
        win: parsed.downloadUrls?.win ?? '',
        mac: parsed.downloadUrls?.mac ?? '',
        linux: parsed.downloadUrls?.linux ?? '',
      },
      signature: typeof parsed.signature === 'string' ? parsed.signature : '',
      sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : '',
    };
  } catch {
    // 配置缺失/解析失败：回退安全默认，绝不锁死客户端
    return SAFE_DEFAULT;
  }
}

/**
 * 按 OS 取下载 URL。
 *
 * @param manifest - 版本清单
 * @param os - 客户端 OS
 * @returns 该 OS 的下载 URL（未知 OS 回退 win）
 */
export function downloadUrlForOs(
  manifest: VersionsManifest,
  os: 'win' | 'mac' | 'linux',
): string {
  return manifest.downloadUrls[os] ?? manifest.downloadUrls.win ?? '';
}
