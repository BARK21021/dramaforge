// ============================================================
// 编剧分析提示词模板
// 参考: 剧本解析需求文件 + videostylization/kimiClient.ts
// 支持双语：英文输入 → 英文剧本 + 英文结构标签 + 原文文化背景
//          中文输入 → 保持现有中文行为
// ============================================================

import { stripMetaCommentary } from "@dramaforge/shared";
import type { CostumeVariant } from "./types";
import {
  detectLanguage,
  type ScriptLanguage,
  SCRIPT_LABELS,
} from "./language";
import {
  parseTargetLanguage,
  type LocalizationProfile,
  type TargetLanguage,
} from "./target-languages";

/**
 * 跨集编剧分析上下文（第二集及之后传入）。
 * - previousEpisodes：前面集数的场景摘要，让模型理解剧情延续。
 * - existingAssets：项目已确认资产（含 CHARACTER 的造型变体），要求模型复用、不得改名。
 * - episodeNumber：当前分集编号，>1 时与上述上下文配合注入跨集段落。
 */
export interface ScriptAnalysisContext {
  episodeNumber?: number;
  /** 海外转绘时由文本转风格阶段持久化，所有分集共享同一目标语种/文化。 */
  localizationProfile?: LocalizationProfile;
  previousEpisodes?: Array<{
    episodeNumber: number;
    title?: string | null;
    sceneSummaries?: Array<{ id: string; location: string; characters: string[]; contentExcerpt: string }>;
  }>;
  existingAssets?: Array<{
    kind: string;
    name: string;
    description?: string;
    costumes?: CostumeVariant[];
    coverageScenes?: string[];
  }>;
}

function buildScriptLocalizationSection(
  profile: LocalizationProfile | undefined,
  language: ScriptLanguage,
): string {
  if (!profile || (!profile.stylePrompt?.trim() && !profile.targetLanguage)) return "";
  const target = profile.targetLanguage;
  const targetSummary = target
    ? `${target.zh} / ${target.native} / ${target.en}; culture=${target.cultureHint}`
    : "由下方目标风格要求确定";
  const stylePrompt = target
    ? `${target.zh} / ${target.cultureHint}`
    : (profile.stylePrompt?.trim() || "（未提供）");

  if (language === "en") {
    return [
      "## Authoritative Localization Profile (highest priority)",
      `- Target language/culture: ${targetSummary}`,
      `- User target style: ${stylePrompt}`,
      "- Keep character, location, organization, and prop names aligned with this profile and use the target-language name only; do NOT keep bilingual identifiers or parenthesized Chinese-original names.",
      "- Dialogue, visible text, ethnicity/nationality cues, architecture, clothing, and customs must agree with this profile; Chinese production narration alone is not evidence of East Asian identity.",
    ].join("\n");
  }

  return [
    "## 权威本地化档案（最高优先级）",
    `- 目标语种/文化：${targetSummary}`,
    `- 用户目标风格：${stylePrompt}`,
    "- 角色、地点、机构、道具名称必须与该档案及转绘后的原文一致，且只用目标语言名；不得保留中文原名或“源名(目标语名)”双语括号对照。",
    "- 对白、画面文字、人种/国籍线索、建筑、服装与习俗必须互相一致；中文制作叙述本身不能作为东亚身份依据。",
  ].join("\n");
}

/**
 * 构造「前集资产与剧情延续」段落（第二集及之后注入）。
 * 列出前集场景摘要 + 已确认资产（CHARACTER 项含造型变体），要求模型复用、不得改名。
 * 双语：language='en' 时输出英文段落，否则中文。
 */
function buildCrossEpisodeSection(ctx: ScriptAnalysisContext, language?: ScriptLanguage): string {
  const lang: ScriptLanguage = language ?? "zh";
  const isEn = lang === "en";
  const { previousEpisodes, existingAssets, episodeNumber } = ctx;
  const lines: string[] = isEn
    ? ["## Previous Episode Assets & Continuity"]
    : ["## 前集资产与剧情延续"];

  // 前集场景摘要
  if (previousEpisodes && previousEpisodes.length > 0) {
    lines.push("", isEn ? "### Previous Episode Plot Overview (reference only; do not invent new plot)" : "### 前集剧情概览（仅供连贯性参考，不得据此发明新剧情）");
    for (const ep of previousEpisodes) {
      const epTitle = ep.title ? ` · ${ep.title}` : "";
      lines.push(isEn ? `Episode ${ep.episodeNumber}${epTitle}:` : `第 ${ep.episodeNumber} 集${epTitle}：`);
      const scenes = ep.sceneSummaries || [];
      if (scenes.length === 0) {
        lines.push(isEn ? "  (no scene summaries)" : "  （无场景摘要）");
      } else {
        for (const s of scenes) {
          const chars = (s.characters || []).join(isEn ? ", " : "、");
          const excerpt = (s.contentExcerpt || "").replace(/\s+/g, " ").trim();
          const short = excerpt.length > 80 ? excerpt.slice(0, 80) + "…" : excerpt;
          const rolePrefix = isEn ? ` Characters: ${chars}` : ` 角色：${chars}`;
          lines.push(`  ${s.id} [${s.location}]${chars ? rolePrefix : ""} — ${short}`);
        }
      }
    }
  }

  // 已确认资产清单（含造型变体）
  if (existingAssets && existingAssets.length > 0) {
    const KIND_LABEL = isEn
      ? { CHARACTER: "Characters", PROP: "Props", LOCATION: "Locations" }
      : { CHARACTER: "角色", PROP: "物品", LOCATION: "环境" };
    lines.push("", isEn ? "### Existing Asset List (must reuse, do not rename / do not recreate)" : "### 已有资产清单（必须复用，禁止改名/禁止重复创建）");
    for (const kind of ["CHARACTER", "PROP", "LOCATION"] as const) {
      const items = existingAssets.filter((a) => a.kind === kind);
      if (items.length === 0) continue;
      lines.push(`- ${KIND_LABEL[kind]}：`);
      for (const a of items) {
        const desc = a.description ? `：${a.description}` : "";
        if (kind === "CHARACTER" && a.costumes && a.costumes.length > 0) {
          const costumeDesc = a.costumes
            .map((c) => isEn
              ? `${c.label} (coverage scenes: ${(c.coverageScenes || []).join(", ") || "unmarked"})`
              : `${c.label}（覆盖场景：${(c.coverageScenes || []).join("、") || "未标注"}）`)
            .join(isEn ? "; " : "；");
          lines.push(isEn ? `  · ${a.name}${desc} 【existing costumes: ${costumeDesc}】` : `  · ${a.name}${desc} 【已有造型：${costumeDesc}】`);
        } else {
          lines.push(`  · ${a.name}${desc}`);
        }
      }
    }
  }

  const epHint = episodeNumber && episodeNumber > 1
    ? (isEn
        ? `\nThis is episode ${episodeNumber}. The previous-episode overview above is for CONTINUITY REFERENCE ONLY (keep characters/plot/style consistent; do not rename existing assets). You must structure ONLY the source text actually provided for THIS episode. STRICTLY FORBIDDEN: inventing any new plot beat, scene, character, prop, or dialogue line that is not present in this episode's source text. Previous episode data may be in another language; prioritize current episode language for output.`
        : `\n本集为第 ${episodeNumber} 集。上方前集剧情仅供**连贯性参考**（保持角色/剧情/风格一致，不得改名已有资产）。你**只能结构化「本集用户实际提供的原文」**。【严禁】发明本集原文中不存在的任何新剧情、新场景、新角色、新道具或新台词。`)
    : "";

  if (isEn) {
    lines.push(
      "",
      "## Costume Scene-Matching Requirements",
      "",
      "1. For each scene, identify every appearing character's costume and match it to the existing costume list above.",
      "2. If a character's costume this episode matches an existing one, use that existing costume's label directly in the costume table.",
      `3. If a character appears in a NEW costume not in the existing list, mark "New Costume" at the end of that row, and describe the new costume concretely in the costume description (top/pants/shoes/material/color/accessories) for later extraction as a new costume variant.`,
      "4. Character names must exactly match the existing asset list. Do not rename, do not add aliases/variant names; a new costume is just a new outfit variant of the same character, not a new character.",
      "5. A character wears only one costume per scene; list separately when changing across scenes.",
      epHint
    );
  } else {
    lines.push(
      "",
      "## 服装造型场景匹配要求",
      "",
      "1. 逐场景识别每个出场角色穿着的服装造型，并与上述「已有造型」清单对应。",
      "2. 若角色本集穿着的服装与某已有造型一致，造型表中直接使用该已有造型的 label。",
      "3. 若角色本集出现「已有造型清单中不存在」的新服装造型，必须在造型表对应行末标注「新造型」，并在「造型说明」中具体描述该新服装（上衣/裤子/鞋子/材质/颜色/配饰），便于后续提取为新的造型变体。",
      "4. 角色名必须与已有资产清单完全一致，禁止改名、禁止新增别名/变体名；新造型只是同一角色的新服装变体，不是新角色。",
      "5. 同一角色在同一场景只穿一套造型；跨场景换装时分别列出。",
      epHint
    );
  }

  return lines.filter((l) => l !== "").join("\n");
}

/**
 * 构造「## 服装造型表填写要求」段落（所有集都注入，包括 ep1）。
 *
 * 与 buildCrossEpisodeSection 中的「## 服装造型场景匹配要求」不同：
 * - 本段是关于「如何填写造型表」的通用规则（格式、归并、差异化），ep1+ 都注入。
 * - 「## 服装造型场景匹配要求」是关于「与已有造型清单匹配」的跨集规则，仅 ep2+ 注入。
 *
 * 当 costume table 在输出格式段已有示例时，本段强化规则、强调必填、补齐归并/差异化规则。
 */
function buildCostumeTableFillingSection(language: ScriptLanguage): string {
  const isEn = language === "en";
  if (isEn) {
    return [
      "## Costume Table Filling Requirements (MANDATORY — affects later costume variant extraction)",
      "",
      "The Costume Table block at the end of the screenplay is a HARD REQUIREMENT, not optional.",
      "For every scene, for every character appearing in that scene, output exactly one row recording their costume.",
      "Skipping rows causes downstream asset extraction to miss costume variants — the character will end up with only a \"default\" costume.",
      "",
      "Format: `S{sceneNumber} / {CharacterName} / {costumeLabel} / {costumeDescription} / [New Costume]`",
      "  - costumeLabel: a short tag summarizing the costume (e.g. casual, formal, battle-worn, night-op, gown, travel, sleepwear, uniform, armor, swimsuit, coat, disguised). Reuse the same label when the same character wears the same outfit across scenes; use a new label when the outfit changes.",
      "  - costumeDescription: concretely describe the outfit appearance (top/pants/shoes/material/color/accessories); the more specific the better — this text will be used downstream as the costume variant description for image generation.",
      "  - [New Costume]: only mark \"New Costume\" at the end of the row when this outfit has not appeared for the character before; if same as previous scenes, do not mark.",
      "  - Every appearing character in every scene MUST have one row; do not omit any.",
      "  - Merge similar outfits: if two scenes show the same outfit (same garment type + color + material), use the same label. Differentiate only when at least one visual detail differs.",
      "  - Different costumes of the same character MUST differ in at least 3 visual details (color, garment type, accessory, footwear, etc.).",
    ].join("\n");
  }
  return [
    "## 服装造型表填写要求（强制 — 影响后续造型变体提取）",
    "",
    "剧本末尾的「造型表」块是硬性要求，不是可选项。",
    "对每个场景中每个出场的角色，必须输出一行记录其服装造型。",
    "漏行会导致下游资产提取遗漏造型变体——该角色最终只会得到一个 \"default\" 造型。",
    "",
    "格式：`S{场景编号} / {角色名} / {造型label} / {造型说明} / [新造型]`",
    "  - 造型label：用简短标签概括该造型（如 便装/正装/战损/夜行/礼服/旅行装/睡衣/制服/盔甲/泳装/外套/伪装）。同一角色跨场景穿同一套服装时 label 保持一致，换装时用新 label。",
    "  - 造型说明：具体描述该造型的服装外观（上衣/裤子/鞋子/材质/颜色/配饰），越具体越好——此文本将作为下游造型变体生图的描述。",
    "  - [新造型]：仅当该造型是角色此前未出现过的新服装时，在行末标注\"新造型\"；若与前几场相同则不标注。",
    "  - 每个场景的每个出场角色都必须有一行，不得遗漏。",
    "  - 相似服装归并：若两个场景是同一套服装（同款+同色+同材质），用相同 label；只在至少一个视觉细节不同时才区分。",
    "  - 同一角色的不同造型必须在至少 3 个视觉细节上有差异（颜色、服装类型、配饰、鞋类等）。",
  ].join("\n");
}

/**
 * 构造编剧分析提示词
 * 将用户输入的小说/剧本文本转化为标准格式的剧本
 * 输出格式遵循「剧本解析」需求: 场景列表 + 剧本正文 + 信息点 + 场景元信息 + 造型表
 *
 * 第二集及之后：可传入 context（前集场景摘要 + 已确认资产含造型），注入「前集资产与剧情延续」
 * 与「服装造型场景匹配要求」段落，并要求输出「造型表」匹配场景与角色服装造型。
 *
 * @param novelText - 原始小说/剧本文本
 * @param enhancementPrompt - （可选）用户增强指导，非空时作为「用户增强指导」段落注入 systemPrompt，
 *                            用于指导角色/场景/资产提取方向（如突出某角色线、精简配角、保留原语言等）
 * @param context - （可选）跨集上下文，episodeNumber>1 且非空时注入跨集段落
 */
export function buildScriptAnalysisPrompt(
  novelText: string,
  enhancementPrompt?: string,
  context?: ScriptAnalysisContext,
  language?: ScriptLanguage
): { system: string; user: string } {
  const lang: ScriptLanguage = language ?? detectLanguage(novelText);
  const isEn = lang === "en";
  const enhancementSection = enhancementPrompt && enhancementPrompt.trim()
    ? (isEn
        ? `\n\n## User Enhancement Guidance (must strictly follow)\n\n${enhancementPrompt.trim()}`
        : `\n\n## 用户增强指导（须严格遵守）\n\n${enhancementPrompt.trim()}`)
    : "";

  // 跨集上下文段落（仅当 episodeNumber>1 且有前集/资产数据时注入）
  const hasCrossEpisode = context && context.episodeNumber && context.episodeNumber > 1 &&
    ((context.previousEpisodes && context.previousEpisodes.length > 0) ||
     (context.existingAssets && context.existingAssets.length > 0));
  const crossEpisodeSection = hasCrossEpisode ? buildCrossEpisodeSection(context!, lang) : "";
  const localizationSection = buildScriptLocalizationSection(context?.localizationProfile, lang);

  // 服装造型表填写要求段（所有集都注入，强化造型表必填 + 归并 + 差异化规则）
  const costumeTableFillingSection = buildCostumeTableFillingSection(lang);

  const systemCore = isEn
    ? buildScriptAnalysisSystemEn(crossEpisodeSection, costumeTableFillingSection)
    : buildScriptAnalysisSystemZh(crossEpisodeSection, costumeTableFillingSection);
  const system = systemCore + (localizationSection ? `\n\n${localizationSection}` : "") + enhancementSection;

  const user = novelText;

  return { system, user };
}

/**
 * 中文模式 system prompt（保持原有行为，回归安全）。
 */
function buildScriptAnalysisSystemZh(crossEpisodeSection: string, costumeTableFillingSection: string): string {
  return [
    '你是一位专业的影视编剧和剧本结构分析师，根据输入的原剧本风格与台词、字幕等保持一致性。将用户提供的小说/故事文本转化为标准格式的影视剧本。',
    '',
    '【重要】直接输出剧本内容，不要输出任何前言、解释、确认语。不要说"好的""我来分析""以下是"等。第一行必须是"场景列表"。',
    '',
    '## 核心原则：按「地点 + 连续时间段」划分场景',
    '',
    '一个「场景」= 同一地点内连续发生的一段戏。地点不变且时间连续时，所有事件合并到同一个场景编号；',
    '地点变化，或发生会改变光线、人物状态、布景状态与叙事阶段的明确时间跳跃时，才新建 S 编号。',
    '内容过载由后续分镜阶段拆成镜头或生成片段；不要仅因内容长、情绪变化或冲突升级而拆场。',
    '',
    '【硬规则】location 相同且时间连续的相邻内容必须合并；只有地点变化或明确跨越时间段，才允许新建 S 编号。',
    '  - 短时连续（如"三分钟后"且人物、光线、布景状态连续）：不拆分',
    '  - 跨时段（如"次日清晨"、昼夜变化、人物离场后重新进入）：即使地点相同也应拆分，以建立新的连续性锚点',
    '  - 情绪/氛围突变：若仍同一地点，不要拆分',
    '  - 核心冲突切换：若仍同一地点，不要拆分',
    '',
    '【错误示例】手术室发生 20 个镜头 → 输出 S1~S20（全部手术室，过度碎片化）',
    '【错误示例】同一台手术连续进行时，仅因内容较长拆为 S1~S20',
    '【正确示例】连续手术过程合并为 S1；若明确跳到次日复查，则建立新的场景编号和连续性锚点',
    '',
    '典型场景数量：短篇 3~6 个场景，中篇 6~12 个场景，长篇不超过 20 个场景。',
    '如果同地点内容处在同一连续时间段，必须合并；若时间跳跃改变了连续性状态，则保留独立场景。',
    '',
    // 跨集上下文段落（第二集及之后注入：前集剧情 + 已确认资产含造型 + 造型匹配要求）
    ...(crossEpisodeSection ? [crossEpisodeSection, ''] : []),
    // 服装造型表填写要求段（所有集都注入：必填 + 归并 + 差异化规则）
    ...(costumeTableFillingSection ? [costumeTableFillingSection, ''] : []),
    '## 输出格式（严格按此结构，不要加任何额外标题或说明）',
    '',
    '场景列表',
    'S1',
    '地点·时间·内外景',
    'S2',
    '地点·时间·内外景',
    '',
    '## S1 [地点 · 时间 · 内外景] 角色：角色1 / 角色2',
    '',
    '△动作/画面描述',
    '',
    '角色名（情绪）：台词',
    '',
    '△同一场景内的后续动作和对白继续写在这里，不要另起场景编号',
    '',
    '## S2 [地点 · 时间 · 内外景] 角色：角色1',
    '',
    '△动作描述',
    '',
    '信息点',
    '冲突升级  描述内容',
    '打脸  描述内容',
    '新目标  描述内容',
    '',
    'E1S1 采石场',
    '时间/场景  午 / 外',
    '出场人物  阿灵、苍尘',
    '场景画风  仙侠写实风',
    '',
    '造型表',
    '【填写规则见上方「服装造型表填写要求」段；每个场景的每个出场角色都必须有一行，不得遗漏】',
    '【示例】',
    '造型表',
    'S1 / 林夏 / 便装 / 白色棉质T恤、浅蓝色牛仔裤、白色帆布鞋、黑色双肩包 / 新造型',
    'S2 / 林夏 / 便装 / 白色棉质T恤、浅蓝色牛仔裤、白色帆布鞋、黑色双肩包',
    'S3 / 林夏 / 正装 / 深灰色西装套装、白色衬衫、黑色皮鞋、银色领带夹 / 新造型',
    'S1 / 赵默 / 风衣 / 黑色长款风衣、深色高领毛衣、黑色皮靴、银色项链 / 新造型',
    '',
    '## 格式规则',
    '',
    '场景标题：## S{序号} [地点 · 时间 · 内外景] 角色：{角色列表}',
    '【角色名·逐字约束】角色列表里的每个名字必须逐字出现在原文中（服务端会做 novelText.includes(角色名) 校验，编造的名字命中率<30% 会导致整个分析被拒）。原文无命名角色时（宣传片/纪录片/说明文/分镜脚本），直接用原文出现的泛称（如"大一新生""学生""旁白""女主"），绝不编造具体人名。',
    '动作描述：△ 开头',
    '对白：角色名（情绪）：台词  （无特殊情绪可省略括号）',
    '内心独白：角色名OS：内容',
    '站位布局（多角色场景必填，单角色场景省略）：凡场景中出现 2 个及以上角色，在场景标题行之后、第一个 △ 之前写一行「站位布局：用场景中的角色名，为每个角色列出在画面中的固定空间位置」，要求角色名与位置一一配对、每个角色都要绑定一个位置、不得只列空位、角色数须等于位置数、不得用「司机/副驾」等功能位替代角色名。固定空间场景（车内、餐桌、会议桌、手术台、审讯室等）写精确座位方位，如「站位布局：林夏(左前·驾驶位)、赵默(右前·副驾)、王五(后排左)、李四(后排右)」；自由调度场景（客厅对话、走廊、空地、办公室等）写开场时各角色的相对画面位置与姿态，如「站位布局：林夏(画面左·站立)、赵默(画面右·坐在沙发)、王五(后景·靠窗)」。追逐/打斗等位置持续变化的场景写开场站位即可。该布局用于跨镜保持角色相对位置一致，只描述空间占位，不描述动作。',
    '',
    '### 下游生产数据契约',
    '- 每场必须能独立回答：谁在何处、开场状态是什么、完成了什么可见动作、结束状态发生了什么变化；缺一项就先补齐再输出',
    '- 人物、道具、门窗、光源的方位与持有关系必须可从上一动作连续推导；不得无动作瞬移、换手、换装或凭空出现/消失',
    '- 每句对白必须绑定说话人和可见表演，长对白要有自然停顿或反应动作，避免后续镜头无法在时长内完成口型',
    '- 场景元信息与正文必须同源：角色、地点、时间、内外景、关键道具不得互相矛盾；造型表必须覆盖正文中的每次换装',
    '',
    '### 情绪标签约束（防视频生成失控）',
    '- 情绪标签禁止使用抽象单词（如"生气"、"愤怒"、"悲伤"、"快乐"等），AI 无法精确控制',
    '- 必须用功能性描述替代：写具体面部特征/身体姿态/声音特质',
    '- 示例：',
    '  ❌ "愤怒" → ✅ "眉头紧皱、嘴角下压、声音低沉"',
    '  ❌ "悲伤" → ✅ "眼眶微红、视线向下、呼吸浅"',
    '  ❌ "紧张" → ✅ "手指微颤、眼神闪躲、喉结滚动"',
    '  ❌ "开心" → ✅ "嘴角上扬、眼睛发亮、语速加快"',
    '- 情绪强度须适度克制，避免过度夸张（如"暴怒"、"狂喜"、"崩溃"），视频 AI 无法稳定呈现',
    '- 角色情绪变化须有视觉过渡（表情渐变/呼吸变化/姿态调整），禁止情绪突变',
    '',
    '信息点类型：冲突升级、打脸、新目标、新风险、反转、身份揭示、悬念、情感推进、伏笔',
    '',
    '## 内容要求',
    '1. 忠于原文，不添加原文中没有的情节；合理补充环境描写和动作细节',
    '2. 对白符合角色身份和性格，保持场景连贯性',
    '3. 【必须】最后必须输出"信息点"和"E1S1"场景元信息，不可省略',
    '4. 【对白语言必须与原文一致】原文用什么语言写对白，剧本中的台词就用什么语言。原文是中文就对白用中文，是英文就用英文，是其他语言就用相应语言。禁止擅自翻译或转换对白语言。',
    '5. 【角色名/地点名语言一致性·硬性约束】场景标题"角色："后的角色名、场景地点名、对白中的角色名，必须与原文中该名字出现时的语言完全一致，禁止意译、音译或本地化。原文是英文则角色名用英文（如"Woman in Black"），原文是中文则用中文。角色名作为标识符，即使对白语言需转换，角色名本身也不得翻译。',
    '',
    '## 编导思维（浓缩版 · 影响场景拆分与描写质量）',
    '',
    '### 张力判断',
    '- 每个场景明确：主爆点（最多1-2个）、首次有效钩子时机（默认前20-30秒）',
    '- 镜头功能分层：铺垫（<=3-4个连续）/推进（结束状态须变化）/攻击（每15-25秒至少1个）',
    '- 段尾/集尾落在「动作/反应/钩子」，不落在解释',
    '- 爆点段必须有反应/停顿/压迫/声音反差，不只是台词；增强张力优先增强镜头调度/人物反应/声音反差/节奏切换，而不是改台词',
    '',
    '### 画面描述写法标准（△动作/画面描述行）',
    '- 禁止灌水："某人震惊"→要写表情/动作/关系落点；"特效爆发"→要写来源/形态/方向/环境反馈',
    '- 禁止空泛充数："前中后景关系清楚""镜头关注中心""人物处在主位"一律删除',
    '- 禁止重复场次编号，场景锚点只需在切场首镜弱提示一次',
    '- 推荐结构：场景锚点 + 人物出场方向 + 站位层次(前/中/后景) + 镜头焦点 + 当前动作落点 + 环境反馈',
    '- 两人以上场景必须写清：谁从哪个方向入镜、谁占左前/右后/高位/低位、谁挡住谁、镜头结束时位置是否变化',
    '- 弱写法："两个人在空中打斗" → 强写法："少女从画面左下方向上反冲，男主在右后高位回身拦截"',
    '- 弱写法："山路上有一辆马车在跑" → 强写法："冷月夜色压住整条官路，马车上的一点暖灯火落在画面中部成为视觉中心"',
    '',
    '### 动作写法标准',
    '- 动作不是把画面内容原句再说一遍，要交代：起点→方向→落点→对手反应→衔接下一镜',
    '- 禁写模板话："完成对应表演""按原动作完成走位"',
    '- 对白镜头动作：人物如何说、视线落向哪里、说完谁接反应',
    '- 反应镜头动作：先表情还是先肢体、停顿多久、情绪怎么传导',
    '',
    '### 声音提示写法',
    '- 只写：对白/VO/OS/环境声/动作声/特效声/声音反差',
    '- 禁止写：背景音乐/配乐/BGM/煽情音乐/收尾音乐/字幕音效',
    '- VO应写：镜头内正在看什么 + 画外音如何进入 + 是否压低现场环境声',
    '- OS应写：人物表情、呼吸、停顿、眼神如何承接独白',
    '',
    '### 台词处理硬规则',
    '- 默认不得擅自改写/润色/缩写/换词/重组语序原台词',
    '- 可以决定哪句台词放哪个场景、前后补什么动作/停顿/反应/运镜',
    '- 【台词完整性·强制】必须把原文每一条带说话人的台词 1:1 收进分镜表，不得以"非关键/过场/短句"为由省略、合并或漏抄。单字叫名（如"Leo."）、状态询问（如"Campus security?"）、汇报体（如"...报告完毕/风险评估已完成"）同样必须逐字收录——漏一句会让后镜的回应失去前置、台词链断裂。明确禁止"只引用关键台词"。',
    '- 【标点·逐字保留】台词与正文里的所有标点必须原样保留，不得截断、转义、规范化或美化（不要把弯引号转直引号、不要给没引号的台词加引号、不要改省略号/破折号）。尤其：英文台词里的撇号是词内缩写字符，不是引号闭合符——绝不据此断句或截断台词。输出 JSON 时撇号就是普通字符串内容，不要额外转义。',
    '- 增强张力时优先增强镜头调度/反应/声音反差，而不是改台词',
    '',
    '### 情感短剧高张力规则（羞辱/偷听/对峙/断裂/觉醒场景适用）',
    '- 羞辱戏：优先拍出三段打击（环境失衡→关系失衡→主观受伤：停住/耳鸣/眼神空掉/手指发紧）',
    '- 偷听/发现真相：声音先到理解后到，或画面先到反应后炸，先给停顿和吸收过程',
    '- 对峙戏：补清压制关系（谁逼近/谁后退/谁占高位/谁被卡到边缘/镜头结束时位置变化）',
    '- 断裂/觉醒戏：给一个清晰可视化动作锚点（解发/松手/转身/让位/关门/撕纸/摔杯）',
    '- 集尾优先收在：人物即将做什么 / 刚做出不可逆动作 / 钩子台词落在动作之后',
    '',
    '### 编导禁忌自检（出稿前逐条对照）',
    '',
    '#### 叙事逻辑类（底层红线）',
    '- 禁无意义炫技：平淡对话硬加360°环绕/希区柯克变焦（运镜是否服务于叙事目的？去掉是否影响表达？）',
    '- 禁无理由跳切：同机位同景别同主体直接拼接（相邻镜头至少一项差异化）',
    '- 禁视线与动作脱节：上一镜看左→下一镜内容在右（上一镜看的方向=下一镜呈现的内容）',
    '',
    '#### 影视语法类（专业硬规则）',
    '- 禁无技巧越轴：对话戏突然换侧拍无过渡（机位保持轴线同侧，或用中性镜头/特写/人物运动越轴）',
    '- 禁违反30°规则：同景别角度差<30°→肉眼跳感（角度差≥30°或景别不同）',
    '- 禁景别无逻辑跳级：全景直接切大特写（跳级须有冲击力目的，否则加过渡镜）',
    '- 禁运动方向冲突：同轴线前后镜头方向相反（汽车左行→下一镜不能右来）',
    '',
    '#### AI智能体专属禁忌（高频踩坑）',
    '- 禁参数逻辑矛盾：24mm广角大特写 / f/16浅景深（广角=全景中景，长焦=近景特写）',
    '- 禁时空逻辑断裂：白天室内→夜晚室外无转场（连续场景保持光线/时间一致）',
    '- 禁机位空间崩坏：对话戏机位围着人乱转（建虚拟平面图标定机位）',
    '- 禁物理可行性失效：0.5秒升50米 / 室内360°环绕（人步行1.5m/s，升降0.5m/s）',
    '- 禁镜头功能同质化：连续多镜只有内容差异无功能区分（每镜唯一标签：说话/反应/细节/关系/环境）',
    '- 禁纯停顿帧/时间凝固：视频是连续运动的时间流，静止帧=抽掉时间维度，一律改写为"线性倍速减慢"/"缓慢减速"保持运动连续性',
    '',
    '### 反平铺检查清单',
    '- 前20-30秒内有有效钩子？无3+连续镜头重复同信息？',
    '- 爆点镜头有反应/停顿/压迫/声音设计？全段至少3个封面帧？',
    '- 集尾有明确下一步承接力？两项以上答不上来→继续加强'
  ].join('\n');
}

/**
 * 英文模式 system prompt：逐条翻译中文版全部规则，结构标签用英文。
 * 文化背景必须由原文/本地化档案决定；英文只是输出语言，不能被当作人种或地域信号。
 */
function buildScriptAnalysisSystemEn(crossEpisodeSection: string, costumeTableFillingSection: string): string {
  return [
    'You are a professional screenwriter and script structure analyst. Transform the user-provided novel/story text into a standard formatted screenplay, keeping consistency with the source text style, dialogue, and subtitles.',
    '',
    '[IMPORTANT] Output the screenplay directly. No preface, no explanation, no confirmation. Do not say "Sure" "Let me analyze" "Here is" etc. The first line MUST be "Scene List".',
    '',
    '## Source-Locale and Cultural Coherence',
    'Infer the cultural setting from explicit source evidence and preserve it consistently across scenes, characters, names, props, architecture, customs, and historical period. English is an output language, not evidence that the story or its characters are Western.',
    '',
    '### Cultural Background & Historical Period Coherence',
    '- Identify the implied era from the source text and keep every element consistent with that period (19th-century Victorian → gas lamps, corsets, carriages; modern-day → smartphones, subway, SUVs).',
    '- Do NOT mix eras: no anachronistic props, fashion, or architecture. When locale or era is not established, remain culturally neutral instead of defaulting to a country, ethnicity, or Western setting.',
    '',
    '### Characters — Source-Grounded Identity',
    '- Keep character names exactly as established by the source/localization input; never replace them merely because the screenplay is written in English.',
    '- Describe ethnicity, nationality, facial traits, clothing, and social behavior only from explicit or strongly implied story evidence. Do not invent them from language alone and do not use cultural stereotypes.',
    '- Preserve each character\'s source-grounded personality, family structure, and motivations instead of rewriting them into a regional archetype.',
    '',
    '### Props & Customs — Era- and Locale-Appropriate',
    '- Props must match the era\'s technology level and established locale; no anachronistic objects. Locale-specific symbolism may be used only when supported by the source.',
    '- Use region-specific architecture, daily-life conventions, religious symbols, gestures, and text-bearing props only when supported by the established locale.',
    '- Do not import customs from another culture merely to make the scene look more "English" or "international".',
    '',
    '## Core Principle: Divide Scenes by Location + Continuous Time Envelope',
    '',
    'One "scene" = a continuous dramatic passage at one location. Merge events when both location and time continuity are unchanged.',
    'Create a new S number when the location changes or an explicit time jump changes lighting, character state, set state, or narrative phase.',
    'Content overload is handled later by shots or generation clips; never split a scene merely because it is long, emotionally complex, or conflict-heavy.',
    '',
    '[Hard Rule] Adjacent content with the same location and continuous time MUST be merged. A location change or clear time-envelope change may create a new S number.',
    '  - Short continuous gap (e.g. "three minutes later" with unchanged people, light, and set state): do not split',
    '  - New time envelope (e.g. "the next morning", day-to-night, or characters leave and later re-enter): split even at the same location so continuity can re-anchor',
    '  - Mood/atmosphere shift: if still the same location, do not split',
    '  - Core conflict switch: if still the same location, do not split',
    '',
    '[Wrong Example] 20 shots in an operating room → output S1~S20 (all operating room, over-fragmented)',
    '[Wrong Example] One continuous operation → create S1~S20 merely because the passage is long',
    '[Correct Example] Keep the continuous operation in S1; if the story explicitly jumps to next-day follow-up, open a new scene and continuity anchor',
    '',
    'Typical scene count: short story 3~6 scenes, mid-length 6~12 scenes, long story no more than 20 scenes.',
    'Merge repeated location content inside one continuous time envelope. Keep separate scene numbers when a clear time jump changes continuity state.',
    '',
    // 跨集上下文段落（第二集及之后注入：前集剧情 + 已确认资产含造型 + 造型匹配要求）
    ...(crossEpisodeSection ? [crossEpisodeSection, ''] : []),
    // 服装造型表填写要求段（所有集都注入：必填 + 归并 + 差异化规则）
    ...(costumeTableFillingSection ? [costumeTableFillingSection, ''] : []),
    '## Output Format (strictly follow this structure, do not add any extra headings or explanation)',
    '',
    'Scene List',
    'S1',
    'Location·Time·Int/Ext',
    'S2',
    'Location·Time·Int/Ext',
    '',
    '## S1 [Location · Time · Int/Ext] Characters: Character1 / Character2',
    '',
    '△Action/visual description',
    '',
    'Character (emotion): dialogue',
    '',
    '△Subsequent action and dialogue within the same scene continue here; do not start a new scene number',
    '',
    '## S2 [Location · Time · Int/Ext] Characters: Character1',
    '',
    '△Action description',
    '',
    'Info Points',
    'Conflict Escalation  description',
    'Reversal  description',
    'New Goal  description',
    '',
    'E1S1 Quarry',
    'Time/Scene  Noon / Ext',
    'Characters  Aling, Cangchen',
    'Art Style  realistic cinematic consistent with the established locale',
    '',
    'Costume Table',
    '[See the "Costume Table Filling Requirements" section above for filling rules; every appearing character in every scene MUST have one row — do not omit any]',
    '[Example]',
    'Costume Table',
    'S1 / Lin Xia / casual / white cotton T-shirt, light blue jeans, white canvas shoes, black backpack / New Costume',
    'S2 / Lin Xia / casual / white cotton T-shirt, light blue jeans, white canvas shoes, black backpack',
    'S3 / Lin Xia / formal / dark gray suit, white shirt, black leather shoes, silver tie clip / New Costume',
    'S1 / Zhao Mo / trench / black long trench coat, dark turtleneck sweater, black leather boots, silver necklace / New Costume',
    '',
    '## Format Rules',
    '',
    'Scene header: ## S{number} [Location · Time · Int/Ext] Characters: {character list}',
    'Action description: starts with △',
    'Dialogue: Character (emotion): dialogue  (parentheses may be omitted when no special emotion)',
    'Inner monologue: Character OS: content',
    'Spatial Layout (optional; required for multi-character fixed-space scenes): when 2 or more characters share a fixed spatial relationship (car interior, dining table, conference table, operating table, interrogation room, etc.), write one line "Spatial Layout: list each character\'s fixed position by name and seat" right after the scene header and before the first △, e.g. "Spatial Layout: Lin Xia (front-left·driver), Zhao Mo (front-right·passenger), Wang Wu (rear-left), Li Si (rear-right)"; pair each character name with one position, bind every character to a position, never list bare seats, never use functional roles like "driver/passenger" in place of character names, and the number of characters must equal the number of positions; omit the line for single-character scenes or scenes without fixed positions (chases, fights) — do not output a blank line. This layout keeps positions consistent across shots; describe spatial occupancy only, not actions.',
    '',
    '### Downstream Production Data Contract',
    '- Every scene must independently establish who is where, the opening state, the visible action completed, and the changed end state; fill any missing element before output.',
    '- Positions and ownership of characters, props, doors/windows, and light sources must follow continuously from prior actions; no unexplained teleporting, hand-swaps, costume changes, appearances, or disappearances.',
    '- Bind every spoken line to its speaker and a visible performance beat. Give long dialogue natural pauses or reaction actions so later shots can fit the lip performance into their duration.',
    '- Scene metadata and body text must share one source of truth: characters, location, time, Int/Ext, and key props may not contradict each other; the Costume Table must cover every costume change in the body.',
    '',
    '### Emotion Tag Constraints (prevent video generation instability)',
    '- Emotion tags MUST NOT use abstract single words (e.g. "angry", "furious", "sad", "happy") — AI cannot precisely control these',
    '- MUST use functional descriptions: write concrete facial features / body posture / voice quality',
    '- Examples:',
    '  ❌ "angry" → ✅ "brows furrowed, lips pressed down, voice lowered"',
    '  ❌ "sad" → ✅ "eyes slightly red, gaze downward, shallow breathing"',
    '  ❌ "nervous" → ✅ "fingers trembling slightly, gaze darting, throat bobbing"',
    '  ❌ "happy" → ✅ "corners of mouth lifted, eyes brightened, speech tempo quickened"',
    '- Emotion intensity MUST be restrained; avoid hyperbolic words (e.g. "enraged", "ecstatic", "devastated") — video AI cannot stably render these',
    '- Character emotion changes MUST have visual transitions (expression gradual change / breathing shift / posture adjustment); no sudden emotion jumps',
    '',
    'Info point types: Conflict Escalation, Reversal, New Goal, New Risk, Twist, Identity Reveal, Suspense, Emotional Progression, Foreshadowing',
    '',
    '## Content Requirements',
    '1. Stay faithful to the source; do not add plot not present in the original. Reasonably supplement environment descriptions and action details.',
    '2. Dialogue must fit the character identity and personality; keep scene continuity.',
    '3. [MUST] The final output MUST include "Info Points" and "E1S1" scene metadata; do not omit.',
    '4. [Dialogue language MUST match the source] Whatever language the source uses for dialogue, the screenplay dialogue uses the same language. English source → English dialogue; Chinese source → Chinese dialogue. Do not translate or convert dialogue language.',
    '5. [Character/location name language consistency · hard constraint] Character names after "Characters:" in scene headers, scene location names, and character names in dialogue MUST exactly match the language in which they appear in the source. Do not translate, transliterate, or localize. English source → English names (e.g. "Woman in Black"); Chinese source → Chinese names. Character names are identifiers and must not be translated even if dialogue language needs conversion.',
    '',
    '## Directorial Thinking (condensed · affects scene splitting and description quality)',
    '',
    '### Tension Judgment',
    '- Each scene must clarify: main climax (at most 1-2), first effective hook timing (default first 20-30 seconds).',
    '- Shot function layering: setup (<=3-4 consecutive) / progression (end state must change) / attack (at least 1 every 15-25 seconds).',
    '- Paragraph/episode ending lands on "action/reaction/hook", not on explanation.',
    '- Climax segments must have reaction/pause/pressure/sound contrast, not just dialogue; when enhancing tension, prioritize enhancing shot blocking / character reaction / sound contrast / rhythm switching — not rewriting dialogue.',
    '',
    '### Visual Description Standard (△ action/visual lines)',
    '- No filler: "someone is shocked" → must write expression/action/relationship landing; "FX burst" → must write source/form/direction/environment feedback.',
    '- No vague padding: "foreground/midground/background clearly related" "lens focus center" "character in main position" — delete all of these.',
    '- Do not repeat scene numbers; the scene anchor only needs a weak hint once at the first shot of a cut.',
    '- Recommended structure: scene anchor + character entrance direction + blocking layers (front/mid/back) + lens focus + current action landing + environment feedback.',
    '- Scenes with two or more characters must clarify: who enters from which direction, who occupies front-left / back-right / high / low position, who blocks whom, whether positions change at the end of the shot.',
    '- Weak: "two people fighting in the air" → Strong: "the girl surges up from the lower-left of frame, the male lead turns back to intercept from the high back-right".',
    '- Weak: "a carriage runs on the mountain road" → Strong: "cold moonlight presses over the entire road; a single warm lamp on the carriage lands mid-frame as the visual center".',
    '',
    '### Action Description Standard',
    '- Action is not restating the visual content verbatim; it must convey: start point → direction → landing → opponent reaction → link to next shot.',
    '- Forbidden template phrases: "complete the corresponding performance" "complete the blocking as per original action".',
    '- Dialogue shot action: how the character speaks, where the gaze lands, who takes the reaction after the line.',
    '- Reaction shot action: expression first or body first, how long the pause, how emotion conducts.',
    '',
    '### Sound Cue Standard',
    '- Only write: dialogue/VO/OS/environment sound/action sound/FX sound/sound contrast.',
    '- Do NOT write: background music/score/BGM/sentimental music/end music/subtitle SFX.',
    '- VO should write: what the lens is currently looking at + how the voiceover enters + whether on-site environment sound is ducked.',
    '- OS should write: character expression, breathing, pause, how the gaze carries the monologue.',
    '',
    '### Dialogue Handling Hard Rules',
    '- By default, do not rewrite/polish/abbreviate/swap words/reorder the original dialogue.',
    '- You may decide which line goes in which scene, and what action/pause/reaction/camera move to add before/after.',
    '- You may quote only key lines in the storyboard table instead of copying all dialogue into the table.',
    '- When enhancing tension, prioritize enhancing shot blocking/reaction/sound contrast — not rewriting dialogue.',
    '',
    '### Emotional Short-Drama High-Tension Rules (for humiliation/eavesdropping/confrontation/breaking/awakening scenes)',
    '- Humiliation: prioritize capturing three strikes (environment imbalance → relationship imbalance → subjective injury: freeze/tinnitus/blank stare/clenched fingers).',
    '- Eavesdropping/truth discovery: sound arrives before understanding, or image arrives before reaction explodes; give a pause and absorption process first.',
    '- Confrontation: clarify the dominance relationship (who advances / who retreats / who holds high ground / who is pushed to the edge / whether position changes at shot end).',
    '- Breaking/awakening: give a clear visualizable action anchor (untying hair / letting go / turning away / yielding / closing door / tearing paper / smashing cup).',
    '- Episode ending preferably lands on: the character about to do something / having just done an irreversible action / a hook line landing after an action.',
    '',
    '### Directorial Taboo Self-Check (cross-check each item before delivery)',
    '',
    '#### Narrative Logic (bottom-line red lines)',
    '- No meaningless show-off: forcing 360° orbit / Hitchcock zoom onto flat dialogue (does the camera move serve the narrative purpose? does removing it affect expression?).',
    '- No unjustified jump cut: same angle, same shot size, same subject cut directly together (adjacent shots must differ in at least one aspect).',
    '- No gaze-action disconnect: previous shot looks left → next shot content is on the right (the direction looked at in the previous shot = the content presented in the next shot).',
    '',
    '#### Cinematic Grammar (professional hard rules)',
    '- No unmotivated axis crossing: a dialogue scene suddenly switches to the other side without transition (keep the camera on the same side of the axis, or cross the axis with a neutral shot / close-up / character motion).',
    '- No 30° rule violation: same shot size with angle difference <30° → visible jump (angle difference ≥30° or different shot size).',
    '- No illogical shot-size jump: full shot cut directly to extreme close-up (a jump must have an impact purpose, otherwise add a transitional shot).',
    '- No motion direction conflict: shots on the same axis with opposite directions (car going left → next shot must not come from the right).',
    '',
    '#### AI-Agent-Specific Taboos (frequent pitfalls)',
    '- No contradictory parameters: 24mm wide-angle extreme close-up / f/16 shallow depth of field (wide-angle = full/medium shot, telephoto = close-up).',
    '- No spacetime logic break: daytime interior → nighttime exterior without transition (continuous scenes keep light/time consistent).',
    '- No camera-space collapse: dialogue scene camera spinning around people (build a virtual floor plan to calibrate camera positions).',
    '- No physical-feasibility failure: rising 50m in 0.5s / 360° orbit indoors (walking 1.5m/s, crane 0.5m/s).',
    '- No shot-function homogenization: consecutive shots differing only in content with no function distinction (each shot needs a unique tag: speaking/reaction/detail/relationship/environment).',
    '- No pure freeze-frame / time frozen: video is a continuous flow of time; a static frame = stripping the time dimension. Always rewrite as "linear slow-motion" / "slow deceleration" to keep motion continuous.',
    '',
    '### Anti-Flat-Laying Checklist',
    '- Effective hook within the first 20-30 seconds? No 3+ consecutive shots repeating the same info?',
    '- Climax shots have reaction/pause/pressure/sound design? At least 3 cover frames in the whole segment?',
    '- Episode ending has a clear next-step carry? If two or more cannot be answered → keep strengthening.'
  ].join('\n');
}

/**
 * 构造「已有资产清单」段落（用于第二集及之后的文本转风格）。
 * 当传入非空 existingAssets 时，按 角色/物品/环境 分组列出，要求模型复用主角名、
 * 补充新资产推进剧情；与「语言转换」原则协调：若目标风格要求语言转换，资产名一并
 * 转换为对应语言的等价名，但同一资产在剧本中保持一致，不得改名或重复创建。
 * 当 existingAssets 为空/未传时返回空字符串（第一集/项目模式不注入）。
 */
function buildExistingAssetsSection(
  existingAssets?: Array<{ kind: string; name: string; description: string }>,
  episodeNumber?: number,
  language?: ScriptLanguage
): string {
  if (!existingAssets || existingAssets.length === 0) return "";
  const isEn = (language ?? "zh") === "en";

  const KIND_LABEL: Record<string, string> = isEn
    ? { CHARACTER: "Characters", PROP: "Props", LOCATION: "Locations" }
    : { CHARACTER: "角色", PROP: "物品", LOCATION: "环境" };
  // 按 kind 分组（仅保留有标签的三类，过滤 VOICE 等）
  const groups: Record<string, Array<{ kind: string; name: string; description: string }>> = {};
  for (const a of existingAssets) {
    const label = KIND_LABEL[a.kind];
    if (!label) continue;
    if (!groups[a.kind]) groups[a.kind] = [];
    groups[a.kind].push(a);
  }
  // 构造分组清单
  const groupLines: string[] = [];
  for (const kind of ["CHARACTER", "PROP", "LOCATION"]) {
    const items = groups[kind];
    if (!items || items.length === 0) continue;
    groupLines.push(`### ${KIND_LABEL[kind]}`);
    for (const a of items) {
      const desc = a.description ? `：${a.description}` : "";
      groupLines.push(`- ${a.name}${desc}`);
    }
    groupLines.push("");
  }
  if (groupLines.length === 0) return "";

  const episodeHint = isEn
    ? (episodeNumber && episodeNumber > 1
        ? `\nThis is episode ${episodeNumber}. You may ONLY structure or style-rewrite the source text the user actually provided for THIS episode. The existing asset list above exists ONLY to keep character/prop/location names consistent across episodes — it is NOT permission to continue or invent the plot. STRICTLY FORBIDDEN: writing any new plot beat, scene, character, prop, or dialogue line that does not appear in the source text provided for this episode. If the source for this episode is empty or the story has already ended, faithfully reproduce the prior ending as-is and add NOTHING new. Give target-style names ONLY to entities that genuinely first appear in this episode's source text.`
        : "\nThe existing asset list above exists ONLY to keep names consistent. You may ONLY structure or style-rewrite the source text actually provided. STRICTLY FORBIDDEN: inventing any new plot beat, scene, character, prop, or dialogue line not present in the source. If the source has ended, reproduce its ending faithfully and add NOTHING new.")
    : (episodeNumber && episodeNumber > 1
        ? `\n本集为第 ${episodeNumber} 集。你只能对「用户为本集实际提供的原文」做结构化拆解/风格转换。上方已有资产清单**仅用于保持角色/物品/环境名称在跨集间一致**，**绝不是授权你续写或发明剧情**。【严禁】写出本集原文中不存在的任何新剧情、新场景、新角色、新道具或新台词。若本集原文为空或剧情已结束，按原文结尾忠实呈现即可，**不得新增任何内容**。仅对本集原文中确属首次出现的新角色/物品/环境，才按目标风格起名。`
        : "\n上方已有资产清单**仅用于保持名称一致**。你只能对「用户实际提供的原文」做结构化拆解/风格转换。【严禁】发明原文中不存在的任何新剧情、新场景、新角色、新道具或新台词。若原文已结束，按原文结尾忠实呈现，不得新增任何内容。");

  if (isEn) {
    return [
      "## Existing Asset List (hard constraint: must reuse as-is, no renaming/translation/rewriting)",
      "",
      "The following assets are locked for this project; rewriting must strictly follow them:",
      "- [Hard constraint] Character/prop/location names in the existing asset list are locked identifiers of this project; they must be reused as-is.",
      "  Do not translate, rewrite, abbreviate, expand, or create variant names (e.g. if \"Grandpa Shen\" already exists, do not change it to \"Grandfather Sterling\").",
      "- Even if the target style requires language conversion, existing asset names do NOT participate in conversion — they are cross-episode stable identifiers and must keep their original names.",
      "- Only give target-style names to NEWLY ADDED characters/props/locations.",
      "- The same asset must keep a consistent name throughout the screenplay; do not rename or recreate same-name assets.",
      "",
      ...groupLines,
      episodeHint.trim(),
    ].join("\n");
  }

  return [
    "## 已有资产清单（硬性约束：必须原样复用，禁止重命名/翻译/改写）",
    "",
    "本项目已锁定以下资产，改写时必须严格沿用：",
    "- 【硬性约束】已有资产清单中的角色名/物品名/环境名为本项目锁定的标识符，必须原样复用，",
    "  禁止翻译、改写、缩写、扩写或创建变体名（例如已有 \"Grandpa Shen\" 时不得改为 \"Grandfather Sterling\"）；",
    "- 即使目标风格要求语言转换，已有资产名也不参与转换 — 它们是跨集稳定标识符，必须保持原名；",
    "- 仅对「新增」的角色/物品/环境起符合目标风格的名字；",
    "- 同一资产在剧本中保持名称一致，不得改名、不得重复创建同名资产。",
    "",
    ...groupLines,
    episodeHint.trim(),
  ].join("\n");
}

/**
 * 构造文本转风格提示词
 * 将已有剧本文本按用户指定的目标风格进行改写转换，
 * 输出格式与「剧本分析」保持一致（场景列表 + 剧本正文 + 信息点 + 场景元信息）。
 *
 * 第二集及之后：可传入 existingAssets（项目已确认资产），在 systemPrompt 中注入
 * 「已有资产清单」段落，要求模型复用主角名、补充新资产推进剧情。
 *
 * @param scriptText - 原始剧本文本
 * @param stylePrompt - 目标风格提示词（如「改成欧美风剧本…」）
 * @param existingAssets - （可选）项目已确认资产列表，每项 { kind, name, description }
 * @param episodeNumber - （可选）当前分集编号，>1 时与 existingAssets 配合注入跨集上下文
 * @returns { system, user } 供网关调用
 */
export function buildTextStylePrompt(
  scriptText: string,
  stylePrompt: string,
  existingAssets?: Array<{ kind: string; name: string; description: string }>,
  episodeNumber?: number,
  language?: ScriptLanguage
): { system: string; user: string } {
  const lang: ScriptLanguage = language ?? detectLanguage(scriptText);
  const isEn = lang === "en";

  // 结构化目标语言（来自海外 LanguageMenu）：命中则启用「中文叙述+目标对白」新规则；
  // 自由文本（ORIGINAL Textarea）不命中 → 走 legacy 模板，行为不变。
  const targetLang: TargetLanguage | undefined = parseTargetLanguage(stylePrompt);
  const newRulesZh = targetLang
    ? [
        '',
        '## 海外转绘改写规则（目标语言：' + targetLang.zh + ' / ' + targetLang.native + '）',
        '本规则优先于通用改写原则，必须严格执行：',
        '',
        '【正文语言】动作/画面描述、场景叙述、信息点、场景元信息（时间场景/出场人物/场景画风字段）一律用中文。注意：对白台词与画面文字不在此列，必须按下一条使用目标语言。',
        '',
        '【对白与画面文字】强制：对白台词、内心独白、字幕，以及画面中出现的文字（招牌/信件/文件/UI 等）必须使用目标语言（' + targetLang.zh + '）的原文写出（含其正确字符、文字与标点），严禁用中文撰写任何对白台词或画面文字。仅情绪标签（如（愤怒））保留中文。',
        '',
        '【名称格式】角色名/地名/场景名统一只用目标语言名（如 Yamada、Carlos、Tokyo Station），不得保留中文原名或「中文名(目标语言名)」双语括号对照。角色名映射表的 newName 也只用目标语言名。',
        '',
        '【文化贴合】' + targetLang.cultureHint + '。角色背景、动机、问候、餐饮、节庆、亲属称谓、礼仪、宗教/法律引用、建筑、社会规范一律贴合该目标文化与现实习俗，不得混入源文化或第三文化。',
        '',
        '【语言分配·正确示范】（务必照此分配语言，不得把对白写成中文）',
        '- 动作/画面描述（△ 开头）：中文。例：△Yamada推门走入一间日式茶室，点了一杯抹茶。',
        '- 对白台词：必须使用目标语言（' + targetLang.zh + '）原文写出，严禁中文。例如角色打招呼，应直接写成' + targetLang.zh + '原文，而非中文「你好」。',
        '- 画面文字（招牌/文件/字幕等）：必须使用目标语言原文。',
        '',
      ].join('\n')
    : '';
  const newRulesEn = targetLang
    ? [
        '',
        '## Overseas rewrite rules (target language: ' + targetLang.en + ' / ' + targetLang.native + ')',
        'These rules take precedence over the general rewriting principles:',
        '',
        '[Body language] All action/visual description, scene narration, info points and scene metadata fields MUST be in Chinese.',
        '',
        '[Dialogue & on-screen text] All dialogue, monologue, subtitles, and any text appearing in-frame (signage/letters/documents/UI) MUST be in the target language (' + targetLang.en + '). Emotion tags (e.g. (angry)) stay in Chinese.',
        '',
        '[Name format] Character/location/scene names MUST use ONLY the target-language name (e.g. Yamada, Carlos), without the Chinese original or "Chinese-name(Target-language-name)" bilingual pairing. The Character Name Mapping newName uses the target-language name only.',
        '',
        '[Cultural conformance] ' + targetLang.cultureHint + '. Every element must conform to that target culture; do not mix in source or third cultures.',
        '',
      ].join('\n')
    : '';
  // 文化本地化完全由用户 stylePrompt 指定的目标文化驱动，模板不硬编码任何具体文化（西/中/拉美等）
  // 构造「已有资产清单」段落（仅当传入已确认资产时才注入；第一集/项目模式不注入）
  const assetSection = buildExistingAssetsSection(existingAssets, episodeNumber, lang);

  const system = isEn
    ? [
        'You are a professional screenwriter and script style-rewriting expert. Rewrite the provided original script text into the target style given by the user.',
        '',
        '[IMPORTANT] Output the rewritten screenplay directly. No preface, no explanation, no confirmation. Do not say "Sure" "Let me rewrite" "Here is" etc. The first line MUST be "Scene List".',
        ...(newRulesEn ? [newRulesEn] : []),
        '## Cultural & Stylistic Localization (fully driven by the user\'s Target Style)',
        'The user\'s Target Style Requirements specify the target culture, era, region, language and aesthetic. You MUST localize every element to match that target. Do not leave any source-culture element unconverted, and never default to a culture the user did not request.',
        '',
        '### Coherence with the target culture & era',
        '- Infer the target culture and historical era from the Target Style Requirements, and keep every element consistent with that culture and era (technology, fashion, architecture, social norms, naming conventions).',
        '- Do NOT mix cultures or eras: no element from a culture/era the user did not request. If no era is specified, use the target culture\'s contemporary setting unless the style dictates otherwise.',
        '',
        '### Localize every dimension to the target culture',
        '- Character names: convert to names natural for the target culture/language. [Exception] names already present in the Existing Asset List below are locked identifiers — reuse them as-is, do not translate.',
        '- Character background & motivation: reflect the target culture\'s real social structures, family systems, institutions and values; drop source-culture tropes that have no target-culture equivalent.',
        '- Props & daily-life objects: use objects native to the target culture/era; replace source-culture-specific objects with target-culture equivalents that preserve the same plot function.',
        '- Locations & architecture: use architecture and environments native to the target culture/region; avoid architectural elements foreign to that culture unless the style explicitly requires them.',
        '- Customs & social conventions: greetings, meals, festivals, kinship terms, etiquette, religious/legal references must all follow the target culture\'s real conventions; do not invent customs from other cultures.',
        '- Language: if the target style requires a language change, ALL dialogue, monologue, subtitles, character names, location names and scene names must be in the target language, including its correct punctuation and diacritics.',
        '',
        '### No cultural mixing',
        '- Do not blend the target culture with the source culture or any third culture. Every visible, audible and textual element must belong to one coherent target-cultural world.',
        '',
        '## Rewriting Principles',
        '',
        '1. **Keep the plot skeleton**: scene structure, event order, character relationships, and core conflicts must stay faithful to the source; do not add/remove scenes or change the plot direction.',
        '2. **Execute the target style**: strictly rewrite per the user target style — including character settings, environment description, asset style, dialogue language, subtitle language, all dimensions.',
        '3. **Language conversion (including character/location names)**: if the target style requires language conversion (e.g. to a Western language), all dialogue, monologue, subtitles, character names, location names, scene names must be converted to the target language in sync; do not keep the source language. Character names as identifiers must also be converted (e.g. original Chinese "黑衣女子" → "Woman in Black" for English style). [Exception] If a character/prop/location name already appears in the Existing Asset List below, that name is a locked identifier of this project; reuse it as-is and do not translate or rewrite it again.',
        '4. **Scene continuity**: merge content only when both location and time envelope remain continuous. A clear time jump that changes light, character state, set state, or narrative phase opens a new scene even at the same location.',
        '5. **Keep and adapt Info Points and scene metadata**: the source info points (Conflict Escalation / Reversal / Twist etc.) and scene metadata (E1S1 / Time-Scene / Characters / Art Style) must be retained, and the "Art Style" field adjusted per the target style.',
        ...(assetSection ? ['', assetSection] : []),
        '',
        '## Output Format (strictly follow this structure, do not add any extra headings or explanation)',
        '',
        'Scene List',
        'S1',
        'Location·Time·Int/Ext',
        'S2',
        'Location·Time·Int/Ext',
        '',
        '## S1 [Location · Time · Int/Ext] Characters: Character1 / Character2',
        '',
        '△Action/visual description',
        '',
        'Character (emotion): dialogue',
        '',
        '## S2 [Location · Time · Int/Ext] Characters: Character1',
        '',
        '△Action description',
        '',
        'Info Points',
        'Conflict Escalation  description',
        '',
        'E1S1 Location',
        'Time/Scene  Day / Ext',
        'Characters  Character1, Character2',
        'Art Style  target-style art',
        '',
        '## Format Rules',
        '',
        'Scene header: ## S{number} [Location · Time · Int/Ext] Characters: {character list}',
        'Action description: starts with △',
        'Dialogue: Character (emotion): dialogue  (parentheses may be omitted when no special emotion)',
        'Inner monologue: Character OS: content',
        '',
        '## Notes',
        '',
        '- Screenplay language should be concise and forceful; avoid verbose description.',
        '- Dialogue must fit the character identity and personality under the target style.',
        '- Keep continuity and logic between scenes.',
        '- Do not output any preface, epilogue, or explanatory text.',
        '',
        '## Character Name Mapping Output (mandatory)',
        '',
        'After the screenplay body (after the last scene metadata block), you MUST append a "Character Name Mapping" section recording the "old name → new name" correspondence for every character whose name changed during this rewrite.',
        'Format (strictly a JSON array, each item has oldName/newName fields):',
        '',
        '### Character Name Mapping',
        '```json',
        '[',
        '  { "oldName": "季舒语", "newName": "EVELYN VANCE" },',
        '  { "oldName": "乔野", "newName": "LEO CROSS" }',
        ']',
        '```',
        '',
        'Rules:',
        '- oldName = the original character name in the source script (before rewrite)',
        '- newName = the character name used in the rewritten screenplay (must exactly match the name actually appearing in the screenplay body above)',
        '- If a character name did not change (e.g. pure same-language rewrite), still include it with oldName === newName',
        '- Must cover ALL characters appearing in the screenplay, no omissions',
        '- This mapping is used downstream to update the characterId↔character identity mapping, so accuracy is critical',
      ].join('\n')
    : [
        '你是一位专业的影视编剧和剧本风格改写专家。请按照用户给出的「目标风格要求」，对提供的原剧本文本进行风格改写。',
        '',
        '【重要】直接输出改写后的剧本内容，不要输出任何前言、解释、确认语。不要说"好的""我来改写""以下是"等。第一行必须是"场景列表"。',
        ...(newRulesZh ? [newRulesZh] : []),
        '## 改写原则',
        '',
        '1. **保持剧情骨架**：场景结构、事件顺序、人物关系、核心冲突必须忠于原文，不得增删场景或改变剧情走向。',
        '2. **执行目标风格**：严格按照用户给出的目标风格要求改写——包括人物设定、环境描写、资产风格、对白语言、字幕语言等所有维度。',
        '3. **语言转换（含角色名/地点名）**：若目标风格要求转换语言（如改为欧美语言），所有对白、独白、字幕、角色名、地点名、场景名必须同步转换为目标语言，禁止保留原文语言。角色名作为标识符也必须转换（如原中文"黑衣女子"转英文风格时必须变为"Woman in Black"），不得保留原文。【例外】若下方「已有资产清单」中已包含某角色/物品/环境的名字，该名字已是本项目锁定的标识符，必须原样复用、禁止再次翻译或改写。',
        '4. **场景连续性**：地点和时间段都连续时才合并；若明确时间跳跃改变了光线、人物状态、布景状态或叙事阶段，即使地点相同也新建场景。',
        '5. **保留并适配信息点与场景元信息**：原文的信息点（冲突升级/打脸/反转等）与场景元信息（E1S1/时间场景/出场人物/场景画风）须保留，并按目标风格调整「场景画风」字段。',
        ...(assetSection ? ['', assetSection] : []),
        '',
        '## 输出格式（严格按此结构，不要加任何额外标题或说明）',
        '',
        '场景列表',
        'S1',
        '地点·时间·内外景',
        'S2',
        '地点·时间·内外景',
        '',
        '## S1 [地点 · 时间 · 内外景] 角色：角色1 / 角色2',
        '',
        '△动作/画面描述',
        '',
        targetLang
          ? '角色名（情绪）：此处台词必须为' + targetLang.zh + '原文（禁止中文）'
          : '角色名（情绪）：台词',
        '',
        '## S2 [地点 · 时间 · 内外景] 角色：角色1',
        '',
        '△动作描述',
        '',
        '信息点',
        '冲突升级  描述内容',
        '',
        'E1S1 地点',
        '时间/场景  日 / 外',
        '出场人物  角色1、角色2',
        '场景画风  目标风格画风',
        '',
        '## 格式规则',
        '',
        '场景标题：## S{序号} [地点 · 时间 · 内外景] 角色：{角色列表}',
        '动作描述：△ 开头',
        '对白：角色名（情绪）：台词  （无特殊情绪可省略括号）',
        '内心独白：角色名OS：内容',
        '',
        '## 注意事项',
        '',
        '- 剧本语言应简洁有力，避免冗长描述',
        '- 对白要符合目标风格下角色的身份和性格',
        '- 保持场景之间的连贯性和逻辑性',
        '- 不要输出任何前言、结语或解释性文字',
        '',
        '## 角色名映射表输出要求（必须）',
        '',
        '在剧本正文最后（最后一个场景元信息块之后），必须追加一段「角色名映射表」，记录本次改写中所有"原角色名 → 新角色名"的对应关系。',
        '格式严格如下（JSON 数组，每项含 oldName/newName 两字段）：',
        '',
        '### 角色名映射表',
        '```json',
        '[',
        '  { "oldName": "季舒语", "newName": "EVELYN VANCE" },',
        '  { "oldName": "乔野", "newName": "LEO CROSS" }',
        ']',
        '```',
        '',
        '要求：',
        '- oldName = 改写前剧本中的原始角色名',
        '- newName = 改写后剧本中使用的角色名，必须与剧本正文中实际出现的名字完全一致',
        '- 若原剧本无角色名变化（如纯中文模式改写），仍需输出映射表（oldName === newName）',
        '- 必须涵盖剧本中出现的所有角色，不遗漏',
        '- 此映射表用于下游更新声纹↔角色身份映射，准确性至关重要',
      ].join('\n');

  const user = isEn
    ? [
        '## Target Style Requirements',
        '',
        stylePrompt.trim() || '(No specific style requirements provided; keep the source style.)',
        '',
        '## Original Script Text',
        '',
        scriptText,
      ].join('\n')
    : [
        '## 目标风格要求',
        '',
        stylePrompt.trim() || '（用户未提供具体风格要求，请保持原文风格）',
        '',
        '## 原剧本文本',
        '',
        scriptText,
      ].join('\n');

  return { system, user };
}

/**
 * 构造原创项目「整剧一次性转风格」提示词。
 *
 * 与 buildTextStylePrompt 的单集生产模板不同：这里不能先假定集数，也不能把整剧
 * 套进一份全局 Scene List。模型必须完整读取正文，从正文自身的分集/章节标题识别
 * 任意数量的叙事单元，并在改写时逐单元保持原顺序和原边界。
 */
export function buildWholeSeriesTextStylePrompt(
  scriptText: string,
  stylePrompt: string,
  language?: ScriptLanguage,
  sourceStructureEpisodeCount?: number,
  outputMode: 'manuscript' | 'episode-json' = 'manuscript',
): { system: string; user: string } {
  const lang: ScriptLanguage = language ?? detectLanguage(scriptText);
  const isEn = lang === "en";
  const targetLang = parseTargetLanguage(stylePrompt);
  const sourceStructureRule = sourceStructureEpisodeCount
    ? (isEn
        ? `- A prior lossless AI reading of this exact source found ${sourceStructureEpisodeCount} narrative units. Preserve exactly those ${sourceStructureEpisodeCount} source units one-to-one; this runtime number comes from the current manuscript, not metadata or a preset.`
        : `- 上游 AI 已对这份原文完成无损通读，并识别出 ${sourceStructureEpisodeCount} 个叙事单元。必须将本次原文的这 ${sourceStructureEpisodeCount} 个单元逐一保留；该运行时数字来自当前原文，不是旧数据或预设。`)
    : undefined;

  const targetLanguageRules = targetLang
    ? isEn
      ? [
          "## Target-language allocation",
          `- Target language: ${targetLang.en} / ${targetLang.native}.`,
          "- Keep production-facing action, visual description, scene narration, info points, and scene metadata in Chinese.",
          `- Write every line of dialogue, inner monologue, subtitle, and visible in-frame text in ${targetLang.en}, using its native script and punctuation.`,
          "- Character, location, organization, and prop names MUST be written as Chinese-name(Target-language-name), e.g. 柯林(Colin), 塞拉斯(Silas); kept consistent across the entire series; characterNameMapping newName uses the same format.",
          `- Localize names, institutions, architecture, clothing, food, etiquette, religion, law, and social behavior to ${targetLang.cultureHint}; never mix in an unrelated culture.`,
        ]
      : [
          "## 目标语言分配",
          `- 目标语言：${targetLang.zh} / ${targetLang.native}。`,
          "- 面向制作的动作、画面描述、场景叙述、信息点和场景元信息统一使用中文。",
          `- 所有对白、内心独白、字幕和画面内文字必须使用${targetLang.zh}原文及其正确文字、标点，不得用中文代写。`,
          "- 角色、地点、机构和道具名称统一只用目标语言名（如 Colin、Silas），在整剧中保持一致；characterNameMapping 的 newName 也只用目标语言名。",
          `- 姓名、制度、建筑、服装、饮食、礼仪、宗教、法律与社会行为必须贴合${targetLang.cultureHint}，不得混入无关文化。`,
        ]
    : isEn
      ? [
          "## Language and culture",
          "- Follow the Target Style Requirements exactly for language and cultural localization.",
          "- Keep every recurring name and identity consistent across the whole series.",
        ]
      : [
          "## 语言与文化",
          "- 严格按「目标风格要求」完成语言与文化本地化。",
          "- 所有跨集复现的名称和身份必须在整剧中保持一致。",
        ];

  const outputRules = outputMode === 'episode-json'
    ? isEn
      ? [
          "## Machine-readable single-pass output",
          "- Return strict JSON only, without Markdown fences or any text before or after the JSON.",
          "- Shape: {\"detectedEpisodeCount\":N,\"episodes\":[{\"episodeNumber\":1,\"title\":\"Episode 1\",\"sourceHeading\":\"the exact source-unit heading\",\"content\":\"the complete styled episode\",\"emotionArc\":\"setup→progression→hook\"}],\"characterNameMapping\":[{\"oldName\":\"\",\"newName\":\"\"}]}",
          "- First read to EOF and silently enumerate every explicit source-unit heading in order. Each heading that owns substantive body text must produce exactly one episodes item; an explicit boundary overrides any broader semantic story arc and short units must never be merged.",
          "- Set detectedEpisodeCount to that final dynamic inventory size. episodes.length must equal detectedEpisodeCount, and episodeNumber must be consecutive from 1 through N.",
          "- Each content is the complete rewritten body for exactly one source unit, including its visible unit heading. Concatenating content in episodeNumber order is the complete styled whole-series manuscript; do not duplicate it in another top-level field.",
          "- sourceHeading copies only the corresponding source heading for audit; never copy the source body or return offsets, anchors, metadata counts, or any extra source-evidence payload. If no explicit headings exist, use WHOLE SERIES and return one natural unit unless the prose itself unambiguously marks multiple units.",
          "- Before returning JSON, silently verify that every source unit and body block has exactly one complete styled counterpart and that the final source unit is present in full.",
        ]
      : [
          "## 单次调用的机器可读输出",
          "- 只返回严格 JSON；不得使用 Markdown 代码围栏，JSON 前后不得出现任何说明文字。",
          "- 结构：{\"detectedEpisodeCount\":N,\"episodes\":[{\"episodeNumber\":1,\"title\":\"Episode 1\",\"sourceHeading\":\"对应的原文单元标题\",\"content\":\"该原文单元完整的转风格正文\",\"emotionArc\":\"起→承→钩子\"}],\"characterNameMapping\":[{\"oldName\":\"\",\"newName\":\"\"}]}。",
          "- 必须先读到原文 EOF，并在内部按顺序列出所有明确分集标题。每个拥有实质正文的标题必须对应 episodes 中恰好一个对象；明示边界优先于更大的剧情语义弧，短集也绝不能合并。",
          "- detectedEpisodeCount 写入本次从完整原文识别出的最终 N；episodes.length 必须等于 detectedEpisodeCount，episodeNumber 再从 1 连续递增到 N。",
          "- 每个 content 是一个原文单元完整且唯一的转风格正文，包含可见单元标题。按 episodeNumber 拼接所有 content，就是可直接持久化的完整转风格整剧；不得再用其他顶层字段重复整剧。",
          "- sourceHeading 只逐字写对应的原文标题用于核对；不要复抄正文，不要返回偏移、锚点、元数据集数或其他原文证据字段。若原文完全没有明确标题，sourceHeading 写「全文」，除非正文自身清晰标明多个自然单元，否则只返回一个自然单元。",
          "- 返回 JSON 前在内部逐项核验：原文每个单元和正文块都恰好有一个完整转风格对应项，且最后一个原文单元完整存在。",
        ]
    : isEn
      ? [
          "## Output",
          "- Output the complete rewritten series directly, with no preface, analysis, episode-count report, progress note, confirmation, or Markdown wrapper.",
          "- If the source has explicit units, begin each output unit with its corresponding visible unit heading and then output that unit's full rewritten body.",
          "- After the entire series, append one Character Name Mapping section as a JSON array of {\"oldName\":\"\",\"newName\":\"\"}. Cover every named character; unchanged names still appear with identical values.",
          "- Before finishing, silently verify that every source unit and every source body block has exactly one output counterpart and that the final source unit is present in full.",
        ]
      : [
          "## 输出要求",
          "- 直接输出完整转风格后的整剧，不要前言、分析、集数报告、进度说明、确认语或 Markdown 外层包装。",
          "- 原文有明确单元时，每个输出单元先写对应的可见单元标题，再写该单元完整改写正文。",
          "- 全剧正文结束后只追加一次「角色名映射表」，用 {\"oldName\":\"\",\"newName\":\"\"} 的 JSON 数组覆盖所有具名角色；未改名角色也要以相同值列出。",
          "- 结束前在内部逐项核验：原文每个单元、每段正文都恰好有一个输出对应项，且原文最后一个单元完整存在。",
        ];

  const system = isEn
    ? [
        "You are a senior series screenwriter and cultural-localization editor. The input is one complete series manuscript, not a single episode.",
        "",
        "## Highest-priority source-structure contract",
        "- Read the source from its first character through the end before writing any output. Derive the source's actual narrative-unit inventory from the manuscript itself, never from a project title, UI value, assumed default, or a predefined episode count.",
        ...(sourceStructureRule ? [sourceStructureRule] : []),
        "- Recognize explicit source-unit headings such as 第N集, Episode N, EP N, 第N章, Chapter N, or equivalent clearly marked episode/chapter headings.",
        "- When explicit units exist, the output must have a one-to-one correspondence with every source unit: preserve their order, start boundary, end boundary, and all plot content. Never merge, split, omit, duplicate, or reorder units, and never move a scene, event, or line across a source-unit boundary.",
        "- A repeated, skipped, or malformed heading number does not authorize deletion or merging. Use surrounding plot context to understand the intended unit, retain every body block, and correct only the heading when necessary; never swallow, relocate, or summarize its text.",
        "- Duplicate-heading rule: consecutive same-number headings with no substantive body between them are one boundary, not an extra unit. If each same-number heading has its own substantive body, they are distinct real units; preserve both and correct only their displayed numbering from context.",
        "- When the source has no explicit episode/chapter structure, perform only the requested style rewrite while preserving its natural structure. Do not manufacture episodes or cut by character count, token count, paragraph count, duration, or equal-sized chunks.",
        "- Preserve source-unit headings as visible boundaries. A heading may be translated for the target language, but its number, sequence position, and association with its body must remain unambiguous.",
        "",
        "## Per-unit production rules",
        "- Rewrite each discovered source unit independently inside its own boundary while keeping the complete series coherent.",
        "- Preserve plot causality, event order, character relationships, reversals, cliffhangers, and the opening and closing content of every unit. Do not abridge or summarize.",
        "- If screenplay structuring is needed, give each unit its own local Scene List and restart scene numbering from S1 inside that unit. Never emit one global Scene List or one global scene-number sequence for the whole series.",
        "- Scene changes follow narrative time/location continuity, not fixed length. Do not invent or remove scenes merely to make formatting uniform.",
        "",
        ...targetLanguageRules,
        "",
        ...outputRules,
      ].join("\n")
    : [
        "你是一位资深的长篇影视编剧和文化本地化编辑。输入是一部完整整剧稿，不是单集稿。",
        "",
        "## 最高优先级：原文结构契约",
        "- 集数和边界必须完全由当前完整原文决定，不得使用任何外部预设或历史集数。",
        "- 输出前必须从原文第一个字符完整读到结尾，再依据正文自身建立实际叙事单元清单；严禁从项目标题、界面数值、默认值或预设集数猜测。",
        ...(sourceStructureRule ? [sourceStructureRule] : []),
        "- 识别原文中的明确单元标题，例如「第N集」「Episode N」「EP N」「第N章」「Chapter N」以及语义等价、清晰可辨的分集或章节标题。",
        "- 原文存在明确单元时，输出必须与原文每个单元一一对应：顺序、起点、终点和剧情内容全部保留。禁止合并、拆分、遗漏、复制或重排单元，禁止把任何场景、事件或台词跨越原单元边界移动。",
        "- 标题编号重复、跳号或书写异常，不代表可以删除或合并。必须结合前后剧情理解实际单元，保留每一段正文；必要时只纠正标题，绝不能吞掉、挪动或概括正文。",
        "- 重复标题判定：同号标题连续出现且中间没有实质正文时，只算同一个边界，不得多造一集；若两个同号标题后各自拥有实质正文，则属于两个真实单元，必须全部保留，并仅依据上下文纠正显示序号。",
        "- 原文没有明确分集或章节结构时，只执行目标风格改写并保持原有自然结构；不得按字数、token 数、段落数、时长或等长区块人为造集。",
        "- 保留可见的原单元标题作为边界。标题文字可按目标语言转换，但编号、顺序位置及其与正文的归属必须清晰不变。",
        "",
        "## 单元内部制作规则",
        "- 每个识别出的原文单元只能在自己的边界内独立改写，同时保持整剧连续性。",
        "- 忠实保留剧情因果、事件顺序、人物关系、反转、悬念，以及每个单元的开头和结尾内容；不得删节或摘要。",
        "- 需要剧本结构化时，每个单元分别拥有自己的「场景列表」，场景号在每个单元内从 S1 重新开始；严禁给整剧只做一份全局场景列表或连续到底的全局场景编号。",
        "- 场景划分依据剧情中的时间与地点连续性，不按固定长度；不得为了格式整齐擅自增删场景。",
        "",
        ...targetLanguageRules,
        "",
        ...outputRules,
      ].join("\n");

  const user = isEn
    ? [
        "## Target Style Requirements",
        stylePrompt.trim() || "Keep the source style while honoring the source-structure contract.",
        "",
        "--- COMPLETE SOURCE SERIES START ---",
        scriptText,
        "--- COMPLETE SOURCE SERIES END ---",
      ].join("\n")
    : [
        "## 目标风格要求",
        stylePrompt.trim() || "保持原文风格，同时严格遵守原文结构契约。",
        "",
        "---完整原剧开始---",
        scriptText,
        "---完整原剧结束---",
      ].join("\n");

  return { system, user };
}

/**
 * 清理 AI 返回文本：去除前言/结语，只保留实际内容
 * 稳健地去除 "好的，作为您的专业影视编剧..." / "Sure, here is..." 等 AI 套话
 * 双语：同时识别中文标签（场景列表/信息点/造型表/场景画风）与英文标签
 *（Scene List / Info Points / Costume Table / Art Style）。
 */
export function cleanAiOutput(rawText: string): string {
  // 长视频分批生成时，模型偶尔会把续写计划、批次说明或 AI 思考混进正文。
  // 共享过滤器只删除整行元文本，剧情对白中的“生成器/AI”等正常词汇仍会保留。
  let text = stripMetaCommentary(rawText);

  // 查找多个子串中最早出现的位置（找不到返回 -1）
  const earliestIdx = (subs: string[]): number => {
    let best = -1;
    for (const s of subs) {
      const i = text.indexOf(s);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    return best;
  };
  // 查找多个子串中最晚出现的位置
  const latestIdx = (subs: string[]): number => {
    let best = -1;
    for (const s of subs) {
      const i = text.lastIndexOf(s);
      if (i > best) best = i;
    }
    return best;
  };

  // 1. 找到实际内容的起始位置：第一个 "场景列表"/"Scene List" 或 "## S"
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

  // 2. 如果找到了内容起始位置，且前面有前言内容，则截断前言
  if (contentStart > 0) {
    const preamble = text.slice(0, contentStart);
    // 前言通常包含这些关键词之一（中英双语）
    const isPreamble = /好[的，,。]|作为|以下是|我来|我已|请查看|这是|根据您|为您|将您|分析并|转化|标准格式|影视编剧|剧本结构|请稍|这是为您|已经将|sure[!,.]?|here\s+is|here's|as\s+a|let\s+me|i'll|i\s+will|below\s+is|the\s+following|无缝续写|余下场次|本次[只仅]生成|此前至|批次|续写计划|生成计划/i.test(preamble);
    if (isPreamble) {
      text = text.slice(contentStart);
    }
  }

  // 3. 逐行清理：去除开头的空行和单独的 AI 套话行
  const lines = text.split('\n');
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // 跳过空行
    if (!line) { startLine = i + 1; continue; }
    // 如果是实际内容起始，停止（中英双语标签）
    if (line.startsWith('场景列表') || line.startsWith('Scene List')
        || line.startsWith('## S')
        || line.startsWith('信息点') || line.startsWith('Info Points')
        || /^《[^》]+》/.test(line)
        || /^第[ \t]*0*1[ \t]*集/.test(line)
        || /^\[1-1/.test(line)) {
      startLine = i;
      break;
    }
    // 如果是 AI 套话行，跳过（中英双语）
    if (/^(好[的，,]|作为|以下|我来|我已|请查看|这是|根据|为您|已经|sure[!,.]?|here|as\s+a|let\s+me|i'll|i\s+will|below|the\s+following|我(?:需要|会|将|来|先|要)|让[我俺]|本次[只仅]|剩余[场集]|此前[至到]|接下来|上面[已是]|下面[我将])/i.test(line)) {
      startLine = i + 1;
      continue;
    }
    // 其他非空行视为实际内容
    startLine = i;
    break;
  }
  text = lines.slice(startLine).join('\n').trim();

  // 4. 去除尾部的解释性文字（在最后一个场景元信息/角色名映射表之后的内容如果不像格式内容则截断）
  // 注：角色名映射表/Character Name Mapping 必须加入 latestIdx 和白名单，否则 step 4 会把这块静默删除
  const lastMetaIdx = latestIdx(['场景画风', 'Art Style', '角色名映射表', 'Character Name Mapping']);
  if (lastMetaIdx >= 0) {
    const afterMeta = text.slice(lastMetaIdx);
    const newlineAfterMeta = afterMeta.indexOf('\n');
    if (newlineAfterMeta >= 0) {
      const tail = afterMeta.slice(newlineAfterMeta + 1).trim();
      // 如果尾部内容不像格式内容（不是 E1S1/场景列表/Scene List/信息点/Info Points/造型表/Costume Table/角色名映射表/Character Name Mapping 开头也不是空），截断
      // 注：造型表/Costume Table/角色名映射表/Character Name Mapping 必须加入白名单，否则 step 4 会把这块静默删除
      if (tail && !tail.match(/^(E\d+S\d+|##\s*S\d+|场景列表|Scene\s+List|信息点|Info\s+Points|造型表|Costume\s+Table|角色名映射表|Character\s+Name\s+Mapping)/)) {
        text = text.slice(0, lastMetaIdx + newlineAfterMeta + 1);
      }
    }
  }

  return text.trim();
}

/**
 * 解析 AI 输出尾部的"角色名映射表/Character Name Mapping"段落
 * 返回 Map<oldName, newName>，仅包含发生变化的映射（oldName !== newName）
 * 解析失败或无映射段落时返回空 Map
 *
 * 用于 text-to-style 阶段回写 characterMapping 中角色的 name 字段：
 * 把旧角色名（如中文"季舒语"）替换为新角色名（如英文"EVELYN VANCE"），
 * 保证全局角色映射与后续 analyze/asset-extraction 提取的英文资产名命名空间一致。
 */
export function parseCharacterAliasMap(text: string): Map<string, string> {
  const aliasMap = new Map<string, string>();
  if (!text) return aliasMap;

  // 定位"角色名映射表/Character Name Mapping"段落位置
  const sectionIdx = text.search(/角色名映射表|Character\s+Name\s+Mapping/);
  if (sectionIdx < 0) return aliasMap;

  // 在段落之后查找第一个 ```json ... ``` 代码块
  const afterSection = text.slice(sectionIdx);
  const jsonMatch = afterSection.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!jsonMatch) return aliasMap;

  try {
    const arr = JSON.parse(jsonMatch[1].trim());
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item.oldName === "string" && typeof item.newName === "string") {
          // 仅记录发生变化的映射，oldName === newName 的项无意义
          if (item.oldName !== item.newName) {
            aliasMap.set(item.oldName, item.newName);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[parseCharacterAliasMap] JSON 解析失败:", e);
  }
  return aliasMap;
}

/**
 * 解析 AI 返回的剧本文本，提取结构化数据
 */
export interface ParsedScript {
  rawText: string;           // 清理后的文本
  scenes: SceneInfo[];       // 场景列表
  infoPoints: InfoPoint[];   // 信息点
  sceneMeta: SceneMeta[];    // 场景元信息
  characters: string[];      // 提取的角色名
  costumeMap: CostumeMapEntry[]; // 造型表（场景→角色→造型），ep2+ 跨集分析匹配场景与角色服装造型
}

export interface SceneInfo {
  id: string;          // S1, S2...
  location: string;    // 地点
  time: string;        // 时间
  intExt: string;      // 内/外
  content: string;     // 场景正文
  spatialLayout?: string; // 多角色场景（≥2 人）的站位/座位不变量（如"林夏(画面左·站立)、赵默(画面右·坐在沙发)"或"司机左前座、副驾右前座"），跨镜保持位置一致；由 analyzing LLM 写入、parseScriptResult 从「站位布局：/座位布局：」行提取
}

export interface InfoPoint {
  type: string;        // 冲突升级/打脸/反转...
  description: string; // 描述
}

export interface SceneMeta {
  episodeScene: string;  // E1S1
  location: string;      // 采石场
  timeScene: string;     // 午 / 外
  characters: string;    // 阿灵、苍尘
  artStyle: string;      // 仙侠写实风
}

/**
 * 造型表条目（场景→角色→造型）。
 * 由 parseScriptResult 从「造型表」块解析得到，供资产提取阶段匹配场景与角色服装造型。
 * 行格式：S{序号} / 角色名 / 造型label / 造型说明 / [新造型]（首尾两段可选）
 */
export interface CostumeMapEntry {
  sceneId: string;       // S1, S2...
  character: string;     // 角色名（与资产清单精确一致）
  costumeLabel: string;  // 造型 label：便装/正装/战损...
  costumeDesc: string;   // 造型说明（服装外观描述，新造型时用于生成新变体）
  isNew: boolean;        // 是否为新造型（行末标注「新造型」）
}

/**
 * 解析「灵石格式」剧本文本（完整剧本重写 buildRewriteFromOutlinePrompt 的输出格式）。
 *
 * 灵石格式特征：
 *   第001集：标题
 *   本集钩子：…  /  本集推进（或旧版“本集爽点”）：…  /  本集结尾：…
 *   [1-1 场景名 时段 内/外 人物：人物1、人物2]
 *   ▲ 画面/动作描写
 *   角色名：台词
 *   角色名（OS）：内心独白
 *
 * 仅当文本含 `[集号-场号 …]` 场头时认定为灵石格式，否则返回 null（交回标准 S 编号解析）。
 * 场景 id 用「集-场」（如 "1-1"）以保留分集结构；本集钩子/推进/结尾抽为信息点。
 */
function parseLingshiScript(text: string): {
  scenes: SceneInfo[];
  characters: string[];
  infoPoints: InfoPoint[];
} | null {
  const cleanText = stripMetaCommentary(text);
  // 场头：行首 [集号-场号 场景 时段 内/外 人物：人物列表]
  const sceneHeaderRe = /^\[(\d+)-(\d+)\s+([^\]]*)\]\s*$/;
  const lines = cleanText.split("\n");
  const headerIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (sceneHeaderRe.test(lines[i].trim())) headerIdxs.push(i);
  }
  if (headerIdxs.length === 0) return null;

  const scenes: SceneInfo[] = [];
  const characters = new Set<string>();
  const infoPoints: InfoPoint[] = [];

  // 新版“本集推进”与旧版“本集爽点”都保留，兼容已持久化的历史剧本。
  for (const line of lines) {
    const t = line.trim();
    const m = t.match(/^(本集钩子|本集推进|本集爽点|本集结尾)[：:]\s*(.+)$/);
    if (m) infoPoints.push({ type: m[1], description: m[2].trim() });
  }

  for (let h = 0; h < headerIdxs.length; h++) {
    const startLine = headerIdxs[h];
    const headerLine = lines[startLine].trim();
    const hm = headerLine.match(sceneHeaderRe)!;
    const epNo = hm[1];
    const sceneNo = hm[2];
    const inner = hm[3]; // 场景 时段 内/外 人物：人物列表

    // 用「人物」关键字切出人物列表
    let charList = "";
    let before = inner;
    const pIdx = inner.indexOf("人物");
    if (pIdx >= 0) {
      const colonCandidates = [inner.indexOf("：", pIdx), inner.indexOf(":", pIdx)].filter((x) => x >= 0);
      if (colonCandidates.length > 0) {
        const cp = Math.min(...colonCandidates);
        before = inner.slice(0, pIdx).trim();
        charList = inner.slice(cp + 1).trim();
      }
    }
    // before = "场景名 时段 内/外"：末段=内外景，前一段=时段，其余=地点
    const tokens = before.split(/\s+/).filter(Boolean);
    let intExt = "";
    let time = "";
    let location = before;
    if (tokens.length >= 3) {
      intExt = tokens[tokens.length - 1];
      time = tokens[tokens.length - 2];
      location = tokens.slice(0, -2).join(" ");
    } else if (tokens.length === 2) {
      intExt = tokens[1];
      location = tokens[0];
    } else if (tokens.length === 1) {
      location = tokens[0];
    }

    if (charList) {
      for (const c of charList.split(/[、,，/]/)) {
        const n = c.trim();
        if (n) characters.add(n);
      }
    }

    // 场景正文：场头下一行 → 下一个场头/集头
    const nextStop = h + 1 < headerIdxs.length ? headerIdxs[h + 1] : lines.length;
    const bodyLines: string[] = [];
    for (let j = startLine + 1; j < nextStop; j++) {
      const lt = lines[j].trim();
      if (/^第\d+集/.test(lt)) break;
      if (sceneHeaderRe.test(lt)) break;
      bodyLines.push(lines[j]);
    }
    const content = bodyLines.join("\n").trim();

    // 从对白行补抽角色名：角色：台词 / 角色（OS）：独白
    for (const bl of bodyLines) {
      const lt = bl.trim();
      if (!lt || lt.startsWith("▲") || lt.startsWith("[")) continue;
      const os = lt.match(/^([^\s▲\[（(【]+?)[（(]OS[）)][：:]\s*(.+)$/);
      if (os) {
        const name = os[1].trim();
        if (name.length >= 2 && name.length <= 12) characters.add(name);
        continue;
      }
      const d = lt.match(/^([^\s▲\[（(【]+?)[：:]\s*(.+)$/);
      if (d) {
        const name = d[1].trim();
        if (name.length >= 2 && name.length <= 12 && !/^(本集|第\d)/.test(name)) {
          characters.add(name);
        }
      }
    }

    scenes.push({ id: `${epNo}-${sceneNo}`, location, time, intExt, content });
  }

  return { scenes, characters: [...characters], infoPoints };
}

export function parseScriptResult(rawText: string): ParsedScript {
  const cleaned = cleanAiOutput(rawText);

  const scenes: SceneInfo[] = [];
  const infoPoints: InfoPoint[] = [];
  const sceneMeta: SceneMeta[] = [];
  const characters = new Set<string>();
  const costumeMap: CostumeMapEntry[] = [];

  // 先全局提取信息点和场景元信息（从任意位置提取，不限于文末）
  // 提取所有 "信息点/Info Points" 块
  // 双语类型列表：中文原 9 类 + 英文对应（"打脸" 合并到 Reversal）
  const infoPointTypeList = [
    '冲突升级', '打脸', '新目标', '新风险', '反转', '身份揭示', '悬念', '情感推进', '伏笔',
    'Conflict Escalation', 'Reversal', 'New Goal', 'New Risk', 'Twist', 'Identity Reveal', 'Suspense', 'Emotional Progression', 'Foreshadowing',
  ];
  const infoPointTypes = infoPointTypeList.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  // 匹配 "信息点/Info Points" 后跟若干行 "类型  描述" 的块，直到遇到 E1S1 / ## S / 新信息点 / 造型表 / 文本结束
  const infoBlockRegex = new RegExp(`(?:信息点|Info\\s+Points)[：:\\s]*\\n([\\s\\S]*?)(?=\\nE\\d+S\\d+|\\n##\\s*S\\d+|信息点|Info\\s+Points|造型表|Costume\\s+Table|$)`, 'g');
  let infoMatch;
  while ((infoMatch = infoBlockRegex.exec(cleaned)) !== null) {
    const infoLines = infoMatch[1].split('\n');
    for (const line of infoLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 跳过 E 开头的元信息行和空行
      if (/^E\d+S\d+/.test(trimmed)) continue;
      if (/^(时间[\/／]场景|Time[\/／\-]Scene|出场人物|Characters|场景画风|Art\s+Style)/i.test(trimmed)) continue;
      // 匹配 "类型  描述" 或 "类型：描述"
      const parts = trimmed.split(/\s{2,}|\t|[：:]\s*/);
      if (parts.length >= 2) {
        const type = parts[0].trim();
        const desc = parts.slice(1).join(' ').trim();
        if (type && desc && infoPointTypeList.includes(type)) {
          infoPoints.push({ type, description: desc });
        }
      } else if (trimmed.length > 2) {
        const m = trimmed.match(new RegExp(`^(${infoPointTypes})\\s+(.+)`));
        if (m) {
          infoPoints.push({ type: m[1].trim(), description: m[2].trim() });
        }
      }
    }
  }

  // 如果信息点仍为空，尝试宽松匹配：在全文中搜索已知类型关键词
  if (infoPoints.length === 0) {
    for (const type of infoPointTypeList) {
      const escapedType = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`${escapedType}[：:\\s]+([^\\n##]+)`, 'g');
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        const desc = m[1].trim();
        if (desc.length > 2 && desc.length < 500) {
          infoPoints.push({ type, description: desc });
        }
      }
    }
  }

  // 提取所有 E1S1 场景元信息块（lookahead 加入「造型表/Costume Table」，避免元信息块吞掉后续块）
  const metaBlockRegex = /(E\d+S\d+[\s\S]*?)(?=\nE\d+S\d+|\n##\s*S\d+|信息点|Info\s+Points|造型表|Costume\s+Table|$)/g;
  let metaMatch;
  while ((metaMatch = metaBlockRegex.exec(cleaned)) !== null) {
    const block = metaMatch[1];
    const epMatch = block.match(/(E\d+S\d+)/);
    // 标准格式为 `E1S1 地点`，地点与编号在同一行。旧逻辑误取下一行，
    // 会把 `时间/场景 日 / 内` 保存成 location。
    const locMatch = block.match(/E\d+S\d+\s+([^\n]+)/);
    const timeMatch = block.match(/(?:时间[\/／]场景|Time[\/／\-]Scene)\s*[：:]?\s*(.+)/i);
    const charMatch = block.match(/(?:出场人物|Characters)\s*[：:]?\s*(.+)/i);
    const styleMatch = block.match(/(?:场景画风|Art\s+Style)\s*[：:]?\s*(.+)/i);

    if (epMatch) {
      const location = locMatch?.[1]?.trim() || '';
      const timeScene = timeMatch?.[1]?.trim() || '';
      const chars = charMatch?.[1]?.trim() || '';
      const artStyle = styleMatch?.[1]?.trim() || '';
      if (location || timeScene || chars || artStyle) {
        sceneMeta.push({
          episodeScene: epMatch[1],
          location,
          timeScene,
          characters: chars,
          artStyle,
        });
      }
    }
  }

  // 提取「造型表/Costume Table」块：造型表\nS1 / 角色名 / 造型label / 造型说明 / [新造型/New Costume]
  // 造型表位于场景元信息之后，供资产提取阶段匹配场景与角色服装造型
  const costumeBlockRegex = /(?:造型表|Costume\s+Table)[：:\s]*\n([\s\S]*?)(?=\nE\d+S\d+|\n##\s*S\d+|信息点|Info\s+Points|造型表|Costume\s+Table|$)/g;
  let costumeMatch;
  while ((costumeMatch = costumeBlockRegex.exec(cleaned)) !== null) {
    const blockLines = costumeMatch[1].split('\n');
    for (const line of blockLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 跳过元信息行（E1S1/时间场景/出场人物/场景画风 中英）与【填写说明】/ [Filling instructions] 说明行
      if (/^E\d+S\d+/.test(trimmed)) continue;
      if (/^(时间[\/／]场景|Time[\/／\-]Scene|出场人物|Characters|场景画风|Art\s+Style)/i.test(trimmed)) continue;
      if (/^【|^\s*-\s|^\s*\*\s|^\s*\[\s*filling/i.test(trimmed)) continue;
      // 4字段+可选新造型：S1 / 角色名 / 造型label / 造型说明 / [新造型|New Costume]
      const m4 = trimmed.match(/^(S\d+)\s*\/\s*([^\/]+?)\s*\/\s*([^\/]+?)\s*\/\s*(.+?)(?:\s*\/\s*(新造型|New\s+Costume))?\s*$/i);
      if (m4) {
        costumeMap.push({
          sceneId: m4[1].trim(),
          character: m4[2].trim(),
          costumeLabel: m4[3].trim(),
          costumeDesc: m4[4].trim(),
          isNew: /^(?:新造型|New\s+Costume)$/i.test((m4[5] || '').trim()),
        });
      }
    }
  }

  // 从清理后的文本中移除信息点、场景元信息块、造型表块，避免它们进入场景正文
  let contentText = cleaned;
  contentText = contentText.replace(/\n(?:信息点|Info\s+Points)[：:\s]*\n[\s\S]*?(?=\nE\d+S\d+|\n##\s*S\d+|造型表|Costume\s+Table|$)/g, '');
  contentText = contentText.replace(/\nE\d+S\d+[\s\S]*?(?=\n##\s*S\d+|造型表|Costume\s+Table|$)/g, '');
  // 剥离「造型表/Costume Table」块（避免泄漏进场景正文）
  contentText = contentText.replace(/\n(?:造型表|Costume\s+Table)[：:\s]*\n[\s\S]*?(?=\n##\s*S\d+|$)/g, '');
  contentText = contentText.trim();

  // 提取场景: ## S1 [地点 · 时间 · 内外景] 角色：xxx / Characters: xxx
  const sceneRegex = /##\s*(S\d+)\s*\[([^\]]*)\]\s*(?:(?:角色|Characters)[：:]\s*([^\n]+))?/g;
  let match;
  const scenePositions: { start: number; end: number; scene: SceneInfo }[] = [];

  while ((match = sceneRegex.exec(contentText)) !== null) {
    const id = match[1];
    const headerContent = match[2].trim();
    const charList = match[3]?.trim() || '';

    const parts = headerContent.split(/[·•]/).map((s: string) => s.trim());
    const location = parts[0] || '';
    const time = parts[1] || '';
    const intExt = parts[2] || '';

    if (charList) {
      charList.split(/[\/、,，]/).forEach((c: string) => {
        const name = c.trim();
        if (name) characters.add(name);
      });
    }

    scenePositions.push({
      start: match.index,
      end: 0,
      scene: { id, location, time, intExt, content: '' },
    });
  }

  // 填充每个场景的内容（到下一个场景标题为止）
  for (let i = 0; i < scenePositions.length; i++) {
    const nextStart = i + 1 < scenePositions.length
      ? scenePositions[i + 1].start
      : contentText.length;
    scenePositions[i].end = nextStart;
    const fullContent = contentText.slice(scenePositions[i].start, nextStart).trim();
    const firstNewline = fullContent.indexOf('\n');
    let bodyContent = firstNewline >= 0 ? fullContent.slice(firstNewline + 1).trim() : fullContent;

    // 后处理：清除场景正文中可能残留的元信息行（中英双语）
    const lines = bodyContent.split('\n');
    const cleanedLines: string[] = [];
    let skipMeta = false;
    for (const line of lines) {
      const trimmed = line.trim();
      // 跳过 "信息点/Info Points" 及其后的类型行（如果残留在正文中）
      if (/^(?:信息点|Info\s+Points)[：:\s]*$/i.test(trimmed)) { skipMeta = true; continue; }
      if (skipMeta) {
        // 遇到场景标题或新的动作/对白行则停止跳过
        if (/^##\s*S\d+/.test(trimmed) || trimmed.startsWith('△') || /^[A-Za-z\u4e00-\u9fff]+[（(]/.test(trimmed) || /^[A-Za-z\u4e00-\u9fff]+OS[：:]/.test(trimmed)) {
          skipMeta = false;
        } else if (infoPointTypeList.some(t => trimmed.startsWith(t))) {
          continue;
        } else if (/^E\d+S\d+/.test(trimmed) || /^(时间[\/／]场景|Time[\/／\-]Scene|出场人物|Characters|场景画风|Art\s+Style)/i.test(trimmed)) {
          continue;
        } else {
          skipMeta = false;
        }
      }
      // 跳过 E1S1 元信息行（中英双语）
      if (/^E\d+S\d+/.test(trimmed)) continue;
      if (/^(时间[\/／]场景|Time[\/／\-]Scene)/i.test(trimmed)) continue;
      if (/^(出场人物|Characters)/i.test(trimmed)) continue;
      if (/^(场景画风|Art\s+Style)/i.test(trimmed)) continue;
      cleanedLines.push(line);
    }
    bodyContent = cleanedLines.join('\n').trim();

    // 提取"站位布局/座位布局"位置不变量（多角色场景），从正文中剔除避免污染下游分镜
    let spatialLayout: string | undefined;
    const layoutMatch = bodyContent.match(/^[ \t]*(?:座位布局|站位布局|空间布局|Spatial\s+Layout)\s*[：:]\s*([^\n\r]+?)[ \t]*$/im);
    if (layoutMatch) {
      spatialLayout = layoutMatch[1].trim();
      bodyContent = bodyContent
        .replace(/^[ \t]*(?:座位布局|站位布局|空间布局|Spatial\s+Layout)\s*[：:]\s*[^\n\r]*\r?\n?/im, '')
        .trim();
    }

    scenePositions[i].scene.content = bodyContent;
    if (spatialLayout) scenePositions[i].scene.spatialLayout = spatialLayout;
    scenes.push(scenePositions[i].scene);
  }

  // 如果没提取到角色，从对白中提取（按行解析 + 双语分支）
  // 中文：角色名（情绪）：台词 —— 名字不含空格，用 [^\s△（(]+?
  // 英文：Name With Spaces (emotion): dialogue —— 名字可含空格，用 .+? 懒匹配到第一个 (
  // 英文动作行必须以 △ 开头（prompt 强制），此处跳过 △ 与 ## 行；长度上限 40 防误吞整行描述
  if (characters.size === 0) {
    const dLines = contentText.split('\n');
    for (const line of dLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('△') || trimmed.startsWith('##')) continue;
      // 中文优先（名字不含空格）
      const cnMatch = trimmed.match(/^([^\s△（(]+?)[（(]([^）)]*)[）)][:：]\s*(.+)$/);
      if (cnMatch) {
        const name = cnMatch[1].trim();
        if (name.length >= 2 && name.length <= 4 && !name.includes('：')) {
          characters.add(name);
        }
        continue;
      }
      // 英文（.+? 懒匹配到第一个 (，允许空格，长度 2-40 且不以数字开头）
      const enMatch = trimmed.match(/^(.+?)[（(]([^）)]*)[）)][:：]\s*(.+)$/);
      if (enMatch) {
        const name = enMatch[1].trim();
        if (name.length >= 2 && name.length <= 40 && !/^\d/.test(name)) {
          characters.add(name);
        }
        continue;
      }
      // OS 兜底：角色名OS：内容 / Name OS: content
      const osMatch = trimmed.match(/^(.+?)\s*OS[:：]\s*(.+)$/);
      if (osMatch) {
        const name = osMatch[1].trim();
        if (name.length >= 2 && name.length <= 40 && !/^\d/.test(name)) {
          characters.add(name);
        }
      }
    }
  }

  // 灵石格式兜底：标准 ## S 解析未拿到场景时，尝试 [集-场 场景 时段 内/外 人物：] + ▲ + 角色： 格式
  let isLingshi = false;
  if (scenes.length === 0) {
    const lingshi = parseLingshiScript(cleaned);
    if (lingshi) {
      isLingshi = true;
      for (const s of lingshi.scenes) scenes.push(s);
      for (const c of lingshi.characters) characters.add(c);
      for (const ip of lingshi.infoPoints) {
        if (!infoPoints.some((x) => x.type === ip.type && x.description === ip.description)) {
          infoPoints.push(ip);
        }
      }
    }
  }

  // 后处理：合并同地点的场景（仅标准 S 编号格式）。
  // 灵石格式按「集-场」保留结构与编号，不合并、不重编号，避免抹掉分集信息。
  let mergedScenes: SceneInfo[];
  if (isLingshi) {
    mergedScenes = scenes.map((s) => ({ ...s }));
  } else {
    mergedScenes = [];
    for (const scene of scenes) {
      const last = mergedScenes[mergedScenes.length - 1];
      if (
        last &&
        last.location === scene.location &&
        last.time === scene.time &&
        last.intExt === scene.intExt
      ) {
        last.content = (last.content + '\n\n' + scene.content).trim();
        if (!last.spatialLayout && scene.spatialLayout) last.spatialLayout = scene.spatialLayout;
      } else {
        mergedScenes.push({ ...scene });
      }
    }
    mergedScenes.forEach((s, i) => { s.id = `S${i + 1}`; });
  }

  return {
    rawText: cleaned,
    scenes: mergedScenes,
    infoPoints,
    sceneMeta,
    characters: [...characters],
    costumeMap,
  };
}

/**
 * 分析产物一致性守卫：检测 AI 分析与输入 novelText 的不一致，并区分"整体不可信"与
 * "仅局部瑕疵"，让调用方只重试不可信的整体、局部瑕疵就地修（不整体重跑）。
 *
 * 兜住的历史故障（EP34 case）：AI 幻觉/缓存污染对英文原文返回整套中文仙侠分析
 * （李墨渊/魅颜环），或 novelText 事后被改致陈旧分析。
 *
 * 判据与处置：
 *   - 语种不一致（en≠zh 等）→ kind:'total'，整个分析是另一套语言/故事，无可挽救，
 *     必须重试。EP34 即此。
 *   - 同语种、但解析角色命中率 <30% → kind:'total'，过半角色系编造，整体不可信，重试。
 *   - 同语种、命中率 ≥30% 但有零星角色不在原文 → kind:'characters'，**局部瑕疵**：
 *     给出 hallucinated 名单，调用方过滤掉即可，不必整体重试（保留好的场景/台词）。
 *   - 否则 ok:true。
 *
 * 设计意图：宁可就地修局部，不轻易整体重跑（重跑一次=重新调一次长输出 AI + 计费）。
 * 只有整个产物不可信时才重试。
 */
export type AnalysisConsistencyVerdict =
  | { ok: true }
  | { ok: false; kind: 'total'; reason: string }
  | { ok: false; kind: 'characters'; reason: string; hallucinated: string[] };

export function validateAnalysisConsistency(
  parsed: ParsedScript,
  novelText: string,
): AnalysisConsistencyVerdict {
  if (!novelText || !parsed.scenes || parsed.scenes.length === 0) {
    return { ok: true }; // 空边界交给上层 scenes-empty 检查
  }
  const novelLang = detectLanguage(novelText);
  const analysisBlob = parsed.scenes
    .map((s) => `${s.location ?? ''} ${s.intExt ?? ''} ${s.content ?? ''}`)
    .join('\n');
  const analysisLang = detectLanguage(analysisBlob);
  if (novelLang !== analysisLang) {
    return {
      ok: false,
      kind: 'total',
      reason: `分析场景语种(${analysisLang})与原文语种(${novelLang})不一致——疑似AI幻觉/缓存污染或输入被替换`,
    };
  }
  const chars = (parsed.characters || []).filter(
    (c) => typeof c === 'string' && c.trim().length > 0,
  );
  if (chars.length >= 3) {
    const hallucinated = chars.filter((c) => !novelText.includes(c));
    const hitRatio = (chars.length - hallucinated.length) / chars.length;
    if (hitRatio < 0.3) {
      return {
        ok: false,
        kind: 'total',
        reason: `解析角色原文命中率过低(${chars.length - hallucinated.length}/${chars.length})——过半角色系编造，整体不可信`,
      };
    }
    if (hallucinated.length > 0) {
      // 局部瑕疵：零星角色不在原文，过滤即可，不整体重试
      return {
        ok: false,
        kind: 'characters',
        reason: `${hallucinated.length}/${chars.length} 个解析角色不在原文`,
        hallucinated,
      };
    }
  }
  return { ok: true };
}

/**
 * 从场景正文中提取结构化对话列表（共享函数，供 analyze-script / start-workflow 等路由复用）。
 *
 * 匹配格式（双语）：
 * - 中文：角色名（情绪）：台词  （名字不含空格）
 * - 英文：Name With Spaces (emotion): dialogue  （名字可含空格，懒匹配到第一个 (）
 * - 内心独白：角色名OS：内容 / Name OS: content
 *
 * 动作行（以 △ 开头）与场景标题（## 开头）跳过。
 */
export interface ExtractedDialogue {
  character: string;
  emotion?: string;
  lines: string;
  type: "dialogue" | "voiceover";
}

export function extractDialoguesFromContent(content: string): ExtractedDialogue[] {
  const dialogues: ExtractedDialogue[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("△") || trimmed.startsWith("##")) continue;

    // 中文格式优先（名字不含空格）：角色名（情绪）：台词
    const cnMatch = trimmed.match(/^([^\s△（(]+?)[（(]([^）)]*)[）)][:：]\s*(.+)$/);
    if (cnMatch) {
      dialogues.push({
        character: cnMatch[1].trim(),
        emotion: cnMatch[2].trim() || undefined,
        lines: cnMatch[3].trim(),
        type: "dialogue",
      });
      continue;
    }

    // 英文格式（名字可含空格）：Name (emotion): dialogue
    // 长度上限 40 + 不以数字开头，防误吞整行描述
    const enMatch = trimmed.match(/^(.+?)[（(]([^）)]*)[）)][:：]\s*(.+)$/);
    if (enMatch) {
      const name = enMatch[1].trim();
      if (name.length >= 2 && name.length <= 40 && !/^\d/.test(name)) {
        dialogues.push({
          character: name,
          emotion: enMatch[2].trim() || undefined,
          lines: enMatch[3].trim(),
          type: "dialogue",
        });
        continue;
      }
    }

    // OS 内心独白格式：角色名OS：内容 / Name OS: content
    const osMatch = trimmed.match(/^(.+?)\s*OS[:：]\s*(.+)$/);
    if (osMatch) {
      const name = osMatch[1].trim();
      if (name.length >= 2 && name.length <= 40 && !/^\d/.test(name)) {
        dialogues.push({
          character: name,
          lines: osMatch[2].trim(),
          type: "voiceover",
        });
      }
    }
  }

  return dialogues;
}
