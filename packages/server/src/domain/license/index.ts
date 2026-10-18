/**
 * License activation server logic.
 *
 * Tables:
 *   license_codes (code, type, maxVersion, maxDevices, batch, createdAt)
 *   license_activations (id, code, machineId, activatedAt, deactivatedAt)
 *
 * The private key for signing licenses is kept in env (DRAMAFORGE_LICENSE_PRIVKEY).
 */
import { createSign, generateKeyPairSync } from 'crypto';
import { query } from '../../infra/pg';

// ============================================================
// Key management
// ============================================================

let privateKey: string | null = null;
let publicKey: string | null = null;

/** Load keys from env or generate a new pair (dev only). */
function getKeys(): { privateKey: string; publicKey: string } {
  if (privateKey && publicKey) return { privateKey, publicKey };

  const envPriv = process.env.DRAMAFORGE_LICENSE_PRIVKEY;
  const envPub = process.env.DRAMAFORGE_LICENSE_PUBKEY;

  if (envPriv && envPub) {
    privateKey = envPriv;
    publicKey = envPub;
    return { privateKey, publicKey };
  }

  // Dev mode: generate ephemeral keys
  console.warn('[license] No license keys in env  generating ephemeral pair (DEV ONLY)');
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync('ed25519');
  privateKey = priv.export({ type: 'pkcs8', format: 'pem' }) as string;
  publicKey = pub.export({ type: 'spki', format: 'pem' }) as string;
  return { privateKey: privateKey, publicKey };
}

/** Sign a license payload with Ed25519. */
export function signLicense(payload: Omit<LicensePayload, 'signature'>): string {
  const { privateKey } = getKeys();
  const signString = buildSignString(payload);
  const sign = createSign('sha256');
  sign.update(signString);
  sign.end();
  return sign.sign(privateKey, 'hex');
}

/** Get the public key for embedding in client. */
export function getPublicKey(): string {
  return getKeys().publicKey;
}

// ============================================================
// Types
// ============================================================

export interface LicensePayload {
  code: string;
  machineId: string;
  type: 'lifetime' | 'annual' | 'monthly';
  expiresAt: string | null;
  maxVersion: string;
  maxDevices: number;
  activatedAt: string;
  signature: string;
}

// ============================================================
// Helpers
// ============================================================

function buildSignString(p: Omit<LicensePayload, 'signature'>): string {
  return [
    p.code, p.machineId, p.type,
    p.expiresAt ?? 'null',
    p.maxVersion, String(p.maxDevices),
    p.activatedAt,
  ].join('|');
}

function calculateExpiry(type: string, from: Date = new Date()): string | null {
  if (type === 'lifetime') return null;
  const expiry = new Date(from);
  if (type === 'annual') expiry.setFullYear(expiry.getFullYear() + 1);
  if (type === 'monthly') expiry.setMonth(expiry.getMonth() + 1);
  return expiry.toISOString();
}

// ============================================================
// Database operations
// ============================================================

/** Ensure license tables exist. */
export async function ensureLicenseTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS license_codes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'lifetime',
      "maxVersion" TEXT NOT NULL DEFAULT '99.0.0',
      "maxDevices" INTEGER NOT NULL DEFAULT 2,
      batch TEXT,
      note TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "createdBy" TEXT
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS license_activations (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL REFERENCES license_codes(code),
      "machineId" TEXT NOT NULL,
      "activatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "deactivatedAt" TIMESTAMPTZ,
      UNIQUE(code, "machineId")
    )
  `);
}

/** Generate and store a batch of license codes. */
export async function generateLicenseBatch(
  count: number,
  opts: {
    type?: 'lifetime' | 'annual' | 'monthly';
    maxVersion?: string;
    maxDevices?: number;
    batch?: string;
    note?: string;
    createdBy?: string;
  } = {},
): Promise<string[]> {
  const type = opts.type ?? 'lifetime';
  const maxVersion = opts.maxVersion ?? '99.0.0';
  const maxDevices = opts.maxDevices ?? 2;
  const batch = opts.batch ?? `batch-${Date.now()}`;
  const codes: string[] = [];
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  for (let n = 0; n < count; n++) {
    const parts: string[] = [];
    for (let p = 0; p < 4; p++) {
      let part = '';
      for (let i = 0; i < 4; i++) part += chars[Math.floor(Math.random() * chars.length)];
      parts.push(part);
    }
    const raw = parts.slice(0, 3).join('') + parts[3].slice(0, 3);
    let checksum = 0;
    for (const c of raw) checksum += c.charCodeAt(0);
    parts[3] = parts[3].slice(0, 3) + chars[checksum % chars.length];
    const code = `SF-${parts.join('-')}`;
    codes.push(code);

    await query(
      `INSERT INTO license_codes (code, type, "maxVersion", "maxDevices", batch, note, "createdAt", "createdBy")
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       ON CONFLICT (code) DO NOTHING`,
      [code, type, maxVersion, maxDevices, batch, opts.note ?? null, opts.createdBy ?? null],
    );
  }

  return codes;
}

/** Activate a license code on a machine. */
export async function activateLicenseCode(
  code: string,
  machineId: string,
): Promise<{ success: boolean; license?: LicensePayload; error?: string }> {
  // 1. Check code exists and is valid
  const codeResult = await query(
    `SELECT * FROM license_codes WHERE code = $1`,
    [code],
  );
  if (codeResult.rows.length === 0) {
    return { success: false, error: 'INVALID_CODE' };
  }
  const codeRow = codeResult.rows[0] as Record<string, unknown>;

  // 2. Check current active activations for this code
  const activeResult = await query(
    `SELECT COUNT(*) as cnt FROM license_activations
     WHERE code = $1 AND "deactivatedAt" IS NULL`,
    [code],
  );
  const activeCount = parseInt((activeResult.rows[0] as { cnt: string }).cnt);
  const maxDevices = codeRow.maxDevices as number;
  if (activeCount >= maxDevices) {
    // Check if this machine is already activated
    const existing = await query(
      `SELECT * FROM license_activations
       WHERE code = $1 AND "machineId" = $2 AND "deactivatedAt" IS NULL`,
      [code, machineId],
    );
    if (existing.rows.length === 0) {
      return { success: false, error: 'MAX_DEVICES_REACHED' };
    }
//
  } else {
    // 3. Record activation
    const { randomUUID } = await import('crypto');
    await query(
      `INSERT INTO license_activations (id, code, "machineId", "activatedAt")
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (code, "machineId") DO UPDATE SET "deactivatedAt" = NULL, "activatedAt" = NOW()`,
      [randomUUID(), code, machineId],
    );
  }

  // 4. Build signed license payload
  const activatedAt = new Date().toISOString();
  const expiresAt = calculateExpiry(codeRow.type as string);
  const payload: Omit<LicensePayload, 'signature'> = {
    code,
    machineId,
    type: codeRow.type as 'lifetime' | 'annual' | 'monthly',
    expiresAt,
    maxVersion: codeRow.maxVersion as string,
    maxDevices,
    activatedAt,
  };
  const signature = signLicense(payload);
  const license: LicensePayload = { ...payload, signature };

  return { success: true, license };
}

/** Deactivate a license on a machine (free a device slot). */
export async function deactivateLicenseCode(
  code: string,
  machineId: string,
): Promise<{ success: boolean; error?: string }> {
  await query(
    `UPDATE license_activations SET "deactivatedAt" = NOW()
     WHERE code = $1 AND "machineId" = $2 AND "deactivatedAt" IS NULL`,
    [code, machineId],
  );
  return { success: true };
}

/** List all license codes (admin). */
export async function listLicenseCodes(opts: { batch?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const limit = Math.min(opts.limit ?? 100, 1000);
  let sql = `
    SELECT lc.*,
      (SELECT COUNT(*) FROM license_activations la
       WHERE la.code = lc.code AND la."deactivatedAt" IS NULL) as activeDevices
    FROM license_codes lc
  `;
  const params: unknown[] = [];
  if (opts.batch) {
    sql += ` WHERE lc.batch = $1`;
    params.push(opts.batch);
  }
  sql += ` ORDER BY lc."createdAt" DESC LIMIT ${limit}`;
  const result = await query(sql, params);
  return result.rows as Record<string, unknown>[];
}

/** Get activation details for a code (admin). */
export async function getLicenseActivations(code: string): Promise<Record<string, unknown>[]> {
  const result = await query(
    `SELECT * FROM license_activations WHERE code = $1 ORDER BY "activatedAt" DESC`,
    [code],
  );
  return result.rows as Record<string, unknown>[];
}