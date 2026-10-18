// ============================================================
// provider 元数据注册表（前端 only）
// ============================================================
//
// 文件职责：
//   统一 AI provider 的展示元数据（中文名 + 品牌色 + 能力类型），
//   供 admin Key 池分组标题、服务商下拉、ModelSelector optgroup 等处共用，
//   避免各组件各自硬编码零散 provider 名导致漂移。
//
// 与后端对齐：key 集合 = packages/server/src/gateway/index.ts 的 PROVIDERS（9 家）。
//   ark / ark_intl / openai / google / deepseek / kimi / minimax / grok / comfyui
// gateway 运行时是 provider 的权威白名单；此处只是 UI 展示层映射。
//
// 品牌色取自 app1（F:\app1 settings SECTIONS / provider-recharge.ts）。
// ============================================================

/** provider 能力类型（决定字母块旁的能力徽章：文本/图像/视频/语音） */
export type ProviderCapability = "text" | "image" | "video" | "tts";

export interface ProviderMeta {
  /** provider 标识（与 gateway PROVIDERS / api_configs.provider 对齐） */
  key: string;
  /** 中文展示名 */
  name: string;
  /** 品牌主色（hex，用于字母块背景着色：`${color}20` ≈ 12% alpha） */
  color: string;
  /** 该 provider 服务的能力类型 */
  capabilities: ProviderCapability[];
}

/** capability 短键 → 展示文案（字母块能力徽章用） */
export const PROVIDER_CAPABILITY_LABELS: Record<ProviderCapability, string> = {
  text: "文本",
  image: "图像",
  video: "视频",
  tts: "语音",
};

/**
 * 全量 provider 元数据（9 家，与 gateway PROVIDERS 对齐）。
 * 顺序即下拉/分组的默认展示顺序。
 */
export const PROVIDER_REGISTRY: ProviderMeta[] = [
  { key: "ark", name: "火山引擎", color: "#ff6b35", capabilities: ["image", "video", "tts"] },
  { key: "ark_intl", name: "火山引擎（国际版）", color: "#ff8c42", capabilities: ["image", "video", "tts"] },
  { key: "deepseek", name: "DeepSeek", color: "#4D6BFE", capabilities: ["text"] },
  { key: "kimi", name: "Kimi", color: "#7C3AED", capabilities: ["text", "video"] },
  { key: "openai", name: "OpenAI", color: "#10a37f", capabilities: ["text", "image", "tts"] },
  { key: "google", name: "Google AI", color: "#4285f4", capabilities: ["text", "image"] },
  { key: "minimax", name: "MiniMax", color: "#FF3D00", capabilities: ["text", "video", "tts"] },
  { key: "grok", name: "Grok", color: "#6B7280", capabilities: ["text", "image"] },
  { key: "comfyui", name: "ComfyUI", color: "#D97757", capabilities: ["image"] },
];

const PROVIDER_MAP: Record<string, ProviderMeta> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => [p.key, p]),
);

/** provider key 全集（供下拉 <option> 枚举；与 gateway 9 家一致） */
export const PROVIDER_KEYS: string[] = PROVIDER_REGISTRY.map((p) => p.key);

/**
 * 取 provider 元数据；未知 key 回退中性兜底（name=key、灰色、无能力）。
 * 永不抛错，UI 渲染层可直接用。
 *
 * 兜底色用 hex #64748b（≈ --text-3 深色值）而非 CSS var，
 * 因为字母块着色靠 `${color}20` 拼 alpha，CSS var 无法拼后缀。
 */
export function getProviderMeta(key: string): ProviderMeta {
  return (
    PROVIDER_MAP[key] ?? {
      key,
      name: key,
      color: "#64748b",
      capabilities: [],
    }
  );
}

/** 取 provider 中文展示名；未知 key 回退原字符串（兼容 ModelSelector 旧 PROVIDER_LABELS 用法）。 */
export function getProviderName(key: string): string {
  return getProviderMeta(key).name;
}
