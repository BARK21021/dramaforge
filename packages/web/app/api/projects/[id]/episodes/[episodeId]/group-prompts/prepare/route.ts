import type { NextRequest } from 'next/server';

import {
  episodeRepo,
  listAssets,
  listShots,
  projectRepo,
  readLocalizationProfile,
  updateShot,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import {
  groupPromptMetadata,
  groupShotsForPreparedPrompts,
  mergeCostumeMaps,
  prepareGroupPromptSnapshot,
  readStoredGroupPrompt,
  buildSceneSpatialLayoutMap,
  buildSceneTimeOfDayMap,
  buildSceneBlockingImageMap,
} from '@web/lib/group-prompt-snapshot';
import { maxDurationForVideoModel } from '@server/domain/prompt/seedance-helpers';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';
import { readBodyWithLimit } from '@web/lib/sms-security';

const BODY_LIMIT_BYTES = 32 * 1024;

interface PrepareBody {
  shotIds?: unknown;
  aspectRatio?: unknown;
  parallelMode?: unknown;
  model?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; episodeId: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    const { id: projectId, episodeId } = await params;
    const [project, episode] = await Promise.all([
      projectRepo.getById(projectId),
      episodeRepo.getById(episodeId),
    ]);
    if (!project || project.userId !== auth.userId || !episode || episode.projectId !== projectId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    const sceneSpatialLayoutMap = buildSceneSpatialLayoutMap(episode.scriptData);
    const sceneTimeOfDayMap = buildSceneTimeOfDayMap(episode.scriptData);
    const sceneBlockingImageMap = buildSceneBlockingImageMap(episode.scriptData, sceneSpatialLayoutMap);

    const bodyResult = await readBodyWithLimit<PrepareBody>(request, BODY_LIMIT_BYTES);
    if (!bodyResult.ok) return apiFail(bodyResult.payload, bodyResult.status);
    const body = bodyResult.body && typeof bodyResult.body === 'object' && !Array.isArray(bodyResult.body)
      ? bodyResult.body
      : {};
    let requestedShotIds: string[] | undefined;
    if (Object.prototype.hasOwnProperty.call(body, 'shotIds')) {
      if (!Array.isArray(body.shotIds) || body.shotIds.length === 0
        || body.shotIds.some((id) => typeof id !== 'string' || !id.trim())) {
        return apiFail({ error: 'shotIds 必须是非空镜头 ID 数组', code: 'INVALID_SHOT_IDS' }, 400);
      }
      requestedShotIds = body.shotIds.map((id) => String(id).trim());
      if (new Set(requestedShotIds).size !== requestedShotIds.length) {
        return apiFail({ error: 'shotIds 不允许重复', code: 'INVALID_SHOT_IDS' }, 400);
      }
    }
    const parallelMode = body.parallelMode === 'fast' ? 'fast' : 'strict';
    const aspectRatio = typeof body.aspectRatio === 'string' && body.aspectRatio.trim()
      ? body.aspectRatio.trim()
      : undefined;

    const [allShots, assets] = await Promise.all([
      listShots(projectId, episodeId),
      listAssets(projectId),
    ]);
    if (allShots.length === 0) {
      return apiFail({ error: '该集尚无分镜，请先生成分镜', code: 'NO_SHOTS' }, 400);
    }
    const requestedSet = requestedShotIds ? new Set(requestedShotIds) : null;
    const targetShots = requestedSet ? allShots.filter((shot) => requestedSet.has(shot.id)) : allShots;
    if (requestedShotIds && targetShots.length !== requestedShotIds.length) {
      return apiFail({ error: '部分镜头不存在或不属于当前分集', code: 'INVALID_SHOT_IDS' }, 400);
    }

    const localizationProfile = readLocalizationProfile(episode.scriptData)
      ?? readLocalizationProfile(project.scriptData);
    const costumeMap = mergeCostumeMaps(project.scriptData, episode.scriptData);
   const modelId = typeof body.model === 'string' && body.model.includes('/')
     ? body.model
     : 'ark/doubao-seedance-2-0-260128';
   const maxDuration = maxDurationForVideoModel(modelId);
   const groups = groupShotsForPreparedPrompts(targetShots, assets, costumeMap, maxDuration);
    const firstTargetOrder = Math.min(...targetShots.map((shot) => shot.sortOrder));
    const hasPreviousContext = allShots.some((shot) => shot.sortOrder < firstTargetOrder);
    const preparedGroups = groups.map((shots, index) => prepareGroupPromptSnapshot({
      shots,
      assets,
      costumeMap,
      localizationProfile,
      projectArtStyle: project.artStyle,
      aspectRatio,
      prevLastFrameHint: parallelMode === 'strict' && (hasPreviousContext || index > 0),
      sceneSpatialLayoutMap,
      sceneTimeOfDayMap,
      sceneBlockingImageMap,
     maxDuration,
    }));

    // 生产门禁解除（2026-07-23 指令）：镜头/资产/造型变化导致自定义组提示词过期时，
    // 不再用 409 GROUP_PROMPT_STALE 阻断并强制用户重确认。过期提示词（含用户手改来源）
    // 统一进入下方重生成逻辑，与 auto 来源一致地确定性重生成。鉴权/计费门禁不受影响。
    let generated = 0;
    let reused = 0;
    for (const prepared of preparedGroups) {
      const firstShot = targetShots.find((shot) => shot.id === prepared.firstShotId)!;
      const stored = readStoredGroupPrompt(firstShot.metadata, prepared);
      // 用户手改版本（source='user'）或认可锁定（approved）最高优先：即使 STALE/MISSING
      // 也保留、不被现算 auto 覆盖（7/23 生产门禁解除把 user 版也放进重生成覆盖路径——
      // 用户手改白改，之后生成用的仍是保存前旧版。与 finalize/preview 的 user 短路对齐；
      // approved 语义同 finalize/preview：认可过的版本也受保护）。
      const firstMeta = (firstShot.metadata ?? {}) as Record<string, unknown>;
      const userOwned = (
        firstMeta.seedanceGroupPromptSource === 'user'
        || firstMeta.seedanceGroupPromptApproved === true
      ) && typeof firstMeta.seedanceGroupPrompt === 'string'
        && firstMeta.seedanceGroupPrompt.trim();
      if (stored.status === 'READY' || userOwned) {
        reused += 1;
        continue;
      }
      await updateShot(firstShot.id, {
        metadata: groupPromptMetadata(firstShot.metadata, prepared),
      });
      generated += 1;
    }

    return apiSuccess({
      ready: true,
      groupCount: preparedGroups.length,
      generated,
      reused,
      groups: preparedGroups.map((prepared) => ({
        firstShotId: prepared.firstShotId,
        shotIds: prepared.shotIds,
        contextHash: prepared.contextHash,
        validDuration: prepared.validDuration,
      })),
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return apiFail({ error: error.message, code: 'INVALID_GROUP_RANGE' }, 400);
    }
    return handleApiError(
      error,
      'POST /api/projects/[id]/episodes/[episodeId]/group-prompts/prepare',
    );
  }
}
