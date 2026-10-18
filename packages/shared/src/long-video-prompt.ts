// 来源：F:\app1\src\core\video\long-video-prompt.ts（整文件 verbatim 移植）。
// 转绘 X3.1 纯函数迁移，零依赖（无 DB/Prisma/redis/ffmpeg/node:*）。
// 仅改 import：app1 `../ai/language` → dramaforge `./language`。

// ============================================================
// 超长视频转剧本提示词模板
// ============================================================
//
// @file core/video/long-video-prompt.ts
// @description 超长视频处理流程的 DeepSeek 提示词：
//   1. buildOutlinePrompt — Whisper 转写文本 → 非常详细的剧本大纲（人物设计/场景/剧情结构）
//   2. buildFullScriptPrompt — 大纲 → 完整剧本
//   3. buildSplitHintPrompt — 补充分集数量提示（可选）
//
// 流程：Whisper 转写 → DeepSeek 大纲 → DeepSeek 完整剧本 → AI 自动分集
// ============================================================

import { detectLanguage, type ScriptLanguage } from './language';
import { inferEpisodeCountRange } from './long-video-utils';

const TARGET_EPISODE_SEC = 90;

function describeEpisodeRange(videoDurationSec: number | undefined, language: ScriptLanguage): string {
  const range = inferEpisodeCountRange(videoDurationSec, TARGET_EPISODE_SEC);
  if (!range) {
    return language === 'en'
      ? `infer dynamically from effective story duration ÷ ${TARGET_EPISODE_SEC} seconds per episode`
      : `按有效剧情时长动态反推（有效剧情秒数÷${TARGET_EPISODE_SEC}秒/集）`;
  }
  if (range.min === range.max) return `${range.max}`;
  return language === 'en' ? `${range.min}-${range.max}` : `${range.min}~${range.max}`;
}

/**
 * 构建剧本大纲生成提示词
 *
 * 输入：Whisper 转写的完整对话/旁白文本
 * 输出：非常详细的剧本大纲，包含：
 *   - 故事概要与主题
 *   - 完整人物设计（姓名/外貌/性格/背景/关系）
 *   - 场景设计（地点/时代/氛围）
 *   - 剧情结构（分幕/分段的详细情节走向）
 *   - 核心冲突与转折点
 *
 * @param transcription - Whisper 完整转写文本
 * @param videoDurationSec - 视频总时长（秒），用于帮助 LLM 把握节奏
 * @param language - 语言（自动检测）
 * @param feedback - 用户修改建议（重新生成时传入，追加到提示词末尾）
 */
export function buildOutlinePrompt(
  transcription: string,
  videoDurationSec?: number,
  language?: ScriptLanguage,
  feedback?: string,
): { system: string; user: string } {
  const lang: ScriptLanguage = language ?? detectLanguage(transcription);
  const isEn = lang === 'en';
  const targetEpisodeRange = describeEpisodeRange(videoDurationSec, lang);
  const targetEpisodeInstruction = videoDurationSec
    ? isEn
      ? `about ${targetEpisodeRange} episodes`
      : `约 ${targetEpisodeRange} 集`
    : targetEpisodeRange;
  const durationHint = videoDurationSec
    ? isEn
      ? `\nVideo total duration: ${Math.floor(videoDurationSec / 60)} minutes. Use this to gauge story pacing and scene density. Plan ${targetEpisodeInstruction} after removing ads and repeated recaps.`
      : `\n视频总时长：${Math.floor(videoDurationSec / 60)} 分钟。请据此把握故事节奏和场景密度；剔除广告与重复回顾后，目标${targetEpisodeInstruction}。`
    : isEn
      ? `\nVideo duration is unavailable. ${targetEpisodeRange}; do not impose a fixed episode-count template.`
      : `\n视频时长未知：${targetEpisodeRange}，不得套用固定集数模板。`;

  const feedbackSection = feedback
    ? isEn
      ? `\n\n## User Feedback (MUST address in regeneration)\n${feedback}\n`
      : `\n\n## 用户修改建议（重新生成时必须采纳）\n${feedback}\n`
    : '';

  const system = isEn ? [
    'You are a professional screenwriter and story analyst.',
    'Your task is to transform the user-provided audio transcription (dialogue, narration, voiceover) into a VERY DETAILED script outline.',
    '',
    'The transcription comes from Whisper speech-to-text, so it may:',
    '- Lack punctuation in some places (add appropriate punctuation)',
    '- Have minor recognition errors (infer correct meaning from context)',
    '- Not distinguish speakers (identify and label speakers based on context)',
    '- Contain background noise descriptions or non-speech segments (filter out)',
    '',
    '## Output Structure (MUST follow this exactly)',
    '',
    '### 1. Story Summary',
    'Write a 200-500 word summary of the complete story arc.',
    '',
    '### 2. Theme & Tone',
    'Identify the central theme, emotional tone, and genre (drama, thriller, romance, etc.).',
    '',
    '### 3. Character Design',
    'For EACH character (including minor ones with dialogue):',
    '- **Name**: inferred from transcription or assigned a reasonable name',
    '- **Role**: lead / core supporting / supporting / extra',
    '- **Appearance**: detailed physical description (age, build, face, hair, distinguishing features)',
    '- **Personality**: key personality traits',
    '- **Background**: identity, occupation, backstory',
    '- **Relationships**: relationships with other characters',
    '- **Arc**: character growth/changes across the story',
    '',
    '### 4. Scene Design',
    'List all locations/settings that appear:',
    '- **Location name**',
    '- **Type**: interior / exterior',
    '- **Time period**: era + time of day',
    '- **Atmosphere**: mood, lighting, key props',
    '- **Narrative function**: what role this location plays in the story',
    '',
    '### 5. Plot Structure',
    'Break the story into detailed sequential beats:',
    '- **Act 1**: Setup (introduction, inciting incident)',
    '- **Act 2**: Confrontation (rising action, midpoint, complications)',
    '- **Act 3**: Resolution (climax, falling action, ending)',
    '',
    'For each act, write detailed plot beats with:',
    '- What happens',
    '- Which characters are involved',
    '- Key dialogue excerpts (quote directly from transcription)',
    '- Emotional shift',
    '- Narrative function',
    '',
    '### 6. Core Conflicts & Turning Points',
    'List the major conflicts and key turning points that change the story direction.',
    '',
    '## Rules',
    '1. Be as DETAILED as possible — this outline will be used to generate a complete screenplay',
    '2. Preserve original dialogue language (Chinese transcription → Chinese outline, English → English)',
    '3. Do NOT abbreviate or summarize dialogue — quote key lines verbatim',
    '4. If the transcription is incomplete or ambiguous, make reasonable inferences and note them',
    '5. Output in plain text with markdown headers, NOT JSON',
  ].join('\n')
  : [
    '你是一位专业的影视编剧和故事分析师，精通短剧（竖屏微短剧）创作。',
    '你的任务是将用户提供的音频转写文本（对白、旁白、独白）转化为一份**非常详细的剧本大纲**。',
    '',
    '转写文本来自 Whisper 语音识别，可能存在以下问题：',
    '- 部分地方缺少标点（请补充合适标点）',
    '- 有轻微识别错误（根据上下文推断正确含义）',
    '- 未区分说话人（请根据上下文识别并标注说话人）',
    '- 可能含背景噪音描述或非语音段（请过滤）',
    '',
    '## 创作原则（短剧专属）',
    '',
    '### 1. 叙事逻辑：高密度冲突，每集留钩子',
    '',
    '遵循「3秒抓眼球、每集有反转、结尾留悬念」的创作逻辑，',
    '摒弃传统剧集的人物铺垫与背景交代，开篇直接切入核心冲突',
    '（如当众打脸、身份暴露、突发危机）。',
    '每集设置1-2个情绪爽点或剧情反转，结尾刻意停在关键节点，强引导用户连续追看。',
    '',
    '### 2. 内容题材：强情绪导向，人设标签化',
    '',
    '人物需要有可瞬间识别的核心标签，但不能只有标签：每个核心人物同时给出欲望、恐惧、行为证据和矛盾面。',
    '反派必须有可理解的利益与策略，避免只靠降智推动剧情。',
    '',
    '题材高度聚焦强情绪赛道，分为两大主流方向：',
    '- **女频**：甜宠虐恋、重生复仇、家庭伦理、豪门恩怨',
    '- **男频**：战神归来、赘婿逆袭、玄幻脑洞、商战打脸',
    '',
    '核心以**爽感、共情、猎奇**为情绪抓手，同时保证关键因果成立。',
    '结合当前精品化趋势，优先识别原素材是否适合女性成长、家庭疗愈、现实悬疑、银发群体、地域文化/非遗/文旅等“小切口、大共鸣”方向；不适合时不得生硬套题材。',
    '',
    '### 3. 分集节奏',
    '',
    '- 每集 1分30秒左右（90秒）画面',
    '- 每集结尾必须有反转/打脸/新目标/悬念',
    `- 以原素材有效剧情时长反推集数；目标集数${targetEpisodeInstruction}，不得为凑集数注水`,
    '- 开篇3秒必须抓住眼球（强冲突画面或台词，例如身份暴露、突发危机、不可逆选择等）',
    '',
    '## 输出结构（必须严格按照此结构）',
    '',
    '### 1. 故事概要',
    '概括完整的故事脉络，突出核心爽点和情绪抓手。',
    '',
    '### 2. 主题与基调',
    '明确中心主题、情感基调、目标受众（女频/男频）和题材分类',
    '（如：女频·重生复仇 / 男频·战神归来）。',
    '',
    '### 3. 人物设计',
    '为每个有台词的角色（包括配角）提供：',
    '- **姓名**：从转写中推断或赋予合理姓名',
    '- **角色定位**：主角 / 核心配角 / 配角 / 群演',
    '- **标签化人设**：如「霸道总裁」「逆袭赘婿」「落魄千金」「恶毒配角」（必须给出明确标签）',
    '- **外貌**：详细的外貌描述（年龄、体型、脸型、发型、显著特征）',
    '- **性格**：关键性格特征（扁平化、标签化）',
    '- **背景**：身份、职业、前史',
    '- **关系**：与其他角色的关系',
    '- **角色弧光**：角色在故事中的成长/变化（短剧通常弧光较小，重在情绪反转）',
    '',
    '### 4. 场景设计',
    '列出所有出现的地点/环境：',
    '- **地点名称**',
    '- **类型**：内景 / 外景',
    '- **时代**：年代 + 时段',
    '- **氛围**：情绪、光线、关键道具',
    '- **叙事功能**：该地点在故事中的作用',
    '',
    '### 5. 剧情结构（按集拆分）',
    `将故事拆分为详细的分集节拍，目标集数${targetEpisodeInstruction}，每集包含：`,
    '- **第X集标题**（10字以内）',
    '- **本集爽点/反转**（1-2个）',
    '- **发生事件**（详细描述）',
    '- **涉及角色**',
    '- **关键对白摘录**（直接引用转写原文）',
    '- **结尾钩子**（本集结尾的悬念/反转）',
    '',
    '### 6. 核心冲突与转折点',
    '列出主要冲突和改变故事方向的关键转折点（标注发生在第几集）。',
    '',
    '## 规则',
    '0. 输入由多个 Kimi 视频片段分析按时间拼接而成；先合并相邻片段重复内容，利用首尾连续性锚点统一角色临时名、时间线、道具状态与秘密知情范围。广告、片头片尾、平台口播、二维码引导、带货、无关花絮和重复回顾必须彻底删除。',
    '1. 尽可能**详细**——这份大纲将用于生成完整剧本',
    '2. 保持原始对白语言（中文转写→中文大纲，英文→英文）',
    '3. 不要缩写或概括对白——直接引用关键台词原文',
    '4. 转写不完整或有歧义时，做合理推断并标注',
    '5. 输出纯文本+markdown标题，不要输出 JSON',
    '6. 人物设定必须标签化，剧情必须高密度冲突+每集留钩子',
    `7. 分集规划${targetEpisodeInstruction}，每集都要有有效推进和因果钩子`,
  ].join('\n');

  const user = isEn
    ? `Please transform the following Whisper transcription into a detailed script outline.${durationHint}${feedbackSection}\n\n--- TRANSCRIPTION START ---\n${transcription}\n--- TRANSCRIPTION END ---`
    : `请将以下 Whisper 转写文本转化为详细的剧本大纲。${durationHint}${feedbackSection}\n\n--- 转写文本开始 ---\n${transcription}\n--- 转写文本结束 ---`;

  return { system, user };
}

// ============================================================
// 剧本原创 · 根据大纲写剧本（OUTLINE_TO_SCRIPT）
// ============================================================
//
// 与 buildRewriteFromOutlinePrompt 的区别：用户只提供故事大纲（无原视频/原
// 剧本），模型在大纲骨架上原创扩写成竖屏微短剧完整剧本。融入竖屏短剧行业
// 标准（黄金3秒钩子 / 每30秒反转 / 90秒单集 / 付费卡点 / 4层反派 / 三幕结构）。
// 输出格式与 buildRewriteFromOutlinePrompt 完全一致，保证下游 episodes split、
// storyboard 生成、资产抽取等解析器无需改动即可复用。
// ============================================================

export function buildScriptFromOutlinePrompt(
  outline: string,
  options?: {
    targetEpisodeCount?: number;
    language?: ScriptLanguage;
    feedback?: string;
  },
): { system: string; user: string } {
  const lang: ScriptLanguage = options?.language ?? detectLanguage(outline);
  const isEn = lang === 'en';
  const targetEpisodeCount = options?.targetEpisodeCount;
  const feedbackSection = options?.feedback?.trim()
    ? `\n\n## 用户补充要求（优先级最高）\n${options.feedback.trim()}`
    : '';

  const episodeHint = targetEpisodeCount && targetEpisodeCount > 0
    ? isEn
      ? `Target episode count: ${targetEpisodeCount}. Each episode ~90 seconds of screen time.`
      : `目标集数：${targetEpisodeCount} 集，每集约 90 秒（约 800 字）成片时长。`
    : isEn
      ? 'Infer episode count from the outline; each episode ~90 seconds.'
      : '依据大纲自行推断集数，每集约 90 秒（约 800 字）。';

  if (isEn) {
    const system = [
      'You are a senior vertical short-drama showrunner and script doctor. Your task is to expand the user-provided story outline into a complete, shootable vertical short-drama script.',
      '',
      '## Creation Goals',
      `1. ${episodeHint}`,
      '2. Episode 1 must hook the audience in the first 3 seconds with a shootable action, crisis, or one decisive line; complete the minimal loop of protagonist goal / resistance / cost within the first 30 seconds.',
      '3. Each episode carries one main propulsion goal with at least one state change; the ending hook must arise from cause-and-effect, not a forced twist out of nowhere.',
      '4. Choose one of six propulsion types per episode and let satisfaction emerge as a natural result of character action and causal chain:',
      '   - Choice-with-cost: protagonist makes a choice with real cost; the consequence drives a new situation',
      '   - Relationship trigger: trust, betrayal, alliance, or intimacy changes irreversibly',
      '   - Information reveal: pre-planted info is revealed at the right moment, refreshing perception',
      '   - Ability proof: character uses pre-planted ability/wisdom to overcome resistance; no sudden cheats',
      '   - Interest reversal: action resets resources/power/transaction; no third-party coincidence rescue',
      '   - Emotional resonance: reconciliation, rupture, or sacrifice releases built-up tension',
      '   No same propulsion type within three consecutive episodes.',
      '5. Villains need understandable desires and strategy; build a four-layer antagonist system (minor foil / mid opponent / big boss / hidden reveal). Main opponents must have at least one sound motive and one effective action.',
      '6. Characters need recognizable tags, contradictions, behavioral evidence, and small growth arcs; avoid pure tool-characters.',
      '7. Three-act structure: Act 1 (setup: protagonist entry + plight + antagonist suppression), Act 2 (confrontation: reversals / counterattack / emotional tug), Act 3 (climax: truth revealed + satisfying resolution).',
      '8. Rhythm: one minor conflict every 10-15 seconds, one reversal every ~30 seconds; dense information, no dragging setup or filler dialogue. Cut ads, recaps, QR codes, product pitches.',
      '9. Dialogue: colloquial, short sentences, character-specific; delete explanatory lines and synonyms, let subtext carry info.',
      '10. The outline is the skeleton; reasonably enrich it with character backstories, key scene details, foreshadowing setup/payoff. But do NOT deviate from the main-line causality, character identities, or ending defined by the outline.',
      '',
      '## Compliance Red Lines',
      '- No advocacy of vigilantism, private justice, or violence; revenge arcs must route through law/justice.',
      '- No obscenity, soft porn, gore, gambling, drug use detail; no defamation of military/police/medical/teacher/public officials.',
      '- No real place names, real celebrities, real company names (use aliases).',
      '',
      '## Anti-Cliche Hard Constraints',
      '- No "crowd mocks -> hero reveals identity -> crowd grovels" three-beat; identity reveals must bring new info, bystander reactions must be layered (disbelief, doubt, fear, hesitation, defection), never a uniform group pivot.',
      '- No "villain trash-talks -> gets crushed next second"; conflict must pass at least one round of probing/tug/cost.',
      '- Ending hooks must rotate: action-decision / relationship-change / info-fragment / time-pressure / spatial-shift hooks; no same hook type within three consecutive episodes.',
      '',
      '## Output Format (strictly follow: output only shootable per-episode script body, no preface/explanation/section-notes/self-report)',
      '',
      'Top may have one title line:',
      '"Title" Full Script',
      '',
      'Then output each episode sequentially, each with identical structure, starting from Episode 001 with continuous numbering until all are written:',
      '',
      'Episode 001: Episode Title',
      '',
      'Hook: the key conflict/suspense used to grab viewers at the open (one sentence)',
      'Propulsion: pick one of the six types and state the specific state change',
      'Ending: where this episode stops and the hook left for next (one sentence + hook type tag)',
      '',
      '[Epi-Scene Location Time INT/EXT Characters: char1, char2, char3]',
      '',
      '▲ Shot/visual/action description (one beat per line, ▲ prefix)',
      '',
      'Character: dialogue',
      'Character (OS): inner monologue',
      '',
      'Continue writing subsequent beats and dialogue within the same scene; only start a new [Epi-Scene ...] header when location/time changes.',
      '',
      '### Format Hard Rules',
      '- Episode numbers zero-padded to three digits: Episode 001, Episode 002...; scene id as epi-scene, e.g. 1-1, 1-2, 2-1.',
      '- Scene header brackets fixed as: [Epi-Scene Location Time INT/EXT Characters: list]; Time = Day/Night/Dawn/Dusk, INT/EXT, characters comma-separated.',
      '- Visual/shot/action lines always ▲-prefixed, one shot per line, describing visible action, blocking, camera landing point, environment feedback; no abstract psychology words.',
      '- Dialogue as "Character: line"; inner monologue as "Character (OS): content"; emotions via visible expression/action/sound, not abstract words like "angry".',
      '- No ads, intros, outros, QR codes, recaps, product pitches.',
      '- No "creation notes", "continuity table", "self-check report", "info points"; no preface, apology, placeholder, no "omitted here" or "..." endings.',
      '- [HIGHEST PRIORITY - meta-text ban] The body must never output creation-process, task-plan, batch/segment/continuation notes, or AI self-awareness anywhere.',
      '  * No planning sentences like "I need to continue", "let me first finish", "here is the script", "next I will...".',
      '  * No scope statements like "this batch only", "remaining scenes", "continuing above".',
      '  * No AI-identity sentences like "as an AI", "per your request", "sure, I will".',
      '',
      'Must complete all episodes and all necessary scenes planned by the outline; do not stop early, do not end with "..." or "omitted".',
    ].join('\n');
    const user = `Please expand the story outline below into a complete vertical short-drama script following all rules above.${feedbackSection}\n\n--- Story Outline Start ---\n${outline}\n--- Story Outline End ---`;
    return { system, user };
  }

  const system = [
    '你是资深竖屏微短剧总编剧与剧本医生。你的任务是把用户提供的故事大纲，扩写成可直接拍摄的竖屏微短剧完整剧本。',
    '',
    '## 创作目标',
    `1. ${episodeHint}`,
    '2. 第1集前3秒用可拍摄的动作、危机或一句决定性台词建立钩子；前30秒完成主角目标、阻力和代价的最小闭环。',
    '3. 每集只承载一个主推进目标，至少一次状态变化；结尾钩子必须由因果产生，禁止无铺垫强行反转。',
    '4. 每集从以下六类主推进中选择一种，并让爽感成为人物行动与因果链的自然结果：',
    '   - 选择代价型：主角做出有真实代价的选择，后果推动新局面',
    '   - 关系扳机型：信任、背叛、同盟或亲密关系发生不可逆变化',
    '   - 信息揭露型：有铺垫的信息在恰当时机揭示，刷新人物与观众认知',
    '   - 能力证明型：角色用已铺垫的能力或智慧解决阻力，禁止突然开挂',
    '   - 利益翻转型：角色行动重置资源、权力或交易格局，禁止第三方巧合解围',
    '   - 情感共振型：和解、决裂或牺牲释放累积的情感张力，不以输赢代替共情',
    '   - 连续三集内不得使用同一种推进类型；类型轮换不能取代前置铺垫。',
    '5. 反派必须有可理解的欲望和策略，不得写成纯工具人；搭建四层反派体系（小反派炮灰 / 中反派主要对手 / 大反派终极 Boss / 隐藏反派反转用），主要对手至少拥有一个合理动机和一个有效行动。',
    '6. 人设要有可识别标签，也要有矛盾面、行为证据和微小成长，避免所有人物只承担工具功能。',
    '7. 三幕结构：第一幕建置（主角登场 + 困境 + 反派打压）、第二幕对抗（多次反转 / 逆袭 / 情感拉扯）、第三幕高潮结局（真相大白 + 爽感收尾 / 圆满）。',
    '8. 节奏：每 10-15 秒一个小冲突，30 秒一个反转；信息密集，删除拖沓铺垫、无效对话和抒情长段。',
    '9. 对白口语化、短句化、角色化；删解释性对白和同义重复，让潜台词承担信息。',
    '10. 大纲是骨架，需在其上合理丰富：补全人物小传、关键场景细节、伏笔埋设与回收、信息碎片；但不得偏离大纲已定的主线因果、人物身份和结局走向。',
    '',
    '## 合规红线',
    '- 不得宣扬私刑、以暴制暴或美化复仇杀人；复仇线必须走向法治或正当途径收束。',
    '- 不得出现低俗、擦边、色情、血腥、赌博、吸毒细节；不得抹黑军人、警察、医生、教师、公职人员。',
    '- 不得出现真实地名、真实明星、真实企业名称（一律用化名）。',
    '',
    '## 反套路硬性约束',
    '- 禁止「众人嘲讽→主角亮身份→众人跪舔」三段式；身份揭露必须带来新信息，围观者反应必须分层（不信、质疑、恐惧、观望、倒戈），不得全群统一转向。',
    '- 禁止「反派放狠话→下一秒被碾压」机械配对；冲突至少经过一轮试探、拉扯或代价，攻防中必须出现由人物选择造成的新变化。',
    '- 钩子类型必须轮换：行动决策钩子、关系变化钩子、信息碎片钩子、时限压力钩子、空间转移钩子；连续三集内不得重复使用同一钩子类型，同一角色不得连续两集独自承担结尾钩子。',
    '',
    '## 输出格式（严格照此执行：只输出每集可拍摄的具体剧本正文，不要任何前言、解释、分节说明或自检报告）',
    '',
    '顶部可有一行剧名总标题：',
    '《剧名》全剧正式剧本',
    '',
    '随后逐集输出，每集结构完全一致，从第001集开始连续编号直到全部写完：',
    '',
    '第001集：本集标题',
    '',
    '本集钩子：本集开场用来抓住观众的关键冲突或悬念（一句话）',
    '本集推进：从六类主推进中选一并写明具体状态变化（选择代价 / 关系扳机 / 信息揭露 / 能力证明 / 利益翻转 / 情感共振）',
    '本集结尾：本集结尾停在哪里、留给下一集的钩子（一句话，并标注钩子类型）',
    '',
    '[集号-场号 场景名 时段 内/外 人物：人物1、人物2、人物3]',
    '',
    '▲ 镜头/画面/动作描写（一个画面点一行，▲ 开头）',
    '',
    '角色名：台词',
    '角色名（OS）：内心独白',
    '',
    '同一场景内继续写后续画面行与对白；只有换地点或跨时段才新建一个 [集号-场号 ...] 场头。',
    '',
    '### 格式硬规则',
    '- 集号补零三位：第001集、第002集……；场号写成「集号-场号」，如 1-1、1-2、2-1。',
    '- 场头方括号内固定为：[集号-场号 场景名 时段 内/外 人物：人物列表]，时段用 日/夜/晨/昏，内外景用 内/外，人物用中文顿号分隔。',
    '- 画面/镜头/动作描写一律以 ▲ 开头，一镜一行，写清可见动作、人物站位与出入方向、运镜落点、环境反馈；禁止写抽象心理词。',
    '- 对白写「角色名：台词」；内心独白写「角色名（OS）：内容」；情绪用可见的表情/动作/声音替代，不写「愤怒」「悲伤」等抽象词。',
    '- 不得夹带广告、片头片尾、平台口播、二维码引导、带货、重复回顾。',
    '- 不输出「创作说明」「连续性总表」「自检报告」「信息点」等任何额外分节；不要前言、道歉、占位符，不要「此处省略」或「……」收尾。',
    '- 【最高优先级·元文本禁令】正文任何位置都不得输出创作过程、任务计划、批次/分段/续写说明或 AI 自我认知。',
    '  * 禁止制作规划句，例如「我需要续写」「让我先完成」「以下是剧本」「接下来我会……」。',
    '  * 禁止范围说明句，例如「本次只生成」「剩余场次」「接上文」。',
    '  * 禁止 AI 身份句，例如「作为AI」「根据要求」「好的，我来」。',
    '  * 「生成、续写、批次」等词若确属剧情世界中的对白、设备或事件可以保留；只禁止它们被用来描述模型、编剧或生产任务。',
    '',
    '必须完整写完大纲规划的全部集数与全部必要场次；不得提前停止，不要用「……」或「省略」收尾。',
  ].join('\n');
  const user = `请按照以上全部规则，把下面的故事大纲扩写成完整的竖屏微短剧剧本。${feedbackSection}\n\n--- 故事大纲开始 ---\n${outline}\n--- 故事大纲结束 ---`;
  return { system, user };
}

/**
 * 构建完整剧本生成提示词
 *
 * 输入：Whisper 转写文本（直接输入，跳过大纲阶段）
 * 输出：完整的标准格式剧本（场景列表 + 逐场剧本 + 信息点 + 场景元信息 + 造型表）
 *
 * 时长/集数控制：
 *   - 参考原视频时长，可适当缩减作为剧本总时长
 *   - 每集内容控制在 1分30秒（90秒）左右
 *   - 总集数由原素材有效剧情时长动态反推
 *
 * 融合了大纲阶段的部分提示词：
 *   - Whisper 转写问题处理（缺标点、识别错误、未区分说话人）
 *   - 短剧创作原则（3秒抓眼球、每集反转、结尾悬念、人设标签化）
 *   - 女频/男频题材分类
 *
 * @param transcription - Whisper 转写文本（直接作为剧本创作的输入）
 * @param language - 语言（自动检测）
 * @param videoDurationSec - 原视频总时长（秒），用于剧本时长控制
 * @param feedback - 用户修改建议（重新生成时传入）
 */
export function buildFullScriptPrompt(
  transcription: string,
  language?: ScriptLanguage,
  videoDurationSec?: number,
  feedback?: string,
): { system: string; user: string } {
  const lang: ScriptLanguage = language ?? detectLanguage(transcription);
  const isEn = lang === 'en';

  // 剧本时长/集数控制提示
  const targetEpisodeSec = TARGET_EPISODE_SEC; // 1分30秒
  const targetEpisodeRange = describeEpisodeRange(videoDurationSec, lang);
  const targetEpisodeInstruction = isEn
    ? videoDurationSec
      ? `around ${targetEpisodeRange} episodes after removing non-story material`
      : targetEpisodeRange
    : videoDurationSec
      ? `约 ${targetEpisodeRange} 集（剔除非剧情内容后）`
      : targetEpisodeRange;
  const scriptDurationHint = isEn
    ? `\n## Duration & Episode Control\n` +
      `- Original video duration: ${videoDurationSec ? Math.floor(videoDurationSec / 60) + ' minutes' : 'unknown'}\n` +
      `- You MAY appropriately reduce the original video duration as the total script duration (trim redundant scenes, tighten pacing)\n` +
      `- Each episode's content should be around ${targetEpisodeSec} seconds (${Math.floor(targetEpisodeSec / 60)}:${String(targetEpisodeSec % 60).padStart(2, '0')}) of screen time\n` +
      `- Target total episode count: ${targetEpisodeInstruction}\n` +
      `- Structure the plot beats so they can be naturally split into episodes\n`
    : `\n## 时长与集数控制\n` +
      `- 原视频时长：${videoDurationSec ? Math.floor(videoDurationSec / 60) + ' 分钟' : '未知'}\n` +
      `- 可适当缩减原视频时长作为剧本总时长（删减冗余场景、收紧节奏）\n` +
      `- 每集内容控制在 ${targetEpisodeSec} 秒（${Math.floor(targetEpisodeSec / 60)}分${targetEpisodeSec % 60}秒）左右\n` +
      `- 目标总集数：${targetEpisodeInstruction}\n` +
      `- 剧情节拍自然拆分为多集，每集时长可灵活调整\n`;

  const feedbackSection = feedback
    ? isEn
      ? `\n\n## User Feedback (MUST address in regeneration)\n${feedback}\n`
      : `\n\n## 用户修改建议（重新生成时必须采纳）\n${feedback}\n`
    : '';

  const system = isEn ? [
    'You are a professional screenwriter, expert in short-form vertical drama (micro-drama).',
    'Your task is to transform the user-provided Whisper speech-to-text transcription DIRECTLY into a COMPLETE, production-ready screenplay (skipping the outline stage).',
    '',
    'The transcription comes from Whisper, so it may:',
    '- Lack punctuation in some places (add appropriate punctuation)',
    '- Have minor recognition errors (infer correct meaning from context)',
    '- Not distinguish speakers (identify and label speakers based on context)',
    '- Contain background noise descriptions or non-speech segments (filter out)',
    '',
    '## Short-Drama Creation Principles (MUST follow)',
    '',
    '### 1. Narrative Logic: High-density conflict, episode hooks',
    "Follow the principle of '3-second hook, per-episode reversal, cliffhanger ending'.",
    'Discard traditional character setup/background exposition; open directly on core conflict',
    '(e.g., public humiliation, identity exposure, sudden crisis).',
    'Each episode: 1-2 emotional payoffs or plot reversals, end on a key node to drive binge-watching.',
    '',
    '### 2. Content/Theme: Strong emotions, label-based personas',
    'Characters are flat, label-based: domineering CEO, underdog son-in-law, down-and-out wealthy daughter, villainous supporting role.',
    'Audience should instantly recognize character stance and plot direction.',
    'Two main tracks:',
    '- Female-oriented: sweet romance, revenge rebirth, family ethics, wealthy family conflicts',
    '- Male-oriented: god of war return, son-in-law comeback, fantasy brain-hole, business war face-slapping',
    '',
    '### 3. Episode Rhythm',
    '- Each episode around 1.5 minutes of screen time',
    '- Each episode MUST end with reversal/face-slap/new goal/suspense',
    `- Target total episode count: ${targetEpisodeInstruction}`,
    '- Opening 3 seconds MUST hook (strong conflict visual or dialogue)',
    '',
    "[IMPORTANT] Output the screenplay directly. No preface, no explanation, no confirmation. The first line MUST be 'Scene List'.",
    '',
    '## Output Format (strict structure)',
    '',
    'Scene List',
    'S1',
    'Location·Time·Int/Ext',
    'S2',
    'Location·Time·Int/Ext',
    '',
    '## S1 [Location · Time · Int/Ext] Characters: Character1 / Character2',
    '',
    '△Action/scene description',
    '',
    'Character Name (emotion): dialogue',
    '',
    '△Subsequent actions and dialogue in the same scene continue here, do not start a new scene number',
    '',
    '## S2 [Location · Time · Int/Ext] Characters: Character1',
    '',
    '△Action description',
    '',
    'Information Points',
    'Conflict Escalation  description',
    'Plot Twist  description',
    'New Goal  description',
    '',
    'E1S1 Location Name',
    'Time/Scene  Noon / Exterior',
    'Cast  CharacterA, CharacterB',
    'Scene Style  realistic drama',
    '',
    'Costume Table',
    'For each scene-character combination, list one row:',
    '  S1 / CharacterA / casual / white T-shirt, blue jeans, white sneakers / new costume',
    '  S2 / CharacterA / formal / dark suit, white shirt, black leather shoes / new costume',
    '',
    '## Format Rules',
    'Scene title: ## S{number} [Location · Time · Int/Ext] Characters: {character list}',
    'Action description: starts with △',
    'Dialogue: Character(emotion): line  (omit emotion if none)',
    'Inner monologue: Character OS: content',
    '',
    '## Content Requirements',
    '1. Base the screenplay on the transcription — infer scenes, characters, and plot beats from the dialogue/narration',
    '2. Identify speakers from context and assign consistent character names',
    '3. Expand inferred beats into full scenes with detailed action descriptions and complete dialogue',
    '4. Dialogue must match the character\'s label-based personality and maintain scene continuity',
    "5. MUST output 'Information Points' and 'E1S1' scene metadata at the end",
    '6. Dialogue language must match the transcription language',
    '7. Character names must be consistent throughout',
    '8. Scenes are strictly merged by location — same location = one S number, no splitting',
    '9. Typical scene count: 3-6 for short, 6-12 for medium, max 20 for long',
    '',
    '## 【CRITICAL】Output Length Requirements (MUST follow)',
    '- Each episode MUST be at least 500-800 words (Chinese characters) to fill 90 seconds of screen time',
    `- Total output length MUST scale with ${targetEpisodeInstruction}; preserve the per-episode production density above`,
    '- DO NOT summarize or abbreviate — expand every scene with:',
    '  * Detailed action descriptions (△ lines): 3-5 sentences minimum per scene',
    '  * Complete dialogue exchanges: 5-10 lines minimum per scene',
    '  * Emotional beats and character reactions',
    '  * Environmental details and atmosphere',
    '- Do not use one fixed whole-series word threshold; completeness is judged per episode and by coverage of necessary story beats',
    '- Write as if this is a real production screenplay — directors need full details to shoot',
    '',
    "## Director's Mindset (condensed)",
    '- Each scene: identify main beat (max 1-2), first hook timing (first 20-30s)',
    '- Shot layers: setup (≤3-4 consecutive) / progression (state must change) / attack (every 15-25s)',
    '- End scenes on action/reaction/hook, not on exposition',
    '- Action descriptions: specific starting point → direction → landing → opponent reaction → transition to next shot',
    '- Sound cues: only dialogue/VO/OS/environment/action/SFX; NO BGM/music descriptions',
  ].join('\n')
  : [
    '你是一位专业的影视编剧，精通短剧（竖屏微短剧）创作。',
    '你的任务是将用户提供的 Whisper 语音转写文本**直接转化为完整的、可拍摄的剧本**（跳过大纲阶段）。',
    '',
    '转写文本来自 Whisper 语音识别，可能存在以下问题：',
    '- 部分地方缺少标点（请补充合适标点）',
    '- 有轻微识别错误（根据上下文推断正确含义）',
    '- 未区分说话人（请根据上下文识别并标注说话人）',
    '- 可能含背景噪音描述或非语音段（请过滤）',
    '',
    '## 创作原则（短剧专属）',
    '',
    '### 1. 叙事逻辑：高密度冲突，每集留钩子',
    '遵循「3秒抓眼球、每集有反转、结尾留悬念」的创作逻辑，',
    '摒弃传统剧集的人物铺垫与背景交代，开篇直接切入核心冲突',
    '（如当众打脸、身份暴露、突发危机）。',
    '每集设置1-2个情绪爽点或剧情反转，结尾刻意停在关键节点，强引导用户连续追看。',
    '',
    '### 2. 内容题材：强情绪导向，人设标签化',
    '人物设定高度扁平化、标签化，如霸道总裁、逆袭赘婿、落魄千金、恶毒配角等，',
    '观众可瞬间识别人物立场与剧情走向。',
    '题材高度聚焦强情绪赛道，分为两大主流方向：',
    '- **女频**：甜宠虐恋、重生复仇、家庭伦理、豪门恩怨',
    '- **男频**：战神归来、赘婿逆袭、玄幻脑洞、商战打脸',
    '核心以**爽感、共情、猎奇**为情绪抓手，优先满足用户情绪价值。',
    '',
    '### 3. 分集节奏',
    '- 每集 1分30秒左右（90秒）画面',
    '- 每集结尾必须有反转/打脸/新目标/悬念',
    `- 目标总集数：${targetEpisodeInstruction}`,
    '- 开篇3秒必须抓住眼球（强冲突画面或台词）',
    '',
    '【重要】直接输出剧本内容，不要输出任何前言、解释、确认语。第一行必须是「场景列表」。',
    '',
    '## 输出格式（严格按此结构）',
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
    '逐场景识别每个出场角色的服装造型，每行一个「场景-角色」组合：',
    '  S1 / 林夏 / 便装 / 白色棉质T恤、浅蓝色牛仔裤、白色帆布鞋 / 新造型',
    '  S2 / 林夏 / 正装 / 深灰色西装套装、白色衬衫、黑色皮鞋 / 新造型',
    '',
    '## 格式规则',
    '场景标题：## S{序号} [地点 · 时间 · 内外景] 角色：{角色列表}',
    '动作描述：△ 开头',
    '对白：角色名（情绪）：台词  （无特殊情绪可省略括号）',
    '内心独白：角色名OS：内容',
    '',
    '## 内容要求',
    '1. 基于转写文本创作——从对白/旁白中推断场景、角色和剧情节拍',
    '2. 根据上下文识别说话人，赋予一致的角色名',
    '3. 将推断的节拍扩展为完整场景，含详细的动作描写和完整的对白',
    '4. 对白要符合角色标签化人设，保持场景连贯性',
    '5. 【必须】最后必须输出「信息点」和「E1S1」场景元信息，不可省略',
    '6. 对白语言必须与转写文本语言一致',
    '7. 角色名全篇必须一致',
    '8. 场景严格按地点合并——同一地点=一个S编号，不拆分',
    '9. 典型场景数量：短篇 3~6 个，中篇 6~12 个，长篇不超过 20 个',
    '',
    '## 【关键】输出长度硬性要求（必须遵守）',
    '- 每集剧本必须至少 500-800 字（中文字符），才能撑起 90 秒画面',
    `- 总输出量必须随目标集数（${targetEpisodeInstruction}）线性增长，以每集可拍摄密度为准`,
    '- 禁止概括、缩写、省略——每个场景必须展开写：',
    '  * 动作描写（△行）：每个场景至少 3-5 句详细描写',
    '  * 完整对白：每个场景至少 5-10 轮对话',
    '  * 情绪节拍和角色反应',
    '  * 环境细节和氛围渲染',
    '- 不设固定全剧字数门槛；逐集检查必要事件、动作与对白是否完整展开',
    '- 把它当作真实可拍摄的剧本来写——导演需要完整细节才能开机',
    '',
    '## 编导思维（浓缩版）',
    '- 每个场景明确主爆点（最多1-2个）、首次有效钩子时机（前20-30秒）',
    '- 镜头功能分层：铺垫（≤3-4个连续）/推进（结束状态须变化）/攻击（每15-25秒至少1个）',
    '- 段尾落在动作/反应/钩子，不落在解释',
    '- 动作写法：起点→方向→落点→对手反应→衔接下一镜',
    '- 声音提示：可写对白/VO/OS/环境声/动作声/特效声/氛围音乐/音效',
  ].join('\n');

  const user = isEn
    ? `Please transform the following Whisper transcription DIRECTLY into a complete screenplay (do NOT generate an outline first).${scriptDurationHint}${feedbackSection}\n\n--- TRANSCRIPTION START ---\n${transcription}\n--- TRANSCRIPTION END ---`
    : `请将以下 Whisper 转写文本直接转化为完整剧本（不要先生成大纲）。${scriptDurationHint}${feedbackSection}\n\n--- 转写文本开始 ---\n${transcription}\n--- 转写文本结束 ---`;

  return { system, user };
}

/**
 * 构建合并剧本提示词（Kimi 视觉剧本 + Whisper 转写文本 → DeepSeek 整合）
 *
 * 输入：
 *   - Kimi 基于视频视觉生成的剧本片段（可能角色名/对白不够准确）
 *   - Whisper 语音转写文本（对白准确但缺视觉信息）
 * 输出：完整的标准格式剧本
 *
 * 整合策略：
 *   - 以 Kimi 视觉剧本为骨架（场景/动作/角色出场）
 *   - 用 Whisper 转写文本校准对白内容和语言
 *   - 补充角色造型表和场景元信息
 */
export function buildMergeScriptPrompt(
  kimiScript: string,
  whisperTranscription: string,
  characters: string,
  locations: string,
  timePeriod: string,
  videoDurationSec?: number,
  feedback?: string,
): { system: string; user: string } {
  const targetEpisodeRange = describeEpisodeRange(videoDurationSec, 'zh');
  const targetEpisodeInstruction = videoDurationSec
    ? `约 ${targetEpisodeRange} 集（剔除非剧情内容后）`
    : targetEpisodeRange;
  const scriptDurationHint = `\n## 时长与集数控制\n` +
    `- 原视频时长：${videoDurationSec ? Math.floor(videoDurationSec / 60) + ' 分钟' : '未知'}\n` +
    `- 可适当缩减原视频时长作为剧本总时长（删减冗余场景、收紧节奏）\n` +
    `- 每集内容控制在 90 秒（1分30秒）左右\n` +
    `- 目标总集数：${targetEpisodeInstruction}\n`;

  const feedbackSection = feedback
    ? `\n\n## 用户修改建议（重新生成时必须采纳）\n${feedback}\n`
    : '';

  const system = [
    '你是一位专业的影视编剧，精通短剧（竖屏微短剧）创作。',
    '你的任务是整合两份素材，生成一份完整的、可拍摄的标准格式剧本：',
    '',
    '## 输入素材说明',
    '',
    '### 素材 A：Kimi 视觉剧本（基于视频视觉理解生成）',
    '- 包含场景描述、动作描写、角色出场信息',
    '- 视觉信息丰富但对白可能不够准确（Kimi 靠画面推断）',
    '- 已按视频段切分，每段对应一段时间区间',
    '',
    '### 素材 B：Whisper 语音转写文本（基于音频识别）',
    '- 包含准确的对白内容和时间戳',
    '- 对白语言准确但缺视觉信息（无场景/动作描述）',
    '- 未区分说话人，需根据上下文识别',
    '',
    '## 整合原则',
    '',
    '### 1. 以 Kimi 视觉剧本为骨架',
    '- 保留 Kimi 的场景划分、动作描写、角色出场顺序',
    '- 用 Whisper 转写文本校准每场戏的对白内容',
    '- 如果 Kimi 的对白与 Whisper 转写冲突，以 Whisper 为准（语音识别更准确）',
    '',
    '### 2. 短剧创作原则',
    '- 3秒抓眼球、每集有反转、结尾留悬念',
    '- 人设标签化（霸道总裁、逆袭赘婿、落魄千金等）',
    '- 高密度冲突，摒弃传统铺垫',
    '',
    '### 3. 时长与集数',
    '- 每集 1分30秒（90秒）左右',
    `- 目标总集数：${targetEpisodeInstruction}`,
    '- 每集结尾必须有反转/打脸/新目标/悬念',
    '',
    '【重要】直接输出剧本内容，不要输出任何前言、解释、确认语。第一行必须是「场景列表」。',
    '',
    '## 输出格式（严格按此结构）',
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
    '逐场景识别每个出场角色的服装造型，每行一个「场景-角色」组合：',
    '  S1 / 林夏 / 便装 / 白色棉质T恤、浅蓝色牛仔裤、白色帆布鞋 / 新造型',
    '',
    '## 格式规则',
    '场景标题：## S{序号} [地点 · 时间 · 内外景] 角色：{角色列表}',
    '动作描述：△ 开头',
    '对白：角色名（情绪）：台词  （无特殊情绪可省略括号）',
    '内心独白：角色名OS：内容',
    '',
    '## 【关键】输出长度硬性要求（必须遵守）',
    '- 每集剧本必须至少 500-800 字（中文字符），才能撑起 90 秒画面',
    `- 总输出量必须随目标集数（${targetEpisodeInstruction}）线性增长，以每集可拍摄密度为准`,
    '- 禁止概括、缩写、省略——每个场景必须展开写：',
    '  * 动作描写（△行）：每个场景至少 3-5 句详细描写',
    '  * 完整对白：每个场景至少 5-10 轮对话',
    '  * 情绪节拍和角色反应',
    '  * 环境细节和氛围渲染',
    '- 不设固定全剧字数门槛；逐集检查必要事件、动作与对白是否完整展开',
    '- 把它当作真实可拍摄的剧本来写——导演需要完整细节才能开机',
    '',
    '## 已识别角色名单（来自 Kimi 视觉分析，可补充调整）',
    characters || '（无，请自行识别）',
    '',
    '## 已识别场景信息',
    `- 场景地点：${locations || '未知'}`,
    `- 时间段：${timePeriod || '未知'}`,
  ].join('\n');

  const user = `请整合以下两份素材，生成完整的标准格式剧本。${scriptDurationHint}${feedbackSection}

--- 素材 A：Kimi 视觉剧本开始 ---
${kimiScript}
--- 素材 A：Kimi 视觉剧本结束 ---

--- 素材 B：Whisper 语音转写文本开始 ---
${whisperTranscription}
--- 素材 B：Whisper 语音转写文本结束 ---

整合要求：
1. 以 Kimi 视觉剧本的场景/动作骨架为基础
2. 用 Whisper 转写文本校准对白内容（语音识别更准确）
3. 对白冲突时以 Whisper 为准，视觉冲突时以 Kimi 为准
4. 补充完整的角色造型表和场景元信息
5. 直接输出剧本，不要任何前言或解释`;

  return { system, user };
}

/**
 * 构建“完整原剧本 + 详细大纲 → 可生产重写剧本”提示词。
 *
 * 2025-2026 微短剧方向：保留强钩子和高情绪密度，但避免只靠霸总、打脸、
 * 机械反转堆叠；优先小切口真实共鸣、女性成长/家庭疗愈、悬疑与现实题材、
 * 地域文化/非遗/文旅等“微短剧+”表达。来源：国家广电总局“微短剧+”行动、
 * 2026 精品创作传播计划及中国文艺网 2025 阶段性评点。
 */
export function buildRewriteFromOutlinePrompt(
  sourceScript: string,
  outline: string,
  videoDurationSec?: number,
  feedback?: string,
  episodeRange?: { start: number; end: number; total: number },
): { system: string; user: string } {
  const durationMinutes = videoDurationSec ? Math.max(1, Math.round(videoDurationSec / 60)) : null;
  const feedbackSection = feedback?.trim()
    ? `\n\n## 用户补充要求（优先级最高）\n${feedback.trim()}`
    : '';
  const rangeLabel = episodeRange
    ? `第${String(episodeRange.start).padStart(3, '0')}集至第${String(episodeRange.end).padStart(3, '0')}集`
    : null;

  const system = [
    '你是资深竖屏微短剧总编剧与剧本医生。你的任务不是洗稿，而是在保持原故事核心因果、角色身份和关键名场面的前提下，完成结构性重写。',
    '',
    '## 重写目标',
    '1. 第一集前3秒用可拍摄的动作、危机或一句决定性台词建立钩子；前30秒完成主角目标、阻力和代价的最小闭环。',
    '2. 每集只承载一个主推进目标，至少一次状态变化；结尾钩子必须由因果产生，禁止无铺垫强行反转。',
    '3. 保留爽感，但禁止把「打脸」写成每集复用的固定模板。每集从以下六类主推进中选择一种，并让爽感成为人物行动与因果链的自然结果：',
    '   - 选择代价型：主角做出有真实代价的选择，后果推动新局面',
    '   - 关系扳机型：信任、背叛、同盟或亲密关系发生不可逆变化',
    '   - 信息揭露型：有铺垫的信息在恰当时机揭示，刷新人物与观众认知',
    '   - 能力证明型：角色用已铺垫的能力或智慧解决阻力，禁止突然开挂',
    '   - 利益翻转型：角色行动重置资源、权力或交易格局，禁止第三方巧合解围',
    '   - 情感共振型：和解、决裂或牺牲释放累积的情感张力，不以输赢代替共情',
    '   - 连续三集内不得使用同一种推进类型；类型轮换不能取代前置铺垫。',
    '4. 反派也必须有可理解的欲望和策略，不得写成纯工具人；主要对手至少拥有一个合理动机和一个有效行动。',
    '5. 人设要有可识别标签，也要有矛盾面、行为证据和微小成长，避免所有人物只承担工具功能。',
    '6. 顺应精品化趋势：优先真实情感、小切口大共鸣、女性成长、家庭疗愈、现实悬疑、银发群体、地域文化/非遗/文旅等；若原题材不适配，不得生硬植入。',
    '7. 删除广告、片头片尾、平台口播、二维码引导、重复回顾、与剧情无关的带货和水词；不得把这些内容改写进剧情。',
    '8. 统一角色名、称谓、时间线、道具状态与秘密知情范围；任何新增情节必须能追溯到前置动机或伏笔。',
    '9. 每场戏必须可拍：地点、时间、人物、可见动作、对白、场景转折清楚；少写抽象心理，多写动作与反应。',
    '10. 对白口语化、短句化、角色化；删解释性对白和同义重复，让潜台词承担信息。不得照搬原台词长段，仅保留不可替代的关键台词。',
    '',
    '## 反套路硬性约束（与格式规则同级）',
    '- 禁止「众人嘲讽→主角亮身份→众人跪舔」三段式；身份揭露必须带来新信息，围观者反应必须分层（不信、质疑、恐惧、观望、倒戈），不得全群统一转向。',
    '- 禁止「反派放狠话→下一秒被碾压」机械配对；冲突至少经过一轮试探、拉扯或代价，攻防中必须出现由人物选择造成的新变化。',
    '- 禁止把结尾统一写成“某人出现、电话响起、消息传来”。钩子类型必须轮换：行动决策钩子、关系变化钩子、信息碎片钩子、时限压力钩子、空间转移钩子。',
    '- 连续三集内不得重复使用同一钩子类型；同一角色不得连续两集独自承担结尾钩子。',
    '',
    '## 要素锁定（不得凭空新增）',
    '重写只能在原故事已有要素上重组与强化，严禁凭空引入原稿没有的内容：',
    '- 新人物、第三者，以及原稿未交代的亲属/婚恋/敌对关系；',
    '- 新道具、新证据（录音、照片、聊天记录、合同、遗嘱、转账记录、医院单据等）；',
    '- 重大设定（疾病、怀孕、死亡、犯罪、欠债、出轨、家暴、房产、股份、遗产等）；',
    '- 原稿没有的地点转换或时间跳跃。',
    '需要这些要素时，必须能追溯到原稿已有的伏笔或因果；原稿确实缺失的，用原稿已有要素替代，不要靠加料制造冲突。',
    '',
    '## 输出格式（严格照此执行：只输出每集可拍摄的具体剧本正文，不要任何前言、解释、分节说明或自检报告）',
    '',
    '顶部可有一行剧名总标题：',
    '《剧名》第A-B集正式剧本',
    '',
    episodeRange
      ? `随后只输出${rangeLabel}，逐集连续编号；这是全剧共 ${episodeRange.total} 集中的一个生产批次，不得输出批次外集数：`
      : '随后逐集输出，每集结构完全一致，从第001集开始连续编号直到全部写完：',
    '',
    '第001集：本集标题',
    '',
    '本集钩子：本集开场用来抓住观众的关键冲突或悬念（一句话）',
    '本集推进：从六类主推进中选一并写明具体状态变化（选择代价 / 关系扳机 / 信息揭露 / 能力证明 / 利益翻转 / 情感共振）',
    '本集结尾：本集结尾停在哪里、留给下一集的钩子（一句话，并标注钩子类型）',
    '',
    '[集号-场号 场景名 时段 内/外 人物：人物1、人物2、人物3]',
    '',
    '▲ 镜头/画面/动作描写（一个画面点一行，▲ 开头）',
    '',
    '角色名：台词',
    '角色名（OS）：内心独白',
    '',
    '同一场景内继续写后续画面行与对白；只有换地点或跨时段才新建一个 [集号-场号 ...] 场头。',
    '',
    '### 格式硬规则',
    '- 集号补零三位：第001集、第002集……；场号写成「集号-场号」，如 1-1、1-2、2-1。',
    '- 场头方括号内固定为：[集号-场号 场景名 时段 内/外 人物：人物列表]，时段用 日/夜/晨/昏，内外景用 内/外，人物用中文顿号分隔。',
    '- 画面/镜头/动作描写一律以 ▲ 开头，一镜一行，写清可见动作、人物站位与出入方向、运镜落点、环境反馈；禁止写抽象心理词。',
    '- 对白写「角色名：台词」；内心独白写「角色名（OS）：内容」；情绪用可见的表情/动作/声音替代，不写「愤怒」「悲伤」等抽象词。',
    '- 不得夹带广告、片头片尾、平台口播、二维码引导、带货、重复回顾；成品须无广告残留。',
    '- 不输出「改写说明」「连续性总表」「自检报告」「信息点」等任何额外分节；不要前言、道歉、占位符，不要「此处省略」或「……」收尾。',
    '- 【最高优先级·元文本禁令】正文任何位置都不得输出创作过程、任务计划、批次/分段/续写说明或 AI 自我认知。',
    '  * 禁止制作规划句，例如「我需要无缝续写」「让我先完成」「以下是剧本」「接下来我会……」。',
    '  * 禁止范围说明句，例如「本次只生成」「第X批」「剩余场次」「范围外内容」「接上文」。',
    '  * 禁止 AI 身份句，例如「作为AI」「根据要求」「我会按照」「好的，我来」。',
    '  * 「生成、续写、批次」等词若确属剧情世界中的对白、设备或事件可以保留；只禁止它们被用来描述模型、编剧或生产任务。',
    '  * 若即将写出元文本，直接从下一条合法剧本行继续；不得以少写、缺集或跳场规避。',
    '- 角色名、道具、时间线全篇一致；同地点同连续时间段不拆场。',
    '- 集号只允许出现在每集标题和场号中。角色不知道自己身处第几集，正文、对白、OS、动作和道具说明严禁出现‘第X集’‘从第1集到现在’等打破第四面墙的表述；一律改成剧内事件或时间表达。',
    '- 已在前文完成的授衔、抓捕、身份揭露、枪战、婚礼等事件不得换一个集号重演；当前分集大纲没有分配的旧事件只能作为结果状态，不得复刻原场景。',
    '- 前文明确丢失、损毁、被收缴或不在人物手中的物品，不得无取得过程突然使用；跨地点或跨时段必须先写可见转场，交代人物、服装与随身物如何变化。',
    '',
    '## 内容密度',
    '- 每集约 90 秒画面、3~6 个场次；对白与画面描写都要具体到可直接拍摄，不要概述。',
    '- 每集必须把大纲事件完整展开为动作、反应和对白；通常应有 500~1000 个以上中文字符，这只是可拍摄密度校验，不是字数上限，剧情需要时可以任意更长。',
    '- 不设置剧本字数上限，不得因篇幅减少集数、合并必要场次或删减对白；单次响应触及模型上限时，系统会自动续写并拼接。',
    '',
    '## 参考范例（务必对齐此格式与粒度）',
    '',
    '《示例剧》第1-3集正式剧本',
    '',
    '第001集：凡人代理峰主',
    '',
    '本集钩子：三年之期到，撤峰令压在七星峰名册上，长老当众宣布今日无人入峰就撤峰瓜分。',
    '本集推进：利益翻转——秦萧被嘲是凡人废物，却以代理峰主身份坐到最后；他的「没价值」反成唯一没被收买的理由。',
    '本集结尾：宗门选徒开始，所有新弟子避开七星峰，秦萧在灭峰倒计时里看见系统激活。（行动决策钩子）',
    '',
    '[1-1 天元宗广场 日 外 人物：康正业、姚天盛、秦萧、各峰长老、弟子众人]',
    '',
    '▲ 镜头从天元宗山门俯冲而下，万阶石梯、飞檐灵旗层层展开，唯独七星峰席位空得发冷。',
    '▲ 长老案上一枚黑铜「撤峰令」被推到最前，令牌下压着七星峰旧名册，大半名字被朱笔划掉。',
    '',
    '康正业：三年之期已到。',
    '康正业：七星峰若今日再无人入峰。',
    '康正业：撤峰。',
    '',
    '▲ 广场弟子哗然，镜头扫过各峰长老，有人已把七星峰地形图摊在袖中。',
    '',
    '秦萧（OS）：修仙路。',
    '秦萧（OS）：我想了两辈子。',
    '',
    episodeRange
      ? `禁止输出创作过程、道歉或占位符。必须完整写完${rangeLabel}及其中全部必要场次；不得提前停止，不要用「……」或「省略」收尾。`
      : '禁止输出创作过程、道歉或占位符。必须写完大纲规划的全部集数与全部必要场次；不要用「……」或「省略」收尾。',
  ].join('\n');

  const scopeInstruction = episodeRange
    ? `本次只生成${rangeLabel}（全剧共 ${episodeRange.total} 集），必须逐集完整展开且不能缺集；不要生成范围外内容。`
    : '请依据详细大纲重写完整剧本。';
  const user = `${scopeInstruction}${durationMinutes ? `原视频约 ${durationMinutes} 分钟；重写可压缩广告与重复回顾，但不得丢失任何关键因果、必要场次和有效对白。` : ''}${feedbackSection}\n\n--- 全剧详细大纲开始 ---\n${outline}\n--- 全剧详细大纲结束 ---\n\n--- 本批次对应的原剧本及相邻连续性上下文开始 ---\n${sourceScript}\n--- 本批次对应的原剧本及相邻连续性上下文结束 ---`;
  return { system, user };
}
