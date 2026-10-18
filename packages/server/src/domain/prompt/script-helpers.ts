// ============================================================

import { stripMetaCommentary } from '@dramaforge/shared';
// ③ server/domain/prompt — 剧本提示词纯函数
// ============================================================
//
// 文件职责：
//   从 app1 src/core/ai/script-prompt.ts 抽取的纯函数：
//   - cleanAiOutput：清理 AI 返回的前言/结语，只保留实际剧本内容
//   - parseCharacterAliasMap：解析角色名映射表 JSON（oldName → newName）
//   - extractDialoguesFromContent：从场景正文提取结构化对话列表
//   - ExtractedDialogue 类型
//
// 全部为纯函数（无 I/O、无 DB、无 Redis、无 ffmpeg），可直接单测。
// ============================================================

/**
 * 清理 AI 返回文本：去除前言/结语，只保留实际内容。
 *
 * 稳健去除 "好的，作为您的专业影视编剧..." / "Sure, here is..." 等 AI 套话。
 * 双语：同时识别中文标签（场景列表/信息点/造型表/场景画风）与英文标签。
 */
export function cleanAiOutput(rawText: string): string {
  let text = stripMetaCommentary(rawText);

  const earliestIdx = (subs: string[]): number => {
    let best = -1;
    for (const s of subs) {
      const i = text.indexOf(s);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    return best;
  };
  const latestIdx = (subs: string[]): number => {
    let best = -1;
    for (const s of subs) {
      const i = text.lastIndexOf(s);
      if (i > best) best = i;
    }
    return best;
  };

  // 1. 找到实际内容的起始位置
  const idxSceneList = earliestIdx(['场景列表', 'Scene List']);
  const idxSceneHeader = text.indexOf('## S');
  const idxLingshiTitle = text.search(/^《[^》]+》/m);
  const idxLingshiEpisode = text.search(/^第[ \t]*0*1[ \t]*集/m);
  const idxLingshiScene = text.indexOf('[1-1');
  let contentStart = -1;
  if (idxSceneList >= 0 && idxSceneHeader >= 0) {
    contentStart = Math.min(idxSceneList, idxSceneHeader);
  } else if (idxSceneList >= 0) {
    contentStart = idxSceneList;
  } else if (idxSceneHeader >= 0) {
    contentStart = idxSceneHeader;
  } else {
    const lingshiCandidates = [idxLingshiTitle, idxLingshiEpisode, idxLingshiScene]
      .filter((index) => index >= 0);
    if (lingshiCandidates.length > 0) contentStart = Math.min(...lingshiCandidates);
  }

  if (contentStart > 0) {
    const preamble = text.slice(0, contentStart);
    const isPreamble = /好[的，,。]|作为|以下是|我来|我已|请查看|这是|根据您|为您|将您|分析并|转化|标准格式|影视编剧|剧本结构|请稍|这是为您|已经将|sure[!,.]?|here\s+is|here's|as\s+a|let\s+me|i'll|i\s+will|below\s+is|the\s+following|无缝续写|余下场次|本次[只仅]生成|此前至|批次|续写计划|生成计划/i.test(
      preamble,
    );
    if (isPreamble) {
      text = text.slice(contentStart);
    }
  }

  // 3. 逐行清理
  const lines = text.split('\n');
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      startLine = i + 1;
      continue;
    }
    if (
      line.startsWith('场景列表') ||
      line.startsWith('Scene List') ||
      line.startsWith('## S') ||
      line.startsWith('信息点') ||
      line.startsWith('Info Points') ||
      /^《[^》]+》/.test(line) ||
      /^第[ \t]*0*1[ \t]*集/.test(line) ||
      /^\[1-1/.test(line)
    ) {
      startLine = i;
      break;
    }
    if (/^(好[的，,]|作为|以下|我来|我已|请查看|这是|根据|为您|已经|sure[!,.]?|here|as\s+a|let\s+me|i'll|i\s+will|below|the\s+following|我(?:需要|会|将|来|先|要)|让[我俺]|本次[只仅]|剩余[场集]|此前[至到]|接下来|上面[已是]|下面[我将])/i.test(line)) {
      startLine = i + 1;
      continue;
    }
    startLine = i;
    break;
  }
  text = lines.slice(startLine).join('\n').trim();

  // 4. 去除尾部解释性文字
  const lastMetaIdx = latestIdx(['场景画风', 'Art Style', '角色名映射表', 'Character Name Mapping']);
  if (lastMetaIdx >= 0) {
    const afterMeta = text.slice(lastMetaIdx);
    const newlineAfterMeta = afterMeta.indexOf('\n');
    if (newlineAfterMeta >= 0) {
      const tail = afterMeta.slice(newlineAfterMeta + 1).trim();
      if (
        tail &&
        !tail.match(
          /^(E\d+S\d+|##\s*S\d+|场景列表|Scene\s+List|信息点|Info\s+Points|造型表|Costume\s+Table|角色名映射表|Character\s+Name\s+Mapping)/,
        )
      ) {
        text = text.slice(0, lastMetaIdx + newlineAfterMeta + 1);
      }
    }
  }

  return text.trim();
}

export interface CharacterAliasExtraction {
  manuscript: string;
  aliasMap: Map<string, string>;
  mappingSectionFound: boolean;
}

/**
 * Parse and remove the model-only character mapping appendix.
 *
 * The appendix is metadata for cross-episode identity updates, not screenplay
 * content. Supporting both fenced and bare JSON keeps the parser aligned with
 * the whole-series prompt and prevents the appendix entering the last episode.
 */
export function extractCharacterAliasMapAndManuscript(
  text: string,
): CharacterAliasExtraction {
  const aliasMap = new Map<string, string>();
  if (!text) return { manuscript: '', aliasMap, mappingSectionFound: false };

  const heading = /^[ \t]*(?:#{1,6}[ \t]*)?(?:角色名映射表|Character\s+Name\s+Mapping)[ \t:：]*$/im;
  const headingMatch = heading.exec(text);
  if (!headingMatch || headingMatch.index < 0) {
    return { manuscript: text.trim(), aliasMap, mappingSectionFound: false };
  }

  const sectionIdx = headingMatch.index;
  const afterSection = text.slice(sectionIdx + headingMatch[0].length);
  const fenced = afterSection.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const bare = afterSection.match(/\[[\s\S]*\]/)?.[0];
  const jsonText = fenced ?? bare;

  if (jsonText) {
    try {
      const arr = JSON.parse(jsonText.trim()) as unknown;
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (
            item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).oldName === 'string' &&
            typeof (item as Record<string, unknown>).newName === 'string'
          ) {
            const oldName = String((item as Record<string, unknown>).oldName).trim();
            const newName = String((item as Record<string, unknown>).newName).trim();
            if (oldName && newName && oldName !== newName) {
              aliasMap.set(oldName, newName);
            }
          }
        }
      }
    } catch {
      // The appendix is still stripped from screenplay content even when its
      // metadata JSON is malformed. No identity update is safer than leaking it.
    }
  }
  return {
    manuscript: text.slice(0, sectionIdx).trim(),
    aliasMap,
    mappingSectionFound: true,
  };
}

/** Backward-compatible alias-only view. */
export function parseCharacterAliasMap(text: string): Map<string, string> {
  return extractCharacterAliasMapAndManuscript(text).aliasMap;
}

/** 提取出的对话条目 */
export interface ExtractedDialogue {
  character: string;
  emotion?: string;
  lines: string;
  type: 'dialogue' | 'voiceover';
}

/**
 * 从场景正文中提取结构化对话列表（双语）。
 *
 * 匹配格式：
 * - 中文：角色名（情绪）：台词（名字不含空格）
 * - 英文：Name With Spaces (emotion): dialogue（名字可含空格）
 * - 内心独白：角色名OS：内容 / Name OS: content
 *
 * 动作行（以 △ 开头）与场景标题（## 开头）跳过。
 */
export function extractDialoguesFromContent(content: string): ExtractedDialogue[] {
  const dialogues: ExtractedDialogue[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('△') || trimmed.startsWith('##')) continue;

    // 中文格式优先
    const cnMatch = trimmed.match(/^([^\s△（(]+?)[（(]([^）)]*)[）)][:：]\s*(.+)$/);
    if (cnMatch) {
      dialogues.push({
        character: cnMatch[1].trim(),
        emotion: cnMatch[2].trim() || undefined,
        lines: cnMatch[3].trim(),
        type: 'dialogue',
      });
      continue;
    }

    // 英文格式
    const enMatch = trimmed.match(/^(.+?)[（(]([^）)]*)[）)][:：]\s*(.+)$/);
    if (enMatch) {
      const name = enMatch[1].trim();
      if (name.length >= 2 && name.length <= 40 && !/^\d/.test(name)) {
        dialogues.push({
          character: name,
          emotion: enMatch[2].trim() || undefined,
          lines: enMatch[3].trim(),
          type: 'dialogue',
        });
        continue;
      }
    }

    // OS 内心独白
    const osMatch = trimmed.match(/^(.+?)\s*OS[:：]\s*(.+)$/);
    if (osMatch) {
      const name = osMatch[1].trim();
      if (name.length >= 2 && name.length <= 40 && !/^\d/.test(name)) {
        dialogues.push({
          character: name,
          lines: osMatch[2].trim(),
          type: 'voiceover',
        });
      }
    }
  }

  return dialogues;
}

/**
 * 剥离对白字段里的「角色名（通道）：」标签，只留纯台词——供语种审核
 * （auditLanguageScript）等需要"纯口播文本"的下游使用。
 *
 * 背景：storyboard 的 dialogue 字段采用「角色名（通道）：台词」格式绑定说话人
 * （OS=画外/内心独白、VO=旁白）。其中 OS/VO 是拉丁字母，会让中文项目的语种审核
 * 把它误判为"混入西文字符"（auditLanguageScript 按脚本字符集校验）。本函数在
 * 审核前把标签剥成纯台词，避免假阳性。无标签的纯台词原样返回；多句用「；」接回。
 *
 * 只剥「角色名（…）：台词」这种带括号标签的形式（新格式的明确信号）；裸「角色名：台词」
 * 不剥——角色名与项目语种同文，不会污染审核。
 */
export function stripDialogueTags(value: string | undefined | null): string {
  if (!value || !value.trim()) return '';
  const segments = value.replace(/\r\n/g, '\n').split(/[；;\n]/);
  const out: string[] = [];
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    // 「角色名（通道）：台词」→ 台词
    const m = s.match(/^([^\s：:（(]{1,16})[（(]([^）)]*)[）)]\s*[:：]\s*(.+)$/);
    out.push(m ? m[3].trim() : s);
  }
  return out.filter(Boolean).join('；');
}
