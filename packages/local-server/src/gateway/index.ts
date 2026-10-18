/**
 * BYOK (Bring Your Own Key) gateway for local mode.
 *
 * In local mode, users provide their own API keys (ARK/Seedance/DeepSeek/Kimi).
 * This module replaces the server-side admin key pool with user-configured keys.
 *
 * Provider functions are reused directly from @dramaforge/server — they are
 * self-contained HTTP calls. Only the credential source differs (user key
 * instead of admin pool).
 *
 * Keys are stored in the api_configs table (same schema as cloud),
 * but in local mode they belong to the local user.
 */
import type { Database } from 'better-sqlite3';
import type { GatewayPayload, GatewayResult, ProviderCredential } from '@dramaforge/server';

// Provider call functions — same signature as cloud, just different credentials
import { callArk } from '@dramaforge/server/gateway/providers';
import { callOpenAI } from '@dramaforge/server/gateway/providers';
import { callGoogle } from '@dramaforge/server/gateway/providers';
import { callDeepSeek } from '@dramaforge/server/gateway/providers';
import { callKimi } from '@dramaforge/server/gateway/providers';
import { callMinimax } from '@dramaforge/server/gateway/providers';
import { callGrok } from '@dramaforge/server/gateway/providers';
import { callComfyUI } from '@dramaforge/server/gateway/providers';

import { isLicenseActive } from '@dramaforge/server';

export interface UserCredential {
  apiKey: string;
  baseUrl?: string;
  provider: string;
  configId: string;
}

export class LocalGatewayError extends Error {
  readonly provider: string;
  readonly status: number | null;
  readonly retryAfter: number | null;

  constructor(provider: string, message: string, status: number | null = null, retryAfter: number | null = null) {
    super(message);
    this.name = 'LocalGatewayError';
    this.provider = provider;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

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

type ProviderFn = (
  model: string,
  payload: GatewayPayload,
  cred: ProviderCredential,
  ctx?: { signal?: AbortSignal },
) => Promise<GatewayResult>;

const PROVIDER_HANDLERS: Record<string, ProviderFn> = {
  ark: callArk,
  ark_intl: callArk, // same handler, baseUrl distinguishes endpoint
  openai: callOpenAI,
  google: callGoogle,
  deepseek: callDeepSeek,
  kimi: callKimi,
  minimax: callMinimax,
  grok: callGrok,
  comfyui: callComfyUI,
};

export const PROVIDERS = Object.freeze(Object.keys(PROVIDER_HANDLERS));

/** Pick a user-configured key for a provider (round-robin among enabled keys). */
export function pickUserKey(db: Database, userId: string, provider: string): UserCredential | null {
  const rows = db.prepare(
    `SELECT * FROM api_configs
     WHERE "userId" = ? AND provider = ? AND "isEnabled" = 1 AND "keyStatus" = 'active'
     AND ("disabledUntil" IS NULL OR "disabledUntil" < datetime('now'))
     ORDER BY "lastUsedAt" ASC NULLS FIRST`
  ).all(userId, provider) as Record<string, unknown>[];

  if (rows.length === 0) return null;

  const row = rows[0];
  db.prepare(`UPDATE api_configs SET "lastUsedAt" = datetime('now') WHERE id = ?`).run(row.id);

  return {
    apiKey: row.apiKey as string,
    baseUrl: (row.baseUrl as string) || DEFAULT_BASEURL[provider],
    provider,
    configId: row.id as string,
  };
}

/** Record a successful API call (reset failure count). */
export function recordKeySuccess(db: Database, configId: string): void {
  db.prepare(
    `UPDATE api_configs SET "consecutiveFailures" = 0, "lastErrorMessage" = NULL, "updatedAt" = datetime('now') WHERE id = ?`
  ).run(configId);
}

/** Record a failed API call (increment failure count, maybe disable). */
export function recordKeyFailure(db: Database, configId: string, errorMessage: string): void {
  db.prepare(
    `UPDATE api_configs
     SET "consecutiveFailures" = "consecutiveFailures" + 1,
         "errorCount" = "errorCount" + 1,
         "lastErrorMessage" = ?,
         "updatedAt" = datetime('now'),
         "keyStatus" = CASE
           WHEN "consecutiveFailures" >= 5 THEN 'cooldown'
           ELSE "keyStatus"
         END,
         "disabledUntil" = CASE
           WHEN "consecutiveFailures" >= 5 THEN datetime('now', '+5 minutes')
           ELSE "disabledUntil"
         END
     WHERE id = ?`
  ).run(errorMessage.slice(0, 500), configId);
}

/** Get the base URL for a provider (with user override support). */
export function resolveBaseUrl(provider: string, userOverride?: string | null): string {
  return userOverride || DEFAULT_BASEURL[provider] || '';
}

/** List all supported providers for the settings UI. */
export function getSupportedProviders(): Array<{ id: string; name: string; defaultBaseUrl: string; docs: string }> {
  return [
    { id: 'ark', name: '火山方舟 ARK (豆包/Seedance)', defaultBaseUrl: DEFAULT_BASEURL.ark, docs: 'https://www.volcengine.com/ark' },
    { id: 'deepseek', name: 'DeepSeek', defaultBaseUrl: DEFAULT_BASEURL.deepseek, docs: 'https://platform.deepseek.com' },
    { id: 'kimi', name: 'Kimi (Moonshot)', defaultBaseUrl: DEFAULT_BASEURL.kimi, docs: 'https://platform.moonshot.cn' },
    { id: 'openai', name: 'OpenAI', defaultBaseUrl: DEFAULT_BASEURL.openai, docs: 'https://platform.openai.com' },
    { id: 'ark_intl', name: 'ARK International', defaultBaseUrl: DEFAULT_BASEURL.ark_intl, docs: 'https://www.volcengine.com/ark' },
  ];
}

/**
 * Local AI gateway entry point — BYOK version of the cloud callAI().
 *
 * Flow:
 *   1. Validate provider support
 *   2. Normalize payload to GatewayPayload
 *   3. Read user key from api_configs (BYOK)
 *   4. Dispatch to provider function with user credentials
 *   5. Error normalization
 *
 * @param db       SQLite database
 * @param userId   Authenticated user ID
 * @param provider Provider name (ark / openai / google / ...)
 * @param model    Model ID (e.g. "ark/doubao-seedance-2-0")
 * @param payload  Unknown payload, normalized internally to { capability, input }
 * @returns { url, meta? }
 * @throws LocalGatewayError on any failure
 */
export async function localCallAI(
  db: Database,
  userId: string,
  provider: string,
  model: string,
  payload: unknown,
  opts?: { signal?: AbortSignal },
): Promise<GatewayResult> {
  const handler = PROVIDER_HANDLERS[provider];
  if (!handler) {
    throw new LocalGatewayError(provider, `Unsupported provider: ${provider}`);
  }

  const normalizedPayload = normalizePayload(payload, provider);

  // License gate: block AI calls if no valid license
  if (!isLicenseActive()) {
    throw new LocalGatewayError(provider, 'License not activated. Please activate DramaForge Local to use AI features.');
  }

  // BYOK: read user's own key
  const userKey = pickUserKey(db, userId, provider);
  if (!userKey) {
    throw new LocalGatewayError(
      provider,
      `No active API key configured for provider "${provider}". Please add your key in Settings.`,
    );
  }

  const cred: ProviderCredential = {
    apiKey: userKey.apiKey,
    baseUrl: userKey.baseUrl,
    configId: userKey.configId,
  };

  try {
    const result = await handler(
      model,
      normalizedPayload,
      cred,
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    recordKeySuccess(db, userKey.configId);
    return result;
  } catch (err) {
    recordKeyFailure(db, userKey.configId, err instanceof Error ? err.message : String(err));
    throw toLocalGatewayError(provider, err);
  }
}

/** Normalize unknown payload to GatewayPayload */
function normalizePayload(payload: unknown, provider: string): GatewayPayload {
  if (payload && typeof payload === 'object' && 'capability' in payload) {
    const p = payload as GatewayPayload;
    if (!p.capability) {
      throw new LocalGatewayError(provider, 'payload missing capability field');
    }
    if (!p.input || typeof p.input !== 'object') {
      throw new LocalGatewayError(provider, 'payload.input must be an object');
    }
    return p;
  }
  throw new LocalGatewayError(provider, 'payload must be { capability, input, userId? } object');
}

/** Normalize arbitrary error to LocalGatewayError */
function toLocalGatewayError(provider: string, err: unknown): LocalGatewayError {
  if (err instanceof LocalGatewayError) return err;
  // Re-wrap cloud GatewayError (same shape, different class)
  const anyErr = err as { name?: string; provider?: string; status?: number | null; retryAfter?: number | null; message?: string };
  if (anyErr?.name === 'GatewayError') {
    return new LocalGatewayError(
      anyErr.provider ?? provider,
      anyErr.message ?? 'Unknown error',
      anyErr.status ?? null,
      anyErr.retryAfter ?? null,
    );
  }
  // Re-wrap GatewayHttpError
  if (anyErr?.name === 'GatewayHttpError') {
    return new LocalGatewayError(provider, anyErr.message ?? 'HTTP error', anyErr.status ?? null, anyErr.retryAfter ?? null);
  }
  if (err instanceof Error) {
    return new LocalGatewayError(provider, err.message);
  }
  return new LocalGatewayError(provider, String(err));
}

/** Parse "provider/model-id" → { provider, model } */
export function parseModelId(model: string): { provider: string; model: string } {
  const idx = model.indexOf('/');
  if (idx <= 0) {
    throw new Error(`model missing provider prefix (expected "provider/model-id"): ${model}`);
  }
  return { provider: model.slice(0, idx), model };
}
