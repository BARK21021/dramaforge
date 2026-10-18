// ============================================================
// Video Language Contract — 视频生成全链路的单一语言约束
// ============================================================
//
// 制作说明允许中文，但所有会被模型“说出来/写进画面”的内容只能用目标语言，
// 防止中文镜头说明被误当成中文台词或字幕。
// ============================================================

import type { LocalizationProfile } from './target-languages';

export function buildVideoLanguageContract(
  profile: LocalizationProfile | null | undefined,
  fallbackCode = 'zh-CN',
): string {
  const target = profile?.targetLanguage;
  const code = target?.code || fallbackCode;
  const label = target ? `${target.zh} / ${target.native}（${code}）` : `中文（${code}）`;
  return [
    `【视频语言硬约束：${label}】`,
    `1. 所有可听见的对白、旁白、内心独白、吟唱、广播和人群说话，只能使用 ${label}；禁止混入其他语言。`,
    '2. 中文的镜头、动作、机位和情绪说明仅是制作指令，绝对不能被角色朗读或变成画外音。',
    `3. 默认不生成字幕或画面文字；剧情必须出现招牌、信件、手机 UI 等文字时，只能使用 ${label}，禁止乱码和混合语种。`,
    '4. 台词必须逐字沿用分镜中已给出的目标语种文本，不得翻译回中文、同义改写或自行增加台词。',
  ].join('\n');
}

/** 海外项目没有结构化目标语言时拒绝生产，避免猜测语种后生成错误成片。 */
export function hasLockedTargetLanguage(
  category: unknown,
  profile: LocalizationProfile | null | undefined,
): boolean {
  return String(category).toUpperCase() !== 'OVERSEAS' || Boolean(profile?.targetLanguage?.code);
}
