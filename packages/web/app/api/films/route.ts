import { listUserFilms } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, handleApiError } from '@web/lib/response';

/** GET /api/films — 当前用户跨项目、经整集完成度门禁后的最终成片。 */
export async function GET(): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }
    return apiSuccess(await listUserFilms(auth.userId));
  } catch (error) {
    return handleApiError(error, 'GET /api/films');
  }
}
