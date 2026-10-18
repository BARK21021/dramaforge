export interface AnalysisEpisodeLike {
  id: string;
  episodeNumber: number;
  title?: string | null;
  novelText?: string | null;
  content?: string | null;
  scenes?: unknown;
  scriptData?: unknown;
}

export interface AnalysisAssetLike {
  kind: string;
  name: string;
  description?: string | null;
  costumes?: unknown;
  coverageScenes?: string[] | null;
}

interface SceneLike {
  id?: unknown;
  location?: unknown;
  characters?: unknown;
  content?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readScenes(episode: AnalysisEpisodeLike): SceneLike[] {
  const scriptData = asRecord(episode.scriptData);
  const value = Array.isArray(episode.scenes)
    ? episode.scenes
    : Array.isArray(scriptData.scenes)
      ? scriptData.scenes
      : [];
  return value.filter(
    (scene): scene is SceneLike => Boolean(scene) && typeof scene === 'object' && !Array.isArray(scene),
  );
}

function sceneContent(scene: SceneLike): string {
  return typeof scene.content === 'string' ? scene.content.trim() : '';
}

/**
 * Builds the same two-layer continuity context app1 uses:
 * - concise scene/asset data goes into the system prompt;
 * - every previous scene's full text is prepended to the user prompt.
 *
 * The full text is intentionally not truncated. Continuity failures caused by
 * losing an earlier promise, prop hand-off, costume change, or relationship
 * beat are more expensive than the extra text tokens.
 */
export function buildEpisodeAnalysisContext(
  currentEpisode: AnalysisEpisodeLike,
  allEpisodes: readonly AnalysisEpisodeLike[],
  assets: readonly AnalysisAssetLike[],
  language: 'en' | 'zh',
): {
  previousEpisodes: Array<{
    episodeNumber: number;
    title?: string | null;
    sceneSummaries: Array<{
      id: string;
      location: string;
      characters: string[];
      contentExcerpt: string;
    }>;
  }>;
  existingAssets: Array<{
    kind: string;
    name: string;
    description?: string;
    costumes?: Array<{
      key: string;
      label: string;
      description: string;
      identityLock: string[];
      imageUrl: string | null;
      coverageScenes: string[];
      variantType?: 'costume' | 'period';
    }>;
    coverageScenes?: string[];
  }>;
  previousScriptsPrefix: string;
} {
  const previous = allEpisodes
    .filter((episode) => episode.episodeNumber < currentEpisode.episodeNumber)
    .slice()
    .sort((a, b) => a.episodeNumber - b.episodeNumber);

  const previousEpisodes = previous.map((episode) => {
    const scenes = readScenes(episode);
    return {
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      sceneSummaries: scenes.map((scene, index) => ({
        id: typeof scene.id === 'string' && scene.id.trim() ? scene.id.trim() : `S${index + 1}`,
        location: typeof scene.location === 'string' ? scene.location : '',
        characters: Array.isArray(scene.characters)
          ? scene.characters.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
          : [],
        contentExcerpt: sceneContent(scene),
      })),
    };
  });

  const existingAssets = assets
    .filter((asset) => ['CHARACTER', 'PROP', 'LOCATION'].includes(asset.kind) && asset.name.trim())
    .map((asset) => ({
      kind: asset.kind,
      name: asset.name.trim(),
      ...(asset.description?.trim() ? { description: asset.description.trim() } : {}),
      ...(Array.isArray(asset.costumes)
        ? {
            costumes: asset.costumes
              .filter(
                (costume): costume is Record<string, unknown> => Boolean(costume) && typeof costume === 'object' && !Array.isArray(costume),
              )
              .map((costume) => ({
                key: typeof costume.key === 'string' && costume.key.trim() ? costume.key.trim() : 'default',
                label: typeof costume.label === 'string' ? costume.label : '',
                description: typeof costume.description === 'string' ? costume.description : '',
                identityLock: (Array.isArray(costume.identityLock)
                  ? costume.identityLock
                  : Array.isArray(costume.identity_lock)
                    ? costume.identity_lock
                    : []).filter((value): value is string => typeof value === 'string'),
                imageUrl: typeof costume.imageUrl === 'string' ? costume.imageUrl : null,
                coverageScenes: (Array.isArray(costume.coverageScenes)
                  ? costume.coverageScenes
                  : Array.isArray(costume.coverage_scenes)
                    ? costume.coverage_scenes
                    : []).filter((value): value is string => typeof value === 'string'),
                ...((costume.variantType === 'period' || costume.variant_type === 'period')
                  ? { variantType: 'period' as const }
                  : {}),
              })),
          }
        : {}),
      ...(Array.isArray(asset.coverageScenes) ? { coverageScenes: asset.coverageScenes } : {}),
    }));

  const fullPreviousScripts = previous.map((episode) => {
    const scenes = readScenes(episode);
    const fullScenes = scenes.length > 0
      ? scenes.map((scene, index) => {
          const id = typeof scene.id === 'string' && scene.id.trim() ? scene.id.trim() : `S${index + 1}`;
          const location = typeof scene.location === 'string' ? scene.location : '';
          return `## ${id}${location ? ` [${location}]` : ''}\n${sceneContent(scene)}`;
        }).join('\n\n')
      : (episode.content || episode.novelText || '').trim();
    return `=== EP${episode.episodeNumber}${episode.title ? ` ${episode.title}` : ''} ===\n${fullScenes}`;
  }).filter((block) => !block.endsWith('===\n'));

  const previousScriptsPrefix = fullPreviousScripts.length === 0
    ? ''
    : language === 'en'
      ? [
          `The following is the COMPLETE script of every previous episode (EP1–EP${currentEpisode.episodeNumber - 1}). Read it for continuity only. Preserve established identities, costumes, props, locations, plot facts, and unresolved beats; never copy or invent previous-episode events as new current-episode content.`,
          ...fullPreviousScripts,
          `=== Current Episode Source (EP${currentEpisode.episodeNumber}) ===`,
          '',
        ].join('\n\n')
      : [
          `以下是前面所有集（第1集—第${currentEpisode.episodeNumber - 1}集）的完整剧本。仅用于连续性：保持既有人物身份、造型、道具、环境、剧情事实与未回收伏笔；严禁把前集事件复制或杜撰成当前集内容。`,
          ...fullPreviousScripts,
          `=== 当前集原文（第${currentEpisode.episodeNumber}集）===`,
          '',
        ].join('\n\n');

  return { previousEpisodes, existingAssets, previousScriptsPrefix };
}
