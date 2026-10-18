// 项目迁移导出：只返回当前用户项目的结构化快照，媒体字节由桌面客户端打包。
import { exportProjectSnapshot, ProjectTransferError } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { id } = await params;
    try {
      return apiSuccess(await exportProjectSnapshot(auth.userId, id));
    } catch (error) {
      if (error instanceof ProjectTransferError) {
        return apiFail({ error: error.message, code: 'PROJECT_TRANSFER_ERROR' }, error.statusCode);
      }
      throw error;
    }
  } catch (error) {
    return handleApiError(error, 'GET /api/projects/[id]/transfer');
  }
}
