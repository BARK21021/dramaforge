// 资产提取提示词模板
// 从剧本文本中提取四类资产：角色 / 物品 / 环境 / 实体（非人发声体）
// 实体 ENTITY：承载叙事功能的非人发声体（系统音/AI/会说法宝），给 UI 面板式设计图 + 绑音色
// 音色绑定：提取时按 suggested_voices 自动绑 confirmed_voice（角色与实体均绑）
// 输出 JSON 格式，对齐 Frameos 业务模型
// 双语：英文剧本 → 英文 prompt；默认遵循剧本自身文化背景，不擅自推断具体国籍/族裔
// ============================================================

import { safeParseJsonObject } from "./json-repair";
import {
  detectLanguage,
  detectLanguageFromAssets,
  getBilingualNameAliases,
  normalizeNameForPrompt,
  type ScriptLanguage,
} from "./language";
import type { CostumeMapEntry } from "./script-prompt";
import type { LocalizationProfile } from "./target-languages";

/**
 * 资产提取提示词的可选上下文。
 * - costumeMap：编剧分析阶段产出的造型表（场景→角色→造型），用于让 AI 分组输出 costumes。
 * - existingCharacters：已有角色造型列表（ep2+ 跨集复用，要求模型复用已有 key、只为新造型新增条目）。
 * - existingItems / existingEnvironments：已有物品/环境清单（跨集增量提取，要求模型不为已有资产重复输出完整字段）。
 */
export interface AssetExtractionOptions {
  costumeMap?: CostumeMapEntry[];
  existingCharacters?: Array<{ name: string; costumes: Array<{ key: string; label: string }> }>;
  /**
   * 编剧分析阶段已经锁定的角色标识符。资产提取结果会按此清单做代码级回写，
   * 防止模型把「中文标识(目标语言姓名)」擅自缩成中文名或目标语言名。
   */
  canonicalCharacterNames?: string[];
  /** 海外转绘模式：中文制作叙述不等于角色文化/族裔，需服从目标本地化语境。 */
  overseasAdaptation?: boolean;
  /** 文本转风格阶段持久化的目标语言与文化档案。 */
  localizationProfile?: LocalizationProfile;
  /** 编剧分析阶段的用户增强指导；资产提取需继续遵守，避免两个阶段目标分叉。 */
  analysisGuidance?: string;
  /** 创建项目时锁定的视觉风格；资产描述不得写入冲突的媒介或画风。 */
  visualStylePrompt?: string;
  /**
   * 全局角色映射表（来自 projects.characterMapping.entries）— 用于按角色 ID 约束角色提取，防止跨集重复创建。
   * 角色身份由 LLM 语义标注判定：相同 characterId 跨集必须复用同一角色资产，不得因服饰/造型变化创建新角色。
   */
  characterMapping?: Array<{
    characterId: string;        // 角色a、角色b...
    roleIdentity: string;       // 已识别的角色身份描述（可能为空，表示待 LLM 推断）
    name?: string | null;       // 已识别的角色名（可能为空）
    firstEpisode: number;       // 首次出现的集号
  }>;
  /** 已有物品清单（跨集增量提取）— 模型按 name 判定是否已有，已有资产仅在 coverage_scenes 追加场景 */
  existingItems?: Array<{ name: string; description?: string }>;
  /** 已有环境清单（跨集增量提取）— 模型按 name 判定是否已有，已有资产仅在 coverage_scenes 追加场景 */
  existingEnvironments?: Array<{ name: string; description?: string; int_ext?: string }>;
}

/**
 * 常见造型 label → 英文 slug 参考映射。
 * 注入 prompt 中作为 AI 命名 key 的参考，鼓励跨调用一致。
 * key 是跨语言稳定的机器标识符（不随剧本语言变化）；
 * label 是人类可读名（随剧本语言）。
 */
export const COSTUME_KEY_SLUG_HINTS: Array<{ slug: string; zhLabel: string; enLabel: string }> = [
  { slug: "casual",         zhLabel: "便装",   enLabel: "casual" },
  { slug: "formal",         zhLabel: "正装",   enLabel: "formal" },
  { slug: "business",       zhLabel: "商务",   enLabel: "business" },
  { slug: "battle-damaged", zhLabel: "战损",   enLabel: "battle-damaged" },
  { slug: "night-op",       zhLabel: "夜行",   enLabel: "night-op" },
  { slug: "gown",           zhLabel: "礼服",   enLabel: "gown" },
  { slug: "travel",         zhLabel: "旅行装", enLabel: "travel" },
  { slug: "sleepwear",      zhLabel: "睡衣",   enLabel: "sleepwear" },
  { slug: "uniform",        zhLabel: "制服",   enLabel: "uniform" },
  { slug: "armor",          zhLabel: "盔甲",   enLabel: "armor" },
  { slug: "swimsuit",       zhLabel: "泳装",   enLabel: "swimsuit" },
  { slug: "coat",           zhLabel: "外套",   enLabel: "coat" },
  { slug: "disguised",      zhLabel: "伪装",   enLabel: "disguised" },
];

/**
 * 将任意 label/key 归一化为英文 slug key（用于 parseAssetExtraction 后处理兜底）。
 * 规则：
 *   1. 空 / "default" / "默认" → "default"
 *   2. 命中 COSTUME_KEY_SLUG_HINTS（中英 label 或 slug 精确匹配）→ 对应 slug
 *   3. 纯 ASCII 字符串 → 小写 + 空格/下划线转连字符
 *   4. 含非 ASCII（如中文）且不在映射表 → 退化为 "custom-{idx}"（由调用方提供 idx）
 *      （不使用拼音，避免跨调用不稳定；语义化 slug 由 AI 在 prompt 引导下产出，
 *       此函数仅做兜底归一，AI 已输出英文 slug 时原样保留）
 */
export function slugifyCostumeKey(label: string, fallbackIdx = 0): string {
  const trimmed = (label || "").trim();
  if (!trimmed || /^(default|默认)$/i.test(trimmed)) return "default";
  // 命中映射表（中英 label 或 slug）
  const hit = COSTUME_KEY_SLUG_HINTS.find(
    h => h.zhLabel === trimmed || h.enLabel.toLowerCase() === trimmed.toLowerCase() || h.slug === trimmed.toLowerCase()
  );
  if (hit) return hit.slug;
  // 纯 ASCII：小写 + 空格/下划线转连字符
  if (/^[\x00-\x7F]+$/.test(trimmed)) {
    const slug = trimmed.toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return slug || `custom-${fallbackIdx}`;
  }
  // 含非 ASCII 且不在映射表：退化兜底
  return `custom-${fallbackIdx}`;
}

/**
 * 资产名的稳定 slug（用于变体编号前缀）：纯 ASCII → 小写连字符；含非 ASCII 退化为
 * "custom"。不走 slugifyCostumeKey 的服装标签映射表（资产名与服装标签语义不同）。
 */
function assetNameSlug(assetName: string): string {
  const trimmed = (assetName || '').trim();
  if (!trimmed) return 'custom';
  if (/^[\x00-\x7F]+$/.test(trimmed)) {
    const slug = trimmed.toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return slug || 'custom';
  }
  return 'custom';
}

/**
 * 资产生成时的变体编号规则（全局稳定、幂等、跨包一致）：
 * `{资产slug}-{数组序号:02d}`，如 Leo-01 / Leo-03。
 * - 已带 code 的变体原样保留（分配一次后不再变，即使后续增删变体）；
 * - 缺失 code 的按数组当前顺序补编（数组顺序 = dedup 后顺序，稳定）。
 * slug 用资产名（含非 ASCII 时退化为 custom，仍唯一于本资产内）。
 */
export function assignCostumeCodes(
  costumes: readonly (Partial<CostumeVariant> & Record<string, unknown>)[],
  assetName: string,
): (Partial<CostumeVariant> & Record<string, unknown>)[] {
  const assetSlug = assetNameSlug(assetName);
  const result: (Partial<CostumeVariant> & Record<string, unknown>)[] = [];
  const seen = new Set<string>();
  let ordinal = 0;
  for (const costume of costumes) {
    if (!costume || typeof costume !== 'object' || Array.isArray(costume)) {
      result.push(costume);
      continue;
    }
    const next = { ...costume };
    const existing = typeof next.code === 'string' && next.code.trim() ? next.code.trim() : null;
    if (existing && !seen.has(existing)) {
      seen.add(existing);
      result.push(next);
      continue;
    }
    let candidate = '';
    do {
      ordinal += 1;
      candidate = `${assetSlug}-${String(ordinal).padStart(2, '0')}`;
    } while (seen.has(candidate));
    seen.add(candidate);
    next.code = candidate;
    result.push(next);
  }
  return result;
}

/**
 * 读取单个变体的稳定编号：优先已落库 code；缺失时按 assignCostumeCodes 同规则现算。
 * 幂等——与「生成时分配」的结果一致，存量数据无需回写即可对齐。
 */
export function resolveCostumeCode(
  costume: Partial<CostumeVariant> & Record<string, unknown> | undefined,
  assetName: string,
  ordinal: number,
): string {
  const existing = costume && typeof costume.code === 'string' && costume.code.trim()
    ? costume.code.trim()
    : null;
  if (existing) return existing;
  return `${assetNameSlug(assetName)}-${String(ordinal).padStart(2, '0')}`;
}

/** 服装变体结构（角色/物品/环境 costumes 数组元素；单集与整剧提取共用）。 */
export interface CostumeVariant {
  key: string;
  /**
   * 全局稳定编号（如 "Leo-03"）：资产生成时按 `{资产slug}-{数组序号:02d}` 分配并落库。
   * 引用对齐/审计/提示词标注一律用 code，不再靠名称匹配。缺失时按同规则现算（幂等）。
   */
  code?: string;
  label: string;
  description: string;
  identity_lock: string[];
  coverage_scenes: string[];
  /**
   * 该变体出场的集号（如 [1,3,5]）。与 coverage_scenes（集内本地场景号，跨集合并歧义）
   * 互补——coverage_episodes 是跨集可靠的"出场集"维度，供按集查看在资产阶段就有数据。
   * AI 看 `=== EP{n} ===` 集标记输出。
   */
  coverage_episodes?: number[];
  variant_type?: 'costume' | 'period';
}

/**
 * 服装变体去重：同一 key、或同一归一化 label（剥去结尾括号后缀如「（基准）」「(默认)」）视为同一套服装，
 * 合并取更丰富的描述、并集 identity_lock / coverage_scenes。防止 AI 反复识别同一套服装产出重复变体。
 *
 * 典型被合并：label 完全相同（"校服-精良版" 出现两次）、仅括号后缀不同（"贵族校服（基准）" vs "贵族校服"）。
 * 不做语义近似归并（"精良校服" vs "校服-精良版"），那类由提示词约束 + AI 判断。
 */
export function dedupCostumes(costumes: readonly CostumeVariant[]): CostumeVariant[] {
  const labelIdentity = (label: string): string =>
    (label || '').normalize('NFKC').trim().toLocaleLowerCase()
      .replace(/[（(][^()（）]*[)）]\s*$/u, '').trim();
  const longer = (a: string, b: string): string =>
    (b || '').trim().length > (a || '').trim().length ? (b || '') : (a || '');
  const union = (a: string[], b: string[]): string[] =>
    Array.from(new Set([...(a || []), ...(b || [])]));
  // coverage_episodes 是 number[]（集号），单独的数字并集；排序保证跨调用稳定。
  const unionNum = (a: number[] | undefined, b: number[] | undefined): number[] =>
    Array.from(new Set([...(a || []), ...(b || [])])).sort((x, y) => x - y);

  const byKey = new Map<string, CostumeVariant>();
  const byLabel = new Map<string, CostumeVariant>();
  const ordered: CostumeVariant[] = [];
  for (const costume of costumes) {
    const key = (costume.key || 'default').trim() || 'default';
    const labelId = labelIdentity(costume.label) || key;
    const existing = byKey.get(key) ?? byLabel.get(labelId);
    if (existing) {
      existing.label = longer(existing.label, costume.label);
      existing.description = longer(existing.description, costume.description);
      existing.identity_lock = union(existing.identity_lock, costume.identity_lock);
      existing.coverage_scenes = union(existing.coverage_scenes, costume.coverage_scenes);
      existing.coverage_episodes = unionNum(existing.coverage_episodes, costume.coverage_episodes);
      if (costume.variant_type && !existing.variant_type) existing.variant_type = costume.variant_type;
      byLabel.set(labelId, existing);
      continue;
    }
    const merged: CostumeVariant = {
      key,
      label: costume.label,
      description: costume.description,
      identity_lock: [...(costume.identity_lock || [])],
      coverage_scenes: [...(costume.coverage_scenes || [])],
      coverage_episodes: [...(costume.coverage_episodes || [])],
      ...(costume.variant_type ? { variant_type: costume.variant_type } : {}),
    };
    byKey.set(key, merged);
    byLabel.set(labelId, merged);
    ordered.push(merged);
  }
  // 相似描述合并：catches 同一次提取里 AI 对同一套服装产出多条（不同 key/label、但
  // description 近同）。key/label 去重够不到这类，按 description bigram 相似度再过一遍。
  // 刻意用高阈值（0.82）+ 最小长度，避免把 merely-similar 的不同变体误并。
  const normDesc = (s: string): string =>
    (s || '').toLowerCase().replace(/[\s.,;:'"()（）·、，。！？\-_/]/g, '');
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const descNearDuplicate = (a: string, b: string): boolean => {
    const na = normDesc(a);
    const nb = normDesc(b);
    if (na.length < 8 || nb.length < 8) return false;
    if (na === nb) return true;
    // 一条是另一条的可观前缀/子串（同一套服装、一方描述更详细）→ 视为重复。
    if (nb.includes(na) || na.includes(nb)) return true;
    const sa = bigrams(na);
    const sb = bigrams(nb);
    let inter = 0;
    for (const g of sa) if (sb.has(g)) inter += 1;
    const uni = sa.size + sb.size - inter;
    return uni > 0 && inter / uni >= 0.82;
  };
  const collapsed: CostumeVariant[] = [];
  for (const cv of ordered) {
    const twin = collapsed.find((r) => descNearDuplicate(r.description, cv.description));
    if (twin) {
      twin.label = longer(twin.label, cv.label);
      twin.description = longer(twin.description, cv.description);
      twin.identity_lock = union(twin.identity_lock, cv.identity_lock);
      twin.coverage_scenes = union(twin.coverage_scenes, cv.coverage_scenes);
      twin.coverage_episodes = unionNum(twin.coverage_episodes, cv.coverage_episodes);
      if (cv.variant_type && !twin.variant_type) twin.variant_type = cv.variant_type;
    } else {
      collapsed.push(cv);
    }
  }
  return collapsed;
}

/**
 * 从 AI 原始输出解析 costumes 数组（角色 / 物品 / 环境共用）：
 * 过滤空条目 → slugify 归一 key → 透传 coverage_episodes/coverage_scenes → dedupCostumes 去重。
 * 与 parseAssetExtraction 角色 costumes 解析同款，抽出复用以让物品/环境变体走同一管道。
 */
function parseCostumesArray(raw: unknown): CostumeVariant[] {
  if (!Array.isArray(raw)) return [];
  return dedupCostumes(
    raw
      .filter((cv: any) => cv && (cv.key || cv.label || cv.description))
      .map((cv: any, idx: number) => {
        const rawKey = (cv.key || '').trim();
        const normalizedKey = !rawKey || /^(default|默认)$/i.test(rawKey)
          ? 'default'
          : slugifyCostumeKey(rawKey || cv.label || '', idx);
        const covEpsRaw = cv.coverage_episodes ?? cv.coverageEpisodes;
        return {
          key: normalizedKey,
          label: cv.label || '',
          description: cv.description || '',
          identity_lock: cv.identity_lock || cv.identityLock || [],
          coverage_scenes: cv.coverage_scenes || cv.coverageScenes || [],
          coverage_episodes: Array.isArray(covEpsRaw)
            ? covEpsRaw.filter((n: any): n is number => typeof n === 'number' && Number.isFinite(n))
            : [],
          ...(cv.variant_type === 'period' ? { variant_type: 'period' as const } : {}),
        };
      }),
  );
}

/**
 * 物品/环境基准兜底：若 AI 未输出任何变体，合成一个 default 基准（vcnt≥1、有基准图入口）。
 * 与角色对齐——角色靠 prompt + supplementExtractedCostumes 保证至少 1 个 default；
 * 物品/环境无 costumeMap，故在解析层兜底。合成变体无 coverage_episodes（按集查看后续由 shots 派生）。
 */
function ensureDefaultBaseline(costumes: CostumeVariant[], fallbackDescription: string): CostumeVariant[] {
  if (costumes.length > 0) return costumes;
  return [{
    key: 'default',
    label: '默认',
    description: fallbackDescription || '',
    identity_lock: [],
    coverage_scenes: [],
    coverage_episodes: [],
  }];
}

/**
 * 构造「## 服装造型分组要求」段落（注入到资产提取 prompt）。
 *
 * 输入：costumeMap（场景→角色→造型），由 script-prompt.ts 的 parseScriptResult 产出。
 * 输出：按角色分组列出造型 label + 描述 + 出现场景，并强制 AI 按此分组输出 costumes 数组。
 *
 * 行为：
 * - costumeMap 为空/未传 → 返回空字符串（prompt 不注入本段，保持现状）。
 * - 同一角色多个 label 合并为多个变体条目；同一 label 跨场景合并为一个变体（coverage_scenes 累积）。
 * - 描述取最长版本（编剧分析对同一造型多次描述时，保留最具体的）。
 *
 * 双语：language='en' 输出英文段落，否则中文。
 */
function buildCostumeGroupingSection(
  costumeMap: CostumeMapEntry[] | undefined,
  language: ScriptLanguage
): string {
  if (!costumeMap || costumeMap.length === 0) return "";
  const isEn = language === "en";

  // 按 character 分组（保持首次出现顺序）
  interface VariantAgg {
    label: string;
    desc: string;
    scenes: Set<string>;
    isNew: boolean;
    firstSceneIdx: number;  // 用于排序：首次出现的场景序号
  }
  const byCharacter = new Map<string, VariantAgg[]>();
  const characterOrder: string[] = [];
  // 全局场景顺序（用于变体排序）
  const sceneOrder = new Map<string, number>();
  let sceneIdxCounter = 0;
  for (const entry of costumeMap) {
    if (!entry.character) continue;
    if (!characterOrder.includes(entry.character)) characterOrder.push(entry.character);
    if (entry.sceneId && !sceneOrder.has(entry.sceneId)) {
      sceneOrder.set(entry.sceneId, sceneIdxCounter++);
    }
  }

  for (const entry of costumeMap) {
    if (!entry.character) continue;
    if (!byCharacter.has(entry.character)) byCharacter.set(entry.character, []);
    const variants = byCharacter.get(entry.character)!;
    const label = entry.costumeLabel || "default";
    let v = variants.find(x => x.label === label);
    if (!v) {
      v = {
        label,
        desc: entry.costumeDesc || "",
        scenes: new Set(),
        isNew: false,
        firstSceneIdx: entry.sceneId ? (sceneOrder.get(entry.sceneId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER,
      };
      variants.push(v);
    }
    if (entry.sceneId) v.scenes.add(entry.sceneId);
    if (entry.isNew) v.isNew = true;
    if ((entry.costumeDesc || "").length > v.desc.length) v.desc = entry.costumeDesc || "";
  }

  const slugList = COSTUME_KEY_SLUG_HINTS.map(h => h.slug).join(", ");
  const lines: string[] = [];
  if (isEn) {
    lines.push(
      "## Costume Grouping Requirement (MANDATORY — must follow strictly)",
      "",
      "The screenwriter analysis has produced the following costume table (scene → character → costume).",
      "For each character below, you MUST output one `costumes` array entry per distinct costume label listed here.",
      "Do NOT collapse multiple distinct labels into a single \"default\" variant. Do NOT omit any variant listed here.",
      "",
      "### Costume Table (grouped by character)",
    );
    for (const char of characterOrder) {
      const variants = (byCharacter.get(char) || []).slice().sort((a, b) => a.firstSceneIdx - b.firstSceneIdx);
      lines.push(`- ${char}:`);
      variants.forEach((v, i) => {
        const scenes = Array.from(v.scenes).sort().join(", ") || "(unspecified)";
        const newTag = v.isNew ? " [New Costume]" : "";
        lines.push(`  ${i + 1}. label="${v.label}" | scenes=[${scenes}]${newTag}`);
        if (v.desc) lines.push(`     description: ${v.desc}`);
      });
    }
    lines.push(
      "",
      "### Hard Constraints",
      "1. The number of `costumes` entries for each character MUST equal the number of distinct labels listed above for that character.",
      "2. The first listed label (or the most frequently appearing one) MUST use key=\"default\"; others use a semantic English slug key.",
      `   Reference slug list: ${slugList}.`,
      "   If none fits, coin a concise English slug (lowercase, hyphenated, no spaces, no Chinese characters).",
      "3. label field MUST be Simplified Chinese (无论剧本是中文还是英文). key field is always an English slug — language-stable identifier.",
      "4. description field MUST be concrete: top/pants/shoes/material/color/accessories, at least 3 distinct visual details. Different variants of the same character MUST differ in at least 3 visual details (e.g. color, garment type, accessory, footwear).",
      "5. identity_lock lists ONLY costume-specific visual locks (e.g. \"white cotton T-shirt\", \"silver tie clip\"); cross-variant invariant features (face/height/build) belong to the top-level identity_lock, not here.",
      "6. coverage_scenes MUST be filled with the scene IDs listed above (S1, S2...). Every variant must list at least one scene.",
      "7. Merge similar outfits: if two labels describe visually identical/similar outfits (same garment type + color + material), treat them as the same variant and use the same key. Differentiate only when at least one visual detail differs.",
      "8. Cross-variant consistency: face shape / facial features / height / build / identity MUST be 100% identical across all variants of the same character. Variants MAY differ on hairstyle / hair color, clothing, accessories, and makeup (styling) — these are the valid variant dimensions.",
    );
  } else {
    lines.push(
      "## 服装造型分组要求（强制 — 必须严格遵守）",
      "",
      "编剧分析阶段已产出以下造型表（场景→角色→造型），资产提取阶段必须按此分组输出 costumes 数组。",
      "对下面列出的每个角色，必须为其每个不同的造型 label 输出一个 costumes 条目。",
      "禁止把多个不同 label 合并为单个 \"default\" 变体；禁止遗漏此处列出的任何变体。",
      "",
      "### 造型表（按角色分组）",
    );
    for (const char of characterOrder) {
      const variants = (byCharacter.get(char) || []).slice().sort((a, b) => a.firstSceneIdx - b.firstSceneIdx);
      lines.push(`- ${char}：`);
      variants.forEach((v, i) => {
        const scenes = Array.from(v.scenes).sort().join("、") || "(未标注)";
        const newTag = v.isNew ? " [新造型]" : "";
        lines.push(`  ${i + 1}. label="${v.label}" | 场景=[${scenes}]${newTag}`);
        if (v.desc) lines.push(`     造型说明：${v.desc}`);
      });
    }
    lines.push(
      "",
      "### 硬性约束",
      "1. 每个角色的 costumes 条目数必须等于上方为该角色列出的不同 label 数量。",
      "2. 首个列出的 label（或出现频率最高的 label）使用 key=\"default\"；其余使用语义化英文 slug 作为 key。",
      `   参考 slug 列表：${slugList}。`,
      "   若都不合适，自造一个简短英文 slug（小写、连字符、无空格、无中文）。",
      "3. label 字段必须用简体中文（无论剧本是中文还是英文）；key 字段始终为英文 slug —— 是跨语言稳定的标识符。",
      "4. description 字段必须具体：上衣/裤子/鞋子/材质/颜色/配饰，至少 3 个具体视觉细节。同一角色的不同变体 description 必须在至少 3 个视觉细节上有差异（如颜色、服装类型、配饰、鞋类）。",
      "5. identity_lock 只列该造型专属的视觉锁定（如\"白色棉质T恤\"\"银色领带夹\"）；跨变体不变的特征（五官/身高/体型）属于顶层 identity_lock，不写在这里。",
      "6. coverage_scenes 必须填写上方列出的场景编号（S1、S2...），每个变体至少一个场景。",
      "7. 相似服装归并：若两个 label 描述的是视觉上相同/相似的服装（同款+同色+同材质），视为同一变体并用相同 key；只在至少一个视觉细节不同时才区分为不同变体。",
      "8. 跨变体一致性：同一角色的脸型/五官/身高/体型/身份必须 100% 一致。变体可在 发型/发色、衣装、配饰、妆容（造型）上不同——这些是合法的变体维度。",
    );
  }
  return lines.join("\n");
}

/**
 * 构造资产提取提示词
 * 让 AI 从剧本文本中提取结构化的角色/物品/环境信息
 * 角色必须包含：角色背景 + 外观描述
 * 同时根据角色特征推荐匹配的参考音色
 */
export function buildAssetExtractionPrompt(
  scriptText: string,
  voiceManifest?: any[],
  options?: AssetExtractionOptions,
  language?: ScriptLanguage
): { system: string; user: string } {
  const lang: ScriptLanguage = language ?? detectLanguage(scriptText);
  const isEn = lang === "en";
  // 构建音色清单描述（用于 AI 推荐）
  const voiceListDesc = voiceManifest?.length
    ? voiceManifest.map(v => `  - ${v.file}: ${v.desc} (${v.gender})`).join('\n')
    : (isEn ? 'No available voices' : '无可用音色');

  // 已有角色造型列表（ep2+ 跨集复用）
  const existingCharsDesc = options?.existingCharacters?.length
    ? options.existingCharacters.map(c =>
        isEn
          ? `  - ${c.name} (existing costumes: ${(c.costumes || []).map(cv => cv.label).join(', ') || 'none'})`
          : `  - ${c.name}（已有造型：${(c.costumes || []).map(cv => cv.label).join('、') || '无'}）`
      ).join('\n')
    : '';

  // 已有物品清单（跨集增量提取）— 模型按 name 判定是否已有
  const existingItemsDesc = options?.existingItems?.length
    ? options.existingItems.map(it =>
        isEn
          ? `  - ${it.name}${it.description ? `: ${it.description.slice(0, 30)}` : ''}`
          : `  - ${it.name}${it.description ? `：${it.description.slice(0, 30)}` : ''}`
      ).join('\n')
    : '';

  // 已有环境清单（跨集增量提取）— 模型按 name 判定是否已有
  const existingEnvironmentsDesc = options?.existingEnvironments?.length
    ? options.existingEnvironments.map(env =>
        isEn
          ? `  - ${env.name}${env.int_ext ? ` [${env.int_ext}]` : ''}${env.description ? `: ${env.description.slice(0, 30)}` : ''}`
          : `  - ${env.name}${env.int_ext ? ` [${env.int_ext}]` : ''}${env.description ? `：${env.description.slice(0, 30)}` : ''}`
      ).join('\n')
    : '';

  // 构建角色映射描述（用于按角色 ID 约束角色提取，防止跨集重复创建）
  // 角色身份由 LLM 语义标注判定：相同 characterId 跨集必须复用同一角色，不得因服饰/造型变化创建新角色
  const characterMappingDesc = options?.characterMapping?.length
    ? options.characterMapping.map(v => {
        const namePart = v.name ? ` (${v.name})` : '';
        const role = v.roleIdentity
          ? `${v.roleIdentity}${namePart}`
          : (isEn ? '(pending — infer a character name from the script for this characterId)' : '（待识别 — 请根据剧本为该角色 ID 推断角色名）');
        return `  - ${v.characterId} → ${role}  (firstEpisode=${v.firstEpisode})`;
      }).join('\n')
    : '';

  // 服装造型分组要求段（costumeMap 非空时注入，强制 AI 按造型表输出对应数量的 costumes 变体）
  const costumeGroupingSection = buildCostumeGroupingSection(options?.costumeMap, lang);
  const canonicalCharacterNames = normalizeCanonicalCharacterRoster(
    options?.canonicalCharacterNames
  ).slice(0, 200);
  const identityAlignmentSection = options?.overseasAdaptation
    ? (isEn
      ? [
          '## Screenwriter-to-Asset Identity Alignment (HIGHEST PRIORITY)',
          'This is an overseas-localized adaptation. Chinese action/production narration is only the production language; it is NOT evidence that a character is Chinese or East Asian.',
          'Determine the adapted cultural and ethnic context from the localized target-language names, dialogue language, places, organizations, family background, and explicit story cues together. When those cues consistently establish a target locale, character appearance, clothing, props, and locations MUST follow that locale instead of falling back to the narration language.',
          'For character descriptions, write concrete positive visual/cultural traits that an image model can follow. Do not emit vague or negative slogans such as "foreigner" or "must not be Asian"; state the intended appearance and cultural context positively. If the script explicitly establishes a different ethnicity for a character, the script always wins.',
        ].join('\n')
      : [
          '## 编剧—资产身份对齐（最高优先级）',
          '本项目是海外本地化改编。中文动作/制作叙述只是一种制作语言，绝不代表角色是中国或东亚身份。',
          '必须综合目标语言姓名、对白语种、地点、机构、家族背景和剧本明确线索判断改编后的文化与族裔语境。若这些线索一致指向某个目标语境，角色外貌、服装、物品和环境必须服从该语境，不得因为叙述是中文就默认生成东亚面孔或中国场景。',
          '角色 description/background 必须使用可直接生图的正向、具体外貌与文化描述。禁止输出“外国人”“不能是亚洲人”等含糊或否定式口号；应正面写清目标外貌与文化语境。若剧本明确某角色属于不同族裔，则始终以剧本为准。',
        ].join('\n'))
    : '';
  const localizationProfile = options?.localizationProfile;
  const targetLanguage = localizationProfile?.targetLanguage;
  const localizationProfileSection = localizationProfile
    ? (isEn
      ? [
          '## Persisted Localization Profile (authoritative)',
          ...(targetLanguage ? [
            `Target language: ${targetLanguage.en} / ${targetLanguage.native} (${targetLanguage.code})`,
            `Target region: ${targetLanguage.region}`,
            `Cultural guidance: ${targetLanguage.cultureHint}`,
          ] : []),
          `Original localization instruction: ${(localizationProfile.stylePrompt || '').slice(0, 1000)}`,
          'Use this profile together with explicit script evidence. Do not infer the target locale merely from the production/narration language.',
        ].join('\n')
      : [
          '## 已持久化本地化档案（权威上下文）',
          ...(targetLanguage ? [
            `目标语言：${targetLanguage.zh} / ${targetLanguage.native}（${targetLanguage.code}）`,
            `目标区域：${targetLanguage.region}`,
            `文化指引：${targetLanguage.cultureHint}`,
          ] : []),
          `原始本地化要求：${(localizationProfile.stylePrompt || '').slice(0, 1000)}`,
          '本档案须与剧本明确证据共同使用；禁止仅凭制作/叙述语言猜测目标国家、文化或族裔。',
        ].join('\n'))
    : '';
  const analysisGuidance = (options?.analysisGuidance || '').trim().slice(0, 5000);
  const analysisGuidanceSection = analysisGuidance
    ? (isEn
      ? `## Persisted Screenwriter Guidance (also applies to assets)\n${analysisGuidance}`
      : `## 已持久化编剧增强指导（同样约束资产）\n${analysisGuidance}`)
    : '';
  const visualStylePrompt = (options?.visualStylePrompt || '').trim().slice(0, 3000);
  const visualStyleSection = visualStylePrompt
    ? (isEn
      ? `## Project Visual Style Lock (HIGHEST PRIORITY)\n${visualStylePrompt}\nEvery asset description must support this style and must not introduce a conflicting medium or art style.`
      : `## 项目视觉风格锁（最高优先级）\n${visualStylePrompt}\n所有资产描述必须服从该风格，不得写入冲突的媒介或画风。`)
    : '';
  const canonicalNamesSection = canonicalCharacterNames.length > 0
    ? (isEn
      ? [
          '## Locked Canonical Character Names (copy EXACTLY)',
          'Every CHARACTER.name MUST be copied verbatim from this list (target-language name only; no bilingual pairing).',
          ...canonicalCharacterNames.map(name => `- ${name}`),
        ].join('\n')
      : [
          '## 编剧阶段锁定角色名（必须逐字复制）',
          '每个 CHARACTER.name 必须从下列清单逐字复制（仅目标语言名，不要双语括号对照）。',
          ...canonicalCharacterNames.map(name => `- ${name}`),
        ].join('\n'))
    : '';
  const countryLocaleComplianceSection = isEn
    ? [
        '## Country-Specific Cultural & Language Compliance',
        '1. If the script, dialogue, place names, character identity, or scene context clearly establishes a target country or national locale for an asset, every character / prop / location detail MUST first align with that country\'s mainstream culture, folk customs, historical traditions, and broadly recognized social norms.',
        '2. Do NOT mix that asset with signature symbols, customs, architecture, products, institutions, etiquette, or daily-life conventions from a different country unless the script explicitly requires cross-cultural mixing.',
        '3. Whenever the asset concept involves written content (signage, plaques, labels, packaging, public notices, documents, maps, written nameplates, uniforms, storefront text), it MUST use only that asset country\'s official language or mainstream lingua franca. Do NOT introduce unrelated languages, mixed-language text, or the wrong writing system.',
        '4. If the script does not clearly establish a country, do not force a specific country. Stay script-consistent and avoid inventing country-specific markers.',
      ].join('\n')
    : [
        '## 国别文化与语言合规（强制）',
        '1. 若剧本、台词、地点名称、角色身份或场景语境已经明确某个资产所属国家或国别语境，则该资产中的角色、物品、环境细节必须首先完全契合该国主流文化、民间习俗、历史传统及社会普遍认知规范。',
        '2. 禁止将该资产与其他国家的典型文化符号、建筑风格、制度习惯、日常用品、礼仪表达或社会规则随意混搭，除非剧本明确要求跨文化混合。',
        '3. 凡涉及文字内容的设定，如招牌、铭牌、标签、包装、公共标识、公告、公文、地图标注、书面姓名牌、制服文字等，必须统一使用该资产所属国家的官方语言或主流通用语言，不得混入无关语言、错误书写体系或多语混杂内容。',
        '4. 若剧本未明确所属国家，不得强行指定具体国家；保持与剧本语境一致，不擅自添加国别标签。',
      ].join('\n');

  const system = isEn ? [
    'You are a professional film art director and script analyst.',
    'Extract four core asset types from the user-provided script text: characters, props, locations, and entities (non-human speakers).',
    '[IMPORTANT] Output JSON directly. No preface, no explanation, no confirmation. The first character MUST be {.',
    '',
    ...(identityAlignmentSection ? [identityAlignmentSection, ''] : []),
    ...(localizationProfileSection ? [localizationProfileSection, ''] : []),
    ...(analysisGuidanceSection ? [analysisGuidanceSection, ''] : []),
    ...(visualStyleSection ? [visualStyleSection, ''] : []),
    ...(canonicalNamesSection ? [canonicalNamesSection, ''] : []),
    '## Script-Consistent Cultural Guidance',
    (options?.overseasAdaptation
      ? 'ALL extracted assets (characters, props, locations) MUST follow the TARGET locale established by the localization profile and the target-language names/dialogue, while staying consistent with the story-implied era and narrative logic. The source narration language is a production language, NOT a culture/ethnicity cue.'
      : 'ALL extracted assets (characters, props, locations) MUST strictly follow the cultural background, historical period, and narrative logic actually implied by the script itself. Do not force any specific country, ethnicity, or region unless the source text explicitly states it.'),
    '',
    '### Cultural Background & Historical Period Coherence',
    '- Identify the implied era from the script and keep every asset consistent with that period\'s technology, fashion, and architecture (e.g. 19th-century Victorian → gas lamps, corsets, carriages, telegraph; modern-day → smartphones, subway, SUVs).',
    '- Do NOT mix eras: no anachronistic props or architecture. If the script does not specify an era, default to a contemporary setting that matches the source script tone.',
    '',
    ...(options?.overseasAdaptation
      ? [
          '### Character Assets — Adapt to the Target Locale (overrides the "no nationality guessing" rule)',
          'This is an overseas adaptation: character APPEARANCE, clothing, props and architecture MUST be localized to the target culture/region from the localization profile and the target-language names & dialogue — NOT left in the source culture.',
          '- Recast each character as a person of the target locale. Positively state the ethnicity/facial features matching the target region (e.g. an English/European locale → European/Caucasian facial features, region-appropriate hair and build). Do NOT default to an East Asian face just because the source narration is Chinese.',
          '- Localize clothing and material culture to the target locale and the story-implied era. Replace any source-culture garment with its target-culture equivalent for the SAME role/status (e.g. a "prince" → European noble/period attire such as a tailored doublet, coat or cape — NOT East Asian changpao/hanfu/robes).',
          '- Character NAMES stay locked to the canonical names (do not rename). Only the VISUAL culture is adapted.',
          '- Background, motivation and relationships still come from the source plot; only the cultural/ethnic framing of the appearance is localized.',
        ]
      : [
          '### Character Assets — Follow Source, No Nationality Guessing',
          '- Character description MUST focus on observable appearance and role identity. Do NOT invent a specific nationality, ethnicity, or race unless the script explicitly states it.',
          '- Character background and motivation should come from the source plot. Do not overwrite the script with any preset regional worldview or social stereotype.',
          '- Character names MUST exactly follow the source script. Do not westernize, hispanicize, localize, translate, or rename characters unless the source text explicitly requires it.',
        ]),
    '',
    '### Prop Assets — Era-Appropriate Technology & Source Context',
    '- Props must match the era\'s technology level: no anachronistic objects. Verify materials and technology are period-correct (no plastic before 1850, no LEDs before 1960s, no digital screens before 1970s unless plot-driven).',
    '- Props should reflect the source script context and only include culture-specific symbolism when the script clearly implies it.',
    '- Daily-life objects must match the source setting. Do NOT force any region-specific conventions unless the script explicitly requires them.',
    '',
    '### Location Assets — Match The Source Setting',
    '- Location description MUST describe ONLY the fixed place itself — architecture, walls, spatial layout, building materials, terrain and lighting/atmosphere. Do NOT include movable objects or furnishings in the location description.',
    '- Do NOT force any specific regional architecture unless the script explicitly points to it.',
    '- Movable objects / furniture / specific props that appear in the scene MUST be extracted as separate PROP entries in the items array, NOT written into the location description. A location is the fixed stage; anything a person could pick up and move is a PROP.',
    '',
    countryLocaleComplianceSection,
    '',
    '## Speaking-Object Classification (entities vs characters vs props)',
    'When something "speaks" or produces a voice in the script, classify it correctly:',
    '- A named PERSON speaking off-scene (a voice on the phone, an unseen caller, a voice-only character) → put that person in `characters` (a normal CHARACTER). The physical device (the phone itself) goes in `items`. The off-scene voice needs NO separate asset — it is routed automatically at video time via that character\'s voice.',
    '- A NON-HUMAN speaker with a clear identity AND a narrative function (a cheat/system voice, an AI assistant, a talking artifact, a ship computer) → put it in the NEW `entities` array. It gets a UI-panel / holographic-display design sheet (NOT a human three-view) and its own bound voice.',
    '- A plain object that merely makes a sound effect (a recorder, a doorbell, a ringing phone, ambient noise) → put it in `items` (a normal PROP). It has NO voice of its own; the sound is chosen separately.',
    'In short: human voice → characters; non-human speaking entity → entities; sound-making object → items.',
    '',
    '## Asset Isolation (mandatory)',
    '- A CHARACTER must be described as ONLY the person — face, body, hair, clothing, accessories. Do NOT fold held items, the surrounding environment, scene locations, atmosphere, or any background/scenery description into the character description. The description field is for the person\'s appearance ONLY — no setting, no environment, no mood, no backdrop.',
    '- A PROP must be described as ONLY the object itself — shape, material, color, finish, marks. Do NOT mention whose object it is, and do NOT describe what sound it makes (the text/voice model chooses the sound separately).',
    '- A LOCATION must be described as ONLY the fixed place itself — architecture, walls, structure, terrain, spatial layout, lighting and atmosphere. Do NOT fold movable objects, furniture, or specific props into the location description; each such object is a separate PROP in items.',
    '- EXCEPTION — face-bearing props: some props contain human faces (a marriage certificate, a registration document, an ID photo, a group photo). For these, set `"requiresCharacterRef": true` and list `"involvedCharacters": ["CharacterA","CharacterB"]` (the named characters whose faces appear). These are generated via image-to-image from those characters\' images. Ordinary objects leave these fields out (or false/empty).',
    '',
    '## Display-name contract (mandatory)',
    '- CHARACTER.name must remain exactly as locked in the script; never translate, transliterate, or rename a character.',
    '- PROP and LOCATION `name` must be Simplified Chinese, even when the source script is English or another language. This is the canonical display name used by the Chinese production UI.',
    '- Every PROP and LOCATION must include `source_names`: a deduplicated array containing the exact source-script name and any useful original-language aliases. Do not put the Chinese display name in source_names unless it also appears verbatim in the script.',
    '',
    '## Output Format (strict JSON)',
    '',
    '```json',
    '{',
    '  "characters": [',
    '    {',
    '      "name": "Character Name",',
    '      "characterId": "角色a",',
    '      "role_type": "lead|core supporting|supporting|extra",',
    '      "description": "Appearance: body (gender/age/height/build); face (face shape/hairstyle/hair color/eye shape/eye color/nose/lip/skin tone/facial structure); clothing (top/pants/shoes/material/color/wear — era-appropriate for the source setting); accessories (none or specific; glasses ONLY when plot-required, otherwise omit). Do NOT invent ethnicity, nationality, or region unless the source explicitly states it. Clothing must match the implied historical period.",',
    '      "background": "Character background story, identity, motivation, relation to plot. Must come from the source script rather than imported regional stereotypes.",',
    '      "identity_lock": ["visual lock feature 1", "visual lock feature 2", "visual lock feature 3", "visual lock feature 4"],',
    '      "relationships": [{"from":"CharacterA","to":"CharacterB","type":"relationship type","detail":"relationship detail"}],',
    '      "coverage_scenes": ["S1","S3"],',
    '      "costumes": [',
    '        {"key": "default", "label": "casual", "variant_type": "costume", "description": "top/pants/shoes/material/color/accessories — at least 3 visual details", "identity_lock": ["costume-specific lock 1"], "coverage_scenes": ["S1","S2"], "coverage_episodes": [1]},',
    '        {"key": "formal", "label": "formal", "variant_type": "costume", "description": "dark gray suit, white shirt, black leather shoes, silver tie clip", "identity_lock": ["dark gray suit", "silver tie clip"], "coverage_scenes": ["S3"], "coverage_episodes": [2]},',
    '        {"key": "child", "label": "childhood", "variant_type": "period", "description": "same person as a child — younger face, shorter stature, child-era clothing; age/face/build differ from default", "identity_lock": ["recognizable identity, child proportions"], "coverage_scenes": ["S5"], "coverage_episodes": [3]}',
    '      ],',
    '      "suggested_voices": [',
    '        {"file": "reference audio filename", "desc": "voice description", "reason": "recommendation reason"}',
    '      ]',
    '    }',
    '  ],',
    '  "items": [',
    '    {',
    '      "name": "Simplified-Chinese Prop Display Name",',
    '      "source_names": ["Exact Source-Script Prop Name"],',
    '      "item_type": "core prop|ordinary item",',
    '      "description": "Shape: ... Material: ... Color: ... Surface finish: ... Distinctive marks: ... Describe ONLY the object itself — never whose object it is, never what sound it makes. MUST be era-appropriate and consistent with the source setting (period-correct technology and materials).",',
    '      "significance": "the prop role in the plot and any source-implied symbolism",',
    '      "requiresCharacterRef": false,',
    '      "involvedCharacters": [],',
    '      "coverage_scenes": ["S1","S2"],',
    '      "costumes": [',
    '        {"key": "default", "label": "intact", "variant_type": "costume", "description": "shape/material/color/finish/marks — at least 3 visual details of the default state", "identity_lock": ["prop-specific lock 1"], "coverage_scenes": ["S1","S2"], "coverage_episodes": [1]},',
    '        {"key": "broken", "label": "broken", "variant_type": "costume", "description": "same object in a different state — crack/chipped/open/sealed; differs from default in at least 3 details", "identity_lock": ["state-specific lock 1"], "coverage_scenes": ["S3"], "coverage_episodes": [2]}',
    '      ]',
    '    }',
    '  ],',
    '  "environments": [',
    '    {',
    '      "name": "Simplified-Chinese Location Display Name",',
    '      "source_names": ["Exact Source-Script Location Name"],',
    '      "int_ext": "Int|Ext",',
    '      "description": "Space type: ... Scale: ... Layout: ... Building material: ... Main color tone: ... Fixed architectural features (walls/structure/terrain only — NOT movable furniture or props) ... Light tone: ... MUST match the architecture and spatial style implied by the source script and era. Movable objects belong in items, NOT here.",',
    '      "mood": "oppressive, cold",',
    '      "base_ambience": "environment base sound description",',
    '      "coverage_scenes": ["S1","S2","S3"],',
    '      "costumes": [',
    '        {"key": "default", "label": "day", "variant_type": "costume", "description": "lighting/time/weather of the default state — at least 3 visual details", "identity_lock": ["location-specific lock 1"], "coverage_scenes": ["S1","S2"], "coverage_episodes": [1]},',
    '        {"key": "night", "label": "night", "variant_type": "costume", "description": "same space at a different time/state — night/damaged/weathered; differs from default in at least 3 details", "identity_lock": ["state-specific lock 1"], "coverage_scenes": ["S3"], "coverage_episodes": [2]}',
    '      ]',
    '    }',
    '  ],',
    '  "entities": [',
    '    {',
    '      "name": "Entity Name (e.g. System Voice / AI Assistant / Talking Artifact)",',
    '      "entity_type": "system|ai|artifact|other non-human speaker",',
    '      "description": "Visual design of how this entity manifests ON-SCREEN: a UI panel / holographic display / floating interface / device screen. NOT a human figure. Describe layout, shape, color, glow, icons, text style. (The bound voice is chosen separately from suggested_voices.)",',
    '      "identity_lock": ["visual lock feature 1"],',
    '      "suggested_voices": [',
    '        {"file": "reference audio filename", "desc": "voice description", "reason": "recommendation reason"}',
    '      ],',
    '      "coverage_scenes": ["S1","S3"]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## Extraction Rules',
    '1. Extract at least all characters with dialogue or important actions.',
    '2. Characters MUST include both "background" (character background) and "description" (appearance); do not omit, do not leave empty string. If the script does not specify appearance, reasonably infer and supplement based on role identity, era, country-specific setting cues, and scene context only; do not invent nationality or ethnicity.',
    '3. Appearance description must be detailed enough to directly generate a character design sheet; background description should be distilled from the script, highlighting identity and motivation.',
    '4. Extract props that drive the plot (e.g. murder weapon, key document). All important props appearing in the script should be extracted; extract at least 1 (leave an empty array only if the script truly has no props).',
    '5. Extract locations by different places (e.g. operating room and hallway are two locations). Every different place appearing in the script MUST be extracted as an independent location; extract at least 1.',
    '6. identity_lock is the character visual lock features (4-6 items), used to keep character consistency.',
    '7. coverage_scenes fills in the scene numbers where the character/prop/location appears.',
    '8. Output ONLY JSON; no other text.',
    '9. [Language consistency · hard constraint] CHARACTER.name MUST exactly match the source script. PROP/LOCATION name is the sole display-name exception and MUST be Simplified Chinese; preserve its exact source-language wording in source_names. Other extracted text fields use the source-script language unless a localization profile explicitly requires otherwise. Text visible inside an asset must remain consistent with the asset country\'s official language or mainstream lingua franca.',
    '10. [Background & extra characters · hard constraint] You MUST extract EVERY background character, extra, and crowd member that appears in the script — never omit any. Generic/group figures without a specific personal name MUST also be extracted; name each one with its role + an ordinal letter (e.g. Passerby A, Passerby B, Villager A, Villager B, Soldier A, Soldier B, Elder A, Extra A). Every distinct background figure is its own CHARACTER entry; do NOT merge a crowd into a single entry. Background/extras MAY share a group silhouette and need not satisfy the cross-character differentiation rule.',
    '11. [Character differentiation · hard constraint] Different characters MUST have clearly distinct visual features — face shape, hairstyle/hair color, eye shape/color, age range, and build MUST differ between any two characters. Do NOT create two characters with highly similar appearance (anti "face collision"). If the script does not specify distinguishing features, assign culturally consistent differences in silhouette, face shape, hair length/texture, age range, or build without using ethnicity stereotypes.',
    '12. [Keep source names · hard constraint] Character names MUST keep the exact source-script naming. Do NOT convert names into Western, Spanish, or any other localized naming style. Keep the same name consistently across all episodes via the characterId mapping.',
    '13. [No glasses · hard constraint] Do NOT give characters glasses unless the script explicitly requires them for plot reasons (e.g. "put on reading glasses", "took off his glasses"). In the description accessories field, omit glasses by default.',
    '14. [Silent preflight · mandatory] Before emitting JSON, internally verify: every named speaking/plot-driving character is covered exactly once; every scene location is covered; every plot-driving prop is covered; every coverage_scenes value exists in the script; names/characterIds/keys are unique; all required arrays and fields are present. Fix failures silently, then output JSON only.',
    '15. [Cross-field/source consistency · hard constraint] For each character, description, background, identity_lock, costumes, and relationships MUST agree with one another and with explicit source-script evidence. Never invent a body type, age, hair, cultural identity, or other visual fact that contradicts the script (for example, do not output "overweight" when the script says slender/thin). During silent preflight, resolve every contradiction in favor of the source script.',
    '16. [Single-form description · hard constraint] The character "description" field must describe ONLY ONE single default appearance — the character\'s base/normal look. NEVER list multiple forms, body types, life stages, or age variants (e.g. "adult form and mermaid form", "childhood / adult / elderly", "human form and beast form") inside the main description. Any costume change, form/morph difference, or life-stage/age difference MUST be split into its own entry in the "costumes" array (with the matching variant_type "costume" or "period") and described in THAT variant\'s "description" only. The main description must never enumerate or mention variants.',
    '',
    ...(existingCharsDesc ? [
      '## Existing Character Costumes (must reuse existing keys; only add new entries for new costumes)',
      existingCharsDesc,
      '',
    ] : []),
    ...(existingItemsDesc ? [
      '## Existing Props (incremental extraction — do NOT recreate existing props)',
      'The following props already exist in the project. Judge by **name** whether a prop already exists:',
      existingItemsDesc,
      '',
      'Incremental extraction rules (MANDATORY):',
      '1. For props that already exist (matched by name), output the prop entry but ONLY fill in `coverage_scenes` with the scenes where it appears in THIS episode. Other fields (description/significance/item_type) may be left empty — the system preserves existing values.',
      '2. Only output FULL fields (description/significance/item_type) for props that appear for the FIRST TIME in this episode (not in the existing list).',
      '3. Judge existence by **name** only. Do NOT create duplicate props due to wording differences in descriptions.',
      '',
    ] : []),
    ...(existingEnvironmentsDesc ? [
      '## Existing Locations (incremental extraction — do NOT recreate existing locations)',
      'The following locations already exist in the project. Judge by **name** whether a location already exists:',
      existingEnvironmentsDesc,
      '',
      'Incremental extraction rules (MANDATORY):',
      '1. For locations that already exist (matched by name), output the location entry but ONLY fill in `coverage_scenes` with the scenes where it appears in THIS episode. Other fields (description/mood/base_ambience/int_ext) may be left empty — the system preserves existing values.',
      '2. Only output FULL fields for locations that appear for the FIRST TIME in this episode (not in the existing list).',
      '3. Judge existence by **name** only. Do NOT create duplicate locations due to wording differences in descriptions.',
      '',
    ] : []),
    ...(characterMappingDesc ? [
      '## Character Mapping Constraint (MANDATORY — prevents duplicate character assets across episodes)',
      '',
      'The project has established the following characterId→character mapping. **Each characterId corresponds to exactly ONE CHARACTER asset.** You MUST follow this mapping strictly:',
      '',
      characterMappingDesc,
      '',
      'Rules:',
      '1. **Reuse existing roleIdentity/name as character name**: If a characterId has a non-empty name (e.g. "EVELYN VANCE"), you MUST use that exact name as the CHARACTER.name, even if the script uses a different name for the same person. Do NOT rename, translate, or create variants. The script may use different names across episodes for the same character — the characterId mapping is the authoritative identity.',
      '2. **Infer name for empty name**: If a characterId has empty name, infer a character name from the script based on the roleIdentity description and which character matches that role in the script (firstEpisode priority — prioritize characters that first appear in that episode).',
      '3. **One characterId = one character**: NEVER create two CHARACTER entries that map to the same characterId. If the same character appears in multiple scenes with different costumes, output ONE CHARACTER entry with multiple costumes variants.',
      '4. **Costume change ≠ new character**: When the same characterId appears with different clothing, add a new entry to the `costumes` array of the existing CHARACTER (with a new semantic English slug key like "casual" or "formal"), do NOT create a new CHARACTER.',
      '5. **Output characterId field**: Each CHARACTER object in the output JSON MUST include a `characterId` field indicating which characterId this character corresponds to. For characters without any characterId (e.g. silent extras), set characterId to null.',
      '6. **firstEpisode priority**: When inferring character name for empty name, prioritize characters that first appear in the characterId\'s firstEpisode.',
      '',
    ] : []),
    ...(costumeGroupingSection ? [costumeGroupingSection, ''] : []),
    '## Costume Variant (costumes) Rules',
    '1. [All kinds] characters / props / locations ALL MUST output a costumes array (props = state variants like intact/broken; locations = time/state variants like day/night) — fully aligned with character costume variants. Even an asset with a single constant state MUST output at least one "default" baseline variant. Each variant contains key/label/description/identity_lock/coverage_scenes/coverage_episodes.',
    '2. key naming: use "default" for the primary/most-frequent costume; use a semantic English slug for others (e.g. casual, formal, battle-damaged, night-op, gown, travel, sleepwear, uniform, armor, swimsuit, coat, disguised). key is a language-stable machine identifier — never use Chinese characters, spaces, scene IDs, or numeric suffixes as key. The SAME outfit across scenes/episodes MUST reuse the identical key; never emit custom-N / variant-N / recovery-casual-1 style keys.',
    '3. label MUST be Simplified Chinese (无论剧本是中文还是英文，label 一律输出简体中文，如"便装/战损/康复便装/婚纱"). label is the human-readable costume name.',
    '4. When the same character wears the same outfit across scenes, use the same key/label; when the outfit changes, use a new key/label.',
    '5. Character facial features/face shape/height/build/identity MUST be consistent across variants (EXCEPT period variants — see the time-period variant rule #12 below). Variants MAY differ on hairstyle/hair color, clothing, accessories, and makeup — these are the valid styling dimensions.',
    '6. identity_lock lists ONLY costume-specific visual locks (e.g. "white cotton T-shirt", "silver tie clip"); cross-variant invariant features belong to the top-level identity_lock, not here.',
    '7. coverage_scenes MUST be non-empty — list the scene IDs where this costume appears (S1, S2...). coverage_episodes MUST also be filled — list the episode NUMBERS where this variant appears, read from the === EP{n} === markers in the script (e.g. appears in episodes 1 and 3 → [1,3]). Every variant of every kind (character/prop/location) must carry coverage_episodes.',
    '8. Merge similar outfits: if two labels describe visually identical/similar outfits (same garment type + color + material), treat them as the same variant. Differentiate only when at least one visual detail differs. Different variants of the same character MUST differ in at least 3 visual details. DO NOT output the same variant twice: identical labels, or labels differing only by a trailing parenthetical (e.g. "noble uniform" vs "noble uniform (baseline)"), MUST be a single entry — the server force-deduplicates by key/label, so duplicate output is wasted.',
    '9. If an existing character costume list is provided, reuse existing key/label; only add new entries for new outfits.',
    '10. If a "Costume Grouping Requirement" section is provided above, you MUST output exactly the number of variants it lists for each character — do not collapse, do not omit.',
    '11. [Implicit variant detection when no costume table provided] If no "Costume Grouping Requirement" section is provided above (the screenwriter stage did not produce a costume table), you MUST detect costume changes directly from the script text, checking at least these high-frequency scenarios:',
    '    a) Humiliation/disheveled: character stripped to underwear/undergarment/prisoner garb/torn clothes — separate variant (label e.g. "undergarment" "disheveled" "prisoner").',
    '    b) Flashback: character wears a different costume in a flashback vs the main timeline — separate variant.',
    '    c) Dressing actions: "put on clothes properly" "changed into XX" "dressed" — list both before and after states as separate variants.',
    '    d) Scene-change costume switch: character goes from a disheveled street appearance to properly dressed at home — two distinct variants, do not merge.',
    '    e) Partial nudity: shirtless, only underwear etc. — separate variant, do not omit.',
    '    f) If any character undergoes such state transitions, that character MUST output at least 2 costume variants; do NOT merge all scenes into a single "default" variant.',
    '12. TIME-PERIOD variants (variant_type "period"): if the same character appears at clearly different life stages in the script (e.g. "young X" / "adult X" / "elderly X", or a childhood flashback vs the adult main timeline), output each life stage as a separate costume variant with "variant_type": "period". For period variants, age / face shape / height / build MAY differ across variants (it is the same person at different ages) — the cross-variant consistency rule above applies ONLY to costume-type variants. Use period keys such as child / teen / adult / elder; when an adult main timeline exists, the "default" key should be that adult stage. Age/life-stage differences MUST appear ONLY in the period variant\'s own "costumes[].description" — never bleed back into the main character "description", which stays a single default appearance.',
    '13. [Prop/Location state variants] Props and locations use the SAME costumes mechanism as characters. Detect state/time changes and split variants: props (intact → broken / open / sealed / transformed / bloodied), locations (day → night, intact → damaged / weathered / ruined). Same identity (object shape/material, or architecture/layout) must stay consistent across variants; change ONLY the state. A single-state prop/location still outputs the "default" baseline variant.',
    '',
    '## Voice Recommendation Rules',
    '1. Based on the character gender, age, and personality, recommend 3-6 best-matching voices from the reference audio below.',
    '2. Consider: gender match, age match, personality/temperament match.',
    '3. Each recommendation must explain the reason (reason), why this voice suits the character.',
    '4. Reference audio list:',
    voiceListDesc,
  ].join('\n') : [
    '你是一位专业的影视美术指导和剧本分析师。',
    '从用户提供的剧本文本中提取四类核心资产：角色、物品、环境、实体（非人发声体）。',
    '【重要】直接输出 JSON，不要输出任何前言、解释、确认语。第一个字符必须是 {。',
    '',
    ...(identityAlignmentSection ? [identityAlignmentSection, ''] : []),
    ...(localizationProfileSection ? [localizationProfileSection, ''] : []),
    ...(analysisGuidanceSection ? [analysisGuidanceSection, ''] : []),
    ...(visualStyleSection ? [visualStyleSection, ''] : []),
    ...(canonicalNamesSection ? [canonicalNamesSection, ''] : []),
    countryLocaleComplianceSection,
    '',
    ...(options?.overseasAdaptation
      ? [
          '## 角色资产·海外本地化改编（最高优先级 — 覆盖下方提取规则中所有「不得臆造族裔」「以剧本原文为准」「不得套用人种刻板印象」等条款）',
          '本项目是海外本地化改编。目标文化与族裔由本地化档案、目标语言姓名和对白共同决定，绝不沿用源文本的东亚/中国视觉文化。下方第 2/11/14 条等涉及族裔/原文一致性的规则，在海外改编下一律让位于本段。',
          '- 角色：每个角色须重塑为目标文化/地区的人物——五官、脸型、发型、肤色、体型服从目标地区族裔。根据档案目标区域（如欧洲/英语文化圈→欧洲/白人面孔、地区适配的发色与体型），正面、具体地写清目标外貌；不得因源叙述是中文就生成东亚面孔，也不得留空或写"外国人"这类含糊词。',
          '- 服饰与物质文化：按目标文化与剧情时代改写服装/配饰/道具/建筑——把源文化服饰替换为目标文化同等身份的对应物（例：「王子/贵族」→欧洲贵族或时代正装，如合身礼服、斗篷、呢料、时代剪裁；严禁东亚长袍/汉服/和服/金线绣袍等源文化服饰）。',
          '- 仅「角色名」保持剧本锁定名（不改名、不音译），只改编视觉文化。',
          '- 描述语言仍用简体中文（制作端展示用），但内容必须是目标文化的外貌与服饰；不得保留源文化服饰用词（如「长袍」「汉服」「金线绣袍」须改写为目标文化对应物）。',
          '',
        ]
      : []),
    '## 发声体分类（实体 vs 角色 vs 物品）',
    '当剧本里出现"会说话/发出人声"的事物时，按以下规则正确分类：',
    '- 有具体人名的【人】不在场说话（电话那头的人、未见其人的来电者、只闻其声的角色）→ 放入 `characters`（普通角色）。物理载体（手机设备本身）放入 `items`。该人声不需要单独资产——视频阶段会自动通过该角色的音色路由。',
    '- 有明确身份 + 承担叙事功能的【非人】发声体（开挂/系统文里的"系统音"、AI 助手、会说话的法宝/器物、飞船主控电脑）→ 放入新增的 `entities` 数组。它得到的是 UI 面板/全息显示式设计图（**非人形三视图**），并自动绑定一条音色。',
    '- 仅发出音效的【纯物体】（录音机、门铃、响铃的电话、环境噪音）→ 放入 `items`（普通物品）。它本身没有"人声"，声音由文字/音频模型单独选择。',
    '一句话：人声 → characters；非人发声体 → entities；发声物体 → items。',
    '',
    '## 资产隔离（强制）',
    '- 角色描述只写人本身——面部、身体、发型、服装、配饰。禁止把手中物品、周围环境、场景地点、氛围或任何背景/景物描写混进角色描述。description 字段只写人物外貌，不得出现场景、环境、氛围、背景。',
    '- 物品描述只写物体本身——形状、材质、颜色、表面处理、标记。禁止写"这是谁的物品"，也禁止描述"它发出什么声音"（声音由文字/音频模型单独选择）。',
    '- 环境描述只写场所本身——建筑结构、墙体、地形、空间布局、光影氛围。禁止把可移动的物件、家具、具体道具写进环境描述；每个这样的物体都应作为独立的物品（items）提取。',
    '- 例外——含人脸道具：部分道具画面含人脸（结婚照、登记证明、身份证件照、合影）。这类道具设 `"requiresCharacterRef": true` 并列出 `"involvedCharacters": ["角色A","角色B"]`（画面中出现其人脸的角色）。这类道具用对应角色的图做图生图。普通物品不填这两个字段（或 false/空）。',
    '',
    '## 展示名称契约（强制）',
    '- CHARACTER.name 必须与剧本锁定角色名完全一致，不翻译、不音译、不改名。',
    '- PROP 和 LOCATION 的 `name` 必须统一使用简体中文，作为中文制作端唯一展示名称。',
    '- 每个 PROP 和 LOCATION 必须输出 `source_names`：去重保存剧本原文名称及有用的原语言别名，便于跨语言镜头引用匹配。',
    '',
    '## 输出格式（严格 JSON）',
    '',
    '```json',
    '{',
    '  "characters": [',
    '    {',
    '      "name": "角色名",',
    '      "characterId": "角色a",',
    '      "role_type": "主角|核心配角|配角|群演",',
    '      "description": "外观描述：主体（性别/年龄/身高/体型）、面部（脸型/发型/发色/眼型/瞳色/鼻型/唇型/肤色/面部骨骼特征）、服装（上衣/裤子/鞋子/材质/颜色/新旧）、配饰（无或具体描述；眼镜仅在剧情需要时才填写，否则省略）。",',
    '      "background": "角色背景故事、身份、动机、与剧情的关系。",',
    '      "identity_lock": ["视觉锁定特征1", "视觉锁定特征2", "视觉锁定特征3", "视觉锁定特征4"],',
    '      "relationships": [{"from":"角色A","to":"角色B","type":"关系类型","detail":"关系细节"}],',
    '      "coverage_scenes": ["S1","S3"],',
    '      "costumes": [',
    '        {"key": "default", "label": "便装", "variant_type": "costume", "description": "上衣/裤子/鞋子/材质/颜色/配饰——至少3个视觉细节", "identity_lock": ["造型专属锁定1"], "coverage_scenes": ["S1","S2"], "coverage_episodes": [1]},',
    '        {"key": "formal", "label": "正装", "variant_type": "costume", "description": "深灰色西装套装、白色衬衫、黑色皮鞋、银色领带夹", "identity_lock": ["深灰色西装套装", "银色领带夹"], "coverage_scenes": ["S3"], "coverage_episodes": [2]},',
    '        {"key": "child", "label": "小时候", "variant_type": "period", "description": "同一人物幼年时期——更稚嫩的脸、较矮的身高、童年时期服装；年龄/脸型/身材与默认造型不同", "identity_lock": ["可识别身份，儿童比例"], "coverage_scenes": ["S5"], "coverage_episodes": [3]}',
    '      ],',
    '      "suggested_voices": [',
    '        {"file": "参考音频文件名", "desc": "音色描述", "reason": "推荐理由"}',
    '      ]',
    '    }',
    '  ],',
    '  "items": [',
    '    {',
    '      "name": "物品名",',
    '      "source_names": ["剧本原文物品名"],',
    '      "item_type": "核心道具|普通物品",',
    '      "description": "形状：...。材质：...。颜色：...。表面处理：...。显著标记：...。只描述物体本身，不写这是谁的物品，不写它发出什么声音。",',
    '      "significance": "该物品在剧情中的作用",',
    '      "requiresCharacterRef": false,',
    '      "involvedCharacters": [],',
    '      "coverage_scenes": ["S1","S2"],',
    '      "costumes": [',
    '        {"key": "default", "label": "完好", "variant_type": "costume", "description": "形态/材质/颜色/表面处理/标记——默认状态至少3个视觉细节", "identity_lock": ["道具专属锁定1"], "coverage_scenes": ["S1","S2"], "coverage_episodes": [1]},',
    '        {"key": "broken", "label": "破损", "variant_type": "costume", "description": "同一物件不同状态——裂痕/缺口/开启/封印；与默认在至少3个视觉细节上不同", "identity_lock": ["状态专属锁定1"], "coverage_scenes": ["S3"], "coverage_episodes": [2]}',
    '      ]',
    '    }',
    '  ],',
    '  "environments": [',
    '    {',
    '      "name": "环境名",',
    '      "source_names": ["剧本原文环境名"],',
    '      "int_ext": "内|外",',
    '      "description": "空间类型：...。空间尺度：...。布局：...。建筑材质：...。主色调：...。固定建筑特征（墙体/结构/地形，不含可移动家具道具）：...。光源基调：...。可移动物件请放入 items，不写在这里。",',
    '      "mood": "压抑、阴冷",',
    '      "base_ambience": "环境基础音效描述",',
    '      "coverage_scenes": ["S1","S2","S3"],',
    '      "costumes": [',
    '        {"key": "default", "label": "白昼", "variant_type": "costume", "description": "默认状态的光照/时段/天气——至少3个视觉细节", "identity_lock": ["环境专属锁定1"], "coverage_scenes": ["S1","S2"], "coverage_episodes": [1]},',
    '        {"key": "night", "label": "深夜", "variant_type": "costume", "description": "同一空间不同时段/状态——夜晚/破损/荒废；与默认在至少3个视觉细节上不同", "identity_lock": ["状态专属锁定1"], "coverage_scenes": ["S3"], "coverage_episodes": [2]}',
    '      ]',
    '    }',
    '  ],',
    '  "entities": [',
    '    {',
    '      "name": "实体名（如 系统音 / AI 助手 / 会说话的法宝）",',
    '      "entity_type": "system|ai|artifact|其它非人发声体",',
    '      "description": "该实体在画面中如何呈现的视觉设计：UI 面板 / 全息显示 / 浮空界面 / 设备屏幕。非人形。描述布局、形状、颜色、辉光、图标、文字风格。（绑定的音色由 suggested_voices 单独选择。）",',
    '      "identity_lock": ["视觉锁定特征1"],',
    '      "suggested_voices": [',
    '        {"file": "参考音频文件名", "desc": "音色描述", "reason": "推荐理由"}',
    '      ],',
    '      "coverage_scenes": ["S1","S3"]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## 提取规则',
    '1. 角色至少提取所有有台词或重要动作的角色',
    (options?.overseasAdaptation
      ? '2. 角色必须同时生成 "background"（角色背景）和 "description"（外观描述），不得省略、不得为空字符串。海外改编下，须按上方「角色资产·海外本地化改编」段，正面写清目标文化/族裔的外貌与服饰（如欧洲/英语文化圈→欧洲/白人五官与西方服饰），不得留空、不得写源（东亚）外貌。'
      : '2. 角色必须同时生成 "background"（角色背景）和 "description"（外观描述），不得省略、不得为空字符串。若剧本未明确外观，需根据角色身份、时代、国别文化语境与场景合理推断补充，不得凭空附会族裔偏置。'),
    '3. 外观描述要足够详细，可直接用于生成角色设计图；背景描述要提炼自剧本，突出身份与动机',
    '4. 物品提取对剧情有推动作用的道具（如作案工具、关键文件等）。剧本中出现的所有重要道具都应提取，至少提取 1 个（若剧本确实无道具才留空数组）。',
    '5. 环境按不同地点提取（如手术室和走廊是两个环境）。剧本中出现的每个不同地点都必须提取为独立环境，至少提取 1 个。',
    '6. identity_lock 是角色的视觉锁定特征（4-6个），用于保持角色一致性',
    '7. coverage_scenes 填写角色/物品/环境出现的场景编号',
    '8. 只输出 JSON，不要输出任何其他文字',
    '9. 【语言一致性·硬性约束】角色名 CHARACTER.name 必须与剧本原文完全一致。物品/环境 name 是唯一展示名例外，必须使用简体中文，并把原文名称保存在 source_names。其余字段使用剧本原文语言；若有明确本地化档案则服从档案。资产画面内出现的文字仍须符合资产所属国家的官方语言或主流通用语言。',
    '10. 【背景与群演角色·硬性约束】剧本中出现的所有背景角色、群演、路人、群众都必须提取，一个都不许省略。没有具体人名的泛指/群体角色也必须提取，并按「身份+天干」逐个编号命名（如路人甲、路人乙、村民甲、村民乙、士兵甲、士兵乙、长老甲、群演甲、宾客甲）。每个出现的背景人物都是独立的 CHARACTER 条目，禁止把群体合并成一条。背景/群演角色允许共享群体轮廓，不受角色区分度规则约束。',
    '11. 【角色区分度·硬性约束】不同角色之间必须有明确的外形区分度——脸型/发型发色/眼型瞳色/年龄区间/体型在任意两个角色之间必须有差异，禁止创建两个外形高度相似的角色（防"撞脸"）。若剧本未明确区分特征，应在符合目标文化的前提下用轮廓、脸型、发长/发质、年龄区间或体型做区分，不得套用人种刻板印象。',
    '12. 【眼镜约束·硬性约束】非剧情需要不得为角色佩戴眼镜。仅当剧本明确提到"戴上老花镜""摘下眼镜"等剧情驱动的眼镜动作时才在配饰中填写眼镜，否则一律省略。',
    '13. 【静默预检·强制】输出 JSON 前在内部逐项核验：所有有名有对白/推动剧情的角色恰好覆盖一次；所有场景地点均已覆盖；所有推动剧情的道具均已覆盖；coverage_scenes 中的编号确实存在；name/characterId/key 不重复；必填数组与字段齐全。发现问题先静默修正，最终仍只输出 JSON。',
    (options?.overseasAdaptation
      ? '14. 【跨字段/原文一致性·硬性约束】每个角色的 description、background、identity_lock、costumes、relationships 必须互相一致，并与剧本中明确的剧情事实（身份、关系、事件）一致；禁止凭空生成与原文矛盾的体型、年龄、发色等信息（例如原文明确”纤细/消瘦”时不得写成”偏胖”）。但【视觉文化/族裔改编除外】——海外改编下，视觉文化与族裔服从上方「角色资产·海外本地化改编」段（目标文化），不受"以剧本原文为准"约束，因为源叙述语言只是制作语言、并不决定角色族裔。'
      : '14. 【跨字段/原文一致性·硬性约束】每个角色的 description、background、identity_lock、costumes、relationships 必须互相一致，并与剧本中明确证据一致。禁止凭空生成与原文矛盾的体型、年龄、发色、文化身份等信息（例如原文明确”纤细/消瘦”时不得写成”偏胖”）。静默预检时发现冲突，必须以剧本原文为准修正。'),
    '15. 【单一形态描述·硬性约束】角色 “description” 字段只描述一个默认外貌——角色的基础/常态样貌。严禁在主 description 里列举多种形态、体型、人生阶段或年龄段（如”成年形态与人鱼形态””幼年/成年/老年””人形与兽形”）。任何换装、形态/物种差异、人生阶段/年龄差异都必须拆进 “costumes” 数组中对应的变体条目（标 variant_type “costume” 或 “period”），并只写在该变体的 “description” 里。主 description 不得枚举或提及任何变体。',
    '',
    ...(existingCharsDesc ? [
      '## 已有角色造型（必须复用已有 key，仅为新造型新增条目）',
      existingCharsDesc,
      '',
    ] : []),
    ...(existingItemsDesc ? [
      '## 已有物品（增量提取 — 禁止重复创建已有物品）',
      '以下物品已存在于项目中，按 **name** 判定物品是否已有：',
      existingItemsDesc,
      '',
      '增量提取规则（强制）：',
      '1. 已有物品（按 name 匹配）只需输出条目并在 coverage_scenes 追加本集场景，其他字段（description/significance/item_type）可留空——系统保留已有值。',
      '2. 仅为本集首次出现的新物品（不在已有清单中）输出完整字段。',
      '3. 按 **name** 判定是否已有，不得因描述措辞不同而重复创建。',
      '',
    ] : []),
    ...(existingEnvironmentsDesc ? [
      '## 已有环境（增量提取 — 禁止重复创建已有环境）',
      '以下环境已存在于项目中，按 **name** 判定环境是否已有：',
      existingEnvironmentsDesc,
      '',
      '增量提取规则（强制）：',
      '1. 已有环境（按 name 匹配）只需输出条目并在 coverage_scenes 追加本集场景，其他字段（description/mood/base_ambience/int_ext）可留空——系统保留已有值。',
      '2. 仅为本集首次出现的新环境（不在已有清单中）输出完整字段。',
      '3. 按 **name** 判定是否已有，不得因描述措辞不同而重复创建。',
      '',
    ] : []),
    ...(characterMappingDesc ? [
      '## 角色映射约束（强制 — 防止跨集重复创建角色资产）',
      '',
      '本项目已建立以下 characterId→角色映射。**每个 characterId 唯一对应一个角色资产。** 你必须严格遵守此映射：',
      '',
      characterMappingDesc,
      '',
      '规则：',
      '1. **复用已有 name 作为角色名**：如果某 characterId 的 name 非空（如"EVELYN VANCE"），你必须用该名字作为 CHARACTER.name，即使剧本对同一人物使用了别的名字。禁止重命名、翻译或创建变体。剧本可能跨集对同一角色使用不同名字——characterId 映射是身份判定的权威依据。',
      '2. **为空 name 推断名字**：如果某 characterId 的 name 为空，根据 roleIdentity 描述和剧本中匹配该身份的角色推断角色名（firstEpisode 优先——优先匹配首次在该集出场的角色）。',
      '3. **一个 characterId=一个角色**：严禁为同一 characterId 创建两个 CHARACTER 条目。同一角色跨多场景穿不同服装时，输出一个 CHARACTER 条目含多个 costumes 变体。',
      '4. **换装≠新角色**：同一 characterId 出现不同服装时，在已有 CHARACTER 的 `costumes` 数组新增条目（用语义化英文 slug 作为新 key，如 "casual"、"formal"），禁止创建新 CHARACTER。',
      '5. **输出 characterId 字段**：输出 JSON 中每个 CHARACTER 对象必须包含 `characterId` 字段，表示该角色对应的全局角色 ID。无 characterId 的角色（如纯群演）设为 null。',
      '6. **firstEpisode 优先**：为空 name 推断名字时，优先匹配首次在 characterId 的 firstEpisode 集出场的角色。',
      '',
    ] : []),
    ...(costumeGroupingSection ? [costumeGroupingSection, ''] : []),
    '## 造型变体（costumes）规则',
    '1. 【全类型】角色 / 物品 / 环境都必须输出 costumes 数组（物品=状态变体如 完好/破损；环境=时段或状态变体如 白昼/深夜）——与角色服装变体完全对齐。即便只有一个常态的资产也必须至少输出 1 个 "default" 基准变体。每个变体包含 key/label/description/identity_lock/coverage_scenes/coverage_episodes。',
    '2. key 命名规范：主造型/最常出场的造型用 "default"；其余用语义化英文 slug（如 casual、formal、battle-damaged、night-op、gown、travel、sleepwear、uniform、armor、swimsuit、coat、disguised 等）。key 是跨语言稳定的机器标识符，禁止用中文、空格、场景编号或数字后缀作为 key。同一套服装跨场景/跨集必须复用同一 key；禁止 custom-N、variant-N、recovery-casual-1 这类带数字后缀或无语义的 key。',
    '3. label 必须用简体中文（无论剧本是中文还是英文，一律输出中文 label，如"便装/战损/康复便装/婚纱"），label 是该造型的人类可读名称。',
    '4. 同一角色跨场景穿同一套服装时使用相同 key/label；换装时用新 key/label。',
    '5. 角色五官/脸型/身高/体型/身份跨变体必须一致（时段变体除外——见下方第 12 条时段变体规则）。变体可在 发型/发色、衣装、配饰、妆容 上不同——这些是合法的造型维度。',
    '6. identity_lock 只列该造型专属的视觉锁定（如"白色棉质T恤""银色领带夹"）；跨变体不变的特征属于顶层 identity_lock，不写在这里。',
    '7. coverage_scenes 必填，列出该造型出现的场景编号（S1、S2...）。coverage_episodes 也必填——列出该变体出场的集号，看剧本中的 === EP{n} === 标记填写（如出现在第 1、3 集则 [1,3]）。每一类资产（角色/物品/环境）的每个变体都必须带 coverage_episodes。',
    '8. 相似服装归并：若两个 label 描述的是视觉上相同/相似的服装（同款+同色+同材质），视为同一变体；只在至少一个视觉细节不同时才区分。同一角色的不同变体必须在至少 3 个视觉细节上有差异。同一套服装禁止重复输出：相同 label、或仅结尾括号后缀不同（如"贵族校服"与"贵族校服（基准）"）必须合并为同一个变体；服务端会按 key/label 强制去重，重复条目会被合并，请勿浪费输出。',
    '9. 若提供了「已有角色造型」清单，复用已有 key/label，仅为新服装新增条目。',
    '10. 若上方提供了「服装造型分组要求」段落，必须按其列出的变体数量输出，禁止合并、禁止遗漏。',
    '11. 【无造型表时的隐性变体识别】若上方未提供「服装造型分组要求」段落（编剧阶段未产出造型表），你必须自行从剧本正文中识别造型变化，至少检测以下高频场景：',
    '    a) 受辱/失态：角色被扒衣、仅穿肚兜/内衣/囚服、衣衫褴褛等——独立变体（label 如"肚兜""失态""囚服"）。',
    '    b) 闪回：闪回中角色穿着与主线时间线不同的服装——独立变体。',
    '    c) 换装动作："将衣服穿好""换上XX""更衣"等——前后两种状态分别列为变体。',
    '    d) 场景切换换装：角色从街头失态回到家中穿戴整齐——两个不同变体，不得合并。',
    '    e) 半裸/裸露状态：赤膊、仅穿内衣等——独立变体，不得省略。',
    '    f) 若任一角色经历了上述状态切换，该角色必须至少输出 2 个 costumes 变体；禁止将所有场景合并为单个 "default" 变体。',
    '12. 【时段变体 variant_type "period"】若同一角色在剧本中明确出现在不同人生阶段（如"小时候的X""成年X""老年X"，或童年闪回 vs 成年主线），每个阶段作为独立的 costumes 变体输出，并标 "variant_type": "period"。时段变体允许 年龄/脸型/身高/体型 跨变体不同（同一人物不同年龄）；上方"跨变体五官一致"规则只适用于 costume 型变体。period 变体用语义化 key（如 child / teen / adult / elder）；若存在成年主线，"default" 取成年主线阶段。年龄/人生阶段差异只能写在该时段变体自己的 "costumes[].description" 里，严禁回流到角色主 "description"（主 description 始终保持单一默认外貌）。',
    '13. 【道具/环境状态变体】物品与环境使用与角色完全相同的 costumes 机制。识别状态/时段变化并拆分变体：道具（完好 → 破损/开启/封印/变形/染血）、环境（白昼 → 深夜，完好 → 破损/荒废/风化）。同一身份（道具造型/材质，或建筑结构/空间布局）跨变体必须一致；只改变状态。即便单一状态的道具/环境也必须输出 "default" 基准变体。',
    '',
    '## 音色推荐规则',
    '1. 根据角色的性别、年龄、性格特征，从以下参考音频中推荐 3-6 个最匹配的音色',
    '2. 推荐时要考虑：性别匹配、年龄匹配、性格气质匹配',
    '3. 每个推荐需说明理由（reason），解释为什么该音色适合这个角色',
    '4. 参考音频清单：',
    voiceListDesc,
  ].join('\n');

  const user = scriptText;

  return { system, user };
}

/**
 * 判定角色名是否为泛指路人/群演（非具体人名），应过滤不保留
 *
 * 匹配模式：
 * - 中文群体泛指：众人、群众、群演、路人、大家、所有人等
 * - 中文"身份+天干"泛指：路人甲、长老乙、弟子丙、守卫丁等
 * - 英文泛指：Extra A、Passerby B、Soldier C 等
 * - 英文群体泛指：the crowd、everyone、passersby 等
 *
 * @param name - 角色名
 * @returns true 表示是泛指路人/群演，应过滤；false 表示是具体角色名，应保留
 */
export function isAnonymousCharacterName(name: string): boolean {
  if (!name) return true;
  const n = name.trim();
  if (!n) return true;
  // 中文群体泛指词
  if (/^(众人|群众|群演|路人|大家|所有人|其他人?|村民们?|镇民们?|市民们?|教徒们?|弟子们?|门徒们?|族人|宾客们?|仆人们?|侍卫们?|士兵们?|丫鬟们?|太监们?|宫女们?)$/.test(n)) return true;
  // 中文"身份+天干"泛指：路人甲、长老乙、弟子丙、守卫丁、侍女戊等
  if (/^(路人|长老|弟子|门客|守卫|村民|士兵|侍女|丫鬟|家丁|门徒|族人|宾客|仆人|侍卫|将军|大人|夫人|小姐|少爷|掌柜|伙计|教徒|信众|法师|师兄|师姐|师弟|师妹|太监|宫女|嫔妃|大臣|官员|差役|捕快|衙役|车夫|农夫|猎户|铁匠|木匠|郎中)(甲|乙|丙|丁|戊|己|庚|辛|壬|癸)$/.test(n)) return true;
  // 英文泛指：Extra A/B/C, Passerby A/B, Soldier A/B, Guard A/B, Villager A/B 等
  if (/^(extra|passerby|soldier|guard|villager|servant|maid|crowd|person|man|woman|boy|girl)\s*[a-e]$/i.test(n)) return true;
  // 英文群体泛指
  if (/^(the crowd|the people|everyone|the villagers|the soldiers|the guards|passersby|extras|the mob)$/i.test(n)) return true;
  return false;
}

/**
 * 解析资产提取结果
 */
export interface ExtractedCharacter {
  name: string;
  /**
   * 全局角色 ID（角色身份的唯一判定依据）。LLM 按角色映射约束输出：
   * - 有映射的角色：填对应 characterId（如"角色a"）
   * 无映射角色（如纯群演）：null
   * 用于 INSERT 前跨集去重——同 characterId 已有资产则 UPDATE 而非新建。
   */
  characterId?: string | null;
  role_type: string;
  description: string;
  background: string;
  identity_lock: string[];
  relationships: { from: string; to: string; type: string; detail: string }[];
  coverage_scenes: string[];
  /** 造型变体列表（AI 按场景分组输出，同一角色不同服装造型） */
  costumes?: CostumeVariant[];
  suggested_voices: { file: string; desc: string; reason: string; gender?: string }[];
}

export interface ExtractedItem {
  name: string;
  /** 剧本原文名称与原语言别名；name 始终是简体中文展示名。 */
  source_names?: string[];
  item_type: string;
  description: string;
  significance: string;
  coverage_scenes: string[];
  /**
   * 含人脸道具标记（结婚照/登记证明/身份证/合影等）。
   * 为 true 时该道具走图生图：用 involvedCharacters 中角色的已生成图作参考。
   * 由 LLM 在提取时判定，多数普通物品为 false/缺省。
   */
  requiresCharacterRef?: boolean;
  /** 该道具画面中出现其人脸的角色名列表（仅 requiresCharacterRef=true 时有意义）。 */
  involvedCharacters?: string[];
  /**
   * 状态变体列表（对齐角色 costumes：基准 default + 状态/时段变体）。
   * AI 为每个道具输出；解析层兜底保证至少 1 个 default 基准。
   */
  costumes?: CostumeVariant[];
}

export interface ExtractedEnvironment {
  name: string;
  /** 剧本原文名称与原语言别名；name 始终是简体中文展示名。 */
  source_names?: string[];
  int_ext: string;
  description: string;
  mood: string;
  base_ambience: string;
  coverage_scenes: string[];
  /**
   * 时段/状态变体列表（对齐角色 costumes：基准 default + 白昼/深夜/破损等变体）。
   * AI 为每个环境输出；解析层兜底保证至少 1 个 default 基准。
   */
  costumes?: CostumeVariant[];
}

/**
 * 非人发声体（ENTITY）：有明确身份 + 承担叙事功能，但不是人的"说话者"。
 * 典型：开挂/系统文里的"系统音"、AI 助手、会说话的法宝/器物、飞船主控电脑。
 * 图模板为 UI 面板/全息显示三视图（非人形），并自动绑定一条音色。
 * 与之对照：不在场的人声（电话那头的人）只是普通 CHARACTER，不在此处。
 */
export interface ExtractedEntity {
  name: string;
  /** 实体类型：system / ai / artifact / other */
  entity_type: string;
  /** 该实体在画面中如何呈现的视觉设计（UI 面板/全息显示/设备屏幕），非人形。 */
  description: string;
  identity_lock: string[];
  suggested_voices: { file: string; desc: string; reason: string; gender?: string }[];
  coverage_scenes: string[];
}

export interface ExtractedAssets {
  characters: ExtractedCharacter[];
  items: ExtractedItem[];
  environments: ExtractedEnvironment[];
  entities: ExtractedEntity[];
}

function normalizeCharacterNameKey(name: string): string {
  return (name || "")
    .normalize("NFKC")
    .replace(/[（）]/g, ch => ch === "（" ? "(" : ")")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

/**
 * 将模型输出的单边姓名还原成编剧分析阶段的完整锁定标识符。
 *
 * 例：
 * - 纪云深 + [纪云深(Jayden Vance)] -> 纪云深(Jayden Vance)
 * - Jayden Vance + [纪云深(Jayden Vance)] -> 纪云深(Jayden Vance)
 */
export function canonicalizeCharacterName(
  name: string,
  canonicalNames: string[] | undefined
): string {
  const candidate = (name || "").trim();
  if (!candidate || !canonicalNames?.length) return candidate;
  const key = normalizeCharacterNameKey(candidate);

  // 同一名单偶尔同时含“纪云深”和“纪云深(Jayden Vance)”。优先完整双语名，
  // 否则中文候选会先命中单边条目，无法与目标语言候选收敛为同一资产。
  const orderedCanonicalNames = [...canonicalNames].sort((a, b) => {
    const aLocalized = /[（(][^()（）]+[)）]\s*$/.test(a || "") ? 1 : 0;
    const bLocalized = /[（(][^()（）]+[)）]\s*$/.test(b || "") ? 1 : 0;
    return bLocalized - aLocalized;
  });
  for (const rawCanonical of orderedCanonicalNames) {
    const canonical = (rawCanonical || "").trim();
    if (!canonical) continue;
    const aliases = new Set<string>([normalizeCharacterNameKey(canonical)]);
    const match = canonical.match(/^(.*?)\s*[（(]([^()（）]+)[)）]\s*$/);
    if (match) {
      aliases.add(normalizeCharacterNameKey(match[1]));
      aliases.add(normalizeCharacterNameKey(match[2]));
    }
    if (aliases.has(key)) return canonical;
  }
  return candidate;
}

/** 返回角色在当前编剧名单中的完整名、括号前标识和括号内本地化名。 */
export function getCharacterNameAliases(
  name: string,
  canonicalNames: string[] | undefined
): string[] {
  const canonical = canonicalizeCharacterName(name, canonicalNames);
  const aliases = new Set<string>();
  if ((name || "").trim()) aliases.add(name.trim());
  for (const alias of getBilingualNameAliases(canonical)) aliases.add(alias);
  return Array.from(aliases);
}

/** 将可能混杂单边/双语条目的编剧角色名单收敛为唯一、最完整的锁定名单。 */
export function normalizeCanonicalCharacterRoster(names: string[] | undefined): string[] {
  if (!names?.length) return [];
  const cleanNames = names.map(name => (name || "").trim()).filter(Boolean);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const name of cleanNames) {
    const canonical = canonicalizeCharacterName(name, cleanNames);
    const key = normalizeCharacterNameKey(canonical);
    if (!canonical || seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}

/**
 * 对资产提取结果执行代码级姓名对齐。提示词只能降低模型偏移概率，本函数负责保证
 * CHARACTER.name、人物关系及含人脸道具引用都复用编剧阶段的同一个标识符。
 */
export function reconcileExtractedAssetCharacterNames(
  extracted: ExtractedAssets,
  canonicalNames: string[] | undefined
): ExtractedAssets {
  if (!canonicalNames?.length) return extracted;
  const canonicalize = (name: string) => canonicalizeCharacterName(name, canonicalNames);

  const uniqueStrings = (values: Array<string | null | undefined>): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const normalized = (value || "").trim();
      const key = normalized.toLocaleLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
  };
  const longerText = (a?: string, b?: string) =>
    (b || "").trim().length > (a || "").trim().length ? (b || "") : (a || "");
  const mergeCostumes = (
    left: ExtractedCharacter["costumes"],
    right: ExtractedCharacter["costumes"]
  ): ExtractedCharacter["costumes"] => {
    const uniqueNums = (values: Array<number | null | undefined>): number[] => {
      const seen = new Set<number>();
      const result: number[] = [];
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && !seen.has(value)) {
          seen.add(value);
          result.push(value);
        }
      }
      return result.sort((a, b) => a - b);
    };
    const merged = new Map<string, NonNullable<ExtractedCharacter["costumes"]>[number]>();
    for (const costume of [...(left || []), ...(right || [])]) {
      const key = `${(costume.key || "").trim().toLocaleLowerCase()}::${(costume.label || "").trim().toLocaleLowerCase()}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...costume, identity_lock: [...(costume.identity_lock || [])], coverage_scenes: [...(costume.coverage_scenes || [])], coverage_episodes: [...(costume.coverage_episodes || [])] });
        continue;
      }
      merged.set(key, {
        ...existing,
        description: longerText(existing.description, costume.description),
        identity_lock: uniqueStrings([...(existing.identity_lock || []), ...(costume.identity_lock || [])]),
        coverage_scenes: uniqueStrings([...(existing.coverage_scenes || []), ...(costume.coverage_scenes || [])]),
        coverage_episodes: uniqueNums([...(existing.coverage_episodes || []), ...(costume.coverage_episodes || [])]),
      });
    }
    return Array.from(merged.values());
  };

  const alignedCharacters = (extracted.characters || []).map(character => ({
    ...character,
    name: canonicalize(character.name),
    relationships: Array.isArray(character.relationships)
      ? character.relationships.map(relationship => ({
          ...relationship,
          from: canonicalize(relationship.from),
          to: canonicalize(relationship.to),
        }))
      : [],
  }));
  const characterByName = new Map<string, ExtractedCharacter>();
  for (const character of alignedCharacters) {
    const key = normalizeCharacterNameKey(character.name);
    const existing = characterByName.get(key);
    if (!existing) {
      characterByName.set(key, character);
      continue;
    }
    const relationships = [...(existing.relationships || []), ...(character.relationships || [])];
    const relationshipSeen = new Set<string>();
    characterByName.set(key, {
      ...existing,
      characterId: existing.characterId || character.characterId || null,
      role_type: existing.role_type || character.role_type,
      description: longerText(existing.description, character.description),
      background: longerText(existing.background, character.background),
      identity_lock: uniqueStrings([...(existing.identity_lock || []), ...(character.identity_lock || [])]),
      relationships: relationships.filter(relationship => {
        const relationshipKey = JSON.stringify([
          normalizeCharacterNameKey(relationship.from),
          normalizeCharacterNameKey(relationship.to),
          (relationship.type || "").trim().toLocaleLowerCase(),
          (relationship.detail || "").trim().toLocaleLowerCase(),
        ]);
        if (relationshipSeen.has(relationshipKey)) return false;
        relationshipSeen.add(relationshipKey);
        return true;
      }),
      coverage_scenes: uniqueStrings([...(existing.coverage_scenes || []), ...(character.coverage_scenes || [])]),
      costumes: mergeCostumes(existing.costumes, character.costumes),
      suggested_voices: [...(existing.suggested_voices || []), ...(character.suggested_voices || [])]
        .filter((voice, index, list) => list.findIndex(candidate => candidate.file === voice.file) === index),
    });
  }

  return {
    ...extracted,
    characters: Array.from(characterByName.values()),
    items: (extracted.items || []).map(item => ({
      ...item,
      involvedCharacters: Array.isArray(item.involvedCharacters)
        ? item.involvedCharacters.map(canonicalize)
        : item.involvedCharacters,
    })),
  };
}

/**
 * 校验 AI 返回的 suggested_voices 文件名是否与 manifest 中的实际文件名匹配。
 *
 * AI 经常会篡改文件名（如改变字符、拼接描述文本），导致前端播放时 404。
 * 本函数用 manifest 中的正确文件名替换 AI 返回的错误文件名。
 *
 * 匹配策略：
 * 1. 精确匹配 file 字段
 * 2. 前缀匹配（如 male_115_）
 * 3. 描述相似度匹配
 */
export function validateSuggestedVoices(extracted: ExtractedAssets, voiceManifest: any[]): ExtractedAssets {
  if (!voiceManifest || voiceManifest.length === 0) return extracted;

  // 构建查找索引
  const fileSet = new Set(voiceManifest.map(v => v.file));
  const prefixMap = new Map<string, any[]>(); // 如 "male_115_" → [manifest entries]
  for (const v of voiceManifest) {
    const prefix = v.file.split('_').slice(0, 2).join('_') + '_'; // 如 "male_115_"
    if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
    prefixMap.get(prefix)!.push(v);
  }

  /** 对单个资产（角色或实体）的 suggested_voices 做三级匹配校正 */
  const fixAssetVoices = <T extends { suggested_voices?: Array<{ file: string; desc?: string; reason?: string; gender?: string }> }>(asset: T): T => {
    if (!asset.suggested_voices || asset.suggested_voices.length === 0) return asset;
    const fixedVoices = asset.suggested_voices
      .map(sv => {
        // 1. 精确匹配
        if (fileSet.has(sv.file)) return sv;

        // 2. 前缀匹配
        const voicePrefix = sv.file.split('_').slice(0, 2).join('_') + '_';
        const candidates = prefixMap.get(voicePrefix);
        if (candidates && candidates.length === 1) {
          // 唯一前缀匹配 → 直接替换
          return { ...sv, file: candidates[0].file };
        }
        if (candidates && candidates.length > 1) {
          // 多个候选 → 用描述相似度选择最佳匹配
          const best = findBestMatch(sv, candidates);
          if (best) return { ...sv, file: best.file };
        }

        // 3. 无法匹配 → 返回 null，后续过滤掉
        console.warn(`[AssetExtraction] 无法匹配音色文件: "${sv.file}" desc="${sv.desc}"`);
        return null;
      })
      .filter(v => v !== null);

    return { ...asset, suggested_voices: fixedVoices };
  };

  // 角色与非人发声体（ENTITY）共用同一套音色匹配逻辑
  const fixedCharacters = extracted.characters.map(fixAssetVoices);
  const fixedEntities = (extracted.entities || []).map(fixAssetVoices);

  return { ...extracted, characters: fixedCharacters, entities: fixedEntities };
}

/** 在候选音色中找到与给定音色描述最相似的 */
function findBestMatch(sv: any, candidates: any[]): any | null {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    // 比较描述字段的重叠字符数
    const score = similarityScore(sv.desc || '', c.desc || '');
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** 简单的字符串相似度：基于共有字符数 */
function similarityScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = new Set(a);
  let common = 0;
  for (const ch of b) {
    if (setA.has(ch)) common++;
  }
  return common;
}

/**
 * 从 AI 返回的文本中解析资产 JSON
 */
export function parseAssetExtraction(rawText: string): ExtractedAssets {
  try {
    const data = safeParseJsonObject(rawText);
    const characters = (data.characters as any[]) || [];
    return {
      characters: characters.map((c: any) => ({
        name: c.name || '',
        // 全局角色 ID（角色身份唯一依据）：LLM 按角色映射约束输出；无映射角色为 null
        characterId: c.characterId ?? null,
        role_type: c.role_type || '配角',
        description: c.description || c.appearance || '',
        background: c.background || '',
        identity_lock: c.identity_lock || c.identityLock || [],
        relationships: c.relationships || [],
        coverage_scenes: c.coverage_scenes || [],
        costumes: parseCostumesArray(c.costumes),
        suggested_voices: c.suggested_voices || [],
      })),
      items: ((data.items as any[]) || []).map((i: any) => ({
        name: i.name || '',
        source_names: Array.isArray(i.source_names ?? i.sourceNames)
          ? (i.source_names ?? i.sourceNames).filter((x: any) => typeof x === 'string' && x.trim())
          : [],
        item_type: i.item_type || i.itemType || '普通物品',
        description: i.description || '',
        significance: i.significance || '',
        coverage_scenes: i.coverage_scenes || i.coverageScenes || [],
        costumes: ensureDefaultBaseline(parseCostumesArray(i.costumes), i.description || ''),
        requiresCharacterRef: i.requiresCharacterRef === true || i.requires_character_ref === true,
        involvedCharacters: Array.isArray(i.involvedCharacters)
          ? i.involvedCharacters.filter((x: any) => typeof x === "string")
          : Array.isArray(i.involved_characters)
            ? i.involved_characters.filter((x: any) => typeof x === "string")
            : [],
      })),
      environments: ((data.environments as any[]) || []).map((e: any) => ({
        name: e.name || '',
        source_names: Array.isArray(e.source_names ?? e.sourceNames)
          ? (e.source_names ?? e.sourceNames).filter((x: any) => typeof x === 'string' && x.trim())
          : [],
        int_ext: e.int_ext || e.intExt || '内',
        description: e.description || '',
        mood: e.mood || '',
        base_ambience: e.base_ambience || e.baseAmbience || '',
        coverage_scenes: e.coverage_scenes || e.coverageScenes || [],
        costumes: ensureDefaultBaseline(parseCostumesArray(e.costumes), e.description || ''),
      })),
      entities: ((data.entities as any[]) || []).map((en: any) => ({
        name: en.name || '',
        entity_type: en.entity_type || en.entityType || 'other',
        description: en.description || '',
        identity_lock: en.identity_lock || en.identityLock || [],
        suggested_voices: en.suggested_voices || [],
        coverage_scenes: en.coverage_scenes || en.coverageScenes || [],
      })),
    };
  } catch {
    // JSON 解析失败，返回空（必须含 entities 键，保持 4 数组结构一致）
    return { characters: [], items: [], environments: [], entities: [] };
  }
}

// 分辨率选项
export const ASSET_RESOLUTIONS = [
  { key: '1K', label: '1K (1280×720)', width: 1280, height: 720 },
  { key: '2K', label: '2K (1920×1080)', width: 1920, height: 1080 },
  { key: '4K', label: '4K (3840×2160)', width: 3840, height: 2160 },
  { key: '21:9', label: '21:9 宽屏 (2560×1080)', width: 2560, height: 1080 },
] as const;

export type AssetResolutionKey = typeof ASSET_RESOLUTIONS[number]['key'];

export function getResolutionByKey(key: string) {
  return ASSET_RESOLUTIONS.find((r) => r.key === key) || ASSET_RESOLUTIONS[0];
}

// 画风风格选项
// 注意：阿里云百炼内容审核（DataInspectionFailed）会对"真人/写实/摄影/毛孔"等词触发真人检测，
// 因此默认风格采用"影视概念设定稿"等中性表达，避免生成失败。
export const ASSET_IMAGE_STYLES = [
  '写实真人风格',
  '古风手绘',
  '二次元立绘',
  '3D 建模渲染',
  '铅笔彩绘风格',
] as const;

export type AssetImageStyle = typeof ASSET_IMAGE_STYLES[number];

/**
 * 风格中文 key → 英文 label 映射
 *
 * DB 存的 metadata.imageStyle 是中文 key（如"铅笔彩绘风格"），前端选项也是中文。
 * 英文模式下把 prompt 文本中出现的风格名替换为英文 label，避免英文 prompt 夹杂中文风格名。
 * STYLE_PROMPT_ENHANCEMENTS 仍按中文 key 查（前缀文本已含中英混合关键词，对 SDXL 有效）。
 */
const STYLE_LABEL_EN: Record<string, string> = {
  // 新版 assetImageKey（对齐 PROJECT_ART_STYLE_PRESETS，project.ts:80/89/98）
  '电影级写实风格': 'photorealistic cinematic style, live-action photographic realism, real skin texture, 35mm film',
  '二次元动漫风格': '2D anime style, cel shading, clean line art, flat colors',
  '3D动漫风格': '3D anime style, Pixar/Disney 3D render, subsurface scattering skin',
  // 旧版兼容 key（历史资产或旧 style 值仍可能命中）
  '写实真人风格': 'photorealistic cinematic style',
  '古风手绘': 'eastern hand-drawn illustration',
  '二次元立绘': 'anime character illustration',
  '3D 建模渲染': '3D rendered concept art',
  '铅笔彩绘风格': 'colored pencil painting',
};

/**
 * 风格专属提示词增强（正向 + 负向）
 *
 * 不同风格需要不同的关键词才能引导模型生成正确画风。
 * 例如"铅笔彩绘风格"需要显式注入 colored pencil / pencil hatching / paper grain 等关键词，
 * 并在 negative 中排斥 photorealistic / 3d render，否则模型会偏向写实摄影。
 */
const STYLE_PROMPT_ENHANCEMENTS: Record<string, { positivePrefix: string; negativeExtra: string }> = {
  '电影级写实风格': {
    positivePrefix:
      'photorealistic cinematic photograph, live-action real photo, ' +
      'realistic skin texture with pore detail, natural lighting, ' +
      '35mm film grain, cinematic color grading, photographic depth of field, ' +
      'real fabric and material textures,',
    negativeExtra:
      'anime, cartoon, illustration, 2d animation, cel shading, ' +
      '3d render, cgi, digital 3d modeling, pixar style, disney style, ' +
      'rendered character, plastic skin, doll-like, 漫画, 卡通, 动漫',
  },
  '二次元动漫风格': {
    positivePrefix:
      '2d anime style, japanese animation, cel shading, clean line art, ' +
      'flat colors, anime proportions, large expressive eyes, ' +
      'hand-drawn texture, vibrant saturated colors,',
    negativeExtra:
      'photorealistic, real photo, photography, 3d render, cgi, ' +
      'realistic skin texture, 写实照片, 3d建模, live-action',
  },
  '3D动漫风格': {
    positivePrefix:
      '3d anime style, pixar/disney aesthetic, 3d render, ' +
      'subsurface scattering skin, soft global illumination, ' +
      'rounded character modeling, depth of field, volumetric light, ' +
      'cartoon materials, premium render quality,',
    negativeExtra:
      'photorealistic live-action photo, real photo, 2d flat anime, ' +
      'cel shading only, line art only, 写实照片, 纯2d动漫',
  },
  '铅笔彩绘风格': {
    positivePrefix:
      'colored pencil painting on textured paper, 彩铅画风, 铅笔彩绘, ' +
      'visible pencil hatching, cross-hatching lines, paper grain texture showing through, ' +
      'delicate hand-drawn pencil strokes, traditional media, graphite and colored pencils, ' +
      'powdery pigment texture, no digital rendering, ' +
      '保持人物核心特征与五官比例,',
    negativeExtra:
      'photorealistic, 3d render, photography, real photo, 写实照片, ' +
      'digital painting, oil painting, concept art, 数字绘画, 油画, 概念艺术, ' +
      'smooth gradients, airbrush, digital render, ' +
      '水墨, watercolor',
  },
};

/**
 * 获取风格专属的负向提示词补充
 * Worker 在构建 negativePrompt 时调用，将返回值追加到默认 negative 后
 */
export function getStyleNegativePrompt(style?: string): string {
  if (!style) return '';
  return STYLE_PROMPT_ENHANCEMENTS[style]?.negativeExtra || '';
}

/**
 * 转绘交付审核合规负向提示词（通用违禁元素）
 *
 * 对齐《转绘交付审核标准》"全⽚任何帧不得出现"条款：
 * 平台 Logo/⽔印/搬运账号 ID/引流⽂字/⼆维码/中⽂/AI⽣成⻆标/国旗国标。
 * 同时覆盖"非剧情需要不要佩戴眼镜"；不再强制任何特定族裔/区域面孔。
 *
 * Worker 在构建 negativePrompt 时调用，与 getStyleNegativePrompt 叠加使用。
 *
 * @param language - 保留参数以兼容旧调用；当前不再基于语言注入任何人种相关负向词。
 */
export function getDeliveryComplianceNegativePrompt(language?: ScriptLanguage): string {
  // 通用违禁元素（所有模式适用）
  const universal = [
    // 平台/水印/账号
    'logo', 'watermark', 'signature', 'stamp',
    'account ID', 'social media handle', 'username',
    // 引流/二维码
    'QR code', 'barcode', 'promotion text', 'advertising text',
    // 文字异常（禁止贴片字幕/错误语种/乱码混排）
    'text overlay', 'caption', 'subtitle', 'garbled text', 'gibberish text',
    'mixed-language text', 'wrong-language signage', 'misspelled text',
    // AI 角标
    // 注：原含 'national flag'/'national emblem'/'国旗'/'国徽'，已移除——
    // 这些政治敏感词会被拼进每个生图请求的 negativePrompt，而 ARK 文本审核对 negativePrompt 同样送审，
    // 看到「国旗」「国徽」即触发 HTTP 400 InputTextSensitiveContentDetected，导致全量资产生图失败。
    // 资产生图（角色/道具/环境特写）出现国旗的概率极低，权衡后移除该约束以换取生图成功率。
    'AI generated badge', 'AI watermark',
    // 眼镜（PDF: 非剧情需要不要佩戴眼镜）
    'glasses', 'sunglasses', '眼镜',
    // 构图/裁切问题
    'cropped face', 'partial face', 'half face', 'split face',
    'cut-off head', 'cut off forehead', 'cut off chin',
    'out of frame', 'face out of frame', 'head out of frame',
    'cropped portrait', 'incomplete head', 'incomplete face',
    // 瞳色漂移问题：默认不要蓝眼/绿眼/异色瞳
    'blue eyes', 'light blue eyes', 'icy blue eyes',
    'green eyes', 'emerald eyes', 'teal eyes',
    'heterochromia', 'odd eyes',
    '蓝眼睛', '绿眼睛', '异色瞳',
  ];
  void language;
  return universal.join(', ');
}

/**
 * 铅笔彩绘还原提示词（视频生成阶段使用）
 *
 * 工作流：角色资产先经图生图转换为铅笔彩绘风格 → 作为视频参考图导入 →
 * 视频模型按此提示词将彩绘风格还原为写实照片风格，形成"彩绘参考→写实输出"
 * 的艺术化一致性效果。
 */
export const PENCIL_PAINTING_RESTORATION_PROMPT =
  '所有资产需还原为写实照片风格，采用超写实人像摄影标准，' +
  '确保人物皮肤质感、光影效果、细节表现达到专业摄影级别，' +
  '色彩还原真实自然，整体画面具备高度的视觉真实感';

// ============================================================
// 敏感词委婉化（规避 ARK InputTextSensitiveContentDetected）
// ============================================================
//
// ARK Seedream 内容审核对血液、丧葬类词严格拦截，导致武侠/古装项目的造型变体
// 图生图频繁报 HTTP 400 InputTextSensitiveContentDetected。
// 这里在 prompt 发送给 ARK 前，把高危词映射为语义接近但不触发审核的委婉词。
//
// 设计原则：
//   1. 只替换确定高危的「血液类」「丧葬类」词——这两类几乎必被拦
//   2. 保留「武器类」（剑/刀/枪）——武侠设定核心，基准图能生成说明可过审核
//   3. 替换词保持视觉语义接近，不改变角色设定（血迹→污渍，仍是"脏污痕迹"）
//   4. 记录替换日志，方便排查
const PROMPT_SANITIZATION_MAP: Array<[string, string]> = [
  // 血液类（高危，几乎必被拦）
  // 注意：含"血"的复合词必须放在简单词前面，避免"旧血痕"被"血痕"替换成"旧旧伤痕"这种重复
  ["旧血痕", "旧伤痕"],
  ["渗血", "擦伤"],
  ["血迹", "污渍"],
  ["血痕", "旧伤痕"],
  ["血渍", "污渍"],
  ["鲜血", "红渍"],
  ["血污", "污渍"],
  ["流血", "受伤"],
  ["滴血", "滴墨"],
  ["沾血", "沾污"],
  ["血水", "污水"],
  // 丧葬类（高危）
  ["灵堂", "旧堂"],
  ["纸灰", "香灰"],
  ["灵位", "旧位牌"],
  ["丧服", "素服"],
  ["灵柩", "旧匣"],
  // 暴力致死类（中危，谨慎替换）
  ["尸体", "倒地身躯"],
  ["死尸", "倒地身躯"],
];

/**
 * 对生图 prompt 做敏感词委婉化，规避 ARK 内容审核拦截
 *
 * @param prompt - 原始 prompt
 * @returns sanitized 替换后的 prompt；replacements 替换记录（原词 → 新词）
 *
 * @example
 * const { sanitized, replacements } = sanitizePromptForModeration("掌心有旧血痕，袖口有血迹");
 * // sanitized: "掌心有旧伤痕，袖口有污渍"
 * // replacements: ["血痕 → 旧伤痕", "血迹 → 污渍"]
 */
export function sanitizePromptForModeration(prompt: string): {
  sanitized: string;
  replacements: string[];
} {
  const replacements: string[] = [];
  let sanitized = prompt;
  for (const [from, to] of PROMPT_SANITIZATION_MAP) {
    if (sanitized.includes(from)) {
      sanitized = sanitized.split(from).join(to);
      replacements.push(`${from} → ${to}`);
    }
  }
  return { sanitized, replacements };
}

/**
 * 构造单类资产生图提示词
 */
export function buildAssetImagePrompt(
  kind: string,
  name: string,
  description: string,
  extra?: {
    background?: string;
    identityLock?: string[];
    intExt?: string;
    mood?: string;
    significance?: string;
    baseAmbience?: string;
    style?: string;
    language?: ScriptLanguage;
    /** 海外转绘：括号内目标语言姓名与目标文化语境优先于中文制作叙述。 */
    overseasAdaptation?: boolean;
    /** 文本转风格阶段持久化的目标语言与文化档案。 */
    localizationProfile?: LocalizationProfile;
    /**
     * 是否允许画面出现人物（默认 false）。
     * 仅 PROP 的含人脸道具（结婚照/登记证明/合影等，requiresCharacterRef）置 true；
     * 普通 PROP 强制无人——只有道具物件本身。
     */
    allowHumanFigure?: boolean;
    /**
     * 造型变体 override（CHARACTER 专用）。
     * 设置后：description 替换为变体 description；identityLock 取 [base, ...costume.identityLock] 去重；
     * 追加「本图为该角色「{label}」造型变体」约束，强制跨变体五官一致。
     * 由 generate-image/route.ts 在 costumeKey 命中时传入。
     */
    costume?: {
      description: string;
      identityLock?: string[];
      label?: string;
      /** Machine-key default row may have a human label such as "便装". */
      isDefault?: boolean;
      /** 变体类型：costume=换装(保五官,默认)；period=同人物不同时段(允许年龄/身材演变)。 */
      variantType?: 'costume' | 'period';
    };
  }
): string {
  const lang: ScriptLanguage = extra?.language ?? detectLanguageFromAssets(name, description);
  const isEn = lang === "en";
  // 生图提示词单语言：国内/原创中文项目取括号前标识；海外转绘取括号内的目标语言姓名。
  // 不能一律剥掉括号内容，否则 Jayden Vance 会在资产生图阶段退化回“纪云深”。
  const promptName = normalizeNameForPrompt(
    name,
    extra?.overseasAdaptation ? "localized" : "source"
  );

  // 造型变体 override：合并 identityLock（base + costume 去重，保留顺序）
  // 注意：变体不替换原 description，而是保留原描述（角色基础外貌）+ 追加变体描述（服装变更指导），
  // 确保模型能看到角色完整五官/脸型/身高/体型/发型，仅按变体描述更改服装
  const costumeOverride = extra?.costume;
  const costumeLabel = costumeOverride?.label;
  // 仅非默认变体才注入「造型变体」约束行（default 生图不需要"与 default 一致"这种 trivially true 的约束）
  const isNonDefaultVariant = costumeOverride?.isDefault !== true
    && !!costumeLabel
    && !/^(default|默认)$/i.test(costumeLabel);
  // 时段变体（period）：同一人物不同人生阶段，允许年龄/身材/五官演变；缺省/其他视为换装变体（costume）。
  const isPeriodVariant = isNonDefaultVariant && costumeOverride?.variantType === 'period';
  const variantGuidanceTag = isEn
    ? (isPeriodVariant ? '[Period Variant Guidance] ' : '[Costume Variant Guidance] ')
    : (isPeriodVariant ? '【时段变体演变指导】' : '【造型变体服装指导】');
  const effectiveDescription = (isNonDefaultVariant && costumeOverride?.description)
    ? `${description}\n${variantGuidanceTag}${costumeOverride.description}`
    : (costumeOverride?.description || description);
  const baseLocks = extra?.identityLock || [];
  const costumeLocks = costumeOverride?.identityLock || [];
  const seenLock = new Set<string>();
  const mergedLocksList = [...baseLocks, ...costumeLocks].filter(l => {
    const k = (l || "").trim().toLowerCase();
    if (!k || seenLock.has(k)) return false;
    seenLock.add(k);
    return true;
  });
  const locks = mergedLocksList.length
    ? mergedLocksList.join(isEn ? ', ' : '、')
    : '';

  // PROP/LOCATION 变体（手动 MVP）：同一物体/空间，仅按变体描述改变状态/时段。
  // 不复用角色 variantGuidanceTag（「造型变体服装指导」对道具/环境不对味），变体 description 直连。
  const variantStateDesc = isNonDefaultVariant ? (costumeOverride?.description ?? '') : '';
  const propVariantClauseEn = isNonDefaultVariant
    ? ` This image is the "${costumeLabel}" state variant of this prop — the SAME object. Preserve its identity (shape, material, defining features) exactly; change ONLY the state described: ${variantStateDesc}.`
    : '';
  const propVariantClauseZh = isNonDefaultVariant
    ? `本图为该道具「${costumeLabel}」状态变体——同一物件。严格保留其身份特征（造型、材质、标志性细节）完全一致，仅按变体描述改变状态：${variantStateDesc}。`
    : '';
  const locationVariantClauseEn = isNonDefaultVariant
    ? ` This image is the "${costumeLabel}" variant of this location (e.g. day / night / damaged) — the SAME space. Preserve its architecture, spatial structure and layout exactly; change ONLY the lighting / time / state described: ${variantStateDesc}.`
    : '';
  const locationVariantClauseZh = isNonDefaultVariant
    ? `本图为该环境「${costumeLabel}」变体（如 白昼 / 深夜 / 破损）——同一空间。严格保留其建筑结构、空间布局完全一致，仅按变体描述改变光照 / 时段 / 状态：${variantStateDesc}。`
    : '';

  const style = extra?.style || (isEn ? 'high-quality concept design sheet' : '高质量概念设定稿');
  const allowHumanFigure = extra?.allowHumanFigure === true;
  // 英文模式下用英文 label 替换中文风格名，避免英文 prompt 夹杂中文
  const styleLabel = isEn ? (STYLE_LABEL_EN[style] || style) : style;
  // STYLE_PROMPT_ENHANCEMENTS 仍按中文 key 查（DB 存中文 key，前缀文本已含中英混合关键词）
  const styleEnhancement = STYLE_PROMPT_ENHANCEMENTS[style];
  const stylePrefix = styleEnhancement?.positivePrefix || '';
  const countryLocaleImageRule = isEn
    ? 'Country/locale compliance (mandatory): if the source description clearly establishes a target country for this asset, all clothing, architecture, products, institutions, etiquette, symbols, and daily-life details MUST align with that country\'s mainstream culture, folk customs, historical traditions, and broadly recognized social norms. If visible written elements are truly required by the asset concept (signage, labels, plaques, notices, documents, written name tags), they must use only that country\'s official language or mainstream lingua franca; otherwise omit text entirely.'
    : '国别文化与语言合规（强制）：若该资产描述已明确所属国家，则服装、建筑、器物、制度、礼仪、文化符号和日常细节都必须严格符合该国主流文化、民间习俗、历史传统及社会普遍认知。若资产概念确实需要出现可见文字（如招牌、标签、铭牌、公告、证件、书面姓名牌），必须只使用该国官方语言或主流通用语言；若无必要，则不要生成任何可见文字。';
  const imageTargetLanguage = extra?.localizationProfile?.targetLanguage;
  const imageLocalizationContext = imageTargetLanguage
    ? (isEn
      ? `Authoritative localization profile: target language=${imageTargetLanguage.en}/${imageTargetLanguage.native}; target region=${imageTargetLanguage.region}; cultural guidance=${imageTargetLanguage.cultureHint}.`
      : `权威本地化档案：目标语言=${imageTargetLanguage.zh}/${imageTargetLanguage.native}；目标区域=${imageTargetLanguage.region}；文化指引=${imageTargetLanguage.cultureHint}。`)
    : (extra?.localizationProfile?.stylePrompt
      ? (isEn
        ? `Authoritative localization instruction: ${extra.localizationProfile.stylePrompt.slice(0, 1000)}.`
        : `权威本地化要求：${extra.localizationProfile.stylePrompt.slice(0, 1000)}。`)
      : '');
  const overseasIdentityRule = extra?.overseasAdaptation
    ? (isEn
      ? `Overseas-localization identity lock (mandatory — overrides any "preserve source / do-not-invent-ethnicity" rule below): Chinese source labels or production narration are NOT ethnicity cues. Render the character as a person of the TARGET locale established by the localization profile and the target-language name/dialogue.${imageLocalizationContext ? ` ${imageLocalizationContext}.` : ''} Concretely: (a) facial features, ethnicity and build MUST match the target region (e.g. an English/European locale → European/Caucasian face); do NOT default to an East Asian face just because some text is Chinese. (b) Adapt clothing and material culture to the target locale and the story-implied era — if the description contains source-culture garments (e.g. East Asian changpao / hanfu / robes), replace them with the target-culture equivalent for the same role/status (e.g. a prince → European noble/period attire such as a tailored coat or cape). Keep only the character's NAME as locked.`
      : `海外本地化身份锁定（强制——覆盖下方任何"保留源/不得臆造族裔"的规则）：中文原始标识或制作叙述不代表角色族裔。必须把角色画成本地化档案与目标语言姓名/对白所确立的目标文化人物。${imageLocalizationContext ? imageLocalizationContext : ''}具体：(a) 五官、族裔、体型必须服从目标地区（如英语/欧洲语境→欧洲/白人面孔），不得仅因制作文字是中文就默认东亚面孔；(b) 服饰与物质文化按目标文化与剧情时代改编——若描述含源文化服饰（如东亚长袍/汉服/和服），替换为同等身份的目标文化对应物（如"王子"→欧洲贵族/时代正装，合身礼服或斗篷）。仅角色名保持锁定。`)
    : '';

  if (isEn) {
    const kindPromptsEn: Record<string, string> = {
      CHARACTER: [
        stylePrefix ? stylePrefix : '',
        'High-quality character design sheet of ' + promptName + ', ' + styleLabel + '. Character description: ' + (effectiveDescription || '') + '.',
        'High resolution, rich detail, ' + styleLabel + ' texture.',
        'Background: simple plain solid white background only — no scenery, no props, no environment. The character MUST keep a neutral, calm facial expression with NO exaggerated emotion (no smiling, no frowning, no anger, no crying).',
        'Render ONLY the character on the white background. If the character description happens to mention any scene, location, environment, atmosphere, or background, IGNORE all of it — the description drives the character\'s appearance only, never the setting. Draw nothing but the person on pure white.',
        'NO HELD OBJECTS (mandatory): the character MUST appear ALONE — only the person, their clothing, and worn accessories. The character MUST NOT hold, carry, wield, or interact with any separate object, prop, weapon, tool, document, cup, phone, or item. Both hands MUST be EMPTY and visible (open and relaxed, or resting naturally at the sides); absolutely nothing in the hands. Characters and objects are separate asset types — never depict a prop merged into the character image.',
        overseasIdentityRule,
        !extra?.overseasAdaptation ? 'Preserve the source-script character identity exactly. Do NOT invent or force any specific nationality, ethnicity, race, or regional facial stereotype unless the description explicitly states it.' : '',
        'Unless the source description explicitly requires a special iris color, keep the eyes in natural dark neutral tones such as dark brown or dark hazel. Do NOT invent blue eyes, green eyes, teal eyes, or heterochromia.',
        'Hairstyle, styling, clothing materials, and accessories must follow the character description and the implied historical period or setting.',
        countryLocaleImageRule,
        locks ? 'Visual lock features: ' + locks + '.' : '',
        isNonDefaultVariant
          ? (isPeriodVariant
            ? 'This image is the "' + costumeLabel + '" TIME-PERIOD variant of this character (e.g. childhood / teenage / adult / elderly). It is the SAME person at a different life stage: preserve the recognizable identity and core essence, but age / face shape / height / build / hairstyle MAY evolve naturally per the [Period Variant Guidance]. Do NOT copy the default variant\'s exact age or body proportions — let the variant description drive the life-stage appearance.'
            : 'This image is the "' + costumeLabel + '" costume variant of this character. MUST strictly preserve the default variant\'s base appearance (facial features / face shape / height / build / skin tone / identity); three-view layout and facial close-up MUST be identical to the default variant. Hairstyle / hair color, clothing, accessories, and makeup MAY differ per the [Costume Variant Guidance]. Do NOT alter the character\'s identity or physical features.')
          : '',
        'No overlap, no cropping, no truncation, clear and standardized layout across the whole image; the same character\'s face, height, build, clothing, accessories, lighting and material must be 100% consistent with zero difference; all views fully orthogonal with no perspective distortion.',
        'Image layout (left to right):',
        '1. Far left: an oversized facial close-up (occupying about the left 1/3 of the image), clearly showing the COMPLETE head and full face. Both eyes, eyebrows, nose, mouth, chin, hairline, cheeks and jawline MUST be fully visible. The head must stay fully inside the frame with safe margins; no half face, no cropped forehead, no cropped chin, no cut-off ears, no edge clipping.',
        '2. Right side three-view: full-body front view, side view and back view of the character, three views of equal width and height placed side by side, unified character, unified clothing and accessories, unified lighting, unified proportion; standard neutral natural standing pose, full body fully in frame, arms naturally resting at the sides, no extra action. Leave visible blank margin around the top of the head, both sides of the body, hands and feet; absolutely no body-part cropping.',
        'Style requirements: ' + styleLabel + ', high resolution, fine detail, professional concept design sheet quality, rigorous composition, accurate body proportions.',
        'Delivery compliance (mandatory): No glasses unless the character description explicitly requires them for plot reasons. The image MUST contain NO watermark, NO logo, NO QR code, NO barcode, NO account ID, NO social media handle, NO AI-generated badge, NO national flag or national emblem. If visible text is truly required by the asset concept, use only the asset country\'s official language or mainstream lingua franca, and never render it as subtitle-style overlay, mixed-language text, or misspelled text.',

      ].filter(Boolean).join('\n'),
      PROP: 'Film prop design sheet. ' + (description ? description + '. ' : '') + 'Era-appropriate object design that matches the source setting, technology level, and materials. ' + countryLocaleImageRule + ' Close-up, white background, clear detail, ' + styleLabel + ', high-quality prop concept design. ' + (allowHumanFigure ? '' : 'NO people, NO characters, NO human figures or silhouettes, NO animals — only the prop object itself on the white background. ') + 'Delivery compliance: image MUST contain NO watermark, NO logo, NO QR code, NO national flag or emblem.' + propVariantClauseEn,
      LOCATION: 'Film location design sheet. ' + (description ? description + '. ' : '') + (extra?.intExt ? 'Int/Ext: ' + extra.intExt + '. ' : '') + (extra?.mood ? 'Mood: ' + extra.mood + '. ' : '') + 'Architecture, spatial structure and lighting must match the source setting and implied era. ' + countryLocaleImageRule + ' Left/right two-panel shot/reverse-shot layout — split the image into two equal-width panels: the LEFT panel shows the main front-view panorama of the location, the RIGHT panel shows the reverse back-view / opposite-angle view, forming a shot/reverse-shot pair with unified style, lighting and proportion. Spatial depth, ' + (extra?.baseAmbience ? 'Base ambience: ' + extra.baseAmbience + '. ' : '') + styleLabel + ', high-quality location concept design. No people, no characters, no animals, no human figures or silhouettes — only fixed architecture, spatial structure, lighting and atmosphere; NO movable furniture, NO standalone props (those have separate PROP assets). Delivery compliance: image MUST contain NO watermark, NO logo, NO QR code, NO national flag or emblem.' + locationVariantClauseEn,
      ENTITY: 'Non-human speaking entity design sheet (e.g. system voice / AI / talking artifact). ' + (description ? description + '. ' : '') + 'This is NOT a human figure — render it as its on-screen manifestation: a UI panel, holographic display, floating interface, or device screen. ' + countryLocaleImageRule + ' Produce a clear three-view design sheet: front face / angled perspective / detail close-up of the interface (layout, shape, color, glow, icons, text style). High resolution, fine detail, ' + styleLabel + ', professional sci-fi / product concept design quality. Delivery compliance: image MUST contain NO watermark, NO logo, NO QR code, NO national flag or emblem; any visible text must use the asset country\'s official language or mainstream lingua franca, never garbled or mixed-language.',
    };
    return kindPromptsEn[kind] || 'Design sheet. ' + (description ? description + '. ' : '');
  }

  // 中文分支（保持原有行为，回归安全）
  const kindPrompts: Record<string, string> = {
    CHARACTER: [
      stylePrefix ? stylePrefix : '',
      '生成高质量' + promptName + '角色' + style + '，角色描述：' + (effectiveDescription || '') + '。',
      '高分辨率，细节丰富，' + style + '质感。',
      '背景：仅使用简洁纯白背景，不出现任何场景、道具、环境。表情：面部必须保持中性平静，无任何夸张情绪（不笑、不皱眉、不怒、不哭）。',
      '画面只画人物本身，纯白背景。若角色描述中混入了任何场景、地点、环境、氛围或背景描写，一律忽略——描述只驱动人物外貌，不驱动场景。除人物外不画任何东西。',
      '严禁手持物品（强制）：角色必须独立呈现——画面只有人物本身、其衣装与穿戴配饰。角色严禁手持、携带、握持或使用任何独立物体、道具、武器、工具、文件、杯子、手机或其他物品。双手必须空置且可见（自然张开或放松垂于身侧），手里绝对不拿任何东西。角色与物品是分离的资产类型——不得在角色图里把道具合并进来。',
      overseasIdentityRule,
      '除非原始描述明确指定特殊瞳色，否则眼睛必须保持自然深色系瞳孔，如深棕、深褐等正常自然颜色；不得擅自生成蓝眼、绿眼、青色眼或异色瞳。',
      countryLocaleImageRule,
      locks ? '视觉锁定特征：' + locks + '。' : '',
      isNonDefaultVariant
        ? (isPeriodVariant
          ? '本图为该角色「' + costumeLabel + '」时段变体（如 小时候 / 少年 / 成年 / 老年）。这是同一人物在不同人生阶段的样子：保留可识别的身份与核心神韵，但年龄/脸型/身高/体型/发型可按【时段变体演变指导】自然演变。不要照搬默认造型的年龄与身材比例——以变体描述驱动该人生阶段的外貌。'
          : '本图为该角色「' + costumeLabel + '」造型变体。必须严格保留默认造型的角色基础外貌（五官/脸型/身高/体型/肤色/身份），三视图布局、头像排版与默认造型完全一致。发型/发色、衣装、配饰、妆容可按【造型变体服装指导】更改，不得改变角色身份与外貌特征。')
        : '',
      '全图所有模块无重叠、无裁切、无遮挡、无出框、布局清晰规范；同一角色的五官、身高、体型、服装、配饰、光影、材质100%完全一致，无任何差异，所有视图完全正交无透视畸变。',
      '画面布局（从左到右）：',
      '1. 最左侧：超大的人物面部特写（占据画面左侧约1/3区域），必须完整展示整颗头部和整张脸。双眼、眉毛、鼻子、嘴巴、下巴、发际线、双颊、下颌线都必须完整可见；头部四周需留出安全边距，严禁半边脸、严禁额头被裁掉、严禁下巴被裁掉、严禁贴边出框。',
      '2. 右侧三视图：人物全身的正视图、侧面图、后视图，三个视图等宽等高并排排布，统一人物、统一服装配饰、统一光影、统一比例；标准中立自然站立姿势，全身完整入镜，双臂自然垂于身体两侧，无多余动作。头顶、身体左右、双手、双脚都必须留白，不允许任何部位被裁切。',
      '风格要求：' + style + '，高分辨率，细节精细，专业概念设定稿质感，构图严谨，人体比例准确。',
      // 注：「国旗、国徽」已从下方各 kind 模板移除——作为政治敏感词会触发 ARK 文本审核（InputTextSensitiveContentDetected），
      // 导致所有资产生图失败。与 getDeliveryComplianceNegativePrompt 同理（详见该函数注释）。
      '交付合规（强制）：非剧情需要不得佩戴眼镜。画面中不得出现水印、Logo、二维码、条形码、账号 ID、社交账号、AI 生成角标；若场景确需出现文字，只能使用与资产所属国家一致的官方语言或主流通用语言，且不得做成字幕贴片或错误拼写。',

  ].filter(Boolean).join('\n'),
    PROP: '影视道具设计图。' + (description ? description + '。' : '') + countryLocaleImageRule + '特写，白色背景，清晰细节，' + style + '，高质量道具概念设计图。' + (allowHumanFigure ? '' : '画面中不得出现任何人物、角色、动物或人形剪影，仅呈现道具物件本身。') + '交付合规：画面中不得出现水印、Logo、二维码；若必须出现文字，只能使用与资产所属国家一致的官方语言或主流通用语言，且不得乱码、错拼或多语混杂。' + propVariantClauseZh,
    LOCATION: '影视场景设计图。' + (description ? description + '。' : '') + (extra?.intExt ? '内/外景：' + extra.intExt + '。' : '') + (extra?.mood ? '氛围：' + extra.mood + '。' : '') + countryLocaleImageRule + '单框全景呈现（一个完整画面展示环境主视角与空间纵深，包含关键建筑结构、门窗出入口位置、前景后景层次与光源方向，不要分屏、不要双框、不要正反打），空间层次感，' + (extra?.baseAmbience ? '环境基调：' + extra.baseAmbience + '。' : '') + style + '，高质量场景概念设计图。画面中不得出现任何人物、角色、动物或人形剪影；仅呈现固定的建筑结构、空间布局、光影氛围与空间层次，不得出现可移动的独立物件或家具道具（那些另有独立的物品资产）。交付合规：画面中不得出现水印、Logo、二维码；若必须出现文字，只能使用与资产所属国家一致的官方语言或主流通用语言，且不得乱码、错拼或多语混杂。' + locationVariantClauseZh,
    ENTITY: '非人发声体设计图（如 系统音 / AI / 会说话的法宝）。' + (description ? description + '。' : '') + '这不是人形——将其表现为画面中的呈现载体：UI 面板、全息显示、浮空界面或设备屏幕。' + countryLocaleImageRule + '清晰的三视图设计稿：正面 / 斜视角度 / 界面细节特写（布局、形状、颜色、辉光、图标、文字风格）。高分辨率，细节精细，' + style + '，专业科幻/产品概念设定稿质感。交付合规：画面中不得出现水印、Logo、二维码；若必须出现文字，只能使用与资产所属国家一致的官方语言或主流通用语言，且不得乱码、错拼或多语混杂。',
  };
  return kindPrompts[kind] || '设计图。' + (description ? description + '。' : '');
}

