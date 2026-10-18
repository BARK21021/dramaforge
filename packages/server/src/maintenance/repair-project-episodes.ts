/**
 * Retired maintenance entry.
 *
 * The previous implementation accepted an operator-supplied episode count and
 * cut a manuscript into near-equal character ranges. That can preserve bytes
 * while destroying story boundaries, so the mutating path is intentionally no
 * longer present. Production repair must use reprocess-original-series-ai.ts.
 */

type RepairCloneTable = 'projects' | 'assets' | 'asset_image_revisions';

const JSON_COLUMNS: Readonly<Record<RepairCloneTable, ReadonlySet<string>>> = {
  projects: new Set(['scriptData', 'voiceprintMapping', 'characterMapping', 'longVideoProgress']),
  assets: new Set([
    'metadata',
    'tags',
    'identityLock',
    'coverageScenes',
    'relationships',
    'designImage',
    'costumes',
  ]),
  asset_image_revisions: new Set(),
};

/** Kept only for the historical clone-serialization regression test. */
export function serializeRepairCloneValue(
  table: RepairCloneTable,
  column: string,
  value: unknown,
): unknown {
  if (value === null || value === undefined || !JSON_COLUMNS[table].has(column)) return value;
  return JSON.stringify(value);
}

export async function runEpisodeRepairCli(): Promise<never> {
  throw new Error(
    '字符均分修复入口已永久退役；请使用 original-series-ai-reprocess，让 AI 完整阅读冻结原稿后动态拆集',
  );
}
