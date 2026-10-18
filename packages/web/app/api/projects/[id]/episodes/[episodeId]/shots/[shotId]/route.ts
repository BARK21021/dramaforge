// ============================================================
// PATCH /api/projects/[id]/episodes/[episodeId]/shots/[shotId] — 更新单镜（批6 Step 3，OP1）
// ============================================================
//
// 镜像 app1 PATCH /api/projects/[projectId]/shots/[shotId]/route.ts:46-71（直接
// prisma.update with `{...body}`），但 dramaforge 必须做 metadata read-merge-write
// （OP1）：app1 Shot 顶层有 description/shotSize/cameraMovement/dialogue 列，
// dramaforge ShotRecord 无此 4 列，存 metadata JSONB。直接透传 body 会静默丢字段，
// 用户编辑刷新后丢失。
//
// 映射策略：
//   - visualPrompt / durationSeconds：透传 ShotUpdatePatch 顶层列（dramaforge 有）
//   - videoStatus / currentMaterialId / currentMaterialUrl：透传生成状态列；可空素材
//     字段用于重制前清理旧结果
//   - description / dialogue：合并到 metadata 顶层（metadata.description / .dialogue）
//   - shotSize / cameraMovement：合并到 metadata.storyboardTable（与 S9 多源
//     兜底读取对齐：metadata.storyboardTable.shotSize / .cameraMovement）
//   - metadata / errorMessage：与现有 metadata 浅合并，保存组提示词时不覆盖其他键
//
// read-merge-write 流程：
//   1. getShot(shotId) 读现有 metadata + storyboardTable
//   2. 浅合并（{...existing, ...newFields}，storyboardTable 同款两层合并）
//   3. patch.metadata = nextMeta（updateShot 内部 JSON.stringify）
//
// 鉴权：session REQUIRED + 项目 ownership + 镜头属于 project + episode（统一 404）。
// 响应：200 { success:true, data: { shot } } / 400 VALIDATION_ERROR / 401 / 404 / 500
//
// GC-5：纯 metadata JSONB 合并，无新 .sql 列。
// GC-6：OP1 行为等价 app1（用户编辑后刷新数据保留）。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  projectRepo,
  getShot,
  updateShot,
  listAssets,
  normalizeAssetName,
  validateReferencedAssetsShape,
  type ShotRecord,
  type ShotUpdatePatch,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

interface PatchBody {
  description?: string;
  visualPrompt?: string;
  shotSize?: string;
  durationSeconds?: number;
  cameraMovement?: string;
  /** 机位角度（2026-07-28 补，原仅只读解析）。并入 metadata.storyboardTable.cameraAngle。 */
  cameraAngle?: string;
  dialogue?: string;
  videoStatus?: string;
  currentMaterialId?: string | null;
  currentMaterialUrl?: string | null;
  /**
   * 单镜头资产重绑：覆盖该镜头引用的角色/场景/道具名（按资产库挑选）。传 null 清空。
   * 名字必须在项目资产库中存在（路由层校验），否则 400 REFERENCED_ASSET_NOT_FOUND。
   */
  referencedAssets?: {
    characters?: string[];
    speakingCharacters?: string[];
    environments?: string[];
    items?: string[];
    /**
     * 角色→造型手动覆盖（批7）。name 必须 ∈ characters（validation 校验子集），
     * costumeKey 必须真实存在于该角色资产 costumes[]（route 校验，否则 400
     * REFERENCED_COSTUME_NOT_FOUND）。default costumeKey 在 route 层 sanitize 剔除
     * （选默认 = 删条目，走自动匹配/默认图）。
     */
    characterCostumes?: CharacterCostumeRef[];
  } | null;
  metadata?: Record<string, unknown>;
  errorMessage?: string | null;
}

/**
 * 角色→造型手动覆盖条目（批7）。
 *
 * 口径对齐 shot-asset-reference.ts 的 CharacterCostumeRef 与
 * server/domain/storyboard/validation.ts 的同名导出（按「不跨域导入」约定就地同构，
 * 修改时三处同步）。
 */
interface CharacterCostumeRef {
  name: string;
  costumeKey: string;
}

/**
 * 是否为 default 造型 key（口径对齐 shot-asset-reference.ts:isDefaultCostumeKey 与
 * validation.ts；就地复制避免 web→server-内部模块跨域导入）。
 */
function isDefaultCostumeKey(key: string | undefined | null): boolean {
  return !key || /^(default|默认)$/i.test(key);
}

/** referencedAssets 各字段 → asset kind（与 resolver/chain-generate 的 characters→CHARACTER、
 *  environments→LOCATION、items→PROP 映射一致）。 */
const REFERENCED_FIELD_KIND: Record<'characters' | 'environments' | 'items', 'CHARACTER' | 'LOCATION' | 'PROP'> = {
  characters: 'CHARACTER',
  environments: 'LOCATION',
  items: 'PROP',
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string; shotId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId, episodeId, shotId } = await params;

    // 1. ownership + 镜头归属（project + episode 都校验，统一 404）
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const shot = await getShot(shotId);
    if (!shot || shot.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    if (shot.episodeId && shot.episodeId !== episodeId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 2. 解 body（容忍非 JSON / 非对象 body → 空对象处理）
    let body: PatchBody;
    try {
      const raw = (await req.json()) as unknown;
      body = (raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as PatchBody)
        : {}) as PatchBody;
    } catch {
      body = {};
    }

    // 3. 映射 ShotUpdatePatch + metadata read-merge-write（OP1 核心）
    const patch: ShotUpdatePatch = {};

    // 顶层列透传
    if (typeof body.visualPrompt === 'string') patch.visualPrompt = body.visualPrompt;
    if (
      typeof body.durationSeconds === 'number' &&
      Number.isFinite(body.durationSeconds) &&
      body.durationSeconds > 0
    ) {
      patch.durationSeconds = body.durationSeconds;
    }
    if (typeof body.videoStatus === 'string') patch.videoStatus = body.videoStatus;
    if (typeof body.currentMaterialId === 'string' || body.currentMaterialId === null) {
      patch.currentMaterialId = body.currentMaterialId;
    }
    if (typeof body.currentMaterialUrl === 'string' || body.currentMaterialUrl === null) {
      patch.currentMaterialUrl = body.currentMaterialUrl;
    }

    // referencedAssets：单镜头资产重绑（顶层 JSONB 列，非 metadata 合并）。
    // 先结构校验（纯函数），再名字解析校验（每个名字必须命中同 kind 真实资产——
    // 这是"重绑不破坏绑定"的硬保证，杜绝 reintroduce 一个 resolver 解析不到的空槽位）。
    if (body.referencedAssets !== undefined) {
      if (body.referencedAssets === null) {
        patch.referencedAssets = null;
      } else {
        const refsRaw = body.referencedAssets as Record<string, unknown>;
        const shape = validateReferencedAssetsShape(refsRaw);
        if (!shape.valid) {
          return apiFail(
            { error: shape.errors.join('; '), code: 'VALIDATION_ERROR', category: 'validation' },
            400,
          );
        }
        // 建 kind:normalizedName → 规范名 索引（与 resolver 同口径，first-one-wins）。
        const projectAssets = await listAssets(projectId);
        const canonicalName = new Map<string, string>();
        for (const a of projectAssets) {
          const key = `${a.kind}:${normalizeAssetName(a.name)}`;
          if (!canonicalName.has(key)) canonicalName.set(key, a.name);
        }
        const normalizeList = (raw: unknown): string[] =>
          (Array.isArray(raw) ? raw : [])
            .map((n) => (typeof n === 'string' ? n.trim() : ''))
            .filter(Boolean);
        // 把字段名数组解析为规范名数组；任一名字未命中同 kind 资产则返回报错文案。
        const resolveField = (
          field: 'characters' | 'environments' | 'items' | 'speakingCharacters',
          kind: 'CHARACTER' | 'LOCATION' | 'PROP',
        ): { names?: string[]; error?: string } => {
          if (refsRaw[field] === undefined) return {};
          const names = normalizeList(refsRaw[field]);
          const missing = names.filter((n) => !canonicalName.has(`${kind}:${normalizeAssetName(n)}`));
          if (missing.length > 0) {
            return { error: `引用的资产不存在（${field}）: ${missing.join('、')}` };
          }
          return { names: names.map((n) => canonicalName.get(`${kind}:${normalizeAssetName(n)}`)!) };
        };

        const nextRefs: Record<string, unknown> = {};
        const fieldKinds: Array<{ field: 'characters' | 'environments' | 'items'; kind: 'CHARACTER' | 'LOCATION' | 'PROP' }> = [
          { field: 'characters', kind: REFERENCED_FIELD_KIND.characters },
          { field: 'environments', kind: REFERENCED_FIELD_KIND.environments },
          { field: 'items', kind: REFERENCED_FIELD_KIND.items },
        ];
        for (const { field, kind } of fieldKinds) {
          const r = resolveField(field, kind);
          if (r.error) {
            return apiFail(
              { error: r.error, code: 'REFERENCED_ASSET_NOT_FOUND', category: 'validation' },
              400,
            );
          }
          if (r.names) nextRefs[field] = r.names;
        }
        // speakingCharacters：结构校验已保证 ⊆ characters；这里只做名字解析 + 规范化。
        if (refsRaw.speakingCharacters !== undefined) {
          const r = resolveField('speakingCharacters', 'CHARACTER');
          if (r.error) {
            return apiFail(
              { error: r.error, code: 'REFERENCED_ASSET_NOT_FOUND', category: 'validation' },
              400,
            );
          }
          if (r.names) nextRefs.speakingCharacters = r.names;
        }
        // characterCostumes（批7）：名字规范化 + costumeKey 存在性校验 + default sanitize。
        // validation 已校验形状/唯一/子集；route 负责「key 真实属于该资产 costumes[]」，
        // 否则 400 REFERENCED_COSTUME_NOT_FOUND。default costumeKey 剔除（选默认=删条目）。
        if (refsRaw.characterCostumes !== undefined) {
          const rawCc = Array.isArray(refsRaw.characterCostumes) ? refsRaw.characterCostumes : [];
          // CHARACTER 规范名 → 该资产 costumes key 集合（first-one-wins，与 canonicalName 同口径）。
          const characterCostumeKeys = new Map<string, Set<string>>();
          for (const a of projectAssets) {
            if (a.kind !== 'CHARACTER') continue;
            const canon = canonicalName.get(`CHARACTER:${normalizeAssetName(a.name)}`);
            if (!canon || characterCostumeKeys.has(canon)) continue;
            const costumes = Array.isArray(a.costumes) ? a.costumes : [];
            const keys = new Set<string>();
            for (const c of costumes) {
              const k = (c as { key?: unknown }).key;
              if (typeof k === 'string' && k.trim()) keys.add(k.trim());
            }
            characterCostumeKeys.set(canon, keys);
          }
          const sanitized: CharacterCostumeRef[] = [];
          for (const item of rawCc) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const nameRaw = (item as { name?: unknown }).name;
            const keyRaw = (item as { costumeKey?: unknown }).costumeKey;
            if (typeof nameRaw !== 'string' || typeof keyRaw !== 'string') continue;
            const name = nameRaw.trim();
            const costumeKey = keyRaw.trim();
            if (!name || !costumeKey) continue;
            const canon = canonicalName.get(`CHARACTER:${normalizeAssetName(name)}`);
            if (!canon) {
              return apiFail(
                { error: `引用的角色不存在：${name}`, code: 'REFERENCED_ASSET_NOT_FOUND', category: 'validation' },
                400,
              );
            }
            if (isDefaultCostumeKey(costumeKey)) continue; // default = 删条目
            const keys = characterCostumeKeys.get(canon);
            if (!keys || !keys.has(costumeKey)) {
              return apiFail(
                {
                  error: `角色「${canon}」不存在造型 key：${costumeKey}`,
                  code: 'REFERENCED_COSTUME_NOT_FOUND',
                  category: 'validation',
                },
                400,
              );
            }
            sanitized.push({ name: canon, costumeKey });
          }
          nextRefs.characterCostumes = sanitized;
        }
        // 道具/环境变体引用（itemCostumes/environmentCostumes）：分镜 UI 不编辑这两个字段，
        // 故前端草稿通常不含它们。为避免"手动重绑镜头资产就抹掉 AI 指定的变体赋值"，
        // 沿用既有 shot 的赋值（调用方显式提供则尊重 incoming），并剔除已不再引用的资产、
        // 以及 costumeKey 不属于该资产 costumes[] 的悬空条目。default key 视为无变体（不入库）。
        const prevRefs = (shot.referencedAssets && typeof shot.referencedAssets === 'object'
          && !Array.isArray(shot.referencedAssets))
          ? shot.referencedAssets as Record<string, unknown>
          : {};
        const variantKeySets = new Map<string, Set<string>>(); // `${kind}:${canon}` → 该资产合法 costumeKey
        for (const a of projectAssets) {
          if (a.kind !== 'PROP' && a.kind !== 'LOCATION') continue;
          const canon = canonicalName.get(`${a.kind}:${normalizeAssetName(a.name)}`);
          if (!canon || variantKeySets.has(`${a.kind}:${canon}`)) continue;
          const costumes = Array.isArray(a.costumes) ? a.costumes : [];
          const keys = new Set<string>();
          for (const c of costumes) {
            const k = (c as { key?: unknown }).key;
            if (typeof k === 'string' && k.trim()) keys.add(k.trim());
          }
          variantKeySets.set(`${a.kind}:${canon}`, keys);
        }
        const preserveVariantCostumes = (
          field: 'itemCostumes' | 'environmentCostumes',
          kind: 'PROP' | 'LOCATION',
          keepNames: string[],
        ): void => {
          const incomingRaw = Array.isArray(refsRaw[field])
            ? (refsRaw[field] as Array<{ name?: unknown; costumeKey?: unknown }>)
            : null;
          const source = incomingRaw
            ?? (Array.isArray(prevRefs[field])
              ? (prevRefs[field] as Array<{ name?: unknown; costumeKey?: unknown }>)
              : []);
          const keep = new Set(keepNames.map(normalizeAssetName));
          const kept: CharacterCostumeRef[] = [];
          const seen = new Set<string>();
          for (const entry of source) {
            if (!entry || typeof entry !== 'object') continue;
            const nameRaw = entry.name;
            const keyRaw = entry.costumeKey;
            if (typeof nameRaw !== 'string' || typeof keyRaw !== 'string') continue;
            const name = nameRaw.trim();
            const costumeKey = keyRaw.trim();
            if (!name || !costumeKey || isDefaultCostumeKey(costumeKey)) continue;
            const canon = canonicalName.get(`${kind}:${normalizeAssetName(name)}`);
            if (!canon || !keep.has(normalizeAssetName(canon))) continue;
            const keys = variantKeySets.get(`${kind}:${canon}`);
            if (!keys || !keys.has(costumeKey)) continue;
            const dedupe = normalizeAssetName(canon);
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            kept.push({ name: canon, costumeKey });
          }
          if (kept.length > 0) nextRefs[field] = kept;
        };
        preserveVariantCostumes('itemCostumes', 'PROP', (nextRefs.items as string[]) ?? []);
        preserveVariantCostumes('environmentCostumes', 'LOCATION', (nextRefs.environments as string[]) ?? []);
        patch.referencedAssets = nextRefs;
      }
    }

    // metadata read-merge-write：编辑字段、组提示词和错误信息必须保留既有键。
    const incomingMetadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? body.metadata
        : null;
    const hasMetaField =
      typeof body.description === 'string' ||
      typeof body.shotSize === 'string' ||
      typeof body.cameraMovement === 'string' ||
      typeof body.cameraAngle === 'string' ||
      typeof body.dialogue === 'string' ||
      incomingMetadata !== null ||
      typeof body.errorMessage === 'string' ||
      body.errorMessage === null;

    if (hasMetaField) {
      const existingMeta =
        shot.metadata && typeof shot.metadata === 'object'
          ? (shot.metadata as Record<string, unknown>)
          : {};
      const existingSbTable =
        existingMeta.storyboardTable && typeof existingMeta.storyboardTable === 'object'
          ? (existingMeta.storyboardTable as Record<string, unknown>)
          : {};

      const nextSbTable: Record<string, unknown> = { ...existingSbTable };
      if (typeof body.shotSize === 'string') nextSbTable.shotSize = body.shotSize;
      if (typeof body.cameraMovement === 'string')
        nextSbTable.cameraMovement = body.cameraMovement;
      if (typeof body.cameraAngle === 'string') nextSbTable.cameraAngle = body.cameraAngle;

      const nextMeta: Record<string, unknown> = {
        ...existingMeta,
        ...(incomingMetadata ?? {}),
      };
      if (typeof body.description === 'string') nextMeta.description = body.description;
      if (typeof body.dialogue === 'string') nextMeta.dialogue = body.dialogue;
      if (typeof body.errorMessage === 'string' || body.errorMessage === null) {
        nextMeta.errorMessage = body.errorMessage;
      }
      if (Object.keys(nextSbTable).length > 0) nextMeta.storyboardTable = nextSbTable;

      patch.metadata = nextMeta;
    }

    // 4. 空补丁短路（避免静默成功让客户端以为已更新）
    const hasAnyField =
      patch.visualPrompt !== undefined ||
      patch.durationSeconds !== undefined ||
      patch.videoStatus !== undefined ||
      patch.currentMaterialId !== undefined ||
      patch.currentMaterialUrl !== undefined ||
      patch.referencedAssets !== undefined ||
      patch.metadata !== undefined;
    if (!hasAnyField) {
      return apiFail(
        {
          error: '补丁为空（未提供任何可更新字段）',
          code: 'VALIDATION_ERROR',
          category: 'validation',
        },
        400,
      );
    }

    // 5. 调 service 更新（validateShotUpdate 在其内部跑，失败抛 Error）
    let updated: ShotRecord;
    try {
      updated = await updateShot(shotId, patch);
    } catch (err) {
      return apiFail(
        {
          error: err instanceof Error ? err.message : '分镜更新校验失败',
          code: 'VALIDATION_ERROR',
          category: 'validation',
        },
        400,
      );
    }

    return apiSuccess({ shot: updated });
  } catch (err) {
    return handleApiError(err, 'PATCH /api/projects/[id]/episodes/[episodeId]/shots/[shotId]');
  }
}
