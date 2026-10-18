// ============================================================
// Original Script Intake Module — 原创整剧 AI 拆集
// ============================================================
//
// Interface 隐藏三类复杂性：严格拆分提示词、LLM JSON 修复、旧分集备份与原子替换。
// AI 调用在事务外完成，避免长请求占住数据库连接；只有最终替换进入短事务。
// ============================================================

import { createHash } from 'node:crypto';
import { callAI } from '@server/gateway';
import { tx, type QueryFn } from '@server/infra';
import {
  buildWholeSeriesTextStylePrompt,
  buildLocalizedDurationBudget,
  detectLanguage,
  type LocalizationProfile,
} from '@server/domain/prompt';
import {
  normalizeProjectScriptForHash,
  resolveProjectSourceScriptText,
} from '@shared/project-script-snapshot';
import { genId } from '@shared/utils';

export interface SplitEpisodeDraft {
  episodeNumber: number;
  title: string;
  content: string;
  emotionArc?: string;
}

export interface EpisodeSplitOutput {
  episodeIds: string[];
  episodeCount: number;
  coverage: number;
  splitMode: 'ai-verbatim' | 'ai-heading-anchored' | 'ai-whitespace-repaired';
  /** 本次 LLM 平台成本（人民币元），worker 统一换算积分。 */
  cost: number;
}

/** AI 读完整份结构权威原文后得到的动态分集计划。 */
export interface EpisodeStructureAnalysis {
  drafts: SplitEpisodeDraft[];
  episodeCount: number;
  splitMode: EpisodeSplitOutput['splitMode'];
  cost: number;
}

export interface WholeSeriesStyledEpisodeDraft extends SplitEpisodeDraft {
  /** Optional source heading retained only as model-provided context; server does not parse it. */
  sourceHeading?: string;
}

export interface WholeSeriesStyleSplitOutput extends EpisodeSplitOutput {
  /** Every styled episode body concatenated in order; persisted as projects.novelText. */
  styledNovelText: string;
  /** Used after the core transaction to repair voice/role identity mappings. */
  characterAliasMap: Map<string, string>;
}

export interface EpisodeSplitProjectCommit {
  novelText?: string | null;
  scriptData?: Record<string, unknown>;
}

export class StaleProjectScriptError extends Error {
  readonly code = 'STALE_PROJECT_SCRIPT';

  constructor(message = '项目整剧稿件已变化，旧拆集任务已拒绝写入') {
    super(message);
    this.name = 'StaleProjectScriptError';
  }
}

function hashProjectScript(text: string): string {
  return createHash('sha256')
    .update(normalizeProjectScriptForHash(text), 'utf8')
    .digest('hex');
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

/** 从 markdown 包裹或带少量前后文的响应中提取 JSON 对象。 */
export function parseEpisodeSplitResponse(raw: string): SplitEpisodeDraft[] {
  const stripped = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const candidates = [stripped];
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(stripped.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { episodes?: unknown };
      if (!Array.isArray(parsed.episodes)) continue;
      const episodes = parsed.episodes
        .map((entry, index): SplitEpisodeDraft | null => {
          if (!entry || typeof entry !== 'object') return null;
          const row = entry as Record<string, unknown>;
          const content = typeof row.content === 'string' ? row.content : '';
          if (!content.trim()) return null;
          return {
            episodeNumber: Number(row.episodeNumber) || index + 1,
            title: typeof row.title === 'string' && row.title.trim()
              ? row.title.trim()
              : `第 ${index + 1} 集`,
            content,
            ...(typeof row.emotionArc === 'string' ? { emotionArc: row.emotionArc } : {}),
          };
        })
        .filter((entry): entry is SplitEpisodeDraft => entry !== null)
        .sort((a, b) => a.episodeNumber - b.episodeNumber);
      if (episodes.length > 0) return episodes;
    } catch {
      // 尝试下一个候选；全部失败后统一抛业务错误，避免暴露模型原始输出。
    }
  }
  throw new Error('AI 分集返回格式无效，请重试或更换文本模型');
}

/** Parse the compact one-pass whole-series style + dynamic split response. */
export function parseWholeSeriesStyleSplitResponse(raw: string): {
  episodes: WholeSeriesStyledEpisodeDraft[];
  characterAliasMap: Map<string, string>;
  detectedEpisodeCount: number;
} {
  const stripped = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const candidates = [stripped];
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(stripped.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        episodes?: unknown;
        characterNameMapping?: unknown;
        detectedEpisodeCount?: unknown;
      };
      if (!Array.isArray(parsed.episodes)) continue;
      const episodes = parsed.episodes.map((entry, index): WholeSeriesStyledEpisodeDraft | null => {
        if (!entry || typeof entry !== 'object') return null;
        const row = entry as Record<string, unknown>;
        const content = typeof row.content === 'string' ? row.content : '';
        if (!content.trim()) return null;
        return {
          episodeNumber: Number(row.episodeNumber),
          title: typeof row.title === 'string' && row.title.trim()
            ? row.title.trim()
            : `第 ${index + 1} 集`,
          ...(typeof row.sourceHeading === 'string' && row.sourceHeading.trim()
            ? { sourceHeading: row.sourceHeading.trim() }
            : {}),
          content,
          ...(typeof row.emotionArc === 'string' ? { emotionArc: row.emotionArc } : {}),
        };
      });
      if (episodes.length === 0 || episodes.some((episode) => episode === null)) continue;

      const characterAliasMap = new Map<string, string>();
      if (Array.isArray(parsed.characterNameMapping)) {
        for (const entry of parsed.characterNameMapping) {
          if (!entry || typeof entry !== 'object') continue;
          const row = entry as Record<string, unknown>;
          const oldName = typeof row.oldName === 'string' ? row.oldName.trim() : '';
          const newName = typeof row.newName === 'string' ? row.newName.trim() : '';
          if (oldName && newName) characterAliasMap.set(oldName, newName);
        }
      }
      return {
        episodes: episodes as WholeSeriesStyledEpisodeDraft[],
        characterAliasMap,
        detectedEpisodeCount: Number(parsed.detectedEpisodeCount),
      };
    } catch {
      // Try the extracted JSON candidate before returning a stable business error.
    }
  }
  throw new Error('整剧转风格与分集返回格式无效，请重试或更换文本模型');
}

/** 构建“只切分、不改写”的双语契约，防止模型自行删减剧情。 */
export function buildEpisodeSplitPrompt(
  novelText: string,
  localizationProfile?: LocalizationProfile,
  sourceScriptText: string = novelText,
  requiredAiEpisodeCount?: number,
): { system: string; user: string } {
  const normalizedSource = normalizeProjectScriptForHash(sourceScriptText);
  const normalizedTarget = normalizeProjectScriptForHash(novelText);
  const hasDistinctStructureReference = normalizedSource !== normalizedTarget;
  const zh = detectLanguage(sourceScriptText) === 'zh' || detectLanguage(novelText) === 'zh';
  const budget = buildLocalizedDurationBudget(localizationProfile, undefined, zh ? 'zh' : 'en');
  const aiCountContract = requiredAiEpisodeCount
    ? (zh
        ? `\n上游 AI 已先无损通读结构权威原文，并确认本稿实际包含 ${requiredAiEpisodeCount} 个叙事单元。这里必须把待拆分稿一一映射为恰好 ${requiredAiEpisodeCount} 集；该数字来自本次原文 AI 结构分析，不是标题、旧数据或固定算法。`
        : `\nAn upstream AI has already read and losslessly split the structural-authority source, confirming ${requiredAiEpisodeCount} narrative units in this manuscript. Map the target manuscript one-to-one into exactly ${requiredAiEpisodeCount} episodes. This runtime count comes from the current source AI analysis, never a title, stale record, or fixed algorithm.`)
    : '';
  const system = zh
    ? `你是影视剧本分集编辑。必须完整阅读提供的剧本，从开头一直读到最后一个字符，再动态确定实际总集数 N；N 只能由当前原文决定，可以是任意合理的正整数。禁止从项目标题、预填集数、字符数平均值或固定算法推断集数。
结构判定规则：
1. 若结构权威原文明确写有「第X集」「Episode X」「第X章」等连续边界，就以原文真实写出的完整序列为最高优先级。读到最后一个边界后才能确定 N；同一编号偶然重复不等于新增一集，也不得把一个已标记单元按字数再切碎。
2. 只有原文完全没有集/章边界时，才根据完整剧情的自然起承转合、悬念与场景转换由 AI 判断边界。目标语种 ${budget.languageCode} 的 ${budget.minSeconds}-${budget.maxSeconds} 秒时长（优先 ${budget.targetSeconds} 秒）仅作这种情况下的软参考，不是集数公式。
${hasDistinctStructureReference
  ? '3. 这是海外转风格稿：把「结构权威原文」识别出的每一集，按相同顺序和边界一一映射到「待拆分转风格稿」。结构看原文，输出 content 只能逐字取自转风格稿。'
  : '3. 当前只有一份「待拆分完整剧本」，它同时是结构依据和唯一可输出文本。'}
最重要约束：只切分，不删减、不增加、不改写。所有 content 按 episodeNumber 顺序拼接，必须与待拆分文本逐字完全相同；必须返回读到末尾后发现的全部集，不能因篇幅中止。episodeNumber 必须从 1 连续递增到 N，不重复、不跳号。标点（含英文撇号，是词内缩写字符不是引号闭合）逐字保留，不得美化/规范化引号或截断。
统一格式要求：每一集 content 的第一行必须是该集的标题行——若原文该集边界前已有「## 第N集」「第N集」「Episode N」「第N章」等标题，原样保留为第一行；若原文没有标题，必须自行在第一行添加「## 第N集」（N 为该集 episodeNumber）。标题行之后才是该集正文，正文仍须逐字取自待拆分文本。服务端会剥离标题行后校验内容无损，标题行不得包含或吞并任何正文字符。
只输出严格 JSON：{"episodes":[{"episodeNumber":1,"title":"第 1 集","content":"## 第1集\n待拆分文本的逐字切片","emotionArc":"起→承→钩子"}]}${aiCountContract}`
    : `You are a screenplay episode editor. Read every supplied script from the first character through the very last character before dynamically determining the real episode count N. N must come only from the current source and may be any justified positive integer. Never derive N from a project title, a prefilled count, equal character lengths, or a fixed algorithm.
Structure rules:
1. If the structural-authority source explicitly contains a complete sequence such as "Episode X", "Chapter X", or equivalent markers, that sequence is authoritative. Read through its last marker before deciding N. An accidentally repeated number is not a new episode, and an explicitly marked unit must not be subdivided by length.
2. Only when the source contains no explicit episode/chapter boundaries may AI choose boundaries from the complete story's dramatic turns, hooks, and scene changes. The ${budget.minSeconds}-${budget.maxSeconds} second duration for ${budget.languageCode} (prefer ${budget.targetSeconds}) is then a soft guide, never an episode-count formula.
${hasDistinctStructureReference
  ? '3. This is an overseas styled manuscript. Map every episode discovered in the STRUCTURAL AUTHORITY SOURCE, in order and at corresponding story boundaries, onto the STYLED MANUSCRIPT TO SPLIT. Use the source only for structure; every content value must be copied verbatim from the styled manuscript.'
  : '3. There is one COMPLETE MANUSCRIPT TO SPLIT; it is both the structural authority and the only text allowed in content.'}
Critical: split only; never delete, add, summarize, translate, or rewrite. Concatenating all content values in episodeNumber order must reproduce the target manuscript byte-for-byte. Return every episode found after reading to the end. episodeNumber must be consecutive from 1 through N, without duplicates or gaps.
Output strict JSON only: {"episodes":[{"episodeNumber":1,"title":"Episode 1","content":"verbatim target slice","emotionArc":"setup→progression→hook"}]}${aiCountContract}`;
  const user = hasDistinctStructureReference
    ? (zh
        ? `---结构权威原文开始---\n${sourceScriptText}\n---结构权威原文结束---\n\n---待拆分转风格稿开始---\n${novelText}\n---待拆分转风格稿结束---`
        : `---STRUCTURAL AUTHORITY SOURCE BEGINS---\n${sourceScriptText}\n---STRUCTURAL AUTHORITY SOURCE ENDS---\n\n---STYLED MANUSCRIPT TO SPLIT BEGINS---\n${novelText}\n---STYLED MANUSCRIPT TO SPLIT ENDS---`)
    : (zh
        ? `---待拆分完整剧本开始---\n${novelText}\n---待拆分完整剧本结束---`
        : `---COMPLETE MANUSCRIPT TO SPLIT BEGINS---\n${novelText}\n---COMPLETE MANUSCRIPT TO SPLIT ENDS---`);
  return { system, user };
}

function compactWhitespace(value: string): string {
  return value.replace(/\s/gu, '');
}

/** 字符是否为「字」（中英文字母 / 数字）。标点、引号、空白、符号均不算字。 */
const WORD_CHAR = /[a-zA-Z0-9一-鿿]/u;
/** 去除所有非字字符，只保留中英文字母与数字。用于判定 AI 是否只改了标点而未动字。 */
function wordOnly(value: string): string {
  return value.replace(/[^a-zA-Z0-9一-鿿]/gu, '');
}

/**
 * 显式集标题行（行首、独立成行）：`## 第N集` / `第N集` / `Episode N` / `第N章`，
 * `#` 前缀可选（兼容无 markdown 前缀的裸标题行），允许 `（大结局）` 等中文/英文
 * 后缀。标题位置是服务端可独立验证的客观边界，用它切分不依赖 AI 复述字数，
 * 从机制上消除逐集漂移。正文中若出现同名行（如角色台词恰好写「第3集」），
 * 由 findExplicitHeadingCuts 的「编号连续且不重复」校验兜底拒绝，不会误切。
 */
const EXPLICIT_HEADING_LINE_RE =
  /^(?:#{1,6}\s*)?(?:第\s*(\d+)\s*集|Episode\s*(\d+)|EP\s*(\d+)|第\s*(\d+)\s*章)\s*(?:[（(][^）)]*[）)])?\s*$/gimu;

/**
 * 扫描原文中的显式集标题行，返回「第 N 集标题行的起始位置」映射。
 * 仅当标题编号从 1 连续递增到 expectedCount 时返回，否则返回 null（交给其他切分策略）。
 */
function findExplicitHeadingCuts(
  novelText: string,
  expectedCount: number,
): number[] | null {
  const marks = new Map<number, number>();
  EXPLICIT_HEADING_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPLICIT_HEADING_LINE_RE.exec(novelText)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) continue;
    if (marks.has(n)) return null; // 同号标题重复出现，锚点不可信
    marks.set(n, match.index);
  }
  // 原文标题必须恰好是 1..expectedCount 完整序列——AI 返回的集数必须等于原文
  // 显式标题总数。若 AI 少拆（expectedCount < 标题数）或多拆，均不可用标题锚点，
  // 交回逐字/字数校验决定成败，防止「整本合一集」被锚点分支静默放行。
  if (marks.size !== expectedCount) return null;
  for (let n = 1; n <= expectedCount; n += 1) {
    if (!marks.has(n)) return null;
  }
  // cuts[0]=0：第1集从原文开头起（项目头/角色表等前置内容归第1集），
  // 第 N 集（N>=2）从标题N的起始位置起，最后到原文末尾。
  const cuts = [0];
  for (let n = 2; n <= expectedCount; n += 1) {
    const pos = marks.get(n);
    if (pos === undefined) return null;
    cuts.push(pos);
  }
  cuts.push(novelText.length);
  // 标题必须按原文顺序严格递增（连续序列的物理位置必然递增）
  for (let i = 1; i < cuts.length - 1; i += 1) {
    if (cuts[i] >= cuts[i + 1]) return null;
  }
  return cuts;
}

/**
 * 按原文显式标题锚点切分：第 N 集 = [标题N起点, 标题N+1起点)，标题行归属本集。
 * 拼接逐字恒等于原文（在原文上切），且每集开头必为标题行——边界由服务端
 * 直接验证，AI 复述字数不再参与，从机制上消除「每集粘连上集结尾」的漂移。
 */
function reconstructByExplicitHeadings(
  novelText: string,
  drafts: SplitEpisodeDraft[],
): SplitEpisodeDraft[] | null {
  const cuts = findExplicitHeadingCuts(novelText, drafts.length);
  if (!cuts) return null;
  const restored = drafts.map((draft, index) => ({
    ...draft,
    episodeNumber: index + 1,
    content: novelText.slice(cuts[index], cuts[index + 1]),
  }));
  if (restored.map((draft) => draft.content).join('') !== novelText) return null;
  if (!restored.every((draft) => draft.content.trim().length > 0)) return null;
  return restored;
}

/**
 * 无显式标题剧本的锚点串定位：取 AI 每集 content 开头的一段「非空白字符」，
 * 在原文中从上一集锚点之后顺序查找（indexOf）。只要 AI 每集开头几个字对得上
 * 原文，切点就精确——比按整集字数切稳一个数量级（字数统计任一集误差都会
 * 传导给后续所有切点，锚点串只依赖本集开头）。
 */
function reconstructByAnchorStrings(
  novelText: string,
  drafts: SplitEpisodeDraft[],
): SplitEpisodeDraft[] | null {
  const ANCHOR_LENGTH = 24;
  const cuts = [0];
  let searchFrom = 0;
  // 第 i+1 集的起点由「该集正文开头锚点串」在原文中定位（i 从 1 到 N-1）。
  for (let i = 1; i < drafts.length; i += 1) {
    const anchor = compactWhitespace(drafts[i].content).slice(0, ANCHOR_LENGTH);
    if (!anchor) return null;
    // 收集 searchFrom 起原文的非空白字符流与对应绝对索引
    const compactChars: Array<{ ch: string; idx: number }> = [];
    for (let p = searchFrom; p < novelText.length; p += 1) {
      if (!/\s/u.test(novelText[p])) compactChars.push({ ch: novelText[p], idx: p });
    }
    const compactStream = compactChars.map((c) => c.ch).join('');
    const found = compactStream.indexOf(anchor);
    if (found < 0) return null;
    const cutPos = compactChars[found].idx;
    if (cutPos <= cuts[cuts.length - 1]) return null;
    cuts.push(cutPos);
    searchFrom = cutPos + 1;
  }
  cuts.push(novelText.length);
  const restored = drafts.map((draft, index) => ({
    ...draft,
    episodeNumber: index + 1,
    content: novelText.slice(cuts[index], cuts[index + 1]),
  }));
  if (restored.map((draft) => draft.content).join('') !== novelText) return null;
  if (!restored.every((draft) => draft.content.trim().length > 0)) return null;
  return restored;
}

/**
 * AI 统一格式契约：content 第一行可能是「## 第N集」等标题行（prompt 强制）。
 * 标题行不属于正文——校验拼接与锚点定位前必须先剥离，否则拼接永远不等于原文。
 * 仅剥离「行首独立标题行」，绝不碰正文内的同名文本。
 */
const CONTENT_HEADING_PREFIX_RE =
  /^(?:#{1,6}\s*)?(?:第\s*(\d+)\s*集|Episode\s*(\d+)|EP\s*(\d+)|第\s*(\d+)\s*章)\s*(?:[（(][^）)]*[）)])?\s*\n?/u;

function stripContentHeading(draft: SplitEpisodeDraft): SplitEpisodeDraft {
  const stripped = draft.content.replace(CONTENT_HEADING_PREFIX_RE, '');
  if (stripped === draft.content) return draft;
  return { ...draft, content: stripped };
}

/** 剥离全部 content 的标题行（仅当标题行独立于正文时剥离，否则原样返回）。 */
function stripAllContentHeadings(drafts: SplitEpisodeDraft[]): SplitEpisodeDraft[] {
  return drafts.map(stripContentHeading);
}

/**
 * 按 AI 各集的「纯字长度」在冻结原文上重切，保留原文标点。
 *
 * 适用场景：AI 找的集边界正确，但逐字复现时对标点做了美化（典型——给中英混排
 * 剧本的英文台词自发包双引号）。此时纯字流逐字相等，但含标点的拼接不等，会被
 * 严格校验与 1.5% 容差误拒。本函数信任 AI 的边界（各集字数），在原文上按字位置
 * 切、标点跟随相邻字归集，拼接恒等于原文（与 reconstructWhitespaceOnlySplit 同源，
 * 只把计数基准从「非空白字符」收紧为「字字符」，从而吸收标点差异）。
 */
function reconstructByWordCount(
  novelText: string,
  drafts: SplitEpisodeDraft[],
): SplitEpisodeDraft[] {
  const targets = drafts.slice(0, -1).map((draft) => wordOnly(draft.content).length);
  const cuts = [0];
  let sourceIndex = 0;
  for (const targetCount of targets) {
    let seen = 0;
    while (sourceIndex < novelText.length && seen < targetCount) {
      if (WORD_CHAR.test(novelText[sourceIndex])) seen += 1;
      sourceIndex += 1;
    }
    cuts.push(sourceIndex);
  }
  cuts.push(novelText.length);
  return drafts.map((draft, index) => ({
    ...draft,
    episodeNumber: index + 1,
    content: novelText.slice(cuts[index], cuts[index + 1]),
  }));
}

function reconstructWhitespaceOnlySplit(
  novelText: string,
  drafts: SplitEpisodeDraft[],
): SplitEpisodeDraft[] {
  const targets = drafts.slice(0, -1).map((draft) => compactWhitespace(draft.content).length);
  const cuts = [0];
  let sourceIndex = 0;
  for (const targetCount of targets) {
    let seen = 0;
    while (sourceIndex < novelText.length && seen < targetCount) {
      if (!/\s/u.test(novelText[sourceIndex])) seen += 1;
      sourceIndex += 1;
    }
    cuts.push(sourceIndex);
  }
  cuts.push(novelText.length);
  return drafts.map((draft, index) => ({
    ...draft,
    episodeNumber: index + 1,
    content: novelText.slice(cuts[index], cuts[index + 1]),
  }));
}

interface ValidatedSplitAttempt {
  drafts?: SplitEpisodeDraft[];
  splitMode?: EpisodeSplitOutput['splitMode'];
  failureReason?: string;
}

/**
 * Validate an AI-selected boundary set without inventing any boundary in code.
 * Whitespace restoration is safe because each cut is reconstructed from the
 * number of non-whitespace characters on each side of the AI's own cuts.
 */
export function validateSplitAttempt(
  raw: string,
  novelText: string,
  requiredAiEpisodeCount?: number,
): ValidatedSplitAttempt {
  if (!raw.trim()) {
    return { failureReason: 'AI 没有返回可解析的分集内容' };
  }

  let parsedDrafts: SplitEpisodeDraft[];
  try {
    parsedDrafts = parseEpisodeSplitResponse(raw);
  } catch (error) {
    return {
      failureReason: error instanceof Error ? error.message : 'AI 分集 JSON 结构无效',
    };
  }

  // 统一格式契约：AI 的 content 第一行可能是「## 第N集」标题行（prompt 强制）。
  // 标题行不属于正文，剥离后再做拼接校验与锚点定位；最终落库仍以原文切片为准，
  // 因此原文有标题时每集 content 天然以标题行开头，原文无标题时则为纯正文。
  const drafts = stripAllContentHeadings(parsedDrafts);

  const sequential = drafts.every((draft, index) => draft.episodeNumber === index + 1);
  if (!sequential) {
    return { failureReason: 'episodeNumber 不是从 1 开始连续递增的完整序列' };
  }
  if (requiredAiEpisodeCount && drafts.length !== requiredAiEpisodeCount) {
    return {
      failureReason: `分集数与本次原文 AI 结构分析不一致：要求 ${requiredAiEpisodeCount} 集，实际 ${drafts.length} 集`,
    };
  }

  const joined = drafts.map((draft) => draft.content).join('');

  // 0) 显式标题锚点：原文含「## 第N集」等连续标题行时，标题位置是服务端可
  //    独立验证的客观边界，直接按锚点切分。AI 复述字数不再参与，从机制上
  //    消除「每集粘连上集结尾/开头残缺」的逐集漂移。此分支优先于一切
  //    AI-verbatim 与字数重构：拼接逐字恒等原文（在原文上切）。
  const headingRestored = reconstructByExplicitHeadings(novelText, drafts);
  if (headingRestored) {
    return { drafts: headingRestored, splitMode: 'ai-heading-anchored' };
  }

  if (joined === novelText) {
    return { drafts, splitMode: 'ai-verbatim' };
  }

  const compactJoined = compactWhitespace(joined);
  const compactSource = compactWhitespace(novelText);

  // 1) 仅空白差异：紧凑后完全相等，按各集非空白字符数从原文重切。
  if (compactJoined === compactSource) {
    // 优先用「各集开头锚点串」定位（只依赖本集开头几个字，比整集字数稳）：
    const anchored = reconstructByAnchorStrings(novelText, drafts);
    if (anchored) return { drafts: anchored, splitMode: 'ai-whitespace-repaired' };
    const restored = reconstructWhitespaceOnlySplit(novelText, drafts);
    if (restored.map((draft) => draft.content).join('') === novelText) {
      return { drafts: restored, splitMode: 'ai-whitespace-repaired' };
    }
  }

  // 2) 标点无关对齐（字流，95%-105%）：AI 只动了标点/引号/空白，或仅极少量字。
  //    去所有非字字符后比较「字流」——字流完全相等（ratio=1.0）时切点精确无损；
  //    字流比例在 95%-105%（AI 个别字增删）时按字切，拼接仍逐字恒等原文（在原文
  //    上切），仅边界处轻微偏移。前者覆盖「AI 给英文台词包引号」这类标点美化
  //    （诊断实证：16 万字稿 AI 加 2422 个双引号、字一字未改，却因含标点拼接
  //    101.5% 被原 1.5% 容差误拒）；后者作兜底，让长稿不因 AI 少量改字直接卡死。
  //    硬守卫：拼接逐字==原文 + 每集非空（防字数偏差过大时某集被切空）。
  if (drafts.length > 1) {
    const wordJoined = wordOnly(joined);
    const wordSource = wordOnly(novelText);
    if (wordSource.length > 0) {
      const wordRatio = wordJoined.length / wordSource.length;
      if (wordRatio >= 0.95 && wordRatio <= 1.05) {
        const restored = reconstructByWordCount(novelText, drafts);
        if (restored.map((draft) => draft.content).join('') === novelText
          && restored.every((draft) => draft.content.trim().length > 0)) {
          return { drafts: restored, splitMode: 'ai-whitespace-repaired' };
        }
      }
    }
  }

  // 3) 近无损容错：AI 几乎逐字切分，但丢/改了少量标点或个别字（紧凑长度比
  //    98.5%~101.5%）。AI 擅长找边界但不擅长逐字复现，因此仍按其各集非空白
  //    字符数在「冻结原文」上重切——拼接恒等于原文（始终无损），仅边界可能
  //    出现轻微位移。重构后任一集为空则视为不可接受，回退到失败。
  if (drafts.length > 1 && compactSource.length > 0) {
    const compactRatio = compactJoined.length / compactSource.length;
    if (compactRatio >= 0.985 && compactRatio <= 1.015) {
      const restored = reconstructWhitespaceOnlySplit(novelText, drafts);
      if (restored.every((draft) => draft.content.trim().length > 0)) {
        return { drafts: restored, splitMode: 'ai-whitespace-repaired' };
      }
    }
  }

  const rawCoverage = novelText.length > 0 ? joined.length / novelText.length : 1;
  return {
    failureReason: `无损覆盖失败：content 拼接字符比为 ${(rawCoverage * 100).toFixed(1)}%，并非待拆分文本的逐字切片`,
  };
}

interface ValidatedWholeSeriesStyleAttempt {
  drafts?: SplitEpisodeDraft[];
  styledNovelText?: string;
  characterAliasMap?: Map<string, string>;
  splitMode?: EpisodeSplitOutput['splitMode'];
  failureReason?: string;
}





/**
 * Validate compact AI-selected anchors, then slice only the frozen source.
 * Explicit headings are an exact server-side boundary oracle; unmarked prose
 * remains dynamically segmented by AI and is never split by length in code.
 */
function validateWholeSeriesStyleAttempt(
  raw: string,
): ValidatedWholeSeriesStyleAttempt {
  if (!raw.trim()) return { failureReason: 'AI 没有返回整剧转风格与分集内容' };

  let parsed: ReturnType<typeof parseWholeSeriesStyleSplitResponse>;
  try {
    parsed = parseWholeSeriesStyleSplitResponse(raw);
  } catch (error) {
    return {
      failureReason: error instanceof Error ? error.message : '整剧转风格 JSON 结构无效',
    };
  }

  const sequential = parsed.episodes.every(
    (episode, index) => episode.episodeNumber === index + 1,
  );
  if (!sequential) {
    return { failureReason: 'episodeNumber 不是按输出顺序从 1 连续递增的完整序列' };
  }
  if (!Number.isInteger(parsed.detectedEpisodeCount)
    || parsed.detectedEpisodeCount !== parsed.episodes.length) {
    return { failureReason: 'detectedEpisodeCount 必须与 episodes 数组长度完全一致' };
  }

  const styledDrafts = parsed.episodes.map((episode): SplitEpisodeDraft => ({
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    content: episode.content,
    ...(episode.emotionArc ? { emotionArc: episode.emotionArc } : {}),
  }));
  // 注入 === EP{n} === 集标记：整剧资产提取需要按集标注变体出场（coverage_episodes），
  // AI 依此标记输出集号。标记随 styledNovelText 持久化进 project.novelText，并被 ai-worker
  // 直接用作整剧提取输入；格式与单集聚合 route（asset-extraction）一致。
  const styledNovelText = styledDrafts
    .map((episode) => {
      const titleSuffix = episode.title ? ` ${episode.title}` : '';
      return `=== EP${episode.episodeNumber}${titleSuffix} ===\n${episode.content}`;
    })
    .join('\n\n');
  if (!styledNovelText.trim()) return { failureReason: '整剧转风格正文为空' };

  return {
    drafts: styledDrafts,
    styledNovelText,
    characterAliasMap: parsed.characterAliasMap,
    splitMode: 'ai-verbatim',
  };
}

/** 在一个短事务内备份旧分集并替换为新分集，避免半删半建。 */
async function replaceEpisodes(
  q: QueryFn,
  projectId: string,
  drafts: SplitEpisodeDraft[],
  sourceScriptHash?: string,
  queuedScriptText?: string,
  projectCommit?: EpisodeSplitProjectCommit,
): Promise<string[]> {
  // Lock the target project before checking the queued manuscript revision. The
  // check and all writes then happen in one transaction, so a stale worker can
  // never pass validation and delete newer episodes afterwards.
  const projectResult = await q.query(
    `SELECT "scriptData", "novelText", "sourceProjectId"
       FROM projects WHERE id = $1 FOR UPDATE`,
    [projectId],
  );
  const projectRow = projectResult.rows[0] as {
    scriptData?: unknown;
    novelText?: string | null;
    sourceProjectId?: string | null;
  } | undefined;
  if (!projectRow) throw new Error('项目不存在，无法写入拆集结果');

  if (projectRow.sourceProjectId && !sourceScriptHash) {
    throw new StaleProjectScriptError('调用原创整剧的拆集任务缺少冻结原稿哈希，已拒绝写入');
  }

  if (sourceScriptHash) {
    const currentScriptText = resolveProjectSourceScriptText(projectRow);
    const queuedHash = hashProjectScript(queuedScriptText ?? '');
    const currentHash = currentScriptText ? hashProjectScript(currentScriptText) : '';
    if (queuedHash !== sourceScriptHash || currentHash !== sourceScriptHash) {
      throw new StaleProjectScriptError();
    }
  }

  // Lock every episode that is about to be replaced. A concurrent shot insert
  // takes a foreign-key key-share lock on its episode, so this closes the gap
  // between the downstream count and DELETE instead of relying on a UI check.
  const oldResult = await q.query(
    `SELECT "episodeNumber", title, "novelText" FROM episodes
      WHERE "projectId" = $1 ORDER BY "episodeNumber" ASC FOR UPDATE`,
    [projectId],
  );

  // Replacing episodes cascades into shots/materials. Check after locking both
  // the project and old episode rows so concurrent production cannot slip in.
  const downstreamResult = await q.query(
    `SELECT
       (SELECT COUNT(*)::int FROM shots WHERE "projectId" = $1) AS shots,
       (SELECT COUNT(*)::int FROM materials WHERE "projectId" = $1) AS materials,
       (SELECT COUNT(*)::int FROM storyboards WHERE "projectId" = $1) AS storyboards`,
    [projectId],
  );
  const downstream = downstreamResult.rows[0] as {
    shots?: number;
    materials?: number;
    storyboards?: number;
  } | undefined;
  const shotCount = Number(downstream?.shots ?? 0);
  const materialCount = Number(downstream?.materials ?? 0);
  const storyboardCount = Number(downstream?.storyboards ?? 0);
  if (shotCount > 0 || materialCount > 0 || storyboardCount > 0) {
    throw new Error(
      `项目已有下游作品（镜头 ${shotCount}、素材 ${materialCount}、故事板 ${storyboardCount}），为防止级联删除已拒绝重新拆集`,
    );
  }

  const previousEpisodes = oldResult.rows.length > 0
    ? oldResult.rows.map((rawRow) => {
      const row = rawRow as { episodeNumber: number; title: string | null; novelText: string | null };
      return ({
        n: row.episodeNumber,
        t: row.title,
        c: row.novelText,
      });
    })
    : undefined;

  await q.query('DELETE FROM episodes WHERE "projectId" = $1', [projectId]);
  const episodeIds: string[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const id = genId();
    await q.query(
      `INSERT INTO episodes
        (id, "projectId", "episodeNumber", "sortOrder", title, "novelText", content,
         "contentKilo", "emotionArc", status, "stageStatus", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, 'PENDING', 'input', NOW(), NOW())`,
      [id, projectId, index + 1, index, draft.title, draft.content,
        Math.ceil(draft.content.length / 1000), draft.emotionArc ?? null],
    );
    episodeIds.push(id);
  }

  if (previousEpisodes || projectCommit) {
    const scriptData = readScriptData(projectRow.scriptData);
    const mergedScriptData = {
      ...scriptData,
      ...(projectCommit?.scriptData ?? {}),
      ...(previousEpisodes ? { previousEpisodes } : {}),
    };
    const hasNovelTextPatch = projectCommit
      ? Object.prototype.hasOwnProperty.call(projectCommit, 'novelText')
      : false;
    const novelText = hasNovelTextPatch
      ? projectCommit?.novelText ?? null
      : projectRow.novelText ?? null;
    await q.query(
      `UPDATE projects
          SET "scriptData" = $1::jsonb, "novelText" = $2, "updatedAt" = NOW()
        WHERE id = $3`,
      [JSON.stringify(mergedScriptData), novelText, projectId],
    );
  }
  return episodeIds;
}

interface ValidatedAiSplitInput {
  novelText: string;
  userId: string;
  modelId?: string;
  localizationProfile?: LocalizationProfile;
  sourceScriptText?: string;
  /** Dynamic count returned by a prior AI pass over this same frozen source. */
  requiredAiEpisodeCount?: number;
}

async function requestValidatedAiSplit(
  input: ValidatedAiSplitInput,
): Promise<EpisodeStructureAnalysis> {
  const sourceScriptText = input.sourceScriptText ?? input.novelText;
  const modelId = input.modelId || 'deepseek/deepseek-v4-flash';
  const slash = modelId.indexOf('/');
  const provider = slash > 0 ? modelId.slice(0, slash) : 'deepseek';
  const model = slash > 0 ? modelId.slice(slash + 1) : modelId;
  const prompt = buildEpisodeSplitPrompt(
    input.novelText,
    input.localizationProfile,
    sourceScriptText,
    input.requiredAiEpisodeCount,
  );
  const runAttempt = async (correctionReason?: string) => {
    const correction = correctionReason
      ? `\n\n纠错重试 / CORRECTION RETRY：上一次结果未通过服务端校验，原因：${correctionReason}。请重新从头读到最后，重新判断真实集数与剧情边界；不要沿用错误输出。最终 content 仍须逐字无损覆盖待拆分文本。`
      : '';
    const result = await callAI(provider, model, {
      capability: 'text_generation',
      userId: input.userId,
      input: {
        messages: [
          { role: 'system', content: `${prompt.system}${correction}` },
          { role: 'user', content: prompt.user },
        ],
        temperature: correctionReason ? 0.1 : 0.3,
        maxTokens: 393216,
        contextWindow: 1_048_576,
      },
    });
    const meta = result.meta as Record<string, unknown> | undefined;
    return {
      content: typeof meta?.content === 'string' ? meta.content : '',
      cost: typeof result.cost === 'number' ? result.cost : 0,
    };
  };

  const firstResult = await runAttempt();
  let totalCost = firstResult.cost;
  let validation = validateSplitAttempt(
    firstResult.content,
    input.novelText,
    input.requiredAiEpisodeCount,
  );
  if (!validation.drafts || !validation.splitMode) {
    const retryResult = await runAttempt(validation.failureReason ?? '分集结构不合格');
    totalCost += retryResult.cost;
    validation = validateSplitAttempt(
      retryResult.content,
      input.novelText,
      input.requiredAiEpisodeCount,
    );
    if (!validation.drafts || !validation.splitMode) {
      throw new Error(
        `两次 AI 分集均未通过校验，已拒绝写入并保留原分集：${validation.failureReason ?? '未知校验错误'}`,
      );
    }
  }

  const drafts = validation.drafts;
  const splitMode = validation.splitMode;
  const verified = drafts.map((draft) => draft.content).join('');
  if (verified !== input.novelText) {
    throw new Error('分集完整性校验失败，已拒绝写入');
  }
  return {
    drafts,
    episodeCount: drafts.length,
    splitMode,
    cost: totalCost,
  };
}

/**
 * AI 无损通读冻结原文并动态识别结构，不写数据库。
 * 海外整剧先执行此步骤，后续转风格与最终拆集都受本次 AI 计划约束。
 */
export async function analyzeScriptEpisodeStructure(input: {
  novelText: string;
  userId: string;
  modelId?: string;
  localizationProfile?: LocalizationProfile;
}): Promise<EpisodeStructureAnalysis> {
  return requestValidatedAiSplit({
    ...input,
    sourceScriptText: input.novelText,
  });
}

/**
 * One-pass overseas ORIGINAL_PROJECT path. A single streaming model call reads
 * the complete source, decides the semantic units, and returns styled episodes
 * as JSON. The styled manuscript and episode rows commit together.
 */
export async function styleAndSplitOriginalSeries(input: {
  projectId: string;
  sourceScriptText: string;
  sourceScriptHash?: string;
  stylePrompt: string;
  userId: string;
  modelId?: string;
  localizationProfile?: LocalizationProfile;
  projectCommit?: Pick<EpisodeSplitProjectCommit, 'scriptData'>;
}): Promise<WholeSeriesStyleSplitOutput> {
  if (input.sourceScriptHash
    && hashProjectScript(input.sourceScriptText) !== input.sourceScriptHash) {
    throw new StaleProjectScriptError('整剧转风格任务稿件与入队哈希不一致，已拒绝执行');
  }

  const modelId = input.modelId || 'deepseek/deepseek-v4-flash';
  const slash = modelId.indexOf('/');
  const provider = slash > 0 ? modelId.slice(0, slash) : 'deepseek';
  const model = slash > 0 ? modelId.slice(slash + 1) : modelId;
  const prompt = buildWholeSeriesTextStylePrompt(
    input.sourceScriptText,
    input.stylePrompt,
    undefined,
    undefined,
    'episode-json',
  );
  const runAttempt = async (correctionReason?: string) => {
    const correction = correctionReason
      ? `\n\n纠错重试 / CORRECTION RETRY：上一次单次整剧结果未通过服务端最低格式校验，原因：${correctionReason}。请重新从原文第一个字符读到最后一个字符，由原文语义重新确定真实集数和边界，并输出约定 JSON。不要复抄原文，不要返回锚点或偏移。`
      : '';
    const result = await callAI(provider, model, {
      capability: 'text_generation',
      userId: input.userId,
      input: {
        messages: [
          { role: 'system', content: `${prompt.system}${correction}` },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.2,
        maxTokens: 393216,
        contextWindow: 1_048_576,
      },
    });
    const meta = result.meta as Record<string, unknown> | undefined;
    return {
      content: typeof meta?.content === 'string' ? meta.content : '',
      cost: typeof result.cost === 'number' ? result.cost : 0,
    };
  };

  const firstResult = await runAttempt();
  let totalCost = firstResult.cost;
  let validation = validateWholeSeriesStyleAttempt(firstResult.content);
  if (!validation.drafts || !validation.styledNovelText || !validation.splitMode) {
    console.warn('[episode-split] one-pass validation failed', {
      projectId: input.projectId,
      attempt: 1,
      reason: validation.failureReason ?? '整剧 JSON 最低格式校验失败',
    });
    const retryResult = await runAttempt(validation.failureReason ?? '整剧结构或正文不合格');
    totalCost += retryResult.cost;
    validation = validateWholeSeriesStyleAttempt(retryResult.content);
    if (!validation.drafts || !validation.styledNovelText || !validation.splitMode) {
      console.warn('[episode-split] one-pass validation failed', {
        projectId: input.projectId,
        attempt: 2,
        reason: validation.failureReason ?? '整剧 JSON 最低格式校验失败',
      });
      throw new Error(
        `两次 AI 整剧转风格与动态分集均未通过校验，已拒绝写入并保留原分集：${validation.failureReason ?? '未知校验错误'}`,
      );
    }
  }

  const episodeIds = await tx((q) => replaceEpisodes(
    q,
    input.projectId,
    validation.drafts!,
    input.sourceScriptHash,
    input.sourceScriptText,
    {
      ...(input.projectCommit ?? {}),
      novelText: validation.styledNovelText!,
    },
  ));
  return {
    episodeIds,
    episodeCount: episodeIds.length,
    coverage: 1,
    splitMode: validation.splitMode,
    cost: totalCost,
    styledNovelText: validation.styledNovelText,
    characterAliasMap: validation.characterAliasMap ?? new Map(),
  };
}

/** 调 LLM 拆集并原子落库；明显残缺的结果会返回给 UI 明示，而不是静默冒充完整。 */
export async function splitScriptIntoEpisodes(input: {
  projectId: string;
  novelText: string;
  userId: string;
  modelId?: string;
  localizationProfile?: LocalizationProfile;
  /** Frozen source hash is mandatory for every linked-original target. */
  sourceScriptHash?: string;
  /** Original target-project snapshot; differs from novelText after overseas styling. */
  sourceScriptText?: string;
  /** Persisted atomically with the replacement episode set. */
  projectCommit?: EpisodeSplitProjectCommit;
  /** Dynamic count returned by analyzeScriptEpisodeStructure for this source. */
  requiredAiEpisodeCount?: number;
}): Promise<EpisodeSplitOutput> {
  const sourceScriptText = input.sourceScriptText ?? input.novelText;
  if (input.sourceScriptHash && hashProjectScript(sourceScriptText) !== input.sourceScriptHash) {
    throw new StaleProjectScriptError('拆集任务稿件与入队哈希不一致，已拒绝执行');
  }
  const analysis = await requestValidatedAiSplit({
    novelText: input.novelText,
    userId: input.userId,
    modelId: input.modelId,
    localizationProfile: input.localizationProfile,
    sourceScriptText,
    requiredAiEpisodeCount: input.requiredAiEpisodeCount,
  });
  const coverage = 1;
  const episodeIds = await tx((q) => replaceEpisodes(
    q,
    input.projectId,
    analysis.drafts,
    input.sourceScriptHash,
    sourceScriptText,
    input.projectCommit,
  ));
  return {
    episodeIds,
    episodeCount: episodeIds.length,
    coverage,
    splitMode: analysis.splitMode,
    cost: analysis.cost,
  };
}
