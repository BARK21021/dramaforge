/** Project-scoped asset identity and merge helpers, ported from app1 asset-reuse-service. */

export function normalizeAssetName(name: unknown): string {
  return typeof name === 'string'
    ? name.toLowerCase().replace(/[\s\-_·.,'"()（）]/g, '')
    : '';
}

export function getAssetNameAliases(name: unknown): string[] {
  if (typeof name !== 'string' || !name.trim()) return [];
  const trimmed = name.trim();
  const aliases = new Set([trimmed]);
  const match = trimmed.match(/^(.*?)\s*[（(]([^()（）]+)[)）]\s*$/);
  if (match?.[1]?.trim()) aliases.add(match[1].trim());
  if (match?.[2]?.trim()) aliases.add(match[2].trim());
  return Array.from(aliases);
}

export function getAssetLookupKey(
  kind: string,
  name: unknown,
  characterId?: unknown,
): string {
  if (kind === 'CHARACTER' && typeof characterId === 'string' && characterId.trim()) {
    return `${kind}:cid:${characterId.trim()}`;
  }
  return `${kind}:name:${normalizeAssetName(name)}`;
}

export function mergeStringArray(primary: unknown, fallback: unknown): string[] {
  const merged = [
    ...(Array.isArray(fallback) ? fallback : []),
    ...(Array.isArray(primary) ? primary : []),
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return Array.from(new Set(merged));
}

/** number[] 并集（集号用），去重 + 升序，保证跨集合并稳定。 */
export function mergeNumberArray(primary: unknown, fallback: unknown): number[] {
  const merged = [
    ...(Array.isArray(fallback) ? fallback : []),
    ...(Array.isArray(primary) ? primary : []),
  ].filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  return Array.from(new Set(merged)).sort((a, b) => a - b);
}

export function mergeCostumes(
  existingCostumes: unknown,
  nextCostumes: unknown,
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  const ingest = (value: unknown) => {
    for (const raw of Array.isArray(value) ? value : []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const costume = raw as Record<string, unknown>;
      const key = typeof costume.key === 'string' && costume.key.trim()
        ? costume.key.trim()
        : 'default';
      const previous = merged.get(key) ?? {};
      merged.set(key, {
        ...previous,
        ...costume,
        key,
        label: costume.label || previous.label || '默认',
        description: costume.description || previous.description || '',
        identityLock: mergeStringArray(
          costume.identityLock || costume.identity_lock,
          previous.identityLock,
        ),
        coverageScenes: mergeStringArray(
          costume.coverageScenes || costume.coverage_scenes,
          previous.coverageScenes,
        ),
        coverageEpisodes: mergeNumberArray(
          costume.coverageEpisodes || costume.coverage_episodes,
          previous.coverageEpisodes,
        ),
        // 已生成图片永远优先，重新提取只能补文本，不能抹掉用户成果。
        imageUrl: previous.imageUrl || costume.imageUrl || null,
      });
      const current = merged.get(key)!;
      current.imageUrl = previous.imageUrl || costume.imageUrl || null;
    }
  };
  ingest(existingCostumes);
  ingest(nextCostumes);
  return Array.from(merged.values());
}

export function shouldPreserveAssetTextFields(asset: {
  isConfirmed?: boolean;
  regenLocked?: boolean;
} | null | undefined): boolean {
  return asset?.isConfirmed === true || asset?.regenLocked === true;
}

export function shouldProtectAssetFromDeletion(asset: {
  isConfirmed?: boolean;
  regenLocked?: boolean;
  imageUrl?: unknown;
  costumes?: unknown;
} | null | undefined): boolean {
  if (!asset) return false;
  if (asset.isConfirmed === true || asset.regenLocked === true) return true;
  if (typeof asset.imageUrl === 'string' && asset.imageUrl) return true;
  return Array.isArray(asset.costumes)
    && asset.costumes.some((item) => item && typeof item === 'object'
      && typeof (item as Record<string, unknown>).imageUrl === 'string'
      && Boolean((item as Record<string, unknown>).imageUrl));
}
