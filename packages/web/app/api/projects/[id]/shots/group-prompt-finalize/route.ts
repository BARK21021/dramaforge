// ============================================================
// POST /api/projects/[id]/shots/group-prompt-finalize — 生成"最终提示词"供用户审核
// ============================================================
//
// 用户在组卡片上点「生成最终提示词」时调用。与 generate-group-preview 的关键差异：
//   - generate-group-preview 只做确定性拼装（combineGroupPrompts，pre-rewrite）且副作用
//     写 source='auto' 未重写 snapshot；它给"编辑弹窗"用。
//   - 本端点在此基础上**再跑一次 LLM 审核友好重写**（rewriteGroupPromptForModeration），
//     把"LLM 最终写出来"的版本落库（rewritten=true, approved=false, READY）并返回前端展示。
//
// 认可锁定语义：
//   - 首镜已 seedanceGroupPromptApproved===true 且非 force → 直接返回锁定提示词，**不重跑不花钱**。
//   - force（用户点"重新生成"）→ 无论是否已认可都重跑重写，approved 重置为 false（提示词变了）。
//
// 计费：rewriteGroupPromptForModeration 内部 billDirectGeneration（taskType prompt_moderation_rewrite，
//   billingTaskId 独立 genId）。余额前置门 requireBalanceOrFail 在重写前拦截。
//
// 请求：{ shotIds: string[], force?: boolean }
// 响应：{ success:true, data:{ finalPrompt, contextHash, status, approved, rewritten } }
// ============================================================

import type { NextRequest } from 'next/server';
import {
  episodeRepo,
  getShot,
  listAssets,
  listShots,
  projectRepo,
  readLocalizationProfile,
  updateShot,
} from '@dramaforge/server';
import { genId } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiFail, apiSuccess, handleApiError } from '@web/lib/response';
import { readBodyWithLimit } from '@web/lib/sms-security';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import {
  groupPromptMetadata,
  mergeCostumeMaps,
  prepareGroupPromptSnapshot,
  buildSceneSpatialLayoutMap,
  buildSceneTimeOfDayMap,
  buildSceneBlockingImageMap,
} from '@web/lib/group-prompt-snapshot';
import { rewriteGroupPromptForModeration } from '@web/lib/seedance-narrative-rewrite';
import { appendSeedanceMotionCalibration } from '@server/domain/prompt/seedance-helpers';

const BODY_LIMIT_BYTES = 16 * 1024;

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

    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '项目不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    const bodyResult = await readBodyWithLimit<{ shotIds?: unknown; force?: unknown }>(
      request,
      BODY_LIMIT_BYTES,
    );
    if (!bodyResult.ok) {
      return apiFail(bodyResult.payload, bodyResult.status);
    }

    const parsedBody = bodyResult.body;
    const rawShotIds =
      parsedBody !== null && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
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

    const shotIds = rawShotIds.map((value) => (value as string).trim());
    if (new Set(shotIds).size !== shotIds.length) {
      return apiFail({ error: 'shotIds 不允许重复', code: 'INVALID_SHOT_IDS' }, 400);
    }

    const forceRewrite = parsedBody !== null
      && typeof parsedBody === 'object'
      && !Array.isArray(parsedBody)
      && parsedBody.force === true;

    const projectShots = await listShots(projectId);
    const requestedIds = new Set(shotIds);
    const selectedShots = projectShots.filter((shot) => requestedIds.has(shot.id));
    if (
      selectedShots.length !== shotIds.length ||
      selectedShots.some((shot) => shot.projectId !== projectId)
    ) {
      return apiFail({ error: '镜头不存在或不属于当前项目', code: 'SHOT_NOT_FOUND' }, 404);
    }

    const episodeIds = new Set(
      selectedShots
        .map((shot) => shot.episodeId)
        .filter((episodeId): episodeId is string =>
          typeof episodeId === 'string' && episodeId.length > 0,
        ),
    );
    if (episodeIds.size !== 1 || selectedShots.some((shot) => !shot.episodeId)) {
      return apiFail({ error: '所选镜头必须属于同一分集', code: 'CROSS_EPISODE_SHOTS' }, 400);
    }

    const episodeId = [...episodeIds][0];
    const episode = await episodeRepo.getById(episodeId);
    if (!episode || episode.projectId !== projectId) {
      return apiFail({ error: '分集不存在或不属于当前项目', code: 'EPISODE_NOT_FOUND' }, 404);
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
      const prepared = prepareGroupPromptSnapshot({
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
      const firstShot = selectedShots.find((shot) => shot.id === prepared.firstShotId)!;
      const firstMeta = (firstShot.metadata ?? {}) as Record<string, unknown>;
      const alreadyApproved = firstMeta.seedanceGroupPromptApproved === true;
      // 用户手改版本（source='user'）优先于自动整合：非 force 的「生成最终提示词」
      // 一律不覆盖、不重写（否则用户手改白改——历史 bug：source='user' 被 auto 落库覆盖，
      // 之后生成用的是保存前的旧版）。force=true（「重新生成」按钮）按用户主动意图重跑，
      // 会覆盖手改版并置 source='auto'（UI 明示"重新生成最终提示词"）。
      const existingUserPrompt =
        !forceRewrite
        && firstMeta.seedanceGroupPromptSource === 'user'
        && typeof firstMeta.seedanceGroupPrompt === 'string'
        && firstMeta.seedanceGroupPrompt.trim()
          ? firstMeta.seedanceGroupPrompt.trim()
          : null;

      // 已认可且非 force：直接返回锁定提示词，不重跑、不花钱（防误触）。
      if (alreadyApproved && !forceRewrite) {
        return apiSuccess({
          finalPrompt:
            typeof firstMeta.seedanceGroupPrompt === 'string' && firstMeta.seedanceGroupPrompt
              ? firstMeta.seedanceGroupPrompt
              : prepared.prompt,
          contextHash: prepared.contextHash,
          status: 'READY',
          approved: true,
          rewritten: firstMeta.seedanceGroupPromptRewritten === true,
        });
      }

      // 用户手改版：返回用户版本（forceRewrite 也不覆盖——用户手改是最明确意图）。
      if (existingUserPrompt) {
        // 补标记 rewritten=true（保留 prompt/source 不动）：用户手改版即最终版，
        // UI 的 promptFinalized 判定（hasSavedPrompt && rewritten===true）依赖它显示
        // 「✓ 认可锁定」——否则保存过版本后点「生成最终提示词」永远不出现锁定按钮。
        await updateShot(firstShot.id, {
          metadata: {
            ...firstMeta,
            seedanceGroupPromptRewritten: true,
          },
        });
        return apiSuccess({
          finalPrompt: existingUserPrompt,
          contextHash: prepared.contextHash,
          status: 'READY',
          approved: alreadyApproved,
          rewritten: true,
          source: 'user',
        });
      }

      // 余额前置门：昂贵 LLM 重写前拦截欠费。
      const balanceBlocked = await requireBalanceOrFail(auth.userId);
      if (balanceBlocked) return balanceBlocked;

      // LLM 审核友好重写（带结构守卫 + 引用校验 + 计费）；任一守卫抛错降级 combined。
      let finalPrompt = prepared.prompt;
      let rewritten = false;
      try {
        finalPrompt = await rewriteGroupPromptForModeration(prepared.prompt, {
          userId: auth.userId,
          assetRefs: prepared.references.assetRefs,
          billingTaskId: genId(),
          groupIndex: 0,
        });
        rewritten = true;
      } catch (error) {
        console.warn('[group-prompt-finalize] LLM 重写降级，用 combined prompt：', error);
        finalPrompt = prepared.prompt;
      }
      // 与 chain-generate 重写块一致：重写后补 motion 校准，使落库的 READY 提示词
      // 在生产复用（READY&&rewritten 路径不再补）时仍含 motion 段。
      finalPrompt = appendSeedanceMotionCalibration(finalPrompt);

      // 重写窗口守卫：LLM 重写耗时内用户保存了手改版 → 跳过落库（保留用户版本，
      // 与 chain-generate needsRewrite 落库守卫一致；下次 finalize/生成优先用用户版）。
      const freshFirst = await getShot(firstShot.id);
      const freshMeta = (freshFirst?.metadata ?? {}) as Record<string, unknown>;
      const userSavedDuringRewrite = freshMeta.seedanceGroupPromptSource === 'user'
        && typeof freshMeta.seedanceGroupPrompt === 'string'
        && freshMeta.seedanceGroupPrompt.trim();
      if (!userSavedDuringRewrite) {
        // 落库：rewritten=<重写是否成功>，approved=false（新生成解除旧锁定）。
        await updateShot(firstShot.id, {
          metadata: groupPromptMetadata(firstShot.metadata, prepared, finalPrompt, 'auto', rewritten, false),
        });
      }

      return apiSuccess({
        finalPrompt,
        contextHash: prepared.contextHash,
        status: 'READY',
        approved: false,
        rewritten,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        return apiFail({ error: error.message, code: 'INVALID_GROUP_RANGE' }, 400);
      }
      throw error;
    }
  } catch (error) {
    return handleApiError(
      error,
      'POST /api/projects/[id]/shots/group-prompt-finalize',
    );
  }
}
