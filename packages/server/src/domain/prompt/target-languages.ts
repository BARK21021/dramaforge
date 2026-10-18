// ============================================================
// 目标语言清单（海外转绘「文本转风格」语言菜单用）
// 从 app1 src/core/ai/target-languages.ts 整文件移植，P7.2-T1。
// 34 种常用国际语言，按区域分组。每条带文化指引 cultureHint，
// 供 buildTextStylePrompt 注入「贴合该文化」的约束。
// 仅海外转绘路径使用；ORIGINAL 仍走自由文本（不消费本清单）。
// 零外部 import，纯函数 + 常量。
// ============================================================

export interface TargetLanguage {
  code: string;        // ISO 639-1 短码
  native: string;      // 原生名
  zh: string;          // 中文名
  en: string;          // 英文名
  region: string;      // 仅用于语言菜单分组；不是项目故事发生地/角色族裔依据
  cultureHint: string; // 文化指引（避免包含其它语言的完整中文名，防止误匹配）
}

/**
 * 文本转风格后需要贯穿编剧分析、资产提取和资产生图的本地化档案。
 * stylePrompt 保留用户的完整目标要求；targetLanguage 是菜单可结构化解析时的稳定快照。
 */
export interface LocalizationProfile {
  stylePrompt: string;
  targetLanguage?: TargetLanguage;
}

/** 从请求体或 scriptData 中安全恢复持久化的本地化档案。 */
export function readLocalizationProfile(value: unknown): LocalizationProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const raw = record.localizationProfile && typeof record.localizationProfile === 'object'
    ? record.localizationProfile
    : record;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const profile = raw as Record<string, unknown>;
  if (typeof profile.stylePrompt !== 'string' || !profile.stylePrompt.trim()) return undefined;

  const fallback = buildLocalizationProfile(profile.stylePrompt);
  const target = profile.targetLanguage;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return fallback;
  const language = target as Record<string, unknown>;
  const fields: Array<keyof TargetLanguage> = ['code', 'native', 'zh', 'en', 'region', 'cultureHint'];
  if (!fields.every((field) => typeof language[field] === 'string')) return fallback;
  return {
    stylePrompt: profile.stylePrompt.trim(),
    targetLanguage: Object.fromEntries(fields.map((field) => [field, language[field]])) as unknown as TargetLanguage,
  };
}

export interface LocalizedDurationBudget {
  languageCode: string;
  /** 相对中文源片的本地化时长系数；是规划启发值，不替代最终 TTS 实测。 */
  languageFactor: number;
  minSeconds: number;
  targetSeconds: number;
  maxSeconds: number;
}

/**
 * 配音规划启发系数。跨语言信息率整体接近，因此只做温和修正；德语、阿拉伯语、
 * 法语等更易发生台词膨胀，日语/越南语略收紧。最终成片仍应以实际 TTS 时长校准。
 */
const LOCALIZED_DURATION_FACTORS: Record<string, number> = {
  en: 1.05,
  de: 1.10,
  ar: 1.10,
  fr: 1.07,
  es: 1.05,
  pt: 1.05,
  it: 1.04,
  ru: 1.07,
  hi: 1.06,
  th: 1.02,
  ko: 1.00,
  id: 1.00,
  ja: 0.98,
  vi: 0.98,
  zh: 1.00,
};

/**
 * 以用户要求的中文基准 90–150 秒为锚点，再按目标语种与源片有效时长计算。
 * 没有源时长时取语种区间中位数；有源时长时尽量保留节奏，但不越过语言区间。
 */
export function buildLocalizedDurationBudget(
  profile: LocalizationProfile | undefined,
  sourceDurationSeconds?: number | null,
  fallbackLanguageCode = 'en',
): LocalizedDurationBudget {
  const languageCode = profile?.targetLanguage?.code?.toLowerCase() || fallbackLanguageCode.toLowerCase();
  const baseCode = languageCode.split('-')[0];
  const languageFactor = LOCALIZED_DURATION_FACTORS[baseCode] ?? 1.05;
  const minSeconds = Math.round(90 * languageFactor);
  const maxSeconds = Math.round(150 * languageFactor);
  const source = typeof sourceDurationSeconds === 'number' && Number.isFinite(sourceDurationSeconds)
    ? Math.max(1, sourceDurationSeconds)
    : null;
  const desired = source === null
    ? (minSeconds + maxSeconds) / 2
    : source * languageFactor;
  return {
    languageCode,
    languageFactor,
    minSeconds,
    targetSeconds: Math.round(Math.min(maxSeconds, Math.max(minSeconds, desired))),
    maxSeconds,
  };
}

/**
 * 用户明确指定目标时长（参考视频时长或弹窗选择）时构造预算。
 * 不套语言系数、不夹 90–150 锚点：目标即权威，仅给 ±5% 弹性让 LLM 自然落点。
 * languageCode 仍取自本地化档案，供 prompt 标注目标语种。
 */
export function buildExplicitDurationBudget(
  targetSeconds: number,
  profile?: LocalizationProfile | undefined,
  fallbackLanguageCode = 'en',
): LocalizedDurationBudget {
  const target = Number.isFinite(targetSeconds) && targetSeconds > 0 ? targetSeconds : 90;
  const languageCode =
    profile?.targetLanguage?.code?.toLowerCase() || fallbackLanguageCode.toLowerCase();
  const minSeconds = Math.max(1, Math.round(target * 0.95));
  const maxSeconds = Math.round(target * 1.05);
  return {
    languageCode,
    languageFactor: 1,
    minSeconds,
    targetSeconds: Math.round(target),
    maxSeconds: Math.max(minSeconds, maxSeconds),
  };
}

/**
 * 分镜时长优先级解析：参考视频时长（完全跟随，忽略 body）> 用户弹窗选择 > 无（兜底 90–150）。
 * 返回 undefined 表示走老 buildLocalizedDurationBudget 兜底。
 */
export function resolveExplicitStoryboardTarget(
  sourceDurationSeconds?: number | null,
  bodyTotalDuration?: number | null,
): number | undefined {
  if (
    typeof sourceDurationSeconds === 'number' &&
    Number.isFinite(sourceDurationSeconds) &&
    sourceDurationSeconds > 0
  ) {
    return sourceDurationSeconds;
  }
  if (
    typeof bodyTotalDuration === 'number' &&
    Number.isFinite(bodyTotalDuration) &&
    bodyTotalDuration > 0
  ) {
    return bodyTotalDuration;
  }
  return undefined;
}

export const TARGET_LANGUAGES: TargetLanguage[] = [
  // 东亚 / 东南亚
  { code: "ja", native: "日本語", zh: "日语", en: "Japanese", region: "东亚", cultureHint: "日本文化：和风建筑/神社/和服/敬语体系/姓名姓前名后" },
  { code: "ko", native: "한국어", zh: "韩语", en: "Korean", region: "东亚", cultureHint: "韩国文化：韩屋/韩服/长幼尊卑敬语/姓名姓前名后" },
  { code: "th", native: "ภาษาไทย", zh: "泰语", en: "Thai", region: "东南亚", cultureHint: "泰国文化：南传佛寺/泰式建筑/合十礼/君主尊崇" },
  { code: "vi", native: "Tiếng Việt", zh: "越南语", en: "Vietnamese", region: "东南亚", cultureHint: "越南文化：奥黛/法式殖民建筑/咖啡文化/姓氏在前" },
  { code: "id", native: "Bahasa Indonesia", zh: "印尼语", en: "Indonesian", region: "东南亚", cultureHint: "印尼文化：伊斯兰为主多元宗教/纱笼/群岛习俗" },
  { code: "ms", native: "Bahasa Melayu", zh: "马来语", en: "Malay", region: "东南亚", cultureHint: "马来西亚与文莱文化：伊斯兰习俗/马来传统服饰/君主制" },
  { code: "tl", native: "Filipino", zh: "菲律宾语", en: "Filipino", region: "东南亚", cultureHint: "菲律宾文化：天主教为主/美式影响/他加禄习俗" },
  { code: "my", native: "မြန်မာ", zh: "缅甸语", en: "Burmese", region: "东南亚", cultureHint: "缅甸文化：南传佛教/缅式寺院/特纳卡" },
  // 南亚
  { code: "hi", native: "हिन्दी", zh: "印地语", en: "Hindi", region: "南亚", cultureHint: "印度文化：印度教传统/纱丽/家族与种姓/姓名姓在后" },
  { code: "bn", native: "বাংলা", zh: "孟加拉语", en: "Bengali", region: "南亚", cultureHint: "孟加拉文化：孟加拉新年/纱丽与库尔塔/河流与渔产" },
  { code: "ta", native: "தமிழ்", zh: "泰米尔语", en: "Tamil", region: "南亚", cultureHint: "泰米尔文化：达罗毗荼传统/寺庙建筑/南印与斯里兰卡习俗" },
  { code: "ur", native: "اردو", zh: "乌尔都语", en: "Urdu", region: "南亚", cultureHint: "巴基斯坦与北印穆斯林文化：伊斯兰习俗/波斯莫卧儿影响/右起书写" },
  // 中东
  { code: "ar", native: "العربية", zh: "阿拉伯语", en: "Arabic", region: "中东", cultureHint: "阿拉伯文化：伊斯兰习俗/右起书写/海湾或马格里布差异/父名姓氏体系" },
  { code: "tr", native: "Türkçe", zh: "土耳其语", en: "Turkish", region: "中东", cultureHint: "土耳其文化：突厥传统/清真寺/茶馆/姓名姓在后" },
  { code: "fa", native: "فارسی", zh: "波斯语", en: "Persian", region: "中东", cultureHint: "伊朗波斯文化：波斯传统/诺鲁孜新年/右起书写" },
  { code: "he", native: "עברית", zh: "希伯来语", en: "Hebrew", region: "中东", cultureHint: "以色列犹太文化：犹太教传统/右起书写/安息日与节期" },
  // 欧洲（日耳曼）
  { code: "en", native: "English", zh: "英语", en: "English", region: "欧洲", cultureHint: "英语文化圈：英美加澳新等，按描述定位具体国家" },
  { code: "de", native: "Deutsch", zh: "德语", en: "German", region: "欧洲", cultureHint: "德语区文化：德奥瑞；啤酒/哥特与巴洛克建筑/正式敬称" },
  { code: "nl", native: "Nederlands", zh: "荷兰语", en: "Dutch", region: "欧洲", cultureHint: "荷兰与佛兰芒文化：运河/风车/直率社交" },
  { code: "sv", native: "Svenska", zh: "瑞典语", en: "Swedish", region: "欧洲", cultureHint: "瑞典文化：北欧简约/仲夏节/平等主义" },
  { code: "no", native: "Norsk", zh: "挪威语", en: "Norwegian", region: "欧洲", cultureHint: "挪威文化：峡湾/木构建筑/滑雪传统" },
  { code: "da", native: "Dansk", zh: "丹麦语", en: "Danish", region: "欧洲", cultureHint: "丹麦文化：Hygge 生活方式/设计简约/君主立宪" },
  { code: "fi", native: "Suomi", zh: "芬兰语", en: "Finnish", region: "欧洲", cultureHint: "芬兰文化：桑拿/极地自然/北欧福利体系" },
  // 欧洲（罗曼）
  { code: "es", native: "Español", zh: "西班牙语", en: "Spanish", region: "欧洲", cultureHint: "西语文化：西班牙或拉美；弗拉门戈/天主教会/父名加母名" },
  { code: "pt", native: "Português", zh: "葡萄牙语", en: "Portuguese", region: "欧洲", cultureHint: "葡语文化：葡萄牙或巴西；大航海传统/天主教" },
  { code: "fr", native: "Français", zh: "法语", en: "French", region: "欧洲", cultureHint: "法语文化：法国等；美食/时尚/共和世俗主义" },
  { code: "it", native: "Italiano", zh: "意大利语", en: "Italian", region: "欧洲", cultureHint: "意大利文化：罗马与文艺复兴遗产/家族/天主教会" },
  { code: "ro", native: "Română", zh: "罗马尼亚语", en: "Romanian", region: "欧洲", cultureHint: "罗马尼亚文化：东正教/拉丁语系/喀尔巴阡传统" },
  // 欧洲（斯拉夫）
  { code: "ru", native: "Русский", zh: "俄语", en: "Russian", region: "欧洲", cultureHint: "俄罗斯文化：东正教/洋葱顶教堂/姓名 名加父名加姓" },
  { code: "pl", native: "Polski", zh: "波兰语", en: "Polish", region: "欧洲", cultureHint: "波兰文化：天主教/肖邦传统/姓名男女后缀有别" },
  { code: "uk", native: "Українська", zh: "乌克兰语", en: "Ukrainian", region: "欧洲", cultureHint: "乌克兰文化：东正教/刺绣传统/民族复兴" },
  { code: "cs", native: "Čeština", zh: "捷克语", en: "Czech", region: "欧洲", cultureHint: "捷克文化：波西米亚传统/啤酒文化/中欧习俗" },
  // 其他
  { code: "el", native: "Ελληνικά", zh: "希腊语", en: "Greek", region: "欧洲", cultureHint: "希腊文化：东正教/古希腊遗产/地中海饮食/父名" },
  { code: "hu", native: "Magyar", zh: "匈牙利语", en: "Hungarian", region: "欧洲", cultureHint: "匈牙利马扎尔文化：姓名姓在前/多瑙河传统" },
];

/**
 * 按查询串查找目标语言（code/zh/native/en 任一命中）。
 * 匹配优先级：code 精确 > zh 精确 > zh 包含 > native 包含 > en 包含（不区分大小写）。
 */
export function findTargetLanguage(query: string): TargetLanguage | undefined {
  const q = (query || "").trim();
  if (!q) return undefined;
  const ql = q.toLowerCase();
  const byCode = TARGET_LANGUAGES.find((l) => l.code.toLowerCase() === ql);
  if (byCode) return byCode;
  const byZhExact = TARGET_LANGUAGES.find((l) => l.zh === q);
  if (byZhExact) return byZhExact;
  const byZhIncludes = TARGET_LANGUAGES.find((l) => q.includes(l.zh) || l.zh.includes(q));
  if (byZhIncludes) return byZhIncludes;
  const byNative = TARGET_LANGUAGES.find((l) => l.native.includes(q) || q.includes(l.native));
  if (byNative) return byNative;
  const byEn = TARGET_LANGUAGES.find((l) => l.en.toLowerCase().includes(ql) || ql.includes(l.en.toLowerCase()));
  return byEn;
}

/**
 * 从「文本转风格」的 stylePrompt 解析目标语言。
 * LanguageMenu 把 stylePrompt 设为 "${zh} / ${cultureHint} / ${region}"，
 * 故取首个 token（分隔符 / 空白）查 zh/native/en/code。
 * 自由文本（ORIGINAL 仍用 Textarea）无匹配 → undefined → 走 legacy 模板。
 */
export function parseTargetLanguage(stylePrompt: string): TargetLanguage | undefined {
  const firstToken = (stylePrompt || "").split(/[\/\s]/)[0]?.trim();
  return firstToken ? findTargetLanguage(firstToken) : undefined;
}

/** 为文本转风格结果构造可持久化的本地化档案。 */
export function buildLocalizationProfile(stylePrompt: string): LocalizationProfile {
  const rawPrompt = (stylePrompt || "").trim();
  const targetLanguage = parseTargetLanguage(rawPrompt);
  // 结构化语言菜单旧版会把 region（仅 UI 分组）拼进提示词，导致“英语→欧洲、
  // 西语→西班牙”等错误地域先验。结构化档案只保留语言与文化指引。
  const normalizedPrompt = targetLanguage
    ? `${targetLanguage.zh} / ${targetLanguage.cultureHint}`
    : rawPrompt;
  return {
    stylePrompt: normalizedPrompt,
    ...(targetLanguage ? { targetLanguage: { ...targetLanguage } } : {}),
  };
}

/** 判断项目已锁定的目标语种是否被改成另一语种。 */
export function hasLocalizationTargetConflict(
  existing: LocalizationProfile | null | undefined,
  requested: LocalizationProfile | null | undefined
): boolean {
  const existingCode = existing?.targetLanguage?.code?.trim().toLowerCase();
  const requestedCode = requested?.targetLanguage?.code?.trim().toLowerCase();
  return !!existingCode && !!requestedCode && existingCode !== requestedCode;
}
