// ============================================================
// ② server/gateway — 凭证读取（管理员 api_configs 池）
// ============================================================
//
// 文件职责：
//   统一读取产品网关已注册 provider 的 API key + baseUrl。
//   只从管理员平台池读取 active key；池空时明确报错，禁止环境变量绕过后台管理。
//
// 安全约束：
//   - 返回的 ProviderCredential 仅在 server 内部流转，绝不返回给 client
//   - callAI 的对外返回值不含 key
//
// 与 infra 的关系：
//   - query 来自 @server/infra（pg 封装），用于查 api_configs 表
//   - query 仅用于文件粘性锁；普通轮询由 ApiKeyPool 查询同一张表
// ============================================================

import { query } from '@server/infra';
import type { ProviderCredential } from './types';
import { getApiKeyPool, type PoolEntry } from './api-key-pool';

/** provider → 默认 baseUrl（app1 DEFAULT_BASEURL + ark_intl 海外端点） */
const DEFAULT_BASEURL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  ark: 'https://ark.cn-beijing.volces.com/api/v3',
  ark_intl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
  minimax: 'https://api.minimaxi.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  kimi: 'https://api.moonshot.cn/v1',
  grok: 'https://api.x.ai/v1',
  comfyui: 'http://127.0.0.1:8188',
};

/**
 * 解析 baseUrl：管理员池中的自定义地址 > 产品内置官方默认地址。
 * 不读服务器环境变量，确保连接配置也由管理员后台统一控制。
 */
function resolveBaseUrl(provider: string, explicit?: string | null): string | undefined {
  return explicit || DEFAULT_BASEURL[provider];
}

/** 把池条目转为 ProviderCredential（带 configId 供健康回写 + 粘性锁） */
function poolEntryToCredential(entry: PoolEntry, provider: string): ProviderCredential {
  return {
    apiKey: entry.apiKey,
    baseUrl: resolveBaseUrl(provider, entry.baseUrl),
    configId: entry.configId,
  };
}

/**
 * 读取 provider 凭证。
 *
 * 顺序（GC-1：key 是平台云端服务器的，非 BYOK；平台池 api_configs."userId" IS NULL）：
 *   0. 粘性锁：opts.pinnedFileId → 查 provider_files 拿原 api_config_id → 锁回上传该文件
 *      的那个 key（防多 key 轮转 403：文件归账号 A，后续访问必须用 A 的 key）
 *   1. opts.pinnedConfigId → 直接取该 config（admin 测试 / 显式锁某 key）
 *   2. 平台池 getApiKeyPool().pick(provider) 加权轮询 + 健康熔断
 *   3. 池为空则报错，要求管理员在设置中维护可用 Key
 *
 * 返回的 ProviderCredential.configId 始终来自管理员池，供 callAI 健康回写
 * （recordSuccess/recordFailure）与文件粘性锁使用。
 *
 * @throws Error 当 key 完全缺失时
 */
export async function getCredential(
  provider: string,
  // 保留参数位置兼容现有调用方；C/S 平台 Key 不按用户分池。
  _userId?: string,
  opts?: { pinnedConfigId?: string; pinnedFileId?: string },
): Promise<ProviderCredential> {
  // 0. 粘性锁：pinnedFileId → 锁回上传该文件的原 key（防多 key 轮转 403）
  if (opts?.pinnedFileId) {
    try {
      const pf = await query(
        `SELECT api_config_id FROM provider_files WHERE file_id = $1 AND provider = $2`,
        [opts.pinnedFileId, provider],
      );
      const configId = (pf.rows?.[0] as { api_config_id?: string } | undefined)?.api_config_id;
      if (configId) {
        const pinned = await getApiKeyPool().pickById(configId);
        if (pinned) return poolEntryToCredential(pinned, provider);
      }
    } catch {
      // provider_files 查询失败 → 继续走正常选取，不阻断
    }
  }

  // 1. pinnedConfigId（admin 测试或显式锁某 key）
  if (opts?.pinnedConfigId) {
    const pinned = await getApiKeyPool().pickById(opts.pinnedConfigId);
    if (pinned) return poolEntryToCredential(pinned, provider);
  }

  // 2. 平台池优先：所有用户必须受管理员权重、启停与健康熔断统一控制。
  const poolEntry = await getApiKeyPool().pick(provider);
  if (poolEntry) return poolEntryToCredential(poolEntry, provider);

  // 3. 禁止环境变量或用户级 Key 兜底，确保管理员的启停、删除和权重设置真实生效。
  throw new Error(
    `PROVIDER_API_KEY_MISSING: provider=${provider} 管理员 API Key 池未配置可用 Key`,
  );
}
