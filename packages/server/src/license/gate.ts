/**
 * License gate - guards AI calls and app startup.
 *
 * Usage in Electron main process:
 *   import { checkLicenseGate } from '@dramaforge/local-server/license';
 *   const status = await checkLicenseGate(dataDir, appVersion);
 *   if (!status.valid) { showActivationDialog(); }
 *
 * Usage in AI gateway (before calling ARK/Seedance):
 *   import { isLicenseActive } from '@dramaforge/local-server/license';
 *   if (!isLicenseActive()) throw new Error('LICENSE_REQUIRED');
 */
import { getMachineId } from './fingerprint';
import { loadLicense, validateLicense, type LicenseStatus } from './index';

let activeLicense: LicenseStatus | null = null;

/** Full license check: load from disk + validate. Call at startup. */
export async function checkLicenseGate(
  dataDir: string,
  appVersion: string,
): Promise<LicenseStatus> {
  const machineId = getMachineId();
  const license = await loadLicense(dataDir, machineId);
  if (!license) {
    const status: LicenseStatus = { valid: false, reason: 'NO_LICENSE' };
    activeLicense = status;
    return status;
  }
  const status = validateLicense(license, machineId, appVersion);
  activeLicense = status;
  return status;
}

/** Quick check: is there a valid active license? Call before AI calls. */
export function isLicenseActive(): boolean {
  return activeLicense?.valid === true;
}

/** Get current license status (null if not yet checked). */
export function getLicenseStatus(): LicenseStatus | null {
  return activeLicense;
}

/** Clear license state (logout/deactivate). */
export function clearLicenseState(): void {
  activeLicense = null;
}