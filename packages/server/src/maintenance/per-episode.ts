// maintenance/per-episode.ts — 批量编剧分析 + 分镜（复刻 web route 核心，绕 session）
//
// 用法：PROJECT_ID=... USER_ID=... EP_NUM=1 node dist/per-episode.js
//   EP_NUM 省略 = 跑全集。复刻 analyze + generate-storyboard route 的核心逻辑：
//   buildScriptAnalysisPrompt → callAI → parseScriptResult → 写 scriptData
//   → listAssets + buildStoryboardPrompt → callAI → parseStoryboardShots
//   → postprocessStoryboardShots（含变体校验）→ replaceEpisodeShots + warnings 持久化。
import {
  callAI,
  buildScriptAnalysisPrompt,
  parseScriptResult,
  validateAnalysisConsistency,
  detectLanguage,
  listAssets,
  buildStoryboardPrompt,
  parseStoryboardShots,
  postprocessStoryboardShots,
  inferCostumeVariants,
  replaceEpisodeShots,
  buildLocalizedDurationBudget,
} from '@server/index';
import { query } from '@server/infra';
import { createHash } from 'crypto';

const PROJECT_ID = process.env.PROJECT_ID || 'a8a18764-661b-4c60-a760-b6bc9c646aa5';
const USER_ID = process.env.USER_ID || '69bfc804-6dca-4ddb-bfb9-11ed8e144bfc';
const ONLY_EP = process.env.EP_NUM ? parseInt(process.env.EP_NUM, 10) : null;
const MODEL = 'deepseek/deepseek-v4-flash';

function readAssetSourceNames(meta: unknown): string[] {
  const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
  const s = m.sourceNames ?? m.source_names;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string') : [];
}
function buildEpisodeVariants(costumes: unknown, epNum: number) {
  const list = Array.isArray(costumes) ? (costumes as Record<string, unknown>[]) : [];
  const active = list.filter((c) => {
    const eps = c.coverageEpisodes ?? c.coverage_episodes;
    if (!Array.isArray(eps) || eps.length === 0) return true;
    return eps.some((n) => Number(n) === epNum);
  });
  return active
    .filter((c) => typeof c.key === 'string' && c.key.trim())
    .map((c) => ({
      key: String(c.key).trim(),
      label: typeof c.label === 'string' ? c.label : '',
      description: typeof c.description === 'string' ? c.description : null,
    }));
}

interface EpisodeRow { id: string; nt: string; sd: unknown; epnum: number }

async function processEpisode(ep: EpisodeRow, category: string): Promise<void> {
  const episodeNumber = ep.epnum;
  const novelText = ep.nt;
  console.log(`\n=== EP${episodeNumber} (len ${novelText.length}) ===`);

  // 分析（重试恢复，非阻断）：AI 偶发幻觉/缓存污染会返回与原文不一致的分析。
  // 带 cache-busting nonce 重试几次拿对的内容，全败才抛错。
  const language = detectLanguage(novelText);
  const { system, user } = buildScriptAnalysisPrompt(
    novelText, undefined,
    { episodeNumber, previousEpisodes: [], existingAssets: [] } as never,
    language,
  );
  const MAX_ATTEMPTS = 2;
  let parsed: ReturnType<typeof parseScriptResult> | null = null;
  let aContent = '';
  let lastFail = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const nonceUser = attempt === 1 ? user : `[分析请求#${attempt}]\n${user}`;
    const aRes = await callAI('deepseek', 'deepseek-v4-flash', {
      capability: 'text_generation', userId: USER_ID,
      input: {
        messages: [{ role: 'system', content: system }, { role: 'user', content: nonceUser }],
        temperature: 0.7, maxTokens: 393216,
      },
    });
    const content = typeof (aRes.meta as { content?: unknown })?.content === 'string'
      ? (aRes.meta as { content: string }).content : '';
    if (!content) { lastFail = 'analyze empty'; continue; }
    const candidate = parseScriptResult(content);
    if (!candidate.scenes || candidate.scenes.length === 0) { lastFail = 'no scenes'; continue; }
    const consistency = validateAnalysisConsistency(candidate, novelText);
    if (!consistency.ok) {
      if (consistency.kind === 'characters') {
        // 局部瑕疵：只过滤编造角色，不整体重跑
        const bad = new Set(consistency.hallucinated);
        candidate.characters = candidate.characters.filter((c) => !bad.has(c));
        parsed = candidate;
        aContent = content;
        break;
      }
      lastFail = consistency.reason; // total → 重试
      continue;
    }
    parsed = candidate;
    aContent = content;
    break;
  }
  if (!parsed) throw new Error(`EP${episodeNumber} 重试${MAX_ATTEMPTS}次仍不可信：${lastFail}`);
  const novelTextHash = createHash('sha256').update(novelText).digest('hex').slice(0, 16);
  const scriptData = {
    ...(ep.sd && typeof ep.sd === 'object' ? ep.sd as Record<string, unknown> : {}),
    rawAnalysis: aContent, scenes: parsed.scenes, infoPoints: parsed.infoPoints,
    sceneMeta: parsed.sceneMeta, costumeMap: parsed.costumeMap, characters: parsed.characters,
    modelUsed: MODEL, analyzedAt: new Date().toISOString(),
    novelTextHash, novelLanguage: language,
  };
  await query(
    'UPDATE episodes SET "scriptData"=$1, status=$2, "stageStatus"=$3 WHERE id=$4',
    [JSON.stringify(scriptData), 'COMPLETED', 'assets', ep.id],
  );
  console.log(`[EP${episodeNumber}] analyze OK: ${parsed.scenes.length} scenes, ${parsed.characters.length} chars`);

  // 分镜
  const scenes = parsed.scenes.map((s) => ({
    id: s.id, location: s.location ?? null, time: s.time ?? null, intExt: s.intExt ?? null,
    characters: parsed.characters.filter((c) => s.content?.includes(c)), content: s.content ?? '',
  }));
  const allAssets = await listAssets(PROJECT_ID);
  const assets = allAssets
    .filter((a) => ['CHARACTER', 'PROP', 'LOCATION', 'ENTITY'].includes(a.kind))
    .map((a) => {
      const base = { kind: a.kind, name: a.name, description: a.description, sourceNames: readAssetSourceNames(a.metadata) };
      if (a.kind !== 'PROP' && a.kind !== 'LOCATION') return base;
      const variants = buildEpisodeVariants(a.costumes, episodeNumber);
      return variants.length > 1 ? { ...base, variants } : base;
    });
  const durationBudget = buildLocalizedDurationBudget(undefined, undefined);
  const { system: sbSys, user: sbUser } = buildStoryboardPrompt(
    scenes, assets as never,
    { episodeNumber, durationBudget, category } as never,
  );
  const sRes = await callAI('deepseek', 'deepseek-v4-flash', {
    capability: 'text_generation', userId: USER_ID,
    input: {
      messages: [{ role: 'system', content: sbSys }, { role: 'user', content: sbUser }],
      temperature: 0.7, maxTokens: 131072, thinking: 'disabled',
    },
  });
  const sContent = typeof (sRes.meta as { content?: unknown })?.content === 'string'
    ? (sRes.meta as { content: string }).content : '';
  if (!sContent) throw new Error(`EP${episodeNumber} storyboard empty`);
  const parsedShots = parseStoryboardShots(sContent);
  if (parsedShots.length === 0) throw new Error(`EP${episodeNumber} no shots`);
  const targetLang = category === 'DOMESTIC' ? 'zh' : undefined;
  const processed = postprocessStoryboardShots(parsedShots, scenes as never, assets as never, targetLang);
  const coverageByScene = new Map(processed.dialogueCoverage.map((i) => [i.sceneId, i]));
  const replacements = processed.shots.map((sh, index) => {
    const gi = index + 1;
    const gi2 = sh.groupIndex ?? 0;
    const gl = sh.groupLabel ?? `组 ${gi2 + 1}`;
    return {
      projectId: PROJECT_ID, episodeId: ep.id, shotIndex: gi,
      shotSeq: sh.sceneId ? `${sh.sceneId}-${sh.shotIndex}` : `SHOT-${gi}`,
      durationSeconds: sh.durationSeconds, visualPrompt: sh.visualPrompt, purposeTag: sh.purposeTag,
      emotionArcPosition: sh.emotionArcPosition, audioType: sh.audioType,
      referencedAssets: {
        characters: sh.characters, speakingCharacters: sh.speakingCharacters,
        environments: sh.environments, items: sh.items,
        ...(sh.itemCostumes && sh.itemCostumes.length > 0 ? { itemCostumes: sh.itemCostumes } : {}),
        ...(sh.environmentCostumes && sh.environmentCostumes.length > 0 ? { environmentCostumes: sh.environmentCostumes } : {}),
      },
      metadata: {
        sceneId: sh.sceneId || null, dialogue: sh.dialogue || null, action: sh.action || null,
        shotSize: sh.shotSize || null, cameraAngle: sh.cameraAngle || null, cameraMovement: sh.cameraMovement || null,
        soundCue: sh.soundCue || null, groupIndex: gi2, groupLabel: gl,
        dialogueCoverage: coverageByScene.get(sh.sceneId) ?? null,
        storyboardTable: { sceneId: sh.sceneId || null, groupIndex: gi2, groupLabel: gl, shotSize: sh.shotSize || null, cameraAngle: sh.cameraAngle || null, cameraMovement: sh.cameraMovement || null, action: sh.action || null, soundCue: sh.soundCue || null },
        structuredPrompt: { scene: sh.sceneContext || null, sceneDesign: sh.sceneDesign || null, visualInfo: sh.visualInfo || null },
        source: 'ai',
      },
      sortOrder: gi,
    };
  });
  await replaceEpisodeShots(ep.id, replacements as never);
  // 持久化 postprocess warnings（与 route 优化一致：含编造资产/非法变体/对白未覆盖）
  await query(
    `UPDATE episodes SET "scriptData" = COALESCE("scriptData",'{}'::jsonb) || $1::jsonb WHERE id=$2`,
    [JSON.stringify({ storyboardWarnings: processed.warnings ?? [] }), ep.id],
  );
  console.log(`[EP${episodeNumber}] storyboard OK: ${processed.shots.length} shots, ${processed.warnings?.length ?? 0} warnings`);
  if (processed.warnings && processed.warnings.length > 0) {
    console.log(`  warnings: ${JSON.stringify(processed.warnings).slice(0, 800)}`);
  }
}

/**
 * 仅修变体（不调 AI、不重生成）：读现有 shots，对每镜用 inferCostumeVariants
 * 把 default 补成剧情状态对应的状态变体（如云合并/手环碎裂），改了才写回。
 * 用于一次性修复历史 shots 里"AI 一律 default"造成的变体穿帮。
 * 用法：PROJECT_ID=... VARIANTS_ONLY=1 node dist/per-episode.js
 */
type VariantRef = { name: string; costumeKey: string };

async function runVariantsOnly(): Promise<void> {
  const allAssets = await listAssets(PROJECT_ID);
  // 多态资产（PROP/LOCATION，>1 变体）→ 带 variants 的 StoryboardAssetRef。
  // coverageEpisodes 为空时全部变体都 active，故不按集过滤。
  const polyAssets = allAssets
    .filter((a) => a.kind === 'PROP' || a.kind === 'LOCATION')
    .map((a) => {
      const costumes = Array.isArray(a.costumes) ? a.costumes : [];
      const variants = costumes
        .filter((c) => c && typeof c.key === 'string' && c.key.trim())
        .map((c) => ({ key: String(c.key).trim(), label: typeof c.label === 'string' ? c.label : '', description: typeof c.description === 'string' ? c.description : null }));
      return { kind: a.kind, name: a.name, description: a.description, sourceNames: readAssetSourceNames(a.metadata), variants };
    })
    .filter((a) => Array.isArray(a.variants) && a.variants.length > 1);

  const items = polyAssets.filter((a) => a.kind === 'PROP');
  const envs = polyAssets.filter((a) => a.kind === 'LOCATION');
  console.log(`[variants-only] poly assets: ${items.length} prop, ${envs.length} env`);

  const rows = (await query(
    `SELECT s.id, e."episodeNumber" AS epnum, s."visualPrompt" AS vp, s.metadata AS md, s."referencedAssets" AS ra
     FROM shots s JOIN episodes e ON e.id=s."episodeId"
     WHERE s."projectId"=$1 ORDER BY e."episodeNumber", s."shotIndex"`,
    [PROJECT_ID],
  )).rows as Array<{ id: string; epnum: number; vp: unknown; md: unknown; ra: unknown }>;

  let itemChanges = 0;
  let envChanges = 0;
  for (const row of rows) {
    const md = (row.md && typeof row.md === 'object' ? row.md : {}) as Record<string, any>;
    const ra = (row.ra && typeof row.ra === 'object' ? row.ra : {}) as Record<string, any>;
    const sp = (md.structuredPrompt && typeof md.structuredPrompt === 'object' ? md.structuredPrompt : {}) as Record<string, any>;
    const shotLike = {
      visualPrompt: typeof row.vp === 'string' ? row.vp : '',
      dialogue: typeof md.dialogue === 'string' ? md.dialogue : '',
      action: typeof md.action === 'string' ? md.action : '',
      soundCue: typeof md.soundCue === 'string' ? md.soundCue : '',
      sceneContext: typeof sp.scene === 'string' ? sp.scene : '',
      sceneDesign: typeof sp.sceneDesign === 'string' ? sp.sceneDesign : '',
    } as never;
    const warnings: string[] = [];
    const newItem = inferCostumeVariants(shotLike, items as never, (Array.isArray(ra.itemCostumes) ? ra.itemCostumes : undefined) as never, Array.isArray(ra.items) ? ra.items : [], warnings, '道具') as VariantRef[] | undefined;
    const newEnv = inferCostumeVariants(shotLike, envs as never, (Array.isArray(ra.environmentCostumes) ? ra.environmentCostumes : undefined) as never, Array.isArray(ra.environments) ? ra.environments : [], warnings, '环境') as VariantRef[] | undefined;
    const itemChanged = newItem && newItem.some((r, i) => ra.itemCostumes?.[i]?.costumeKey !== r.costumeKey);
    const envChanged = newEnv && newEnv.some((r, i) => ra.environmentCostumes?.[i]?.costumeKey !== r.costumeKey);
    if (!itemChanged && !envChanged) continue;
    const nextRa = { ...ra, ...(itemChanged ? { itemCostumes: newItem } : {}), ...(envChanged ? { environmentCostumes: newEnv } : {}) };
    await query('UPDATE shots SET "referencedAssets"=$1 WHERE id=$2', [JSON.stringify(nextRa), row.id]);
    if (itemChanged) itemChanges += newItem!.filter((r, i) => ra.itemCostumes?.[i]?.costumeKey !== r.costumeKey).length;
    if (envChanged) envChanges += newEnv!.filter((r, i) => ra.environmentCostumes?.[i]?.costumeKey !== r.costumeKey).length;
    console.log(`[EP${row.epnum}] shot ${row.id.slice(0,8)}: ${warnings.join('; ')}`);
  }
  console.log(`[variants-only] DONE: ${itemChanges} item + ${envChanges} env costumeKey 修正`);
}

/**
 * 只回填 novelTextHash + novelLanguage（不调 AI、不动分析产物）。
 * 给守卫上线前已分析的历史 episode 补齐漂移检测指纹：补齐后 generate-storyboard
 * 的 ANALYSIS_STALE 检测对这些集也生效（novelText 事后被改即 401 拦下）。
 * 哈希口径与 analyze route 一致：sha256(novelText.trim()).slice(0,16)。
 * 用法：PROJECT_ID=... HASH_ONLY=1 node dist/per-episode.js
 */
async function runHashBackfill(): Promise<void> {
  const rows = (await query(
    'SELECT id, "episodeNumber" AS epnum, "novelText" AS nt FROM episodes WHERE "projectId"=$1 ORDER BY "episodeNumber"',
    [PROJECT_ID],
  )).rows as Array<{ id: string; epnum: number; nt: unknown }>;
  let filled = 0;
  for (const r of rows) {
    const nt = typeof r.nt === 'string' ? r.nt : '';
    const hash = createHash('sha256').update(nt.trim()).digest('hex').slice(0, 16);
    const lang = detectLanguage(nt);
    await query(
      `UPDATE episodes SET "scriptData" = COALESCE("scriptData",'{}'::jsonb) || jsonb_build_object('novelTextHash',$1::text,'novelLanguage',$2::text)::jsonb WHERE id=$3`,
      [hash, lang, r.id],
    );
    filled += 1;
  }
  console.log(`[hash-backfill] ${filled}/${rows.length} episodes 补齐 novelTextHash`);
}

export async function main(): Promise<void> {
  if (process.env.VARIANTS_ONLY === '1') {
    return runVariantsOnly();
  }
  if (process.env.HASH_ONLY === '1') {
    return runHashBackfill();
  }
  const eps = (await query(
    'SELECT id, "novelText" AS nt, "scriptData" AS sd, "episodeNumber" AS epnum FROM episodes WHERE "projectId"=$1 ORDER BY "episodeNumber"',
    [PROJECT_ID],
  )).rows as EpisodeRow[];
  const project = (await query('SELECT category FROM projects WHERE id=$1', [PROJECT_ID])).rows[0] as { category: string };
  console.log(`project ${PROJECT_ID}: ${eps.length} episodes, category=${project.category}, ONLY_EP=${ONLY_EP ?? 'all'}`);
  const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '5', 10));
  const queue = eps.filter((ep) => ONLY_EP === null || Number(ep.epnum) === ONLY_EP);
  console.log(`[main] eps=${eps.length} queued=${queue.length} concurrency=${CONCURRENCY}`);
  let done = 0;
  const total = queue.length;
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const ep = queue.shift();
      if (!ep) break;
      try {
        await processEpisode(ep, project.category);
      } catch (e) {
        console.error(`[EP${ep.epnum}] FAILED:`, e instanceof Error ? e.message : e);
      }
      done += 1;
      console.log(`[progress] ${done}/${total} done`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));
  console.log('\n=== ALL DONE ===');
}
