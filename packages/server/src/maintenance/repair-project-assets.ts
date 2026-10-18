import { extractWholeScriptAssets } from '@server/domain/asset/whole-script-extraction';
import { readLocalizationProfile } from '@server/domain/prompt';
import { query } from '@server/infra';

interface ProjectRow {
  id: string;
  userId: string;
  title: string;
  category: string | null;
  novelText: string | null;
  scriptData: unknown;
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

function readFinalManuscript(project: ProjectRow): string {
  const scriptData = asRecord(project.scriptData);
  const snapshot = asRecord(scriptData.sourceScriptSnapshot);
  // Overseas projects must extract assets from the one-time whole-series
  // localized manuscript, while the snapshot remains the immutable original.
  const candidates = [project.novelText, scriptData.finalNovelText, snapshot.text, scriptData.novelText];
  return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim() ?? '';
}

function readProjectIds(): string[] {
  const ids = (process.env.ASSET_REPAIR_PROJECT_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error('缺少 ASSET_REPAIR_PROJECT_IDS（逗号分隔）');
  return Array.from(new Set(ids));
}

async function readProject(projectId: string): Promise<ProjectRow> {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0] as ProjectRow | undefined;
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!readFinalManuscript(project)) throw new Error(`项目缺少最终整剧稿：${projectId}`);
  return project;
}

async function summarizeProject(project: ProjectRow): Promise<Record<string, unknown>> {
  const assets = await query(
    `SELECT kind, name FROM assets
      WHERE "projectId" = $1 AND kind IN ('LOCATION', 'PROP')
      ORDER BY kind, name`,
    [project.id],
  );
  const nonChinese = (assets.rows as Array<{ kind: string; name: string }>)
    .filter((asset) => !/[\u3400-\u9fff]/u.test(asset.name) || /[A-Za-z]/u.test(asset.name));
  return {
    projectId: project.id,
    title: project.title,
    manuscriptCharacters: readFinalManuscript(project).length,
    propLocationCount: assets.rows.length,
    nonChineseCount: nonChinese.length,
    nonChinese: nonChinese.map((asset) => `${asset.kind}:${asset.name}`),
  };
}

export async function runAssetRepairCli(argv = process.argv.slice(2)): Promise<void> {
  const projectIds = readProjectIds();
  const projects = await Promise.all(projectIds.map(readProject));
  const before = await Promise.all(projects.map(summarizeProject));
  if (!argv.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, before }, null, 2));
    return;
  }
  const backupRef = process.env.ASSET_REPAIR_BACKUP_REF?.trim();
  if (!backupRef) throw new Error('apply 前必须提供 ASSET_REPAIR_BACKUP_REF');

  const results: Record<string, unknown>[] = [];
  for (const project of projects) {
    const extraction = await extractWholeScriptAssets(
      project.id,
      readFinalManuscript(project),
      project.userId,
      project.category,
      undefined,
      readLocalizationProfile(project.scriptData),
    );
    results.push({
      projectId: project.id,
      title: project.title,
      extraction,
      after: await summarizeProject(project),
    });
  }
  console.log(JSON.stringify({ applied: true, backupRef, results }, null, 2));
}
