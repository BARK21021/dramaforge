function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readGuidance(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 5_000)
    : undefined;
}

/**
 * Screenwriter guidance is project work, not browser state. A retry from a new
 * client must therefore reuse the last persisted guidance when the request
 * does not carry a replacement.
 */
export function resolveAnalysisGuidance(
  requestGuidance: unknown,
  episodeScriptData: unknown,
  projectScriptData: unknown,
): string | undefined {
  return readGuidance(requestGuidance)
    ?? readGuidance(asRecord(episodeScriptData).analysisGuidance)
    ?? readGuidance(asRecord(projectScriptData).analysisGuidance);
}
