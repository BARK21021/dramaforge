export interface AssetImageCandidateAsset {
  id: string;
  kind: string;
  imageUrl?: string | null;
  regenLocked?: boolean | null;
  costumes?: unknown;
}

export interface AssetImageGenerationCandidate<TAsset extends AssetImageCandidateAsset> {
  asset: TAsset;
  costumeKey?: string;
  referenceImageUrl?: string;
}

type IsImageCandidatePending = (assetId: string, costumeKey: string) => boolean;

function optionalImageUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Builds the single source of truth used by both batch pricing and submission.
 * Defaults are returned before variants so the baseline identity request is
 * submitted first. A first-click variant still remains a valid T2I request
 * when no baseline image has landed yet, matching app1's behavior.
 */
export function buildMissingAssetImageCandidates<TAsset extends AssetImageCandidateAsset>(
  assets: readonly TAsset[],
  isPending: IsImageCandidatePending,
): Array<AssetImageGenerationCandidate<TAsset>> {
  const defaults: Array<AssetImageGenerationCandidate<TAsset>> = [];
  const variants: Array<AssetImageGenerationCandidate<TAsset>> = [];

  for (const asset of assets) {
    if (asset.kind === 'VOICE' || asset.regenLocked) continue;
    const costumes = Array.isArray(asset.costumes)
      ? asset.costumes.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
        )
      : [];
    const defaultVariant = costumes.find((costume) => costume.key === 'default');
    const defaultImageUrl = optionalImageUrl(defaultVariant?.imageUrl) ?? optionalImageUrl(asset.imageUrl);

    if (!defaultImageUrl && !isPending(asset.id, 'default')) {
      defaults.push({ asset });
    }

    for (const costume of costumes) {
      const costumeKey = typeof costume.key === 'string' ? costume.key.trim() : '';
      if (
        !costumeKey
        || costumeKey === 'default'
        || optionalImageUrl(costume.imageUrl)
        || isPending(asset.id, costumeKey)
      ) {
        continue;
      }
      variants.push({
        asset,
        costumeKey,
        ...(defaultImageUrl ? { referenceImageUrl: defaultImageUrl } : {}),
      });
    }
  }

  return [...defaults, ...variants];
}

/**
 * Builds a complete regeneration plan: one baseline image for every eligible
 * non-voice asset plus every defined non-default costume (角色/物品/环境全类型，
 * 对齐 costumes JSONB 的 kind 无关设计). Pending state is checked per image,
 * so one running variant does not hide its siblings from the confirmation count
 * or submission plan.
 */
export function buildRegenerateAssetImageCandidates<TAsset extends AssetImageCandidateAsset>(
  assets: readonly TAsset[],
  isPending: IsImageCandidatePending,
): Array<AssetImageGenerationCandidate<TAsset>> {
  const defaults: Array<AssetImageGenerationCandidate<TAsset>> = [];
  const variants: Array<AssetImageGenerationCandidate<TAsset>> = [];

  for (const asset of assets) {
    if (asset.kind === 'VOICE' || asset.regenLocked) continue;
    const costumes = Array.isArray(asset.costumes)
      ? asset.costumes.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item),
        )
      : [];
    const defaultVariant = costumes.find((costume) => costume.key === 'default');
    const defaultImageUrl = optionalImageUrl(defaultVariant?.imageUrl) ?? optionalImageUrl(asset.imageUrl);

    if (!isPending(asset.id, 'default')) defaults.push({ asset });

    const seenCostumeKeys = new Set<string>();
    for (const costume of costumes) {
      const costumeKey = typeof costume.key === 'string' ? costume.key.trim() : '';
      if (
        !costumeKey
        || costumeKey === 'default'
        || seenCostumeKeys.has(costumeKey)
        || isPending(asset.id, costumeKey)
      ) {
        continue;
      }
      seenCostumeKeys.add(costumeKey);
      variants.push({
        asset,
        costumeKey,
        ...(defaultImageUrl ? { referenceImageUrl: defaultImageUrl } : {}),
      });
    }
  }

  return [...defaults, ...variants];
}
