import { createHash } from 'node:crypto';

import { handleTask } from '@server/ai-worker/handlers';
import { projectRepo } from '@server/domain/project';
import { readLocalizationProfile } from '@server/domain/prompt';
import { query, tx } from '@server/infra';
import {
  normalizeProjectScriptForHash,
  resolveProjectSourceScriptText,
} from '@shared/project-script-snapshot';

interface SafetyCounts {
  shots: number;
  materials: number;
  storyboards: number;
  assets: number;
  assetImageRevisions: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function readProjectIds(): string[] {
  return Array.from(new Set(
    String(process.env.REPROCESS_PROJECT_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}

async function readSafetyCounts(projectId: string): Promise<SafetyCounts> {
  const result = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM shots WHERE "projectId" = $1) AS shots,
       (SELECT COUNT(*)::int FROM materials WHERE "projectId" = $1) AS materials,
       (SELECT COUNT(*)::int FROM storyboards WHERE "projectId" = $1) AS storyboards,
       (SELECT COUNT(*)::int FROM assets WHERE "projectId" = $1) AS assets,
       (SELECT COUNT(*)::int FROM asset_image_revisions WHERE "projectId" = $1) AS "assetImageRevisions"`,
    [projectId],
  );
  const row = result.rows[0] as Partial<SafetyCounts> | undefined;
  return {
    shots: Number(row?.shots ?? 0),
    materials: Number(row?.materials ?? 0),
    storyboards: Number(row?.storyboards ?? 0),
    assets: Number(row?.assets ?? 0),
    assetImageRevisions: Number(row?.assetImageRevisions ?? 0),
  };
}

async function recordRepair(input: {
  projectId: string;
  backupRef: string;
  previousEpisodeCount: number;
  repairedEpisodeCount: number;
}): Promise<void> {
  await tx(async (q) => {
    const selected = await q.query(
      'SELECT "scriptData" FROM projects WHERE id = $1 FOR UPDATE',
      [input.projectId],
    );
    const scriptData = asRecord(
      (selected.rows[0] as { scriptData?: unknown } | undefined)?.scriptData,
    );
    const snapshot = asRecord(scriptData.sourceScriptSnapshot);
    const history = Array.isArray(scriptData.episodeAiRepairHistory)
      ? scriptData.episodeAiRepairHistory
      : [];
    // Legacy/manual counts are deliberately removed. Future processing must
    // read the frozen manuscript with AI again instead of trusting stale rows.
    delete scriptData.expectedEpisodeCount;
    delete snapshot.expectedEpisodeCount;
    await q.query(
      `UPDATE projects SET "scriptData" = $1::jsonb, "updatedAt" = NOW() WHERE id = $2`,
      [
        JSON.stringify({
          ...scriptData,
          sourceScriptSnapshot: snapshot,
          episodeAiRepairHistory: [
            ...history,
            {
              repairedAt: new Date().toISOString(),
              backupRef: input.backupRef,
              previousEpisodeCount: input.previousEpisodeCount,
              repairedEpisodeCount: input.repairedEpisodeCount,
              method: 'whole-series-style-and-ai-semantic-split',
            },
          ],
        }),
        input.projectId,
      ],
    );
  });
}

interface FinalizeExistingResult {
  previousEpisodeCount: number;
  repairedEpisodeCount: number;
  manuscriptCharacters: number;
  method: 'finalize-existing-after-validated-split';
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * Finalize a split that was already committed before a best-effort asset step
 * failed. This path never invokes AI and never updates episodes or novelText.
 */
export async function finalizeExistingValidatedSplit(input: {
  projectId: string;
  backupRef: string;
}): Promise<FinalizeExistingResult> {
  return tx(async (q) => {
    const selected = await q.query(
      `SELECT "scriptData", "novelText", "sourceProjectId", category
         FROM projects WHERE id = $1 FOR UPDATE`,
      [input.projectId],
    );
    const project = selected.rows[0] as {
      scriptData?: unknown;
      novelText?: string | null;
      sourceProjectId?: string | null;
      category?: string | null;
    } | undefined;
    if (!project) throw new Error(`项目不存在：${input.projectId}`);
    if (!project.sourceProjectId || project.category === 'ORIGINAL') {
      throw new Error(`项目不是调用原创整剧的目标项目：${input.projectId}`);
    }
    const sourceText = resolveProjectSourceScriptText(project);
    if (!sourceText || sourceText.length < 50) {
      throw new Error(`项目冻结原稿为空或过短：${input.projectId}`);
    }

    const episodeResult = await q.query(
      `SELECT "episodeNumber", "novelText"
         FROM episodes
        WHERE "projectId" = $1
        ORDER BY "episodeNumber" ASC
        FOR UPDATE`,
      [input.projectId],
    );
    const episodes = episodeResult.rows as Array<{
      episodeNumber?: number;
      novelText?: string | null;
    }>;
    if (episodes.length < 1) {
      throw new Error(`项目 ${input.projectId} 没有可收尾的已提交分集`);
    }
    for (let index = 0; index < episodes.length; index += 1) {
      if (episodes[index].episodeNumber !== index + 1) {
        throw new Error(
          `项目 ${input.projectId} 的 episodeNumber 不是严格连续的 1..N 序列`,
        );
      }
      if (typeof episodes[index].novelText !== 'string') {
        throw new Error(`项目 ${input.projectId} 的第 ${index + 1} 集 novelText 无效`);
      }
    }

    // Keep the existing downstream-work qualification inside the same locked
    // transaction so a concurrent insert cannot race the finalization check.
    const downstreamResult = await q.query(
      `SELECT
         (SELECT COUNT(*)::int FROM shots WHERE "projectId" = $1) AS shots,
         (SELECT COUNT(*)::int FROM materials WHERE "projectId" = $1) AS materials,
         (SELECT COUNT(*)::int FROM storyboards WHERE "projectId" = $1) AS storyboards`,
      [input.projectId],
    );
    const downstream = downstreamResult.rows[0] as {
      shots?: number;
      materials?: number;
      storyboards?: number;
    } | undefined;
    const shots = Number(downstream?.shots ?? 0);
    const materials = Number(downstream?.materials ?? 0);
    const storyboards = Number(downstream?.storyboards ?? 0);
    if (shots > 0 || materials > 0 || storyboards > 0) {
      throw new Error(
        `项目 ${input.projectId} 已有下游作品（shots=${shots}, materials=${materials}, storyboards=${storyboards}），拒绝收尾`,
      );
    }

    const projectNovelText = project.novelText;
    if (typeof projectNovelText !== 'string') {
      throw new Error(`项目 ${input.projectId} 的 projects.novelText 无效`);
    }
    const joinedEpisodeText = episodes.map((episode) => episode.novelText as string).join('');
    if (joinedEpisodeText !== projectNovelText) {
      throw new Error(
        `项目 ${input.projectId} 的分集正文拼接结果与 projects.novelText 不逐字一致，拒绝收尾`,
      );
    }

    const scriptData = asRecord(project.scriptData);
    const snapshot = asRecord(scriptData.sourceScriptSnapshot);
    const history = Array.isArray(scriptData.episodeAiRepairHistory)
      ? scriptData.episodeAiRepairHistory
      : [];
    const previousEpisodeCount = Array.isArray(scriptData.previousEpisodes)
      && scriptData.previousEpisodes.length > 0
      ? scriptData.previousEpisodes.length
      : readPositiveInteger(scriptData.expectedEpisodeCount)
        ?? readPositiveInteger(snapshot.expectedEpisodeCount)
        ?? episodes.length;
    delete scriptData.expectedEpisodeCount;
    delete snapshot.expectedEpisodeCount;
    const method = 'finalize-existing-after-validated-split' as const;
    await q.query(
      `UPDATE projects
          SET "scriptData" = $1::jsonb, "updatedAt" = NOW()
        WHERE id = $2`,
      [
        JSON.stringify({
          ...scriptData,
          sourceScriptSnapshot: snapshot,
          episodeAiRepairHistory: [
            ...history,
            {
              repairedAt: new Date().toISOString(),
              backupRef: input.backupRef,
              previousEpisodeCount,
              repairedEpisodeCount: episodes.length,
              method,
            },
          ],
        }),
        input.projectId,
      ],
    );
    return {
      previousEpisodeCount,
      repairedEpisodeCount: episodes.length,
      manuscriptCharacters: projectNovelText.length,
      method,
    };
  });
}

/**
 * Guarded production repair for ORIGINAL_PROJECT targets.
 *
 * Dry-run is the default. `--apply` additionally requires REPROCESS_BACKUP_REF.
 * Unlike the retired repair CLI this runner never accepts an episode count and
 * never slices by character position: the deployed AI workflow reads the full
 * frozen source and decides its real episode structure.
 */
export async function runOriginalSeriesAiReprocessCli(
  argv = process.argv.slice(2),
): Promise<void> {
  const projectIds = readProjectIds();
  if (projectIds.length === 0) {
    throw new Error('缺少 REPROCESS_PROJECT_IDS（逗号分隔的目标项目 ID）');
  }
  const apply = argv.includes('--apply');
  const finalizeExisting = argv.includes('--finalize-existing');
  if (apply && finalizeExisting) {
    throw new Error('--apply 与 --finalize-existing 不能同时使用');
  }
  const backupRef = String(process.env.REPROCESS_BACKUP_REF ?? '').trim();
  if ((apply || finalizeExisting) && !backupRef) {
    throw new Error('执行写入前必须提供 REPROCESS_BACKUP_REF');
  }
  const modelId = String(process.env.REPROCESS_MODEL_ID ?? 'deepseek/deepseek-v4-flash').trim();
  const allowExistingAssets = process.env.REPROCESS_ALLOW_EXISTING_ASSETS === '1';

  const plans: Array<Record<string, unknown>> = [];
  for (const projectId of projectIds) {
    const project = await projectRepo.getById(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    if (!project.sourceProjectId || project.category === 'ORIGINAL') {
      throw new Error(`项目不是调用原创整剧的目标项目：${projectId}`);
    }
    const sourceText = resolveProjectSourceScriptText(project);
    if (!sourceText || sourceText.length < 50) {
      throw new Error(`项目冻结原稿为空或过短：${projectId}`);
    }
    const safety = await readSafetyCounts(projectId);
    if (safety.shots > 0 || safety.materials > 0 || safety.storyboards > 0) {
      throw new Error(
        `项目 ${projectId} 已有下游作品（shots=${safety.shots}, materials=${safety.materials}, storyboards=${safety.storyboards}），拒绝原位重跑`,
      );
    }
    if (apply && (safety.assets > 0 || safety.assetImageRevisions > 0) && !allowExistingAssets) {
      throw new Error(
        `项目 ${projectId} 已有资产 ${safety.assets} 条、图片版本 ${safety.assetImageRevisions} 条；确认数据库备份并显式设置 REPROCESS_ALLOW_EXISTING_ASSETS=1 后才可重跑`,
      );
    }
    const episodeRows = await query(
      'SELECT COUNT(*)::int AS count FROM episodes WHERE "projectId" = $1',
      [projectId],
    );
    const previousEpisodeCount = Number(
      (episodeRows.rows[0] as { count?: number } | undefined)?.count ?? 0,
    );
    const localizationProfile = readLocalizationProfile(project.scriptData);
    const stylePrompt = localizationProfile?.stylePrompt?.trim() ?? '';
    if (project.category === 'OVERSEAS' && !stylePrompt) {
      throw new Error(`海外项目缺少整剧转风格目标：${projectId}`);
    }
    const payload = {
      projectId,
      novelText: sourceText,
      sourceScriptHash: createHash('sha256')
        .update(normalizeProjectScriptForHash(sourceText), 'utf8')
        .digest('hex'),
      modelId,
      category: project.category,
      stylePrompt,
      localizationProfile,
      deleteExisting: true,
    };
    plans.push({
      projectId,
      title: project.title,
      category: project.category,
      sourceCharacters: sourceText.length,
      previousEpisodeCount,
      safety,
      stylePrompt,
    });
    if (finalizeExisting) {
      const finalized = await finalizeExistingValidatedSplit({ projectId, backupRef });
      console.log(JSON.stringify({
        finalizedExisting: true,
        projectId,
        title: project.title,
        ...finalized,
      }));
      continue;
    }
    if (!apply) continue;

    const result = await handleTask(
      'EPISODE_SPLIT',
      payload,
      project.userId,
      `maintenance-ai-reprocess-${projectId}`,
    );
    const output = asRecord(result.output);
    const repairedEpisodeCount = Number(output.episodeCount ?? 0);
    if (!Number.isInteger(repairedEpisodeCount) || repairedEpisodeCount < 1) {
      throw new Error(`项目 ${projectId} 的 AI 重跑没有返回有效分集数`);
    }
    await recordRepair({
      projectId,
      backupRef,
      previousEpisodeCount,
      repairedEpisodeCount,
    });
    console.log(JSON.stringify({
      applied: true,
      projectId,
      previousEpisodeCount,
      repairedEpisodeCount,
      splitMode: output.splitMode,
      wholeSeriesStyled: output.wholeSeriesStyled,
      assetExtraction: output.assetExtraction ?? null,
      warnings: Array.isArray(output.warnings) ? output.warnings : [],
    }));
  }
  if (!apply) console.log(JSON.stringify({ dryRun: true, plans }, null, 2));
}
