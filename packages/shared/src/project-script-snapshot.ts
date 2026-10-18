export interface ProjectSourceScriptSnapshot {
  version: 1;
  text: string;
  hash: string;
  sourceProjectId: string | null;
  /** Legacy-only hint retained so old snapshots remain readable. */
  expectedEpisodeCount?: number;
}

export interface ProjectWithScriptSnapshot {
  novelText?: string | null;
  scriptData?: unknown;
  sourceProjectId?: string | null;
}

function readScriptData(value: unknown): Record<string, unknown> {
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

export function normalizeProjectScriptForHash(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function validEpisodeCount(value: unknown): number | null {
  const count = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 500 ? count : null;
}

/**
 * Read an explicit episode-count hint from a human project title.
 *
 * Examples used by existing original projects include `1-45-海外…` and
 * `1-45集-…`.  A bare unrelated number is deliberately ignored so years and
 * version numbers never become an episode contract by accident.
 */
export function inferEpisodeCountFromProjectTitle(title: string | null | undefined): number | null {
  const value = String(title ?? '').trim();
  if (!value) return null;
  const range = value.match(/(?:^|[^0-9])1\s*[-—–~～至到]\s*([0-9]{1,3})\s*(?:集)?(?:[^0-9]|$)/u);
  const rangedCount = validEpisodeCount(range?.[1]);
  if (rangedCount) return rangedCount;
  const explicit = value.match(/(?:共\s*)?([0-9]{1,3})\s*集/u);
  return validEpisodeCount(explicit?.[1]);
}

/**
 * Legacy compatibility helper for old records that stored a count hint.
 * Production AI splitting must not use this value as an episode-count
 * constraint: the model determines the count by reading the frozen script.
 */
export function resolveExpectedEpisodeCount(project: ProjectWithScriptSnapshot): number | null {
  const scriptData = readScriptData(project.scriptData);
  const snapshot = scriptData.sourceScriptSnapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const count = validEpisodeCount(
      (snapshot as Record<string, unknown>).expectedEpisodeCount,
    );
    if (count) return count;
  }
  const directCount = validEpisodeCount(scriptData.expectedEpisodeCount);
  if (directCount) return directCount;
  if (Array.isArray(scriptData.previousEpisodes)) {
    return validEpisodeCount(scriptData.previousEpisodes.length);
  }
  return null;
}

/**
 * Resolve the immutable manuscript captured on the target project.
 *
 * New records use sourceScriptSnapshot. Existing records are compatible via
 * scriptData.novelText, then project.novelText as the final legacy fallback.
 * The linked source project is deliberately not consulted here.
 */
export function resolveProjectSourceScriptText(
  project: ProjectWithScriptSnapshot,
): string | null {
  const scriptData = readScriptData(project.scriptData);
  const rawSnapshot = scriptData.sourceScriptSnapshot;
  const snapshotText = rawSnapshot && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot)
    && typeof (rawSnapshot as Record<string, unknown>).text === 'string'
    ? (rawSnapshot as Record<string, unknown>).text as string
    : undefined;
  const legacyText = typeof scriptData.novelText === 'string'
    ? scriptData.novelText
    : project.novelText;
  const text = normalizeProjectScriptForHash(snapshotText ?? legacyText ?? '');
  return text || null;
}
