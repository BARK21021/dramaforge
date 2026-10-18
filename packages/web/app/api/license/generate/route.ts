import type { NextRequest } from 'next/server';
import { generateLicenseBatch, ensureLicenseTables } from '@dramaforge/server';
import { requireAdmin, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** POST /api/license/generate  admin generates a batch of license codes. */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const auth = await requireAdmin();
    if (!auth) throw new AuthError('Admin access required', 403, 'FORBIDDEN');

    await ensureLicenseTables();
    const body = await req.json().catch(() => ({})) as {
      count?: number;
      type?: 'lifetime' | 'annual' | 'monthly';
      maxVersion?: string;
      maxDevices?: number;
      batch?: string;
      note?: string;
    };

    const count = Math.min(Math.max(body.count ?? 1, 1), 1000);
    const codes = await generateLicenseBatch(count, {
      type: body.type,
      maxVersion: body.maxVersion,
      maxDevices: body.maxDevices,
      batch: body.batch,
      note: body.note,
      createdBy: auth.userId,
    });

    return apiSuccess({ codes, count: codes.length });
  } catch (err) {
    return handleApiError(err, 'POST /api/license/generate');
  }
}