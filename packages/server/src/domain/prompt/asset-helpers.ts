// ============================================================
// ③ server/domain/prompt — 资产生图提示词纯函数
// ============================================================
//
// 文件职责：
//   从 app1 src/core/ai/asset-prompt.ts 抽取的纯函数与常量：
//   - slugifyCostumeKey / COSTUME_KEY_SLUG_HINTS：造型 key 归一化
//   - isAnonymousCharacterName：路人/群演名过滤
//   - sanitizePromptForModeration / PROMPT_SANITIZATION_MAP：敏感词委婉化
//   - getStyleNegativePrompt / getDeliveryComplianceNegativePrompt：负向提示词
//   - ASSET_RESOLUTIONS / ASSET_IMAGE_STYLES / getResolutionByKey：分辨率与画风选项
//
// 全部为纯函数（无 I/O、无 DB、无 Redis、无 ffmpeg），可直接单测。
// ============================================================

/**
 * 常见造型 label → 英文 slug 参考映射。
 * 注入 prompt 中作为 AI 命名 key 的参考，鼓励跨调用一致。
 */
export const COSTUME_KEY_SLUG_HINTS: Array<{ slug: string; zhLabel: string; enLabel: string }> = [
  { slug: 'casual', zhLabel: '便装', enLabel: 'casual' },
  { slug: 'formal', zhLabel: '正装', enLabel: 'formal' },
  { slug: 'business', zhLabel: '商务', enLabel: 'business' },
  { slug: 'battle-damaged', zhLabel: '战损', enLabel: 'battle-damaged' },
  { slug: 'night-op', zhLabel: '夜行', enLabel: 'night-op' },
  { slug: 'gown', zhLabel: '礼服', enLabel: 'gown' },
  { slug: 'travel', zhLabel: '旅行装', enLabel: 'travel' },
  { slug: 'sleepwear', zhLabel: '睡衣', enLabel: 'sleepwear' },
  { slug: 'uniform', zhLabel: '制服', enLabel: 'uniform' },
  { slug: 'armor', zhLabel: '盔甲', enLabel: 'armor' },
  { slug: 'swimsuit', zhLabel: '泳装', enLabel: 'swimsuit' },
  { slug: 'coat', zhLabel: '外套', enLabel: 'coat' },
  { slug: 'disguised', zhLabel: '伪装', enLabel: 'disguised' },
];

/**
 * 将任意 label/key 归一化为英文 slug key。
 *
 * 规则：
 *   1. 空 / "default" / "默认" → "default"
 *   2. 命中 COSTUME_KEY_SLUG_HINTS（中英 label 或 slug 精确匹配）→ 对应 slug
 *   3. 纯 ASCII 字符串 → 小写 + 空格/下划线转连字符
 *   4. 含非 ASCII（如中文）且不在映射表 → 退化为 "custom-{idx}"
 */
export function slugifyCostumeKey(label: string, fallbackIdx = 0): string {
  const trimmed = (label || '').trim();
  if (!trimmed || /^(default|默认)$/i.test(trimmed)) return 'default';
  const hit = COSTUME_KEY_SLUG_HINTS.find(
    (h) =>
      h.zhLabel === trimmed ||
      h.enLabel.toLowerCase() === trimmed.toLowerCase() ||
      h.slug === trimmed.toLowerCase(),
  );
  if (hit) return hit.slug;
  if (/^[\x00-\x7F]+$/.test(trimmed)) {
    const slug = trimmed
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return slug || `custom-${fallbackIdx}`;
  }
  return `custom-${fallbackIdx}`;
}

/**
 * 判定角色名是否为泛指路人/群演（非具体人名），应过滤不保留。
 *
 * 匹配：中文群体泛指（众人/群众/路人等）、中文"身份+天干"（路人甲）、英文泛指（Extra A / the crowd）。
 *
 * @returns true 表示是泛指路人/群演，应过滤；false 表示是具体角色名
 */
export function isAnonymousCharacterName(name: string): boolean {
  if (!name) return true;
  const n = name.trim();
  if (!n) return true;
  if (/^(众人|群众|群演|路人|大家|所有人|其他人?|村民们?|镇民们?|市民们?|教徒们?|弟子们?|门徒们?|族人|宾客们?|仆人们?|侍卫们?|士兵们?|丫鬟们?|太监们?|宫女们?)$/.test(n))
    return true;
  if (/^(路人|长老|弟子|门客|守卫|村民|士兵|侍女|丫鬟|家丁|门徒|族人|宾客|仆人|侍卫|将军|大人|夫人|小姐|少爷|掌柜|伙计|教徒|信众|法师|师兄|师姐|师弟|师妹|太监|宫女|嫔妃|大臣|官员|差役|捕快|衙役|车夫|农夫|猎户|铁匠|木匠|郎中)(甲|乙|丙|丁|戊|己|庚|辛|壬|癸)$/.test(n))
    return true;
  if (/^(extra|passerby|soldier|guard|villager|servant|maid|crowd|person|man|woman|boy|girl)\s*[a-e]$/i.test(n))
    return true;
  if (/^(the crowd|the people|everyone|the villagers|the soldiers|the guards|passersby|extras|the mob)$/i.test(n))
    return true;
  return false;
}

/** 敏感词委婉化映射表（规避 ARK InputTextSensitiveContentDetected） */
export const PROMPT_SANITIZATION_MAP: Array<[string, string]> = [
  ['旧血痕', '旧伤痕'],
  ['渗血', '擦伤'],
  ['血迹', '污渍'],
  ['血痕', '旧伤痕'],
  ['血渍', '污渍'],
  ['鲜血', '红渍'],
  ['血污', '污渍'],
  ['流血', '受伤'],
  ['滴血', '滴墨'],
  ['沾血', '沾污'],
  ['血水', '污水'],
  ['灵堂', '旧堂'],
  ['纸灰', '香灰'],
  ['灵位', '旧位牌'],
  ['丧服', '素服'],
  ['灵柩', '旧匣'],
  ['尸体', '倒地身躯'],
  ['死尸', '倒地身躯'],
  // 政治敏感违禁词：「帝国」触发火山文本审核整段拒审，统一替换为「王国」（含资产名如「帝国骑士身份令牌」）
  ['帝国', '王国'],
];

/**
 * 对生图 prompt 做敏感词委婉化，规避 ARK 内容审核拦截。
 *
 * @returns sanitized 替换后的 prompt；replacements 替换记录（原词 → 新词）
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
 * 海外（OVERSEAS）文化道具本地化映射表。
 *
 * 源片是中国短剧，Kimi 转剧本会把筷子/包子/汉服等中国特有文化道具写进分镜；海外转绘若照
 * 原文生成 → "外国人用筷子吃包子"穿帮。这里把常见中国特有道具机械替换为目标文化等价物，
 * 仅在 chain-generate 对海外项目应用（镜像 sanitizePromptForModeration）。
 *
 * 属 best-effort 兜底（覆盖已落库的旧分镜）；新分镜由 storyboard prompt 的"海外文化本地化"
 * 硬约束在源头避免。替换用 split/join 全量替换，故 key 取不易歧义、较长的词优先。
 */
export const OVERSEAS_CULTURAL_PROP_MAP: Array<[string, string]> = [
  // 餐具 / 食物
  ['筷子', '刀叉'],
  ['茶叶蛋', '水煮蛋'],
  ['包子', '面包卷'],
  ['馒头', '面包'],
  ['饺子', '馅饼'],
  ['油条', '吐司'],
  ['米线', '意面'],
  ['茶馆', '咖啡馆'],
  ['面馆', '小餐馆'],
  // 节庆 / 装饰
  ['春联', '节日装饰'],
  ['对联', '节日装饰'],
  ['红灯笼', '节日串灯'],
  ['红包', '礼物卡'],
  ['鞭炮', '烟花'],
  // 服饰
  ['汉服', '正装'],
  ['旗袍', '连衣裙'],
  ['马褂', '马甲外套'],
  ['长袍', '长款外套'],
  ['唐装', '立领外套'],
  // 建筑 / 器物
  ['匾额', '招牌'],
  ['牌坊', '拱门'],
  ['算盘', '计算器'],
  ['毛笔', '钢笔'],
  ['宣纸', '纸张'],
];

/**
 * 对海外项目的镜头组提示词做文化道具本地化（中国特有 → 目标文化等价物）。
 *
 * @returns sanitized 替换后的 prompt；replacements 替换记录（原词 → 新词）
 */
export function sanitizeOverseasCulturalProps(prompt: string): {
  sanitized: string;
  replacements: string[];
} {
  const replacements: string[] = [];
  let sanitized = prompt;
  for (const [from, to] of OVERSEAS_CULTURAL_PROP_MAP) {
    if (sanitized.includes(from)) {
      sanitized = sanitized.split(from).join(to);
      replacements.push(`${from} → ${to}`);
    }
  }
  return { sanitized, replacements };
}

/** 分辨率选项 */
export const ASSET_RESOLUTIONS = [
  { key: '1K', label: '1K (1280×720)', width: 1280, height: 720 },
  { key: '2K', label: '2K (1920×1080)', width: 1920, height: 1080 },
  { key: '4K', label: '4K (3840×2160)', width: 3840, height: 2160 },
  { key: '21:9', label: '21:9 宽屏 (2560×1080)', width: 2560, height: 1080 },
] as const;

/** 画风风格选项 */
export const ASSET_IMAGE_STYLES = [
  '写实真人风格',
  '古风手绘',
  '二次元立绘',
  '3D 建模渲染',
  '铅笔彩绘风格',
] as const;

/** 按 key 查分辨率，未命中回退首个（1K） */
export function getResolutionByKey(key: string): { key: string; label: string; width: number; height: number } {
  return ASSET_RESOLUTIONS.find((r) => r.key === key) ?? ASSET_RESOLUTIONS[0];
}

/**
 * 风格专属的负向提示词补充（仅铅笔彩绘风格有特殊负向词）。
 * Worker 在构建 negativePrompt 时调用，将返回值追加到默认 negative 后。
 */
export function getStyleNegativePrompt(style?: string): string {
  // 用户需求：除水印/logo 外不保留任何负面提示词。铅笔彩绘风格的风格反义词已移除。
  void style;
  return '';
}

/**
 * 转绘交付审核合规负向提示词（通用违禁元素）。
 *
 * 对齐《转绘交付审核标准》：平台 Logo/水印/账号 ID/引流文字/二维码/中文/AI 角标/国旗国徽。
 */
export function getDeliveryComplianceNegativePrompt(): string {
  // 用户需求：负面提示词只保留水印/logo 防护，其余全部移除。
  // ARK 文本审核对 negativePrompt 同样送审，冗余词（眼镜/裁脸/瞳色/账号引流等）易触发
  // InputTextSensitiveContentDetected。与 app1 相反——app1 含完整交付合规词表。
  return 'watermark, logo';
}
