// ============================================================
// PATCH/DELETE /api/projects/[id]/assets/[assetId] — 资产部分更新 + 删除（P7.3 批0.5 + 批5）
// ============================================================
//
// 配套 generate-image：那条路由同步 callAI 拿 provider 临时图 URL（ARK TOS 1h
// 过期）后**故意不落 DB**（避免存过期 URL）。客户端（Electron）拿到 URL 后
// 自行下载到本地硬盘 → 拿到 sf-asset://<key>.png 持久 URL → 本路由 PATCH 回写
// imageUrl=sf-asset://...，从此显示本地不过期（契合 dramaforge-assets-client-local）。
//
// 字段白名单严格对齐 server AssetUpdatePatch（validation.ts）：
//   imageUrl / regenLocked / name / description / metadata / tags / assetType /
//   basePrompt / isConfirmed / voiceId / voiceSource / auditionStatus
//   + 批5 MUST 富字段：background / voiceTrait / identityLock / significance /
//     intExt / mood / baseAmbience / coverageScenes（CHARACTER 富字段 A11c 核心）
// 仅转发 body 中出现的字段（部分更新语义）；其余一律丢弃。
//
// DELETE：调 deleteAsset service（幂等：不存在不抛错）。
//
// 鉴权：session REQUIRED + 项目 ownership + 资产属于项目（统一 404，不泄露存在性）。
// 响应（UI-facing envelope）：
//   PATCH 200 { success:true, data: { asset } } / 400 VALIDATION_ERROR / 401 / 404 / 500
//   DELETE 200 { success:true, data: { deletedId } } / 401 / 404
//
// web 禁止 import ffmpeg。零 ffmpeg 依赖。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  getAsset,
  projectRepo,
  updateAsset,
  updateAssetCostumesPreservingImages,
  deleteAsset,
  renameAsset,
  type AssetRecord,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/**
 * 与 server/domain/asset/validation.ts 的 AssetUpdatePatch 同构的最小类型。
 * 复制而非 import：AssetUpdatePatch 未从 @dramaforge/server 的 index 导出（只导出
 * AssetRecord）。此处列 PATCH route 实际会透传的字段，结构对齐 validation.ts。
 * 若 server 端字段调整，需同步本类型 + pickPatch（grep "AssetUpdatePatch" 即可定位）。
 */
interface AssetUpdatePatch {
  name?: string;
  description?: string | null;
  imageUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[] | null;
  assetType?: string | null;
  basePrompt?: string | null;
  isConfirmed?: boolean;
  regenLocked?: boolean;
  voiceId?: string | null;
  voiceSource?: string | null;
  auditionStatus?: string;
  // 批5 MUST 富字段
  background?: string | null;
  voiceTrait?: string | null;
  identityLock?: string[] | null;
  significance?: string | null;
  intExt?: string | null;
  mood?: string | null;
  baseAmbience?: string | null;
  coverageScenes?: string[] | null;
  /** 资产设计开关与服务层更新契约保持一致。 */
  gridOverlayEnabled?: boolean | null;
  pencilPaintEnabled?: boolean | null;
  /** 变体（costumes JSONB）：手动新增/编辑/删除时段变体，整体替换。 */
  costumes?: Record<string, unknown>[] | null;
}

/**
 * body 字段白名单 → AssetUpdatePatch 字段映射器。
 *
 * 仅从 raw body 中挑出 AssetUpdatePatch 允许的字段并做最小类型收窄：
 *   - 字符串字段：非空 string 才采纳（null/undefined 透传需显式判断）
 *   - 布尔字段：仅 true/false 采纳
 *   - 数组 / 对象字段：仅对应 JS 类型采纳
 *
 * 任何无法识别的字段、类型不符的值，一律丢弃（不抛 400），由 server 端
 * validateAssetUpdate 做最终业务校验（assetType / voiceSource / auditionStatus
 * 白名单等）。这样客户端"多发字段"不会炸，"发错类型"由 server 兜底。
 */
function pickPatch(raw: unknown): AssetUpdatePatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const b = raw as Record<string, unknown>;
  const patch: AssetUpdatePatch = {};

  // 字符串 / 可空字符串字段
  if (typeof b.imageUrl === 'string') patch.imageUrl = b.imageUrl;
  else if (b.imageUrl === null) patch.imageUrl = null;

  if (typeof b.name === 'string') patch.name = b.name;

  if (typeof b.description === 'string') patch.description = b.description;
  else if (b.description === null) patch.description = null;

  if (typeof b.basePrompt === 'string') patch.basePrompt = b.basePrompt;
  else if (b.basePrompt === null) patch.basePrompt = null;

  if (typeof b.assetType === 'string') patch.assetType = b.assetType;
  else if (b.assetType === null) patch.assetType = null;

  if (typeof b.voiceId === 'string') patch.voiceId = b.voiceId;
  else if (b.voiceId === null) patch.voiceId = null;

  if (typeof b.voiceSource === 'string') patch.voiceSource = b.voiceSource;
  else if (b.voiceSource === null) patch.voiceSource = null;

  if (typeof b.auditionStatus === 'string') patch.auditionStatus = b.auditionStatus;

  // 批5 MUST 富字段（可空字符串）：background/voiceTrait/significance/intExt/mood/baseAmbience
  const nullableStrings: Array<keyof AssetUpdatePatch> = [
    'background',
    'voiceTrait',
    'significance',
    'intExt',
    'mood',
    'baseAmbience',
  ];
  for (const field of nullableStrings) {
    const v = b[field as string];
    if (typeof v === 'string') {
      (patch as Record<string, unknown>)[field as string] = v;
    } else if (v === null) {
      (patch as Record<string, unknown>)[field as string] = null;
    }
  }

  // 布尔字段
  if (typeof b.regenLocked === 'boolean') patch.regenLocked = b.regenLocked;
  if (typeof b.isConfirmed === 'boolean') patch.isConfirmed = b.isConfirmed;
  if (typeof b.gridOverlayEnabled === 'boolean' || b.gridOverlayEnabled === null) {
    patch.gridOverlayEnabled = b.gridOverlayEnabled as boolean | null;
  }
  if (typeof b.pencilPaintEnabled === 'boolean' || b.pencilPaintEnabled === null) {
    patch.pencilPaintEnabled = b.pencilPaintEnabled as boolean | null;
  }

  // 数组 / 对象字段
  // I5 纵深防御:tags 元素必须全字符串,否则丢弃(server validation.ts 是
  // 最终兜底,这里提前过滤避免脏数组穿透到 service 层)。
  if (Array.isArray(b.tags)) {
    if (b.tags.every((t) => typeof t === 'string')) patch.tags = b.tags as string[];
  } else if (b.tags === null) patch.tags = null;

  // 批5 MUST 字段：identityLock / coverageScenes（可空字符串数组）
  const nullableStringArrays: Array<keyof AssetUpdatePatch> = ['identityLock', 'coverageScenes'];
  for (const field of nullableStringArrays) {
    const v = b[field as string];
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === 'string')) {
        (patch as Record<string, unknown>)[field as string] = v as string[];
      }
    } else if (v === null) {
      (patch as Record<string, unknown>)[field as string] = null;
    }
  }

  // 变体 costumes（JSONB 对象数组）：手动新增/编辑/删除时段变体，整体替换。
  if (Array.isArray(b.costumes)) {
    patch.costumes = b.costumes as Record<string, unknown>[];
  } else if (b.costumes === null) {
    patch.costumes = null;
  }

  if (b.metadata !== undefined) {
    if (b.metadata === null || (typeof b.metadata === 'object' && !Array.isArray(b.metadata))) {
      patch.metadata = b.metadata as Record<string, unknown> | null;
    }
  }

  return patch;
}

/** ownership + 资产归属校验（PATCH/DELETE 共用，统一 404 不泄露存在性）。 */
async function authorizeAsset(
  authUserId: string,
  projectId: string,
  assetId: string,
): Promise<Response | { asset: AssetRecord }> {
  const project = await projectRepo.getById(projectId);
  if (!project || project.userId !== authUserId) {
    return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
  }
  const asset = await getAsset(assetId);
  if (!asset || asset.projectId !== projectId) {
    return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
  }
  return { asset };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, assetId } = await params;

    // 1. ownership + 资产归属
    const authz = await authorizeAsset(auth.userId, projectId, assetId);
    if (authz instanceof Response) return authz;

    // 2. 解 body + 白名单收窄（容忍非 JSON / 非对象 body → 当空对象处理）
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    const patch = pickPatch(raw);

    // 3. 空补丁短路：updateAsset 本身会返回当前资产，但客户端更可能是发错 body；
    //    直接 400 暴露问题，避免静默成功让客户端以为已更新。
    const hasAnyField =
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.imageUrl !== undefined ||
      patch.metadata !== undefined ||
      patch.tags !== undefined ||
      patch.assetType !== undefined ||
      patch.basePrompt !== undefined ||
      patch.isConfirmed !== undefined ||
      patch.regenLocked !== undefined ||
      patch.voiceId !== undefined ||
      patch.voiceSource !== undefined ||
      patch.auditionStatus !== undefined ||
      patch.background !== undefined ||
      patch.voiceTrait !== undefined ||
      patch.identityLock !== undefined ||
      patch.significance !== undefined ||
      patch.intExt !== undefined ||
      patch.mood !== undefined ||
      patch.baseAmbience !== undefined ||
      patch.coverageScenes !== undefined ||
      patch.costumes !== undefined ||
      patch.gridOverlayEnabled !== undefined ||
      patch.pencilPaintEnabled !== undefined;
    if (!hasAnyField) {
      return apiFail(
        { error: '补丁为空（未提供任何可更新字段）', code: 'VALIDATION_ERROR', category: 'validation' },
        400,
      );
    }

    // 4. name 必须走级联改名 Interface，禁止 generic PATCH 绕过名称传播事务。
    let updated: AssetRecord;
    try {
      if (patch.name !== undefined && patch.name.trim() !== authz.asset.name) {
        await renameAsset(projectId, assetId, patch.name);
      }
      const { name: _name, costumes, ...nonNamePatch } = patch;
      updated = costumes !== undefined
        ? await updateAssetCostumesPreservingImages(assetId, projectId, costumes)
        : (await getAsset(assetId))!;
      if (Object.keys(nonNamePatch).length > 0) {
        updated = await updateAsset(assetId, nonNamePatch);
      }
    } catch (err) {
      return apiFail(
        {
          error: err instanceof Error ? err.message : '资产更新校验失败',
          code: 'VALIDATION_ERROR',
          category: 'validation',
        },
        400,
      );
    }

    return apiSuccess({ asset: updated });
  } catch (err) {
    return handleApiError(err, 'PATCH /api/projects/[id]/assets/[assetId]');
  }
}

/**
 * DELETE /api/projects/[id]/assets/[assetId] — 删除资产（对齐 app1）。
 *
 * 鉴权同 PATCH：session REQUIRED + 项目 ownership + 资产属于项目（统一 404）。
 * deleteAsset 幂等（不存在不抛错），但此处先做 ownership 校验避免泄露存在性。
 * 删除后，引用该资产的分镜仍保留名称引用（app1 同语义）。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, assetId } = await params;

    // ownership + 资产归属
    const authz = await authorizeAsset(auth.userId, projectId, assetId);
    if (authz instanceof Response) return authz;

    await deleteAsset(assetId);
    return apiSuccess({ deletedId: assetId });
  } catch (err) {
    return handleApiError(err, 'DELETE /api/projects/[id]/assets/[assetId]');
  }
}
