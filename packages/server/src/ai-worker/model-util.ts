// ============================================================
// ⑥ server/ai-worker/model-util — 模型 ID 解析工具（纯函数）
// ============================================================
//
// 文件职责：
//   parseModel(model) — 从 "provider/model-id" 中提取 provider 与 model。
//   ② callAI(provider, model, payload) 需要独立的 provider 参数，
//   而 app1 的任务 input.model 通常是 "ark/doubao-seedance-2-0" 形式，
//   故在 handler 层拆分。
//
// 服务器禁止 import ffmpeg；本模块为纯函数，零 I/O。
// ============================================================

/**
 * 从模型 ID 中拆分 provider 与 model。
 *
 * "ark/doubao-seedance-2-0"   → { provider: 'ark', model: 'ark/doubao-seedance-2-0' }
 * "openai/gpt-4o"             → { provider: 'openai', model: 'openai/gpt-4o' }
 * "doubao-seedance-2-0"       → 抛错（缺 provider 前缀）
 *
 * 返回的 model 保留原始字符串（含前缀），由 ② gateway 内部的 extractModelId
 * 统一剥离前缀取真实 modelId。
 *
 * @param model - 模型 ID（必须含 provider 前缀）
 * @returns { provider, model }
 * @throws Error 当 model 缺少 provider 前缀（不含 '/'）
 */
export function parseModel(model: string): { provider: string; model: string } {
  if (!model || typeof model !== 'string') {
    throw new Error('模型 ID 为空');
  }
  const idx = model.indexOf('/');
  if (idx < 0) {
    throw new Error(`模型 ID 缺少 provider 前缀: ${model}`);
  }
  const provider = model.slice(0, idx);
  if (!provider) {
    throw new Error(`模型 ID provider 前缀为空: ${model}`);
  }
  return { provider, model };
}

/**
 * 从模型 ID 中提取 provider 前缀；无前缀时返回 null。
 *
 * 与 parseModel 的差异：不抛错，无前缀返回 null，由调用方决定回退策略。
 * 用于 TTS 等可能无前缀的场景（回退到 input.provider）。
 */
export function tryExtractProvider(model: string): string | null {
  if (!model || typeof model !== 'string') return null;
  const idx = model.indexOf('/');
  if (idx < 0) return null;
  const provider = model.slice(0, idx);
  return provider || null;
}

/**
 * 根据宽高计算比例字符串。
 *
 * 复刻 app1 ImageWorker 的比例推断逻辑：
 *   9:16 / 16:9 / 3:4 / 4:3 / 21:9 / 9:21 / 1:1
 *
 * @param width - 图像宽度（像素）
 * @param height - 图像高度（像素）
 * @returns 比例字符串（如 "9:16"），无法匹配时返回 "1:1"
 */
export function computeAspectRatio(width?: number, height?: number): string {
  if (!width || !height || width <= 0 || height <= 0) return '1:1';
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) < 0.1) return '9:16';
  if (Math.abs(ratio - 16 / 9) < 0.1) return '16:9';
  if (Math.abs(ratio - 3 / 4) < 0.1) return '3:4';
  if (Math.abs(ratio - 4 / 3) < 0.1) return '4:3';
  if (Math.abs(ratio - 21 / 9) < 0.1) return '21:9';
  if (Math.abs(ratio - 9 / 21) < 0.1) return '9:21';
  return '1:1';
}

/** 默认反向提示词（复刻 app1 交付合规兜底） */
export const DEFAULT_NEGATIVE_PROMPT =
  '低质量，模糊，变形，多余的肢体，水印，文字';
