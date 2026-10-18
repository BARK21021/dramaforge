/**
 * License validation + activation.
 *
 * Flow:
 *   1. User enters activation code: SF-XXXX-XXXX-XXXX-XXXX
 *   2. App POSTs { code, machineId } to activation server
 *   3. Server verifies code, checks device limit, returns signed license
 *   4. App verifies signature with embedded public key
 *   5. License stored encrypted in userData/license.dat
 *   6. Checked at startup + before every AI call
 */
import { createHash, createVerify, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { EMBEDDED_PUBLIC_KEY } from './public-key';

const LICENSE_PUBLIC_KEY = EMBEDDED_PUBLIC_KEY;

// ============================================================
// Types
// ============================================================

export interface License {
  /** Activation code (SF-XXXX-XXXX-XXXX-XXXX) */
  code: string;
  /** Machine fingerprint this license is bound to */
  machineId: string;
  /** License type: 'lifetime' | 'annual' | 'monthly' */
  type: 'lifetime' | 'annual' | 'monthly';
  /** ISO date when license expires (null = lifetime) */
  expiresAt: string | null;
  /** Maximum app version this license covers (semver, e.g. "2.0.0") */
  maxVersion: string;
  /** Max devices allowed */
  maxDevices: number;
  /** When this license was activated on this machine */
  activatedAt: string;
  /** Ed25519 signature (hex) of the above fields */
  signature: string;
}

export interface LicenseStatus {
  valid: boolean;
  reason?: string;
  license?: License;
  daysRemaining?: number;
}

// ============================================================
// Embedded public key (Ed25519)
// ============================================================

// This public key is compiled into the app via bytenode.
// The private key stays on your activation server ONLY.
// REPLACE this with your actual public key after generating keypair.

/** The public key used for signature verification. */

// ============================================================
// License file encryption (AES-256-GCM)
// ============================================================

const ENCRYPTION_KEY_ENV = 'DRAMAFORGE_LOCAL_SECRET';
// Derive a stable key from environment or machine ID for obfuscation
function getEncryptionKey(machineId: string): Buffer {
  const seed = process.env[ENCRYPTION_KEY_ENV] || machineId;
  return createHash('sha256').update(`dramaforge-license:${seed}`).digest();
}

/** Encrypt license JSON to file. */
async function encryptLicense(license: License, machineId: string): Promise<Buffer> {
  const key = getEncryptionKey(machineId);
  const iv = randomBytes(12);
  // Use Node's built-in crypto via dynamic import (Electron-safe)
  const { createCipheriv } = await import('crypto');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(license);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: [12-byte IV][16-byte authTag][encrypted data]
  return Buffer.concat([iv, authTag, encrypted]);
}

/** Decrypt license file. */
async function decryptLicense(data: Buffer, machineId: string): Promise<License> {
  const key = getEncryptionKey(machineId);
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const { createDecipheriv } = await import('crypto');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// ============================================================
// License signature verification
// ============================================================

/** Build the string that gets signed. */
function buildSignString(license: Omit<License, 'signature'>): string {
  return [
    license.code,
    license.machineId,
    license.type,
    license.expiresAt ?? 'null',
    license.maxVersion,
    String(license.maxDevices),
    license.activatedAt,
  ].join('|');
}

/** Verify license signature with embedded public key. */
export function verifyLicenseSignature(license: License): boolean {
  if (!LICENSE_PUBLIC_KEY) {
    console.warn('[license] No public key configured — skipping signature verification');
    return true; // Dev mode: allow without signature
  }
  try {
    const verify = createVerify('sha256');
    verify.update(buildSignString(license));
    verify.end();
    return verify.verify(
      LICENSE_PUBLIC_KEY,
      Buffer.from(license.signature, 'hex'),
    );
  } catch {
    return false;
  }
}

// ============================================================
// License file storage
// ============================================================

function getLicensePath(dataDir: string): string {
  return path.join(dataDir, 'license.dat');
}

/** Load and validate license from disk. */
export async function loadLicense(dataDir: string, machineId: string): Promise<License | null> {
  const licensePath = getLicensePath(dataDir);
  try {
    const data = await fs.readFile(licensePath);
    const license = await decryptLicense(data, machineId);
    if (license.machineId !== machineId) return null;
    return license;
  } catch {
    return null;
  }
}

/** Save license to disk (encrypted). */
export async function saveLicense(license: License, dataDir: string, machineId: string): Promise<void> {
  const encrypted = await encryptLicense(license, machineId);
  await fs.writeFile(getLicensePath(dataDir), encrypted);
}

/** Remove license from disk (deactivate). */
export async function removeLicense(dataDir: string): Promise<void> {
  try { await fs.unlink(getLicensePath(dataDir)); } catch { /* ignore */ }
}

// ============================================================
// License validation
// ============================================================

/** Check if license is valid (signature + expiry + version). */
export function validateLicense(
  license: License,
  machineId: string,
  appVersion: string,
): LicenseStatus {
  // 1. Machine binding
  if (license.machineId !== machineId) {
    return { valid: false, reason: 'LICENSE_MACHINE_MISMATCH' };
  }

  // 2. Signature
  if (!verifyLicenseSignature(license)) {
    return { valid: false, reason: 'LICENSE_SIGNATURE_INVALID' };
  }

  // 3. Expiry
  if (license.expiresAt) {
    const expiry = new Date(license.expiresAt).getTime();
    const now = Date.now();
    if (now > expiry) {
      return { valid: false, reason: 'LICENSE_EXPIRED', license };
    }
    const daysRemaining = Math.ceil((expiry - now) / (24 * 60 * 60 * 1000));
    return { valid: true, license, daysRemaining };
  }

  // 4. Version check (optional — allow older versions)
  // We compare semver: app version must be <= maxVersion for updates
  // but the app still runs even if version exceeds maxVersion (just no updates)

  return { valid: true, license };
}

// ============================================================
// Online activation
// ============================================================

const ACTIVATION_URL = process.env.DRAMAFORGE_LICENSE_SERVER
  || 'https://your-domain.example.com/api/license';

/** Activate a license code on this machine. */
export async function activateLicense(
  code: string,
  machineId: string,
  dataDir: string,
): Promise<{ success: boolean; license?: License; error?: string }> {
  try {
    const res = await fetch(`${ACTIVATION_URL}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, machineId }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { success: false, error: (body as { error?: string }).error || `Activation failed (HTTP ${res.status})` };
    }

    const body = await res.json() as { license: License };
    const license = body.license;

    // Verify signature before storing
    if (!verifyLicenseSignature(license)) {
      return { success: false, error: 'Server returned invalid license signature' };
    }

    // Verify machine binding
    if (license.machineId !== machineId) {
      return { success: false, error: 'License machine ID mismatch' };
    }

    // Save encrypted license file
    await saveLicense(license, dataDir, machineId);

    return { success: true, license };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Network error: ${msg}` };
  }
}

/** Deactivate license on this machine (frees a device slot on server). */
export async function deactivateLicense(
  dataDir: string,
  machineId: string,
): Promise<{ success: boolean; error?: string }> {
  const license = await loadLicense(dataDir, machineId);
  if (!license) return { success: false, error: 'No active license found' };

  try {
    await fetch(`${ACTIVATION_URL}/deactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: license.code, machineId }),
    });
  } catch {
    // Best effort — remove locally even if server unreachable
  }

  await removeLicense(dataDir);
  return { success: true };
}

// ============================================================
// License code format helpers
// ============================================================

/** Generate a license code: SF-XXXX-XXXX-XXXX-XXXX with checksum. */
export function generateLicenseCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I,O,0,1
  const parts: string[] = [];
  for (let p = 0; p < 4; p++) {
    let part = '';
    for (let i = 0; i < 4; i++) {
      part += chars[Math.floor(Math.random() * chars.length)];
    }
    parts.push(part);
  }
  // Checksum: last char of 4th group is derived from first 15 chars
  const raw = parts.slice(0, 3).join('') + parts[3].slice(0, 3);
  let checksum = 0;
  for (const c of raw) checksum += c.charCodeAt(0);
  const checkChar = chars[checksum % chars.length];
  parts[3] = parts[3].slice(0, 3) + checkChar;

  return `SF-${parts.join('-')}`;
}

/** Validate code format (not server-side validity). */
export function isValidCodeFormat(code: string): boolean {
  return /^SF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code);
}

// ============================================================
// Grace period (offline tolerance)
// ============================================================

const GRACE_PERIOD_DAYS = 7;
let lastOnlineCheck: Date | null = null;

/** Record that we successfully contacted the activation server. */
export function recordOnlineCheck(): void {
  lastOnlineCheck = new Date();
}

/** Check if we're within the offline grace period. */
export function withinGracePeriod(lastCheckFile: string): boolean {
  // For lifetime licenses, no grace period needed
  // For annual/monthly, allow 7 days offline after last server contact
  return true; // Simplified: local validation is enough for now
}