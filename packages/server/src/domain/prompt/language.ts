// ============================================================
// 语言检测与双语标签模块（从 app1 src/core/ai/language.ts 整文件移植，P7.2-T1）
// 用于剧本分析/资产提取/资产生图等链路判定输出语言：
// 英文输入 → 英文剧本 + 英文结构标签 + 西方概念引导
// 中文输入 → 保持现有中文行为
// 零外部 import，纯函数 + 常量。
// ============================================================

export type ScriptLanguage = "zh" | "en";

/**
 * 双语结构标签常量
 * 集中维护，避免在 prompt builder 与 parser 中散落中文字符串。
 * parser 端用 `(?:中文|English)` 正则交替识别两种输出，无需 language 参数。
 */
export const SCRIPT_LABELS: Record<
  ScriptLanguage,
  {
    sceneList: string;
    infoPoints: string;
    costumeTable: string;
    artStyle: string;
    timeScene: string;
    characters: string;
    newCostume: string;
    role: string;
    intExt: string;
  }
> = {
  zh: {
    sceneList: "场景列表",
    infoPoints: "信息点",
    costumeTable: "造型表",
    artStyle: "场景画风",
    timeScene: "时间/场景",
    characters: "出场人物",
    newCostume: "新造型",
    role: "角色",
    intExt: "内外景",
  },
  en: {
    sceneList: "Scene List",
    infoPoints: "Info Points",
    costumeTable: "Costume Table",
    artStyle: "Art Style",
    timeScene: "Time/Scene",
    characters: "Characters",
    newCostume: "New Costume",
    role: "Characters",
    intExt: "Int/Ext",
  },
};

/**
 * 检测文本主导语言。
 *
 * 算法：统计 CJK 统一表意字符（含扩展 A）与拉丁字母数量，
 * 仅以字母类字符为分母（排除数字/标点/空白），避免纯数字文本干扰。
 *
 * 阈值：
 * - CJK 占比 ≥ 15% → 'zh'（英文剧本即使夹中文注释，CJK 通常 <5%；
 *   中文剧本即便含英文术语，CJK 通常 >30%。15% 是安全分界）
 * - 否则若拉丁占比 > CJK 占比 → 'en'
 * - 都不满足（如纯数字/标点/空文本/极短文本）→ 'zh'（保守，保持现状）
 */
export function detectLanguage(text: string): ScriptLanguage {
  if (!text) return "zh";
  // CJK 统一表意文字 + 兼容表意 + 扩展 A
  const cjkChars = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  const total = cjkChars + latinChars;
  if (total === 0) return "zh";
  const cjkRatio = cjkChars / total;
  const latinRatio = latinChars / total;
  if (cjkRatio >= 0.15) return "zh";
  if (latinRatio > cjkRatio) return "en";
  return "zh";
}

/**
 * 从资产名 + 描述检测语言（供 generate-image 路由用，该路由无 novelText）。
 *
 * 资产 description 在英文剧本下应是英文（由 buildAssetExtractionPrompt 英文模式保证），
 * 所以检测可靠。description 为空时仅用 name；两者都缺字符时回退 'zh'。
 * costumeVariant 场景由调用方传入 costumeVariant.description || asset.description。
 */
export function detectLanguageFromAssets(
  name: string,
  description?: string
): ScriptLanguage {
  const combined = `${name || ""} ${description || ""}`;
  return detectLanguage(combined);
}

/**
 * 按项目分类决定剧本/资产链路使用的语言（三类项目架构）。
 *
 * - OVERSEAS（海外转绘）：中文（文本转风格输出中文叙述+目标语言对白，下游按中文结构处理）
 * - DOMESTIC（国内直出）/ ORIGINAL（剧本原创）：自适应，由 detectLanguage(text) 按原文语种判定
 *   （国内项目若原视频/剧本非中文——如英文/方言——资产链路按原文语种走，不再强制中文）
 *
 * 调用点需先确保已查到 project.category。text 用于 DOMESTIC/ORIGINAL 模式下的语言检测；
 * OVERSEAS 不参与判定（可传空串）。
 */
export function languageFromCategory(
  category: string | null | undefined,
  text: string
): ScriptLanguage {
  if (category === "OVERSEAS") return "zh";
  return detectLanguage(text || "");
}

/**
 * 决定资产生图提示词使用的指令语言。
 *
 * 这里不能直接复用 languageFromCategory：海外转绘剧本采用“中文制作叙述 +
 * 目标语言对白/姓名”的混合格式，结构化剧本仍应走 zh，但资产生图必须走英文
 * 指令分支，并把括号中的目标语言姓名交给图像模型。否则模型容易把中文制作
 * 叙述误当成角色国别/族裔线索。
 */
export function assetImageLanguageFromCategory(
  category: string | null | undefined,
  text: string
): ScriptLanguage {
  if (category === "OVERSEAS") return "en";
  return detectLanguage(text || "");
}

/**
 * 生图/视频提示词用名称规整：去掉「中文名(目标语言名)」尾部的目标语言括注，
 * 保证送入图像/视频模型的提示词只含一种语言（中文）。
 * 仅剥「尾部」整段括注（半角 () 或全角 （））；名内括号不动。
 * 例：山田(Yamada)→山田、卡洛斯(Carlos)→卡洛斯、东京站(Tokyo Station)→东京站。
 * 剧本正文/对白仍保留双语全形，仅送模型时规整。
 */
export function normalizeNameForPrompt(
  name: string,
  preferred: "source" | "localized" = "source"
): string {
  const trimmed = (name || "").trim();
  const match = trimmed.match(/^(.*?)\s*[（(]([^()（）]+)[)）]\s*$/);
  if (!match) return trimmed;
  if (preferred === "localized") return match[2].trim() || match[1].trim();
  return match[1].trim();
}

/**
 * 返回双语标识符的兼容别名：完整名、括号前标识、括号内本地化名。
 * 用于历史分镜仍引用旧单边名、资产已升级为完整双语名时继续命中同一资产。
 */
export function getBilingualNameAliases(name: string): string[] {
  const trimmed = (name || "").trim();
  if (!trimmed) return [];
  const aliases = new Set<string>([trimmed]);
  const match = trimmed.match(/^(.*?)\s*[（(]([^()（）]+)[)）]\s*$/);
  if (match?.[1]?.trim()) aliases.add(match[1].trim());
  if (match?.[2]?.trim()) aliases.add(match[2].trim());
  return Array.from(aliases);
}
