import type { NextRequest } from 'next/server';
import { activateLicenseCode, ensureLicenseTables } from '@dramaforge/server';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** POST /api/license/activate  activate a license code on this machine. */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    await ensureLicenseTables();
    const body = await req.json() as { code?: string; machineId?: string };
    if (!body.code || !body.machineId) {
      return apiFail({ error: 'Missing code or machineId', code: 'BAD_REQUEST' }, 400);
    }

    const result = await activateLicenseCode(body.code, body.machineId);
    if (!result.success) {
      const status = result.error === 'INVALID_CODE' ? 404
        : result.error === 'MAX_DEVICES_REACHED' ? 403
        : 400;
      return apiFail({ error: result.error ?? 'Activation failed', code: result.error ?? 'ACTIVATION_FAILED' }, status);
    }

    return apiSuccess({ license: result.license });
  } catch (err) {
    return handleApiError(err, 'POST /api/license/activate');
  }
}