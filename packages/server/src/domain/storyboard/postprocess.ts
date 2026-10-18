import { extractDialoguesFromContent, stripDialogueTags } from '../prompt';
import { verifyDialogueCompleteness } from './dialogue-completeness';
import { auditLanguageScript, type LanguageScriptAudit } from '@shared/language';
import type { StoryboardAssetRef, StoryboardAssetVariant, StoryboardScene } from './prompt';
import type { ParsedStoryboardShot } from './parse';
import { isDegenerateVisualPrompt } from './degenerate';

/** 单场景对白覆盖结果。覆盖不足不会静默丢失，而会随路由响应返回给 UI。 */
export interface DialogueCoverageResult {
  sceneId: string;
  total: number;
  covered: number;
  missing: Array<{ character: string; line: string }>;
}

export interface StoryboardPostprocessResult {
  shots: ParsedStoryboardShot[];
  dialogueCoverage: DialogueCoverageResult[];
  languageAudit: Array<LanguageScriptAudit & { shotIndex: number }>;
  warnings: string[];
}

// 组标签：2026-08-12 ARK 平台实测「高潮组」为涉黄敏感词组（InputTextSensitive
// ContentDetected），改「高潮段落」保留剧情语义（与 group-preview 对齐）。
const GROUP_LABELS = ['建场组', '推进组', '高潮段落', '收束组', '过渡组', '尾声组'];
const PUNCTUATION = /[\s“”‘’。，,.!?！？：:；;、…—\-]/g;
const TIMECODE_LINES = /\[\d{2}:\d{2}(?:\.\d+)?-\d{2}:\d{2}(?:\.\d+)?\][^\n\r]*/g;
const TIMECODE_VALUE = /\[(\d{2}:\d{2}(?:\.\d+)?)-(\d{2}:\d{2}(?:\.\d+)?)\]/;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(PUNCTUATION, '');
}

function parseTimecode(value: string): number {
  const [minutes, seconds] = value.split(':').map(Number);
  return Number.isFinite(minutes) && Number.isFinite(seconds) ? minutes * 60 + seconds : 0;
}

/** app1 允许模型误把多个时间码写进一个镜头；这里拆成独立镜头并重新编号。 */
export function splitMultiTimecodeShots(shots: ParsedStoryboardShot[]): ParsedStoryboardShot[] {
  const result: ParsedStoryboardShot[] = [];
  for (const shot of shots) {
    const lines = shot.visualPrompt.match(TIMECODE_LINES);
    if (!lines || lines.length <= 1) {
      result.push({ ...shot });
      continue;
    }
    for (const line of lines) {
      const timecode = line.match(TIMECODE_VALUE);
      const duration = timecode
        ? Math.min(15, Math.max(0.1, parseTimecode(timecode[2]) - parseTimecode(timecode[1])))
        : shot.durationSeconds;
      result.push({ ...shot, visualPrompt: line.trim(), durationSeconds: duration });
    }
  }
  return result.map((shot, index) => ({ ...shot, shotIndex: index + 1 }));
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

interface AssetNameCandidate {
  canonicalName: string;
  value: string;
}

function buildAssetNameCandidates(assets: StoryboardAssetRef[]): AssetNameCandidate[] {
  const result: AssetNameCandidate[] = [];
  for (const asset of assets) {
    const seen = new Set<string>();
    const values = [
      asset.name,
      ...(Array.isArray(asset.sourceNames) ? asset.sourceNames : []),
    ];
    for (const raw of values) {
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      const key = normalizeText(value);
      if (!value || !key || seen.has(key)) continue;
      seen.add(key);
      result.push({ canonicalName: asset.name, value });
    }
  }
  return result;
}

/**
 * 把大小写、原文别名、包含关系或两字符以内的模型拼写偏差归一到展示名。
 * 别名只是查找键，返回值始终是 canonicalName，因此中英两种引用不会生成两份资产。
 */
function normalizeAssetList(
  values: string[],
  validAssets: StoryboardAssetRef[],
  warnings: string[],
  label: string,
): string[] {
  const candidates = buildAssetNameCandidates(validAssets);
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const normalizedValue = normalizeText(value);
    const exact = candidates.find((candidate) => candidate.value === value);
    const caseMatch = candidates.find(
      (candidate) => candidate.value.toLocaleLowerCase() === value.toLocaleLowerCase(),
    );
    const punctuationMatch = candidates.find(
      (candidate) => normalizeText(candidate.value) === normalizedValue,
    );
    // contains 是子串匹配，双向。短名（如 Quinn）会先命中 long 名（如 Quinn's Sister），
    // 但 next candidate 可能才是真正的短名。用最长匹配优先消歧：多个候选同时含子串关系时
    // 取长度最接近的那个，降低 Quinn→Quinn's Sister 式串角。
    const allContains = candidates.filter((candidate) => {
      const normalizedCandidate = normalizeText(candidate.value);
      return normalizedCandidate.includes(normalizedValue) || normalizedValue.includes(normalizedCandidate);
    });
    const bestContains = allContains.sort((a, b) =>
      Math.abs(normalizeText(a.value).length - normalizedValue.length)
      - Math.abs(normalizeText(b.value).length - normalizedValue.length),
    )[0];
    const fuzzy = candidates.find((candidate) => {
      const normalizedCandidate = normalizeText(candidate.value);
      return Math.max(normalizedCandidate.length, normalizedValue.length) >= 2
        && levenshtein(normalizedCandidate, normalizedValue) <= 2;
    });
    const canonicalName = (exact ?? caseMatch ?? punctuationMatch ?? bestContains ?? fuzzy)?.canonicalName;
    if (!canonicalName) {
      warnings.push(`${label}引用了未定义资产"${value}"`);
      continue;
    }
    if (!result.includes(canonicalName)) result.push(canonicalName);
  }
  return result;
}

function deriveAudioType(shot: ParsedStoryboardShot): string {
  if (shot.dialogue || shot.speakingCharacters.length > 0) return '对白';
  const cue = shot.soundCue ?? '';
  if (/动作|脚步|碰撞|开门/.test(cue)) return '动作音效';
  if (/特效|爆炸|魔法|电流/.test(cue)) return '特效音效';
  return '环境音';
}

function deriveEmotionArc(index: number, total: number): string {
  const ratio = (index + 1) / Math.max(1, total);
  if (ratio < 0.2) return '建场';
  if (ratio < 0.6) return '推进';
  if (ratio < 0.8) return '高潮';
  return '回落';
}

function verifyDialogueCoverage(scene: StoryboardScene, shots: ParsedStoryboardShot[]): DialogueCoverageResult {
  const dialogues = extractDialoguesFromContent(scene.content);
  const haystack = normalizeText(shots.map((shot) => [shot.dialogue, shot.soundCue, shot.visualPrompt].filter(Boolean).join('\n')).join('\n'));
  const missing = dialogues
    .filter((dialogue) => !isLineCovered(normalizeText(dialogue.lines), haystack))
    .map((dialogue) => ({ character: dialogue.character, line: dialogue.lines }));
  return { sceneId: scene.id, total: dialogues.length, covered: dialogues.length - missing.length, missing };
}

/**
 * 台词覆盖判定：逐字命中即算覆盖；长台词按 token 覆盖率容忍个别词/资产名被
 * 替换为代词（如把「食人花盆栽」说成 ours），避免把"实际已配音、仅措辞微调"
 * 的台词误报为漏台词。短台词（<12 字符或 <4 token）仍要求逐字命中。
 */
function isLineCovered(normalizedLine: string, haystack: string): boolean {
  if (haystack.includes(normalizedLine)) return true;
  if (normalizedLine.length < 12) return false;
  const tokens = normalizedLine.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g);
  if (!tokens || tokens.length < 4) return haystack.includes(normalizedLine);
  const hit = tokens.filter((token) => haystack.includes(token)).length;
  return hit / tokens.length >= 0.75;
}

/**
 * 角色引用守卫：LLM 的结构化 characters 字段不可靠（会把角色 A 整集错标成 B），
 * 但 visualPrompt 自由文本可靠。当某镜头引用了角色 X，而 X 的名字/别名从未出现
 * 在该镜头的 visualPrompt 里、但提示词里明确出现了另一个角色 Y 时，把 X 校正为 Y
 * 并记 warning。characters 校正画面内全部引用；speakingCharacters 仅校正已知人类
 * 角色名（保留非人发声实体）。
 *
 * 关键约束（8/11 修复）：**画面引用（characters）只认 visualPrompt 里出现的角色**。
 * dialogue/soundCue 里提到的名字只用于说话角色判定——台词提及 ≠ 登场，角色没出镜
 * 就不能绑参考图，否则生成时会把「台词里提到、并未登场」的角色画进画面。
 */
function reconcileCharactersWithPrompt(
  shot: ParsedStoryboardShot,
  validCharacters: StoryboardAssetRef[],
  warnings: string[],
): void {
  // 同时扫描 visualPrompt / dialogue / soundCue：角色名可能只出现在台词标签里
  // （如 "Headmaster: Welcome..."）或声效里（如 soundCue 'Alice："Hello"｜脚步声'），
  // 而不在画面描述中。漏扫 soundCue 会让说话角色被判孤儿清除→audioType 误判。
  const visualText = shot.visualPrompt ?? '';
  const dialogueText = `${shot.dialogue ?? ''}\n${shot.soundCue ?? ''}`;
  const promptText = `${visualText}\n${dialogueText}`;
  if (!promptText.trim() || validCharacters.length === 0) return;
  // visualNamed：画面里实际登场的角色（决定 characters 引用与补全）。
  // dialogueNamed：台词/声效里提到的角色（只用于说话角色判定，不代表登场）。
  const visualNamed = new Set<string>();
  const dialogueNamed = new Set<string>();
  for (const candidate of validCharacters) {
    const names = [candidate.name, ...(Array.isArray(candidate.sourceNames) ? candidate.sourceNames : [])]
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
    if (names.some((name) => visualText.includes(name))) visualNamed.add(candidate.name);
    if (names.some((name) => dialogueText.includes(name))) dialogueNamed.add(candidate.name);
  }
  const promptNamed = new Set([...visualNamed, ...dialogueNamed]);
  if (promptNamed.size === 0) {
    // 既不在画面也不在台词中出现，但 speakingCharacters 非空时，
    // 清除无台词的 speakingCharacters（标记说话但没台词=孤儿标记）
    if (shot.speakingCharacters.length > 0 && !shot.dialogue?.trim()) {
      warnings.push(`镜头角色守卫：speakingCharacters 标记有说话但无台词文本，已清除孤儿标记：${shot.speakingCharacters.join('、')}`);
      shot.speakingCharacters = [];
    }
    return;
  }
  const characterNames = new Set(validCharacters.map((candidate) => candidate.name));
  // 校正引用：characters 只认画面角色（visualNamed）；speakingCharacters 认台词/画面（promptNamed）。
  const fix = (list: string[], charOnly: boolean, named: Set<string>): string[] => {
    if (list.length === 0) return list;
    const result: string[] = [];
    let changed = false;
    for (const ref of list) {
      if (named.has(ref)) { result.push(ref); continue; }
      // 8/11 修复：ref 只出现在台词/声效里（dialogueNamed 命中）而未出镜 → 明确是
      // 「台词提及≠登场」的误引用，直接移除，不得保留（此前保留会让未登场角色绑参考图）。
      // 仅对画面引用（characters）生效：speakingCharacters 的 named 已含 dialogueNamed，
      // 说话角色在台词里命中会先走 named.has 分支保留，不会落到这里。
      if (dialogueNamed.has(ref)) {
        changed = true;
        warnings.push(`镜头角色守卫：引用「${ref}」仅出现在台词中未登场，已从画面引用移除`);
        continue;
      }
      const reconcilable = charOnly ? characterNames.has(ref) : true;
      if (!reconcilable) { result.push(ref); continue; }
      const replacement = [...named].find((name) => !list.includes(name) && !result.includes(name));
      if (replacement) {
        result.push(replacement);
        changed = true;
        warnings.push(`镜头角色守卫：引用「${ref}」未出现在画面提示词，已按提示词校正为「${replacement}」`);
      } else {
        result.push(ref); // 无可顶替者，保留原引用，避免误删
      }
    }
    return changed ? Array.from(new Set(result)) : list;
  };
  shot.characters = fix(shot.characters, false, visualNamed);
  shot.speakingCharacters = fix(shot.speakingCharacters, true, promptNamed);

  // 补全：visualPrompt 明确点名了多个角色，但 LLM 的 characters 字段只列了一部分。
  // 这是穿帮的根源——画面里出现的角色没有关联到资产，生成时要么无脸、要么用了错误角色。
  // 按 **画面**（visualNamed）出现的角色名补入 characters（已在 ref 中的不重复加）。
  // 台词里提到的角色绝不补入——台词提及 ≠ 登场，8/11 修复（此前 dialogue 命中也被补入，
  // 导致"台词提到但没登场"的角色被绑参考图，生成时乱入画面）。
  // 限人类角色、限已有资产名。节流：单镜头最多补入 4 个，避免群像 shot 把所有角色都灌进去。
  const known = new Set(shot.characters);
  const additions = [...visualNamed]
    .filter((name) => !known.has(name))
    .slice(0, 4);
  if (additions.length > 0) {
    shot.characters = [...shot.characters, ...additions];
    warnings.push(`镜头角色守卫：画面提示词中出现的角色未引用，已补入：${additions.join('、')}`);
  }
}

/**
 * 高精度变体状态推理：当镜头引用了多态资产却用了 default，检查本镜文本是否
 * 出现某非默认变体的状态线索，命中且唯一则改写 costumeKey + warning。
 *
 * 背景：分镜 prompt 已明确要求"非默认状态必须输出对应 key，不得一律 default"，
 * 但实测 AI 几乎一律写 default（54 个变体里 53 个从未被引用），导致状态穿帮
 * （如"云合并"镜头仍用单云 default 图）。本推理是对 AI 不可靠的确定性兜底，
 * 对标已有的 reconcileCharactersWithPrompt（角色推理）与台词自动补全。
 *
 * 精度策略（宁可漏判留待人工，不可误判制造新穿帮）：
 *  - 仅对本镜已引用（normCostumeRefs 归一后保留）的多态资产查
 *  - 触发词权重：label 全词=3、去尾部通用词(形态/模式/状态/失效/释放)的 label=2、
 *    description(3~24 字)=2、key 中 ≥4 字符且非通用词=1
 *  - 通用词不单独作为触发（night/wand/dark/black/form/dusk/arena/stored 单凭一词
 *    不足以判定状态，会误触发——如"夜"出现在每个夜景镜头）
 *  - 命中权重最高且唯一（无并列）才改写；并列则跳过（避免歧义误判）
 */
const VARIANT_KEY_STOP = new Set([
  'default', 'form', 'dark', 'black', 'night', 'wand', 'stored', 'arena', 'dusk',
]);
const VARIANT_LABEL_TAIL_STRIP = /(?:形态|模式|状态|失效|释放|形態)$/;

interface VariantCandidate {
  key: string;
  triggers: Array<{ text: string; weight: number }>;
}

function buildVariantCandidates(variants: StoryboardAssetVariant[] | null | undefined): VariantCandidate[] {
  if (!Array.isArray(variants) || variants.length < 2) return [];
  const candidates: VariantCandidate[] = [];
  for (const v of variants) {
    if (!v || typeof v.key !== 'string') continue;
    const key = v.key.trim();
    if (!key || key === 'default') continue;
    const triggers: Array<{ text: string; weight: number }> = [];
    const labelStr = typeof v.label === 'string' ? v.label.trim() : '';
    if (labelStr) {
      triggers.push({ text: labelStr.toLowerCase(), weight: 3 });
      const stripped = labelStr.replace(VARIANT_LABEL_TAIL_STRIP, '').trim();
      if (stripped && stripped.length >= 2 && stripped !== labelStr) {
        triggers.push({ text: stripped.toLowerCase(), weight: 2 });
      }
    }
    const descStr = typeof v.description === 'string' ? v.description.trim() : '';
    if (descStr.length >= 3 && descStr.length <= 24) {
      triggers.push({ text: descStr.toLowerCase(), weight: 2 });
    }
    for (const part of key.toLowerCase().split(/[^a-z0-9]+/i)) {
      if (part.length >= 4 && !VARIANT_KEY_STOP.has(part)) triggers.push({ text: part, weight: 1 });
    }
    const filtered = triggers.filter((t) => t.text.length >= 2);
    if (filtered.length > 0) candidates.push({ key, triggers: filtered });
  }
  return candidates;
}

export function inferCostumeVariants(
  shot: ParsedStoryboardShot,
  valid: StoryboardAssetRef[],
  refs: ParsedStoryboardShot['itemCostumes'],
  referencedNames: string[],
  warnings: string[],
  label: string,
): ParsedStoryboardShot['itemCostumes'] {
  // 多态资产名(小写) → 候选变体（带触发词）。仅多态资产（≥2 变体）才建。
  const polyByName = new Map<string, VariantCandidate[]>();
  for (const a of valid) {
    if (typeof a.name !== 'string') continue;
    const cands = buildVariantCandidates(a.variants);
    if (cands.length > 0) polyByName.set(a.name.toLocaleLowerCase(), cands);
  }
  if (polyByName.size === 0) return refs;

  const haystack = `${shot.visualPrompt ?? ''}\n${shot.dialogue ?? ''}\n${shot.action ?? ''}\n${shot.soundCue ?? ''}\n${shot.sceneContext ?? ''}\n${shot.sceneDesign ?? ''}`.toLowerCase();
  if (!haystack.trim()) return refs;

  // 对一组候选变体，在 haystack 里取命中权重最高且唯一（无并列）的；否则 null。
  const bestVariant = (cands: VariantCandidate[]): { key: string; weight: number } | null => {
    let bestKey = '';
    let bestWeight = 0;
    let tie = false;
    for (const c of cands) {
      let w = 0;
      for (const t of c.triggers) {
        if (t.weight > w && haystack.includes(t.text)) w = t.weight;
      }
      if (w > 0) {
        if (w > bestWeight) { bestWeight = w; bestKey = c.key; tie = false; }
        else if (w === bestWeight) tie = true;
      }
    }
    return bestKey && !tie ? { key: bestKey, weight: bestWeight } : null;
  };

  const result = Array.isArray(refs) ? refs.map((ref) => ({ ...ref })) : [];
  const covered = new Set(result.map((r) => r.name.toLocaleLowerCase()));
  let changed = false;

  // 1) 现有 default 引用：按文本状态线索升级为对应非默认变体
  for (const ref of result) {
    if (ref.costumeKey !== 'default') continue;
    const cands = polyByName.get(ref.name.toLocaleLowerCase());
    if (!cands) continue;
    const best = bestVariant(cands);
    if (best) {
      ref.costumeKey = best.key;
      changed = true;
      warnings.push(`${label}变体推理：资产「${ref.name}」本镜命中状态线索(权重${best.weight})，default→${best.key}`);
    }
  }

  // 2) 引用了多态资产、却没有 costume 条目（生成时会静默落 default）的镜头：
  //    若文本有明确非默认状态，补一条对应变体。否则不加（加 default 等于没加）。
  for (const rawName of referencedNames) {
    const name = typeof rawName === 'string' ? rawName : '';
    const key = name.toLocaleLowerCase();
    if (!name || covered.has(key)) continue;
    const cands = polyByName.get(key);
    if (!cands) continue;
    const best = bestVariant(cands);
    if (best) {
      result.push({ name, costumeKey: best.key });
      covered.add(key);
      changed = true;
      warnings.push(`${label}变体补入：资产「${name}」本镜引用但无变体条目，据状态线索(权重${best.weight})补入${best.key}`);
    }
  }
  return changed ? result : refs;
}

/**
 * 分镜后处理的唯一 Interface：拆时间码、去重、资产归一、声音分类、对白覆盖和 15 秒编组。
 * 路由不再分别了解这些顺序约束，确保所有生成入口共享同一套行为。
 */
export function postprocessStoryboardShots(
  inputShots: ParsedStoryboardShot[],
  scenes: StoryboardScene[],
  assets: StoryboardAssetRef[],
  targetLanguageCode?: string,
  /** 集原文(novelText)。传入则做台词完整性兜底校验:直比原文,抓分析阶段
   *  从 scene.content 精简掉的台词(verifyDialogueCoverage 查不出的漏抽)。 */
  novelText?: string,
): StoryboardPostprocessResult {
  const warnings: string[] = [];
  const characters = assets.filter((asset) => asset.kind === 'CHARACTER');
  const speakingEntities = assets.filter((asset) => asset.kind === 'ENTITY');
  const environments = assets.filter((asset) => asset.kind === 'LOCATION');
  const items = assets.filter((asset) => asset.kind === 'PROP');
  const sceneMap = new Map(scenes.map((scene) => [scene.id, scene]));
  const seen = new Set<string>();
  let shots = splitMultiTimecodeShots(inputShots).filter((shot) => {
    const signature = `${shot.sceneId}::${normalizeText(shot.visualPrompt).slice(0, 100)}::${[...shot.characters].sort().join('|')}`;
    if (seen.has(signature)) {
      warnings.push(`场景 ${shot.sceneId || '未知'} 存在重复镜头，已去重`);
      return false;
    }
    seen.add(signature);
    return true;
  });

  // 退化镜头（黑屏/白屏/无主体/无场景等"无意义画面"）不应独占一组：Seedance 无法生成
  // "什么都没有"的画面。把退化镜头的台词/声音并入同场景最近邻可见镜（优先前邻、其次后邻），
  // 再剔除——使其永不进入编组、不会独占一组。无同场景邻镜可并入时剔除（rare；storyboard
  // prompt 硬约束已在源头避免大部）。台词并入邻镜后，对白覆盖校验仍能命中（coverage 不丢）。
  const mergeOptText = (a: string | undefined, b: string | undefined): string | undefined => {
    const ta = a?.trim();
    const tb = b?.trim();
    if (!ta && !tb) return undefined;
    if (!ta) return tb;
    if (!tb) return ta;
    return `${ta} ${tb}`;
  };
  const dropIdx = new Set<number>();
  for (let i = 0; i < shots.length; i++) {
    if (!isDegenerateVisualPrompt(shots[i].visualPrompt)) continue;
    let neighborIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (shots[j].sceneId === shots[i].sceneId
        && !isDegenerateVisualPrompt(shots[j].visualPrompt) && !dropIdx.has(j)) {
        neighborIdx = j;
        break;
      }
    }
    if (neighborIdx < 0) {
      for (let j = i + 1; j < shots.length; j++) {
        if (shots[j].sceneId === shots[i].sceneId
          && !isDegenerateVisualPrompt(shots[j].visualPrompt) && !dropIdx.has(j)) {
          neighborIdx = j;
          break;
        }
      }
    }
    const deg = shots[i];
    if (neighborIdx >= 0) {
      const nb = shots[neighborIdx];
      nb.dialogue = mergeOptText(nb.dialogue, deg.dialogue);
      nb.soundCue = mergeOptText(nb.soundCue, deg.soundCue);
      warnings.push(`场景 ${deg.sceneId || '未知'} 的退化镜头（黑屏/无主体等）已并入相邻可见镜头，未独占成组`);
    } else {
      warnings.push(`场景 ${deg.sceneId || '未知'} 的退化镜头（黑屏/无主体等）无相邻可见镜头可并入，已剔除`);
    }
    dropIdx.add(i);
  }
  if (dropIdx.size > 0) {
    shots = shots.filter((_, idx) => !dropIdx.has(idx));
  }

  const sceneGroups = new Map<string, ParsedStoryboardShot[]>();
  for (const shot of shots) {
    const scene = sceneMap.get(shot.sceneId);
    shot.characters = normalizeAssetList(shot.characters, characters, warnings, '角色');
    // speakingCharacters 允许人类角色和非人发声体；characters 仍只保存画面中的人类角色。
    shot.speakingCharacters = normalizeAssetList(
      shot.speakingCharacters,
      [...characters, ...speakingEntities],
      warnings,
      '说话角色/实体',
    );
    reconcileCharactersWithPrompt(shot, characters, warnings);
    shot.environments = normalizeAssetList(
      shot.environments.length > 0 ? shot.environments : scene?.location ? [scene.location] : [],
      environments,
      warnings,
      '场景',
    );
    shot.items = normalizeAssetList(shot.items, items, warnings, '道具');
    // 道具/环境变体引用的 name 归一到展示名（与 items/environments 同口径）。
    // 未解析到的条目静默丢弃——它引用的资产本镜并未出现，变体指定无意义。
    const normCostumeRefs = (
      refs: ParsedStoryboardShot['itemCostumes'],
      valid: StoryboardAssetRef[],
    ): ParsedStoryboardShot['itemCostumes'] => {
      if (!Array.isArray(refs) || refs.length === 0) return undefined;
      const sink: string[] = [];
      const seen = new Set<string>();
      // 资产名 → 合法变体 key 集（default 永远合法；多态资产再并入 variants[].key）。
      // 分镜阶段就拦非法 costumeKey：避免非法变体混入 shots、到生成阶段才静默回退
      // 默认图（变体意图丢失且无感知）。非法 key → warning + 回退 default，保留 name。
      // 仅多态资产（显式声明了 variants）才校验；单态资产（无 variants）只保留 name
      // 归一、costumeKey 沿用原值，兼容历史 fixture 与未声明变体的资产。
      const validKeysByName = new Map<string, Set<string>>();
      for (const a of valid) {
        if (typeof a.name !== 'string') continue;
        if (!Array.isArray(a.variants) || a.variants.length === 0) continue;
        const keys = new Set<string>(['default']);
        for (const v of a.variants) {
          if (v && typeof v.key === 'string' && v.key.trim()) keys.add(v.key.trim());
        }
        validKeysByName.set(a.name.toLocaleLowerCase(), keys);
      }
      const resolved = refs
        .map((ref) => {
          const name = normalizeAssetList([ref.name], valid, sink, '变体资产')[0] ?? '';
          if (!name) return null;
          const rawKey = typeof ref.costumeKey === 'string' && ref.costumeKey.trim()
            ? ref.costumeKey.trim()
            : 'default';
          const allowed = validKeysByName.get(name.toLocaleLowerCase());
          if (allowed && !allowed.has(rawKey)) {
            warnings.push(`变体引用非法：资产「${name}」不存在变体 key「${rawKey}」，已回退 default`);
          }
          // 单态资产（allowed=undefined，未声明 variants）沿用原 costumeKey（兼容历史
          // fixture 与未声明变体的资产）；多态资产（allowed 存在）才校验、非法回退 default。
          const costumeKey = !allowed ? rawKey : (allowed.has(rawKey) ? rawKey : 'default');
          return { name, costumeKey };
        })
        .filter((ref): ref is { name: string; costumeKey: string } => ref !== null)
        .filter((ref) => {
          const key = ref.name.toLocaleLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return resolved.length > 0 ? resolved : undefined;
    };
    shot.itemCostumes = normCostumeRefs(shot.itemCostumes, items);
    shot.environmentCostumes = normCostumeRefs(shot.environmentCostumes, environments);
    // 角色变体（成年/幼年等时期变体）：只做 name 归一 + 非法 key 拦截，不做自动推断——
    // 角色状态/年龄只能由 AI 按剧本判断（场景线索不可靠，如成年 Arthur 也在教室/广场出现），
    // 推断会误伤；AI 未输出则默认图（default 形态），与历史行为一致。
    shot.characterCostumes = normCostumeRefs(shot.characterCostumes, characters);
    // 变体状态推理：AI 几乎一律写 default，漏掉剧情状态变体（如云合并/手环碎裂）。
    // 据本镜文本里的状态线索把 default 补成对应非默认变体，确定性兜底防穿帮。
    shot.itemCostumes = inferCostumeVariants(shot, items, shot.itemCostumes, shot.items, warnings, '道具');
    shot.environmentCostumes = inferCostumeVariants(shot, environments, shot.environmentCostumes, shot.environments, warnings, '环境');
    shot.audioType = shot.audioType || deriveAudioType(shot);
    const group = sceneGroups.get(shot.sceneId) ?? [];
    group.push(shot);
    sceneGroups.set(shot.sceneId, group);
  }

  for (const sceneShots of sceneGroups.values()) {
    let groupIndex = 0;
    let duration = 0;
    sceneShots.forEach((shot, index) => {
      shot.durationSeconds = Math.min(15, Math.max(0.1, shot.durationSeconds));
      if (duration > 0 && duration + shot.durationSeconds > 15.05) {
        groupIndex++;
        duration = 0;
      }
      shot.groupIndex = groupIndex;
      shot.groupLabel = GROUP_LABELS[groupIndex % GROUP_LABELS.length] + (groupIndex >= GROUP_LABELS.length ? `-${groupIndex}` : '');
      shot.emotionArcPosition = shot.emotionArcPosition || deriveEmotionArc(index, sceneShots.length);
      duration += shot.durationSeconds;
    });
  }

  const dialogueCoverage = scenes.map((scene) => verifyDialogueCoverage(scene, sceneGroups.get(scene.id) ?? []));

  // 根治：自动补入未覆盖台词。verifyDialogueCoverage 发现的 missing 行是 LLM 漏分到镜头的
  // 台词。把它们补入同场景最近的镜头（优先选有空白对白槽位或同一说话人的镜头），确保每句
  // 剧本台词都出现在分镜中。补入后重算 coverage 以消除 false-positive。
  for (const coverage of dialogueCoverage) {
    if (coverage.missing.length === 0) continue;
    const sceneShots = sceneGroups.get(coverage.sceneId) ?? [];
    if (sceneShots.length === 0) continue;
    for (const missingLine of coverage.missing) {
      // 最佳目标：同场景中距离结尾最近的、有空闲对白空间的镜头
      let bestShot = sceneShots[0];
      let bestScore = -Infinity;
      for (const shot of sceneShots) {
        const isEmpty = !shot.dialogue?.trim();
        const proximity = -Math.abs(shot.shotIndex - sceneShots[sceneShots.length - 1].shotIndex);
        const score = (isEmpty ? 100 : 0) + proximity;
        if (score > bestScore) { bestScore = score; bestShot = shot; }
      }
      const taggedLine = `${missingLine.character}: ${missingLine.line}`;
      bestShot.dialogue = bestShot.dialogue?.trim()
        ? `${bestShot.dialogue}; ${taggedLine}`
        : taggedLine;
      bestShot.visualPrompt = `${bestShot.visualPrompt}\n[voice:${taggedLine}]`;
      warnings.push(`台词补全：场景 ${coverage.sceneId} 的漏分台词已补入镜头 ${bestShot.shotIndex}：${missingLine.character}: ${missingLine.line.slice(0, 40)}`);
    }
  }
  // 重算 coverage 确保补入后不再报 missing
  for (let i = 0; i < dialogueCoverage.length; i++) {
    const scene = scenes.find((s) => s.id === dialogueCoverage[i].sceneId);
    if (!scene) continue;
    const rechecked = verifyDialogueCoverage(scene, sceneGroups.get(scene.id) ?? []);
    dialogueCoverage[i] = rechecked;
  }
  for (const coverage of dialogueCoverage) {
    if (coverage.missing.length > 0) warnings.push(`场景 ${coverage.sceneId} 有 ${coverage.missing.length}/${coverage.total} 句对白未覆盖`);
  }

  // 兜底校验:直比原文 novelText。verifyDialogueCoverage 只比对【分析后的 scene.content】,
  // 分析阶段若把短句/问答/汇报体从 scene.content 精简掉,它查不出(生产 ep5 "Leo."、
  // ep32 "Campus security?" 等漏写就是这么来的)。这里用 verifyDialogueCompleteness 直比
  // 原文,把漏抽的台词作为 warning 暴露出来(prompt 治本 + 这里兜底告警,不自动补位以免放错场景)。
  if (novelText) {
    const missingFromNovel = verifyDialogueCompleteness(
      novelText,
      shots.map((s) => s.dialogue ?? ''),
    );
    for (const m of missingFromNovel) {
      warnings.push(`原文台词缺失(分析漏抽,需补):${m.speaker} —— ${m.line.slice(0, 60)}`);
    }
  }
  const languageAudit = targetLanguageCode
    ? shots.flatMap((shot, index) => {
        if (!shot.dialogue?.trim()) return [];
        // dialogue 现按「角色名（通道）：台词」标注说话人；OS/VO 是拉丁字符，会让中文
        // 项目语种审核误判混入西文。剥成纯台词后再审，避免假阳性。
        return [{ ...auditLanguageScript(stripDialogueTags(shot.dialogue), targetLanguageCode), shotIndex: index + 1 }];
      })
    : [];
  for (const audit of languageAudit) {
    if (audit.supported && !audit.matches) {
      warnings.push(`镜头 ${audit.shotIndex} 的对白不符合目标语种 ${audit.languageCode}`);
    }
  }

  return {
    shots: shots.map((shot, index) => ({ ...shot, shotIndex: index + 1 })),
    dialogueCoverage,
    languageAudit,
    warnings: [...new Set(warnings)],
  };
}
