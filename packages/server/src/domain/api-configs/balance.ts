// ============================================================
// Provider Capability Health — 平台 Key 余额查询适配器
// ============================================================
//
// 余额接口并非 OpenAI 兼容标准的一部分，因此必须按 provider 隔离实现。
// 本模块只返回统一、已脱敏的结果；原始 Key 仅存在于请求头的局部变量中，
// 不进入日志、异常文本或前端响应。
// ============================================================

export interface ProviderBalanceView {
  provider: string;
  balanceSupported: boolean;
  balance?: number;
  currency?: 'CNY' | 'USD';
  balanceLabel?: string;
  error?: string;
  lastUpdated: string;
}

interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string | null;
}

/** 把 number / 数字字符串统一转成有限数值，拒绝接口返回的空值或对象。 */
function finiteNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

/** 余额查询专用短超时 fetch；错误正文截断，且永不拼入凭证。 */
async function fetchJson(
  url: string,
  apiKey: string,
  timeoutMs = 12_000,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  return await response.json() as Record<string, unknown>;
}

function success(provider: string, balance: number, currency: 'CNY' | 'USD'): ProviderBalanceView {
  const symbol = currency === 'CNY' ? '¥' : '$';
  return {
    provider,
    balanceSupported: true,
    balance,
    currency,
    balanceLabel: `${symbol}${balance.toFixed(2)}`,
    lastUpdated: new Date().toISOString(),
  };
}

async function deepseek(cred: ProviderCredentials): Promise<ProviderBalanceView> {
  const baseUrl = (cred.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const data = await fetchJson(`${baseUrl}/user/balance`, cred.apiKey);
  const balanceInfos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const cnyInfo = balanceInfos.find((item) =>
    typeof item === 'object' && item !== null && String((item as Record<string, unknown>).currency).toUpperCase() === 'CNY');
  const balance = finiteNumber(
    cnyInfo && typeof cnyInfo === 'object'
      ? (cnyInfo as Record<string, unknown>).total_balance
      : data.balance,
  );
  if (balance === undefined) throw new Error('DeepSeek 返回的余额格式无法识别');
  return success('deepseek', balance, 'CNY');
}

async function kimi(cred: ProviderCredentials): Promise<ProviderBalanceView> {
  const baseUrl = (cred.baseUrl || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
  const data = await fetchJson(`${baseUrl}/users/me/balance`, cred.apiKey);
  const nested = typeof data.data === 'object' && data.data !== null
    ? data.data as Record<string, unknown>
    : data;
  const balance = finiteNumber(nested.available_balance ?? nested.balance);
  if (balance === undefined) throw new Error('Kimi 返回的余额格式无法识别');
  return success('kimi', balance, 'CNY');
}

const HANDLERS: Record<string, (cred: ProviderCredentials) => Promise<ProviderBalanceView>> = {
  deepseek,
  kimi,
};

/**
 * 查询单个 Key 的余额。ARK 模型 Key 不具备费用中心权限，因此明确返回“不支持”，
 * 避免把“需要另一套 AK/SK”伪装成余额为 0 或查询成功。
 */
export async function fetchProviderBalance(
  provider: string,
  credentials: ProviderCredentials,
): Promise<ProviderBalanceView> {
  const handler = HANDLERS[provider];
  if (!handler) {
    return { provider, balanceSupported: false, lastUpdated: new Date().toISOString() };
  }
  try {
    return await handler(credentials);
  } catch (error) {
    return {
      provider,
      balanceSupported: true,
      error: error instanceof Error ? error.message : '余额查询失败',
      lastUpdated: new Date().toISOString(),
    };
  }
}
