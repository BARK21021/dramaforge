// ============================================================
// GET/POST /api/projects/[id]/assets — 项目资产列表 + 创建（P7.2-T2b + 批5 POST）
// ============================================================
//
// 列出项目下所有资产（CHARACTER/PROP/LOCATION/ENTITY），可选 ?kind= 过滤；
// 或手动创建一个新资产（POST，kind 白名单 CHARACTER/PROP/LOCATION/ENTITY）。
// 供 workspace 资产面板初始加载 + 提取后刷新 + 手动添加。资产项目级归属。
//
// 鉴权：session REQUIRED。ownership 校验项目归属。
// 响应：
//   GET  200 { success:true, data: { assets } } / 401 / 404
//   POST 200 { success:true, data: { asset } } / 400 VALIDATION_ERROR / 401 / 404 / 409 DUPLICATE
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  projectRepo,
  listAssets,
  createAsset,
  type AssetRecord,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

const ALLOWED_KINDS = new Set(['CHARACTER', 'PROP', 'LOCATION', 'ENTITY']);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;

    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 可选 ?kind= 过滤（白名单，ENTITY 批5 纳入）
    const url = new URL(_req.url);
    const kindParam = url.searchParams.get('kind');
    const kind =
      kindParam && ALLOWED_KINDS.has(kindParam.toUpperCase())
        ? kindParam.toUpperCase()
        : undefined;

    const assets: AssetRecord[] = await listAssets(projectId, kind);
    return apiSuccess({ assets });
  } catch (err) {
    return handleApiError(err, 'GET /api/projects/[id]/assets');
  }
}

/**
 * POST /api/projects/[id]/assets — 手动创建资产（对齐 app1 assets/route.ts）。
 *
 * body: { kind, name, description?, imageUrl?, metadata?, tags?, assetType?, basePrompt?, isConfirmed? }
 * kind 白名单：CHARACTER/PROP/LOCATION/ENTITY（批5 纳入 ENTITY）。
 * 校验交由 server domain validateAssetCreate（createAsset 内部跑）。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;

    // ownership：项目归属
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 解 body（容错）
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return apiFail({ error: '请求体必须为对象', code: 'VALIDATION_ERROR', category: 'validation' }, 400);
    }
    const b = raw as Record<string, unknown>;

    // kind 白名单 + name 必填（前置校验，避免 createAsset 抛通用 Error）
    const kind = typeof b.kind === 'string' ? b.kind.toUpperCase() : '';
    if (!kind || !ALLOWED_KINDS.has(kind)) {
      return apiFail(
        { error: `kind 必须为白名单值: ${Array.from(ALLOWED_KINDS).join('/')}`, code: 'VALIDATION_ERROR', category: 'validation' },
        400,
      );
    }
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) {
      return apiFail({ error: 'name 不能为空', code: 'VALIDATION_ERROR', category: 'validation' }, 400);
    }

    // 调 server domain 创建（validateAssetCreate 在其内部跑，失败抛 Error）
    let created: AssetRecord;
    try {
      created = await createAsset({
        projectId,
        kind,
        name,
        description: typeof b.description === 'string' ? b.description : null,
        imageUrl: typeof b.imageUrl === 'string' ? b.imageUrl : null,
        metadata:
          b.metadata && typeof b.metadata === 'object' && !Array.isArray(b.metadata)
            ? (b.metadata as Record<string, unknown>)
            : null,
        tags: Array.isArray(b.tags) && b.tags.every((t) => typeof t === 'string')
          ? (b.tags as string[])
          : null,
        assetType: typeof b.assetType === 'string' ? b.assetType : null,
        basePrompt: typeof b.basePrompt === 'string' ? b.basePrompt : null,
        isConfirmed: typeof b.isConfirmed === 'boolean' ? b.isConfirmed : false,
      });
    } catch (err) {
      return apiFail(
        { error: err instanceof Error ? err.message : '资产创建失败', code: 'VALIDATION_ERROR', category: 'validation' },
        400,
      );
    }

    return apiSuccess({ asset: created });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/assets');
  }
}
