// 来源：F:\app1\src\core\video\long-video-service.ts 第 113-503 行（纯函数 verbatim 抽取）。
// 转绘 X3.1 纯函数迁移，零依赖（无 DB/Prisma/redis/ffmpeg/node:*）。
// processLongVideo 主链（517+ 行）属于 X3.4 的活，本文件只搬纯字符串/regex 工具。
// 函数间互相依赖（如 appendOnlyMissingEpisodes 调 extractEpisodeNumbers）已在同文件内闭环。

/** 去掉续写开头与上一段末尾的精确重复，避免自动续写留下重叠对白。 */
export function appendModelContinuation(existing: string, continuation: string): string {
  const left = existing.trimEnd();
  const right = continuation.trimStart();
  const maxOverlap = Math.min(4000, left.length, right.length);
  for (let length = maxOverlap; length >= 6; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return left + right.slice(length);
    }
  }
  return `${left}\n${right}`;
}

/**
 * 补缺集续写若误从已存在集数重写，只取第一个尚未出现的正式集标题之后的内容。
 * 这样不会因“第001集”被模型重打一遍而把整段判成重复标题。
 */
export function appendOnlyMissingEpisodes(existing: string, continuation: string): string {
  const existingEpisodes = new Set(extractEpisodeNumbers(existing));
  const heading = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2})?[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm;
  const firstMissingHeading = [...continuation.matchAll(heading)]
    .find((match) => !existingEpisodes.has(Number(match[1])));
  if (!firstMissingHeading) return existing.trimEnd();
  return appendModelContinuation(existing, continuation.slice(firstMissingHeading.index ?? 0));
}

/**
 * 清除模型混入长视频剧本的制作规划/续写说明。
 *
 * 只按“整行是元文本”过滤；带角色名的对白、场头和动作行优先视为剧情，避免把
 * 科幻题材里“生成器/AI”等正常词汇误删。调用方应在每段模型结果拼接前执行。
 */
export function stripMetaCommentary(text: string): string {
  const chineseMeta = /^(?:AI\s*(?:思考|分析|计划)|(?:我的)?思考(?:过程)?|创作(?:思路|计划|说明)|续写(?:计划|说明|安排)?|生成(?:计划|说明|安排)?|批次(?:计划|说明|安排)?|第\s*\d+\s*批(?:次)?|本(?:次|批)(?:只|仅|将|会|需要|要)|(?:接下来|下面)(?:我|将|会|需要|要)|我(?:需要|将|会|先|要)|让(?:我|我们)|根据(?:要求|指令)|按照(?:要求|指令)|作为\s*AI|(?:以下|上面)(?:是|为|已)|(?:剩余|余下)(?:场次|集数|内容)|接上文|继续上文|无缝续写)/i;
  const englishMeta = /^(?:as\s+(?:an?\s+)?AI\b|I\s+(?:need|will|must|should|have\s+to|am\s+going\s+to)\b|let\s+me\b|this\s+(?:batch|response|part)\b|(?:continuation|generation|writing|batch)\s+(?:plan|notes?|instructions?)\b|batch\s*#?\s*\d+\b|according\s+to\s+(?:the\s+)?(?:request|instructions?)\b|the\s+(?:following|above)\s+(?:is|was)\b|remaining\s+(?:scenes?|episodes?|content)\b)/i;
  const explicitMetaSpeaker = /^(?:AI|Assistant|作者|编剧|系统)[：:]\s*(?:思考|分析|计划|我|本次|续写|生成|根据|按照|接下来)/i;
  const screenplayLine = /^(?:第\s*0*\d{1,4}\s*集\b|Episode\s+0*\d{1,4}\b|\[[^\]]+\]|[▲△]|[^：:\r\n]{1,20}[：:])/i;

  const kept = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    const candidate = trimmed.replace(/^(?:[-*•]+|\d+[.)、])\s*/, '');
    if (
      explicitMetaSpeaker.test(candidate)
      || chineseMeta.test(candidate)
      || englishMeta.test(candidate)
    ) return false;
    if (screenplayLine.test(candidate)) return true;
    return true;
  });

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface EpisodeRange {
  start: number;
  end: number;
}

interface EpisodeCountRange {
  min: number;
  max: number;
  target: number;
  targetEpisodeSec: number;
}

/**
 * 由素材时长反推分集规模。上限取“原时长 ÷ 单集目标时长”，下限允许最多约 20%
 * 的去广告、去回顾和节奏压缩；不再把所有长片机械套进固定集数区间。
 */
export function inferEpisodeCountRange(
  durationSec?: number,
  targetEpisodeSec = 90,
): EpisodeCountRange | null {
  if (!Number.isFinite(durationSec) || (durationSec ?? 0) <= 0) return null;
  const normalizedEpisodeSec = Number.isFinite(targetEpisodeSec) && targetEpisodeSec > 0
    ? Math.max(1, Math.round(targetEpisodeSec))
    : 90;
  const target = Math.max(1, Math.round((durationSec as number) / normalizedEpisodeSec));
  return {
    min: Math.max(1, Math.floor(target * 0.8)),
    max: target,
    target,
    targetEpisodeSec: normalizedEpisodeSec,
  };
}

/** 提取模型正文中实际写出的分集编号；用于识别模型“正常结束但提前停笔”。 */
export function extractEpisodeNumbers(text: string): number[] {
  const values = new Set<number>();
  for (const match of text.matchAll(/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2})?[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** 把连续的待生成集数切成小批次，既避免单次输出触顶，也可并行生成超长剧本。 */
export function buildEpisodeRanges(episodes: number[], batchSize: number): EpisodeRange[] {
  const size = Math.max(1, Math.floor(batchSize));
  const sorted = [...new Set(episodes.filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
  const ranges: EpisodeRange[] = [];
  let cursor = 0;
  while (cursor < sorted.length) {
    const start = sorted[cursor];
    let end = start;
    let count = 1;
    cursor += 1;
    while (cursor < sorted.length && sorted[cursor] === end + 1 && count < size) {
      end = sorted[cursor];
      count += 1;
      cursor += 1;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * 把全剧切成严格顺序的三段：前 1/3、中 1/3、后 1/3。
 * 后一段必须在前一段完成后才生成，以便携带全部已写正文作为连续性事实。
 */
export function buildThreeStageEpisodeRanges(totalEpisodes: number): EpisodeRange[] {
  const total = Math.max(1, Math.floor(totalEpisodes));
  const firstEnd = Math.ceil(total / 3);
  const secondEnd = Math.ceil((total * 2) / 3);
  return [
    { start: 1, end: firstEnd },
    ...(firstEnd < secondEnd ? [{ start: firstEnd + 1, end: secondEnd }] : []),
    ...(secondEnd < total ? [{ start: secondEnd + 1, end: total }] : []),
  ];
}

/** 去掉初始模型可能不完整的分集区，只保留故事、人物与场景圣经。 */
export function extractOutlineStoryBible(outline: string): string {
  const plotHeading = outline.search(/^###\s*5(?:\.|、|\s).*$/m);
  const firstEpisodeHeading = outline.search(
    /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2})?[ \t]*第[ \t]*0*1[ \t]*集[^\r\n]*$/m,
  );
  const cutAt = [plotHeading, firstEpisodeHeading]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), outline.length);
  return outline.slice(0, cutAt).trim();
}

/** 从全局大纲中按集号提取当前三分之一，确保前段对应整份大纲的前段，而不是自行提前收尾。 */
export function extractOutlineEpisodeRange(
  outline: string,
  range: EpisodeRange,
  totalEpisodes: number,
): string {
  const heading = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2})?[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm;
  const matches = [...outline.matchAll(heading)].map((match) => ({
    episode: Number(match[1]),
    index: match.index ?? 0,
  }));
  const selected = matches
    .map((match, index) => ({
      ...match,
      content: outline.slice(match.index, matches[index + 1]?.index ?? outline.length).trim(),
    }))
    .filter((item) => item.episode >= range.start && item.episode <= range.end)
    .map((item) => item.content)
    .join('\n\n');
  if (selected) return selected;

  const total = Math.max(1, Math.floor(totalEpisodes));
  const start = Math.floor(((range.start - 1) / total) * outline.length);
  const end = Math.ceil((range.end / total) * outline.length);
  return outline.slice(start, end).trim();
}

/** 从已完成剧本中提取一个完整分段，用于质量返修时保留前面已验收的段落。 */
export function extractScriptEpisodeRange(text: string, range: EpisodeRange): string {
  const heading = /^[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm;
  const matches = [...text.matchAll(heading)].map((match) => ({
    episode: Number(match[1]),
    index: match.index ?? 0,
  }));
  return matches
    .map((match, index) => ({
      ...match,
      content: text.slice(match.index, matches[index + 1]?.index ?? text.length).trim(),
    }))
    .filter((item) => item.episode >= range.start && item.episode <= range.end)
    .map((item) => item.content)
    .join('\n\n')
    .trim();
}

export function episodeRangeCompletionMarker(range: EpisodeRange): string {
  return `[[RANGE_COMPLETE:${range.start}-${range.end}]]`;
}

/** 模型续写常会重打一遍“第 N 集（续）”标题；只去重标题，保留续写正文。 */
export function normalizeOutlineContinuationHeadings(text: string): string {
  const heading = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2})?[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm;
  const seen = new Set<number>();
  let cursor = 0;
  let output = '';
  for (const match of text.matchAll(heading)) {
    const index = match.index ?? 0;
    output += text.slice(cursor, index);
    const episode = Number(match[1]);
    if (!seen.has(episode)) {
      output += match[0];
      seen.add(episode);
    }
    cursor = index + match[0].length;
  }
  output += text.slice(cursor);
  return output.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 模型偶尔会把连续性提示原样写进成片正文，例如“像第46集那次通话”。
 * 集号只允许出现在分集标题；正文中的数字集号改写为剧情内自然时间指代，
 * 避免为了这种机械问题反复调用模型并意外改动已经正确的剧情。
 */
export function normalizeInBodyEpisodeReferences(text: string): string {
  const heading = /^[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm;
  const matches = [...text.matchAll(heading)];
  if (matches.length === 0) return text;

  const normalizeBody = (body: string): string => body
    .replace(/从[ \t]*第[ \t]*0*\d{1,4}[ \t]*集[ \t]*到现在/g, '从最初到现在')
    .replace(/第[ \t]*0*\d{1,4}[ \t]*集(?:时|中|里|那一集|那集)?/g, '此前');

  let output = text.slice(0, matches[0].index ?? 0);
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const headingStart = match.index ?? 0;
    const headingEnd = headingStart + match[0].length;
    const blockEnd = matches[index + 1]?.index ?? text.length;
    output += match[0];
    output += normalizeBody(text.slice(headingEnd, blockEnd));
  }
  return output;
}

/**
 * 连续性板会把 OCR/字幕造成的近名冲突明确写成“统一为某正式名”。
 * 这里只采纳同一表格行中、同姓且像人名的冲突候选，避开“陆先生/三小姐”
 * 这类称谓和“阿笙”这类可能重名的昵称。
 */
export function normalizeCanonicalCharacterNames(text: string, directorBoard: string): string {
  const replacements = new Map<string, string>();
  const titleSuffix = /(先生|小姐|少爷|太太|将军|局长|董事|总裁|家主|父亲|母亲|哥哥|姐姐|弟弟|妹妹|叔|哥|姐|妈|爸|爷)$/;
  for (const line of directorBoard.split(/\r?\n/)) {
    if (!line.includes('统一为') || !line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const formal = cells[1]?.match(/\*\*([^*]+)\*\*/)?.[1]?.trim();
    if (!formal || !/^[㐀-鿿]{2,4}$/.test(formal)) continue;
    const candidates = new Set<string>();
    for (const raw of (cells[2] || '').split(/[、,，]/)) {
      candidates.add(raw.replace(/[（(].*$/u, '').trim());
    }
    for (const quoted of line.matchAll(/["“]([^"”]+)["”]/g)) {
      for (const raw of quoted[1].split(/[\/、,，]/)) candidates.add(raw.trim());
    }
    for (const candidate of candidates) {
      if (
        candidate !== formal
        && /^[㐀-鿿]{2,4}$/.test(candidate)
        && candidate[0] === formal[0]
        && !titleSuffix.test(candidate)
      ) {
        replacements.set(candidate, formal);
      }
    }
  }
  return [...replacements.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .reduce((content, [variant, formal]) => content.split(variant).join(formal), text);
}

/** 保存前的最低生产结构检查；段尾完成标记负责识别“已有末集标题但正文中途停笔”。 */
export function inspectScriptRangeStructure(text: string, range: EpisodeRange): string[] {
  const issues: string[] = [];
  const heading = /^[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm;
  const matches = [...text.matchAll(heading)].map((match) => ({
    episode: Number(match[1]),
    index: match.index ?? 0,
  }));
  for (let episode = range.start; episode <= range.end; episode += 1) {
    const episodeMatches = matches.filter((item) => item.episode === episode);
    if (episodeMatches.length !== 1) {
      issues.push(`第${episode}集标题数量为 ${episodeMatches.length}`);
      continue;
    }
    const current = episodeMatches[0];
    const currentPosition = matches.indexOf(current);
    const block = text.slice(current.index, matches[currentPosition + 1]?.index ?? text.length);
    if (block.trim().length < 500) issues.push(`第${episode}集少于 500 字符`);
    const sceneMatches = [...block.matchAll(/^\[(\d+)-(\d+)\s+[^\]]+\]$/gm)];
    if (sceneMatches.length === 0) issues.push(`第${episode}集缺少场次`);
    if (sceneMatches.some((match) => Number(match[1]) !== episode)) {
      issues.push(`第${episode}集存在跨集场号`);
    }
    if (sceneMatches.some((match) => /\s(?:内\s*\/\s*外|外\s*\/\s*内)\s/.test(match[0]))) {
      issues.push(`第${episode}集场头混用“内/外”`);
    }
    if (block.includes('人物：同上')) issues.push(`第${episode}集使用“人物：同上”`);
    const bodyWithoutHeading = block.slice(block.indexOf('\n') + 1);
    if (/第\s*\d+\s*集/.test(bodyWithoutHeading)) {
      issues.push(`第${episode}集正文出现剧内集号引用`);
    }
  }
  return issues;
}

/**
 * 发现跨集整段复演，而不是把常见短句或场记动作误判为重复。
 * 当前段会同时与已完成前文比较；问题归到后出现的集，便于单集返修。
 */
export function inspectScriptSemanticDuplicates(
  text: string,
  range: EpisodeRange,
  priorText = '',
): string[] {
  const combined = [priorText.trim(), text.trim()].filter(Boolean).join('\n\n');
  const heading = /^[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm;
  const matches = [...combined.matchAll(heading)].map((match) => ({
    episode: Number(match[1]),
    index: match.index ?? 0,
  }));
  const blocks = matches.map((match, index) => ({
    episode: match.episode,
    content: combined.slice(match.index, matches[index + 1]?.index ?? combined.length),
  }));
  const normalize = (line: string) => line.replace(/[，。！？；：“”‘’、,.!?;:'"\s]/g, '');
  const meaningfulLines = new Map<number, Map<string, { raw: string; material: boolean }>>();
  for (const block of blocks) {
    const lines = new Map<string, { raw: string; material: boolean }>();
    for (const rawLine of block.content.split(/\r?\n/).map((line) => line.trim())) {
      if (!rawLine || /^第\s*\d+\s*集|^本集|^---|^\[/.test(rawLine)) continue;
      const isAction = rawLine.startsWith('▲');
      const isDialogue = /^[㐀-鿿A-Za-z·]+(?:（[^）]+）)?[：:]/.test(rawLine);
      if (!isAction && !isDialogue) continue;
      const key = normalize(rawLine);
      if (key.length < 12) continue;
      lines.set(key, {
        raw: rawLine,
        // 长场记常因模型文风相似而撞句；单条只有完整长对白才足以证明情节复演。
        // 动作行仍参与“三条及以上”的整段重复判断。
        material: isDialogue && key.length >= 20,
      });
    }
    meaningfulLines.set(block.episode, lines);
  }

  const issues: string[] = [];
  for (const current of blocks.filter(
    (block) => block.episode >= range.start && block.episode <= range.end,
  )) {
    const currentLines = meaningfulLines.get(current.episode) || new Map();
    for (const previous of blocks.filter((block) => block.episode < current.episode)) {
      const previousLines = meaningfulLines.get(previous.episode) || new Map();
      const duplicates = [...currentLines.keys()].filter((line) => previousLines.has(line));
      const hasMaterialReplay = duplicates.some(
        (line) => currentLines.get(line)?.material || previousLines.get(line)?.material,
      );
      if (duplicates.length >= 3 || hasMaterialReplay) {
        issues.push(`第${current.episode}集与第${previous.episode}集重复已完成情节（${duplicates.length}条）`);
        break;
      }
    }
    const selfAddress = current.content.match(
      /^([㐀-鿿A-Za-z·]{2,8})(?:（[^）]+）)?[：:]\s*\1[，,：:]/m,
    );
    if (selfAddress) issues.push(`第${current.episode}集角色“${selfAddress[1]}”以本人姓名称呼自己`);
  }
  return issues;
}

/**
 * 用返修稿替换一个连续分集区间，同时保留原稿区间前后的正文。
 * 返修调用可能带剧名总标题，因此从首个目标集标题开始截取。
 */
export function replaceScriptEpisodeRange(
  original: string,
  replacement: string,
  range: EpisodeRange,
): string {
  const heading = /^[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*$/gm;
  const originalMatches = [...original.matchAll(heading)].map((match) => ({
    episode: Number(match[1]),
    index: match.index ?? 0,
  }));
  const replacementMatches = [...replacement.matchAll(heading)].map((match) => ({
    episode: Number(match[1]),
    index: match.index ?? 0,
  }));
  const originalStart = originalMatches.find((item) => item.episode === range.start);
  const replacementStart = replacementMatches.find((item) => item.episode === range.start);
  if (!originalStart || !replacementStart) return replacement.trim();

  const originalEnd = originalMatches.find((item) => item.index > originalStart.index && item.episode > range.end)?.index
    ?? original.length;
  const replacementEnd = replacementMatches.find(
    (item) => item.index > replacementStart.index && item.episode > range.end,
  )?.index ?? replacement.length;
  const replacementBody = replacement.slice(replacementStart.index, replacementEnd).trim();
  return `${original.slice(0, originalStart.index).trimEnd()}\n\n${replacementBody}\n\n${original.slice(originalEnd).trimStart()}`.trim();
}

/**
 * 按分集在全剧中的相对位置截取原稿，并多带前后各一集作为连续性上下文。
 * 最终长度由分批数量自然扩展，不对整部剧本设置字符上限。
 */
export function sliceSourceForEpisodeRange(
  source: string,
  range: EpisodeRange,
  totalEpisodes: number,
  contextEpisodes = 1,
): string {
  const total = Math.max(1, Math.floor(totalEpisodes));
  const context = Math.max(0, Math.floor(contextEpisodes));
  const contextStartEpisode = Math.max(1, range.start - context);
  const contextEndEpisode = Math.min(total, range.end + context);
  const start = Math.floor(((contextStartEpisode - 1) / total) * source.length);
  const end = Math.ceil((contextEndEpisode / total) * source.length);
  return source.slice(start, end);
}

/** 优先尊重大纲明确标注的终章；否则按素材时长与单集目标时长动态反推。 */
export function inferTargetEpisodeCount(outline: string, durationSec: number): number {
  const terminalMatches = [...outline.matchAll(
    /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*{1,2})?[ \t]*第[ \t]*0*(\d{1,4})[ \t]*集[^\r\n]*(?:终章|大结局|全剧终|结局)[^\r\n]*$/gm,
  )];
  const terminal = terminalMatches
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value) && value > 0)
    .at(-1);
  if (terminal) return terminal;

  const existing = extractEpisodeNumbers(outline);
  const largestExisting = existing.at(-1) ?? 0;
  const durationTarget = inferEpisodeCountRange(durationSec)?.target ?? 1;
  return Math.max(largestExisting, durationTarget);
}
