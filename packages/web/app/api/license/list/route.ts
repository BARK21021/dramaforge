import type { NextRequest } from 'next/server';
import { listLicenseCodes, getLicenseActivations, ensureLicenseTables } from '@dramaforge/server';
import { requireAdmin, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** GET /api/license/list  admin lists all license codes + activations. */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireAdmin();
    if (!auth) throw new AuthError('Admin access required', 403, 'FORBIDDEN');

    await ensureLicenseTables();
    const url = new URL(req.url);
    const batch = url.searchParams.get('batch') ?? undefined;
    const codes = await listLicenseCodes({ batch });

    // Optionally get activations for a specific code
    const code = url.searchParams.get('code');
    if (code) {
      const activations = await getLicenseActivations(code);
      return apiSuccess({ codes, activations });
    }

    return apiSuccess({ codes });
  } catch (err) {
    return handleApiError(err, 'GET /api/license/list');
  }
}