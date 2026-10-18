// ============================================================
// ③ server/domain/storyboard/degenerate — 退化/无意义画面镜头检测与改写
// ============================================================
//
// Seedance 文生视频无法合成"什么都没有"或"无运动"的画面：纯黑屏/纯白屏/无主体/
// 无场景会直接 HTTP 400 或退化成一张静止图（用户反馈"一张图片很傻逼"）。
//
// 本文件提供两个纯函数（与 asset-helpers.ts 的 PROMPT_SANITIZATION_MAP 同思路）：
//   - isDegenerateVisualPrompt：检测 visualPrompt 是否退化（黑屏/白屏/无主体/无场景等）。
//     供 postprocess 在编组前剔除/合并退化镜头，使其永不独占一组。
//   - sanitizeDegenerateVisualPrompt：机械改写退化措辞成"极暗剪影/可见主体"等可生成措辞，
//     供镜头组层（combineGroupPromps / chain-generate）做防御性兜底——已落库的旧坏数据
//     不必重生成分镜也能安全出片。
//
// 纯函数，零 ffmpeg。
// ============================================================

/** 退化标记：命中任一即判该镜头为"无意义画面"（不可直接生成）。 */
const DEGENERATE_MARKERS = /黑屏|白屏|纯黑|纯白|无主体|无场景|无画面|无图像内容|无任何图像/;

/**
 * visualPrompt 是否退化（无意义画面）。
 * 命中黑屏/白屏/纯黑/纯白/无主体/无场景/无画面/无图像内容等标记即判退化。
 * 空文本不算退化（空文本由 parse 阶段过滤）。
 */
export function isDegenerateVisualPrompt(text: string | null | undefined): boolean {
  if (!text) return false;
  return DEGENERATE_MARKERS.test(text);
}

/**
 * 机械改写退化措辞，把"黑屏/白屏/无主体/无场景/固定黑屏/无移动"等替成可生成的可见措辞。
 * 非退化文本原样返回。用于镜头组层兜底（覆盖已落库旧坏数据）。
 *
 * 注意：产出文案偏生硬（机械替换），仅作 last-resort；新分镜由 storyboard prompt 硬约束 +
 * postprocess 守卫在源头避免退化镜头，正常不会走到这里。
 */
export function sanitizeDegenerateVisualPrompt(text: string | null | undefined): string {
  if (!text) return '';
  let out = text;
  // 先剥零运动短语（会诱导模型只出静图）。
  out = out.replace(/固定黑屏|固定白屏|无任何图像内容|无任何图像|保持全黑|保持全白|无运动模糊/g, '');
  // 黑屏/白屏 → 极暗/极亮环境中的人物剪影（保留可见轮廓，可生成）。
  out = out.replace(/纯黑屏|黑屏/g, '极暗环境中的人物剪影（保留微弱可见轮廓）');
  out = out.replace(/纯白屏|白屏/g, '极亮过曝环境中的人物剪影（保留可见轮廓）');
  out = out.replace(/纯黑|全黑/g, '极暗');
  out = out.replace(/纯白|全白/g, '极亮过曝');
  // "无主体/无场景/无画面" → 补可见主体/场景。
  out = out.replace(/无主体/g, '人物（可见主体）');
  out = out.replace(/无场景/g, '所在场景环境');
  out = out.replace(/无画面|无图像内容/g, '可见画面');
  // 清理由替换产生的多余标点/空格。
  out = out.replace(/[，。、；]{2,}/g, '，').replace(/[ \t]{2,}/g, ' ').replace(/，\s*，/g, '，').trim();
  return out;
}
