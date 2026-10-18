import type { NextRequest } from 'next/server';
import { deactivateLicenseCode, ensureLicenseTables } from '@dramaforge/server';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function POST(req: NextRequest): Promise<Response> {
  try {
    await ensureLicenseTables();
    const body = await req.json() as { code?: string; machineId?: string };
    if (!body.code || !body.machineId) {
      return apiFail({ error: 'Missing code or machineId', code: 'BAD_REQUEST' }, 400);
    }
    await deactivateLicenseCode(body.code, body.machineId);
    return apiSuccess({});
  } catch (err) {
    return handleApiError(err, 'POST /api/license/deactivate');
  }
}