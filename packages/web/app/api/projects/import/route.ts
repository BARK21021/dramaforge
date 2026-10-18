// 项目迁移导入：接收 Electron 已恢复本地媒体并改写 URL 后的元数据快照。
import type { NextRequest } from 'next/server';
import { importProjectSnapshot, ProjectTransferError } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';
import { readBodyWithLimit } from '@web/lib/sms-security';

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const body = await readBodyWithLimit<unknown>(request, MAX_SNAPSHOT_BYTES);
    if (!body.ok) return apiFail(body.payload, body.status);
    try {
      return apiSuccess(await importProjectSnapshot(auth.userId, body.body), 201);
    } catch (error) {
      if (error instanceof ProjectTransferError) {
        return apiFail({ error: error.message, code: 'PROJECT_TRANSFER_ERROR' }, error.statusCode);
      }
      throw error;
    }
  } catch (error) {
    return handleApiError(error, 'POST /api/projects/import');
  }
}
