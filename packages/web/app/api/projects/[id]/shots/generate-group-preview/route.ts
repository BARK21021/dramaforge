// ============================================================
// POST /api/projects/[id]/shots/generate-group-preview — 成组提示词预览
// ============================================================
//
// ProductionStage 在“编辑组提示词”弹窗打开时调用本接口。C/S 迁移边界：
//   1. 云端只做登录、项目所有权、分集及镜头范围校验；
//   2. 通过纯函数拼装可编辑文本，不调用 AI，不创建任务；
//   3. 不读取或写入媒体，不引入 ffmpeg。
//
// 请求：{ shotIds: string[] }
// 响应：{ success:true, data:{ combinedPrompt, totalDuration, validDuration } }
// ============================================================

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
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';
import { readBodyWithLimit } from '@web/lib/sms-security';
import {
  groupPromptMetadata,
  mergeCostumeMaps,
  prepareGroupPromptSnapshot,
  buildSceneSpatialLayoutMap,
  buildSceneTimeOfDayMap,
  buildSceneBlockingImageMap,
} from '@web/lib/group-prompt-snapshot';

/** 组内镜头 ID 很短；16KB 足够正常请求，同时避免无界 JSON 占用内存。 */
const BODY_LIMIT_BYTES = 16 * 1024;

/**
 * 返回成组提示词预览。
 *
 * 安全策略：未知、外项目或缺失镜头统一返回 404，避免向当前用户泄露其他项目的
 * 镜头是否存在；跨分集组合返回 400，因为实际生成链路只能处理单集连续镜头。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) {
      throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');
    }

    const { id: projectId } = await params;

    // 先校验项目所有权，越权与不存在统一返回 404，避免项目枚举。
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail(
        { error: '项目不存在或无权访问', code: 'NOT_FOUND' },
        404,
      );
    }

    const bodyResult = await readBodyWithLimit<{ shotIds?: unknown; force?: unknown }>(
      request,
      BODY_LIMIT_BYTES,
    );
    if (!bodyResult.ok) {
      return apiFail(bodyResult.payload, bodyResult.status);
    }

    // JSON 可能是 null/数组等非对象；统一按缺失 shotIds 处理，避免落入 500。
    const parsedBody = bodyResult.body;
    const rawShotIds =
      parsedBody !== null &&
      typeof parsedBody === 'object' &&
      !Array.isArray(parsedBody)
        ? parsedBody.shotIds
        : undefined;
    if (
      !Array.isArray(rawShotIds) ||
      rawShotIds.length === 0 ||
      rawShotIds.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      return apiFail(
        { error: 'shotIds 必须是非空镜头 ID 数组', code: 'INVALID_SHOT_IDS' },
        400,
      );
    }

    // 去掉输入首尾空格后拒绝重复项，防止同一镜头被重复计时和重复拼接。
    const shotIds = rawShotIds.map((value) => (value as string).trim());
    if (new Set(shotIds).size !== shotIds.length) {
      return apiFail(
        { error: 'shotIds 不允许重复', code: 'INVALID_SHOT_IDS' },
        400,
      );
    }

    // force=true（点「重新整合」）：跳过用户版本短路，现算并覆盖 metadata 重建提示词。
    const forceRefresh = parsedBody !== null
      && typeof parsedBody === 'object'
      && !Array.isArray(parsedBody)
      && parsedBody.force === true;

    // 一次读取项目镜头并按请求 ID 精确匹配；禁止“部分命中后继续生成”的静默降级。
    const projectShots = await listShots(projectId);
    const requestedIds = new Set(shotIds);
    const selectedShots = projectShots.filter((shot) => requestedIds.has(shot.id));
    if (
      selectedShots.length !== shotIds.length ||
      selectedShots.some((shot) => shot.projectId !== projectId)
    ) {
      return apiFail(
        { error: '镜头不存在或不属于当前项目', code: 'SHOT_NOT_FOUND' },
        404,
      );
    }

    // 组预览必须落在单个非空 episode 范围内；跨集拼接会破坏剧情连续性。
    const episodeIds = new Set(
      selectedShots
        .map((shot) => shot.episodeId)
        .filter((episodeId): episodeId is string =>
          typeof episodeId === 'string' && episodeId.length > 0,
        ),
    );
    if (episodeIds.size !== 1 || selectedShots.some((shot) => !shot.episodeId)) {
      return apiFail(
        { error: '所选镜头必须属于同一分集', code: 'CROSS_EPISODE_SHOTS' },
        400,
      );
    }

    // 再校验 episode→project 关系，防止历史脏数据绕过项目范围边界。
    const episodeId = [...episodeIds][0];
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail(
        { error: '分集不存在或不属于当前项目', code: 'EPISODE_NOT_FOUND' },
        404,
      );
    }
    const sceneSpatialLayoutMap = buildSceneSpatialLayoutMap(episode.scriptData);
    const sceneTimeOfDayMap = buildSceneTimeOfDayMap(episode.scriptData);
    const sceneBlockingImageMap = buildSceneBlockingImageMap(episode.scriptData, sceneSpatialLayoutMap);

    try {
      const assets = await listAssets(projectId);
      const localizationProfile = readLocalizationProfile(episode.scriptData)
        ?? readLocalizationProfile(project.scriptData);
      const costumeMap = mergeCostumeMaps(project.scriptData, episode.scriptData);
      const minSelectedOrder = Math.min(...selectedShots.map((shot) => shot.sortOrder));
      const preview = prepareGroupPromptSnapshot({
        shots: selectedShots,
        assets,
        costumeMap,
        localizationProfile,
        projectArtStyle: project.artStyle,
        prevLastFrameHint: projectShots.some((shot) => shot.sortOrder < minSelectedOrder),
        sceneSpatialLayoutMap,
        sceneTimeOfDayMap,
        sceneBlockingImageMap,
      });
      const firstShot = selectedShots.find((shot) => shot.id === preview.firstShotId)!;
      const firstMeta = (firstShot.metadata ?? {}) as Record<string, unknown>;
      // 用户手改（source='user'）或认可锁定（approved）且未强制刷新 → 返回用户版本、不覆盖
      // （防编辑弹窗预览冲掉用户改的/认可的提示词——否则仅打开弹窗就会 updateShot 覆盖丢失）。
      // force=true（点「重新整合」）→ 跳过短路，现算并覆盖，让用户主动重建提示词。
      const userOwned = !forceRefresh && (
        firstMeta.seedanceGroupPromptSource === 'user'
        || firstMeta.seedanceGroupPromptApproved === true
      );
      if (userOwned) {
        const storedPrompt = typeof firstMeta.seedanceGroupPrompt === 'string' && firstMeta.seedanceGroupPrompt
          ? firstMeta.seedanceGroupPrompt
          : null;
        return apiSuccess({
          combinedPrompt: storedPrompt ?? preview.prompt,
          totalDuration: preview.totalDuration,
          validDuration: preview.validDuration,
          ready: true,
          contextHash: preview.contextHash,
        });
      }
      await updateShot(firstShot.id, {
        metadata: groupPromptMetadata(firstShot.metadata, preview),
      });
      return apiSuccess({
        combinedPrompt: preview.prompt,
        totalDuration: preview.totalDuration,
        validDuration: preview.validDuration,
        ready: true,
        contextHash: preview.contextHash,
      });
    } catch (error) {
      // 纯函数仅以 RangeError 表示不可生成的组范围（目前为总时长超过 15 秒）。
      if (error instanceof RangeError) {
        return apiFail(
          { error: error.message, code: 'INVALID_GROUP_RANGE' },
          400,
        );
      }
      throw error;
    }
  } catch (error) {
    return handleApiError(
      error,
      'POST /api/projects/[id]/shots/generate-group-preview',
    );
  }
}
