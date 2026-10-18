// ============================================================
// 分镜台词完整性校验：原文 novelText vs 分镜镜头 dialogue
// ============================================================
//
// 根因：script-prompt 曾允许"只引用关键台词"，AI 据此漏抽短句/问答/汇报体
//（生产 ep5 "Leo."、ep32 "Campus security?" / "Risk assessments..." 漏写）。
// 而 verifyDialogueCoverage 只比对【分析后的 scene.content】——原文一旦在分析阶段
// 被精简，scene.content 里就没有，coverage 永远 missing=[]，查不出来。
//
// 本函数直比对【原文 novelText】(ground truth)：抽出原文每条带说话人的台词，
// 逐句查分镜 dialogue 里有没有（撇号归一化、跨字符比对）。返回缺失清单。
// 作为分析后的兜底硬校验——prompt 再硬也不如代码校验可靠。
// ============================================================

/** 一条缺失的原文台词。 */
export interface MissingDialogue {
  /** 说话人（： 之前的整段，含情绪括号）。 */
  speaker: string;
  /** 原文整行。 */
  line: string;
}

/** 抽出的原文台词行。 */
export interface DialogueLine {
  speaker: string;
  text: string;
  raw: string;
}

/** 撇号归一化（弯 ‘ ’ ↔ 直 '）+ 折叠空白，消除跨字符比对误差。 */
function normalizeForCompare(s: string): string {
  return s.replace(/[‘’‛“”]/g, (m) =>
    m === '“' || m === '”' ? '"' : "'",
  ).replace(/\s+/g, ' ').trim();
}

/**
 * 从 novelText 抽出带说话人的台词行。
 *
 * 判定：含全角「：」、且不像造型/场景头/字幕/纯动作行。台词行形如
 * `Leo（幼年）（哭腔）：Don't cry.` 或 `Gemma：Good. Campus security?`。
 */
export function extractDialogueLines(novelText: string): DialogueLine[] {
  const out: DialogueLine[] = [];
  for (const rawLine of novelText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes('：')) continue;
    // 排除非台词：造型描述、场景头、字幕、动作行
    if (/^(造型|##|【|△|场景|角色|第\s*\d+\s*集|《)/.test(line)) continue;
    if (/^##/.test(line)) continue;
    const colonIdx = line.indexOf('：');
    const speaker = line.slice(0, colonIdx).trim();
    const text = line.slice(colonIdx + 1).trim();
    if (!text || !speaker) continue;
    out.push({ speaker, text, raw: line });
  }
  return out;
}

/**
 * 校验分镜台词完整性：原文每条台词是否都出现在分镜镜头的 dialogue 里。
 *
 * @param novelText 集的原文（ground truth）
 * @param shotDialogues 各镜头的 dialogue 字段（已含说话人前缀，如 `Leo：...`）
 * @returns 缺失清单（原文有、分镜无的台词）
 */
export function verifyDialogueCompleteness(
  novelText: string,
  shotDialogues: string[],
): MissingDialogue[] {
  const haystack = normalizeForCompare(shotDialogues.filter(Boolean).join(' ¶ '));
  const missing: MissingDialogue[] = [];
  for (const { speaker, text, raw } of extractDialogueLines(novelText)) {
    const needle = normalizeForCompare(text);
    if (!needle) continue;
    // 长句（≥6 字符）：直接查台词文本（撇号已归一化）。
    // 短句（<6）：单查文本易误命中角色名（如 "Leo."），改查「说话人核心名 + 台词」。
    const found =
      needle.length >= 6
        ? haystack.includes(needle)
        : haystack.includes(normalizeForCompare(`${speaker}：${text}`)) ||
          haystack.includes(needle);
    if (!found) missing.push({ speaker, line: raw });
  }
  return missing;
}
