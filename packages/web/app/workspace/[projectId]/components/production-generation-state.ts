export interface GenerationShotLike {
  id: string;
  videoStatus?: string | null;
}

export interface ChainGenerationLike {
  status?: string | null;
  progress?: number | null;
  /** Undefined means the active job targets the whole episode. */
  targetShotIds?: readonly string[];
}

const TERMINAL_CHAIN_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
]);

export function isActiveChainGeneration(
  chainJob: ChainGenerationLike | null | undefined,
): boolean {
  if (!chainJob) return false;
  const status = String(chainJob.status ?? "").trim().toUpperCase();
  if (TERMINAL_CHAIN_STATUSES.has(status)) return false;
  const progress =
    typeof chainJob.progress === "number" ? chainJob.progress : 0;
  return progress < 100;
}

/**
 * Combines persisted shot state with the currently running chain scope.
 * The render job starts before individual shot rows are written as GENERATING,
 * so the client-side job scope is the authoritative state during that gap.
 */
export function deriveGeneratingShotIds(
  shots: readonly GenerationShotLike[],
  chainJob: ChainGenerationLike | null | undefined,
): Set<string> {
  const knownShotIds = new Set(shots.map((shot) => shot.id));
  const generatingShotIds = new Set(
    shots
      .filter((shot) => shot.videoStatus === "GENERATING")
      .map((shot) => shot.id),
  );

  if (!isActiveChainGeneration(chainJob)) return generatingShotIds;
  const targets = chainJob?.targetShotIds ?? shots.map((shot) => shot.id);
  for (const shotId of targets) {
    if (knownShotIds.has(shotId)) generatingShotIds.add(shotId);
  }
  return generatingShotIds;
}

export function getEffectiveVideoStatus(
  shot: GenerationShotLike,
  generatingShotIds: ReadonlySet<string>,
): string {
  return generatingShotIds.has(shot.id)
    ? "GENERATING"
    : shot.videoStatus || "PENDING";
}
