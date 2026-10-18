// ============================================================
// 预设音色清单（音色库 manifest）— 批6 音色库
// ============================================================
//
// 文件职责：
//   提供预设音色库（200 条 {file, gender, dur, desc, text, lang}）的访问入口。
//   manifest 是纯文本（非音频字节），server 端持有副本供 AI 资产提取建议音色；
//   音色 wav 字节由客户端 preload IPC（sfShell.listPresetVoices /
//   sfShell.readPresetVoice）从客户端本地读取，server 零音频字节
//   （dramaforge-assets-client-local 不违反：那只禁媒体字节，不禁文本 manifest）。
//
// 数据来源：F:\app1\reference audio\manifest.json （200 条，app1 活的开发副本）。
// 副本：packages/server/data/voices-manifest.json （runtime import via resolveJsonModule）。
//
// 设计：
//   - JSON 通过 `import ... from '../../../data/voices-manifest.json'` 静态 import，
//     打包器（Next.js / vitest）将 JSON 内联进 bundle，无需运行时 fs.readFileSync
//     （dramaforge server 包无 HTTP 框架，被 web/Next.js 进程消费；process.cwd() 不可靠）。
//   - 模块级单例 CACHE，避免每次 buildAssetExtractionPrompt 调用都重读。
//   - PresetVoice 类型公开导出（web/client 共用契约）。
// ============================================================

import manifestData from "../../../data/voices-manifest.json";

/**
 * 预设音色条目（与 client preload IPC sfShell.listPresetVoices 返回项对齐）。
 *
 * 字段对齐 app1 reference audio/manifest.json 原始结构：
 *   - file: wav 文件名（如 "female_001_xxx.wav"），作为音色唯一 key
 *   - gender: "female" | "male"
 *   - dur: 时长（秒），UI 展示 "{dur}s"
 *   - desc: 中文描述（如 "温柔甜美的少女声音"），AI 用作推荐依据 + UI 主显示
 *   - text: 该 wav 朗读的样本文本（中/英文），仅作引用参考
 *   - lang: "Chinese" | "English"，文本语种
 */
export interface PresetVoice {
  file: string;
  gender: string;
  dur: number;
  desc: string;
  text: string;
  lang: string;
}

/**
 * 校验 manifest.json 结构是 PresetVoice[]；运行时防御脏数据（JSON 不可信）。
 * 静态 import 时 JSON 已被解析为对象，这里只做形状校验。
 */
function normalizeManifest(raw: unknown): PresetVoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is PresetVoice => {
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return (
      typeof o.file === "string" &&
      typeof o.gender === "string" &&
      typeof o.desc === "string"
    );
  }) as PresetVoice[];
}

/** 模块级缓存（JSON 静态 import 已内联，normalize 仅一次）。 */
const CACHE: PresetVoice[] = normalizeManifest(manifestData);

/**
 * 读取预设音色清单（200 条）。
 *
 * 用于 AI 资产提取（buildAssetExtractionPrompt 喂清单 → AI 推荐 suggested_voices
 * → validateSuggestedVoices 三级匹配校验）。web 路由调用，server domain 内部共用。
 *
 * @returns PresetVoice[]（不可变引用；调用方不应 mutate）
 */
export function loadPresetVoiceManifest(): PresetVoice[] {
  return CACHE;
}
