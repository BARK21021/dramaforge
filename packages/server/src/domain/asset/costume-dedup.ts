// ============================================================
// ③ server/domain/asset/costume-dedup — 造型变体 AI 去重（一次性数据修复 + 维护）
// ============================================================
//
// 背景：整剧资产提取在"本地化前(中文剧本)"和"本地化后(目标语言剧本)"各跑一次时，
// mergeCostumes 只按 key 去重，中英文 key 不同 → 同一套服装存了两份（一份中文 label、
// 一份英文 label）。本模块用一次 AI 调用逐资产合并跨语言等价变体：
//   - 输出干净的全中文 label/description + 稳定英文 slug key
//   - 通过 absorb 列表保留被合并变体的已生成图片、并集 coverage_episodes/identity_lock
//
// 触发：POST /api/projects/[id]/assets/dedup-costumes（管理/维护操作）。
// 纯文本 AI 调用，零媒体字节，零 ffmpeg。
// ============================================================

import { callAI } from '@server/gateway';
import { tx } from '@server/infra';
import { listAssets, type AssetRecord } from './service';
import { mergeNumberArray, mergeStringArray } from './asset-reuse';
import { safeParseJsonObject } from '../prompt/json-repair';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/** 造型变体最小读取结构（camelCase，对齐写库格式）。 */
interface CostumeLike {
  key?: string;
  label?: string;
  description?: string;
  identityLock?: unknown;
  coverageScenes?: unknown;
  coverageEpisodes?: unknown;
  imageUrl?: string | null;
  variantType?: unknown;
}

/** AI 去重后的单条变体（含 absorb：被合并的输入 key 列表）。 */
interface DedupedCostume {
  key: string;
  label: string;
  description?: string;
  variant_type?: 'costume' | 'period';
  absorb: string[];
}

function isHan(s: string): boolean {
  return /[㐀-鿿]/u.test(s);
}

/** 该资产的变体是否值得调 AI 去重（≥2 变体，且中英混杂或数量偏多疑似重复）。 */
function looksMessy(costumes: CostumeLike[]): boolean {
  if (costumes.length < 2) return false;
  const labels = costumes.map((c) => c.label || c.key || '');
  const hasCN = labels.some((l) => isHan(l));
  const hasEN = labels.some((l) => /[A-Za-z]/.test(l));
  return (hasCN && hasEN) || costumes.length >= 4;
}

/**
 * 单个资产的造型去重。调一次 AI，把跨语言/跨 key 的同一套服装合并。
 * 返回去重后的 costumes（已并集 eps/identityLock、保留图片）；无需去重时返回 null。
 */
async function dedupOneAssetCostumes(
  assetName: string,
  kind: string,
  costumes: CostumeLike[],
  userId: string,
  model: string,
): Promise<Record<string, unknown>[] | null> {
  // 喂给 AI 的输入：key/label/description/集号/是否有图。
  const inputs = costumes.map((c, i) => ({
    idx: i,
    key: c.key || `variant-${i}`,
    label: c.label || '',
    description: (c.description || '').slice(0, 200),
    coverageEpisodes: Array.isArray(c.coverageEpisodes) ? c.coverageEpisodes : [],
    hasImage: !!(c.imageUrl && String(c.imageUrl).trim()),
  }));

  const system = [
    '你是影视资产造型去重器。输入某个资产的若干造型/状态变体——其中可能含重复：同一套服装/状态被提取了两次（常见为一次中文 label、一次英文 label，或仅 key/label 措辞不同）。',
    '任务：把语义重复的变体合并为一个最小、干净、全中文的去重后集合。',
    '规则：',
    '1. 完全相同的服装/状态（无论中英文、无论 key/label 措辞差异）只合并成一条。判断依据是 description 描述的实际服装/状态，不要被 label 语言或 key 不同误导。',
    '2. 真正不同的服装/状态必须分开保留（如"骑士铠甲"与"战损铠甲"是两条；"村妇装"与"婚纱"是两条）。基准/最常出场的用 key="default"。',
    '3. 输出 label 与 description 必须用简体中文。',
    '4. key 必须是稳定的英文 slug（小写、连字符、无中文、无空格、无数字后缀），如 default / light-knight-armor / recovery-casual / wedding-dress。禁止 custom-N、variant-N 这类无语义 key。',
    '5. 每条输出含 absorb：被它合并掉的输入 key 列表（必须至少包含自身对应的那个输入 key；把所有同义输入 key 都列进去，用于保留图片与集号）。',
    '6. variant_type：普通换装/状态用 "costume"；同一人物不同人生阶段用 "period"。',
    `7. 资产名：${assetName}（${kind}）`,
    '只输出 JSON：{"costumes":[{"key":"default","label":"中文名","description":"中文描述","variant_type":"costume","absorb":["输入key1","输入key2"]}]}。不要 markdown 围栏、不要解释。',
  ].join('\n');

  const result = await callAI('deepseek', model, {
    capability: 'text_generation',
    userId,
    input: {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ costumes: inputs }) },
      ],
      temperature: 0.1,
      maxTokens: 8192,
      // 关闭链式推理：去重是按 description 判等价的确定性分类任务，无需推理；
      // dedupProjectCostumes 逐资产串行调用，关闭 thinking 显著缩短整项目去重耗时。
      thinking: 'disabled',
    },
  });

  const meta = (result.meta ?? {}) as { content?: string };
  const parsed = safeParseJsonObject(meta.content || '') as { costumes?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.costumes) || parsed.costumes.length === 0) return null;

  // 输入 key → costume 索引，用于 absorb 回查并集图片/集号/锁定。
  const byKey = new Map<string, CostumeLike>();
  for (const c of costumes) {
    const k = (c.key || '').trim();
    if (k && !byKey.has(k)) byKey.set(k, c);
  }

  const merged: Record<string, unknown>[] = [];
  const seenKeys = new Set<string>();
  for (const raw of parsed.costumes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const d = raw as Partial<DedupedCostume> & Record<string, unknown>;
    const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : 'default';
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const absorbKeys: string[] = Array.isArray(d.absorb)
      ? d.absorb.filter((k): k is string => typeof k === 'string' && Boolean(k.trim())).map((k) => k.trim())
      : [];
    if (!absorbKeys.includes(key) && byKey.has(key)) absorbKeys.push(key);
    const absorbed = absorbKeys.map((k) => byKey.get(k)).filter((c): c is CostumeLike => Boolean(c));
    if (absorbed.length === 0) continue; // 无任何输入命中 → 丢弃（防止 AI 编造）
    // 图片：任一被合并变体有图即保留。
    const imageUrl = absorbed.map((c) => c.imageUrl).find((u) => typeof u === 'string' && u.trim()) ?? null;
    merged.push({
      key,
      label: typeof d.label === 'string' && d.label.trim() ? d.label.trim() : absorbed[0].label || key,
      description: typeof d.description === 'string' && d.description.trim()
        ? d.description.trim()
        : absorbed.map((c) => c.description || '').find((s) => s.trim()) || '',
      identityLock: mergeStringArray(
        absorbed[0].identityLock,
        absorbed.flatMap((c) => c.identityLock),
      ),
      coverageScenes: mergeStringArray(
        absorbed[0].coverageScenes,
        absorbed.flatMap((c) => c.coverageScenes),
      ),
      coverageEpisodes: mergeNumberArray(
        absorbed[0].coverageEpisodes,
        absorbed.flatMap((c) => c.coverageEpisodes),
      ),
      ...(imageUrl ? { imageUrl } : {}),
      ...(d.variant_type === 'period' ? { variantType: 'period' } : {}),
    });
  }
  if (merged.length === 0 || merged.length >= costumes.length) return null; // 没减重就不写
  return merged;
}

export interface CostumeDedupOutput {
  processed: number; // 调 AI 的资产数
  cleaned: number; // 实际减重写回的资产数
  details: Array<{ id: string; name: string; kind: string; before: number; after: number }>;
}

/**
 * 全项目造型变体去重。逐资产调 AI 合并跨语言等价变体，保留图片，写回 costumes 列。
 * 仅处理"疑似重复"的资产（中英混杂或 ≥4 变体），避免无谓 AI 调用。
 */
export async function dedupProjectCostumes(
  projectId: string,
  userId: string,
  model: string = DEFAULT_MODEL,
): Promise<CostumeDedupOutput> {
  const assets: AssetRecord[] = await listAssets(projectId);
  const candidates = assets.filter(
    (a) => (a.kind === 'CHARACTER' || a.kind === 'PROP' || a.kind === 'LOCATION')
      && Array.isArray(a.costumes)
      && looksMessy(a.costumes as CostumeLike[]),
  );

  let cleaned = 0;
  const details: CostumeDedupOutput['details'] = [];
  for (const asset of candidates) {
    const costumes = (asset.costumes || []) as CostumeLike[];
    const before = costumes.length;
    let deduped: Record<string, unknown>[] | null = null;
    try {
      deduped = await dedupOneAssetCostumes(asset.name, asset.kind, costumes, userId, model);
    } catch {
      deduped = null;
    }
    if (!deduped) continue;
    // 写回（单条 UPDATE，保留其它列）。
    await tx(async (q) => {
      await q.query(
        'UPDATE assets SET costumes = $1::jsonb, "updatedAt" = NOW() WHERE id = $2 AND "projectId" = $3',
        [JSON.stringify(deduped), asset.id, projectId],
      );
    });
    cleaned += 1;
    details.push({ id: asset.id, name: asset.name, kind: asset.kind, before, after: deduped.length });
  }

  return { processed: candidates.length, cleaned, details };
}
