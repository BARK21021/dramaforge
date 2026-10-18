// ============================================================
// web/lib/model-parser — provider/model-id 拆分（批3 Q2）
// ============================================================
//
// 文件职责：
//   把 "provider/model-id" 形式的模型 ID 拆分为 { provider, model }，
//   供 analyze route / text-to-style route / 其他 callAI 调用点共享。
//
// 来源：原 analyze route（packages/web/app/api/projects/[id]/episodes/[episodeId]
// /analyze/route.ts:57-63）的私有 parseModel，抽到本 lib 共享，避免每个 route
// 重复实现导致行为漂移。
//
// 与 app1 差异：app1 在多处内联同样的拆分逻辑；dramaforge 集中到此一处。
// web 禁止 import 任何 ffmpeg 模块；本模块为纯工具。
// ============================================================

/**
 * 从 model ID 拆分 provider 前缀。
 *
 * "deepseek/deepseek-v4-flash" → { provider: 'deepseek', model: 'deepseek/deepseek-v4-flash' }
 * 与 generate/video route 的 parseModel 同逻辑（web 不 import ai-worker）。
 *
 * @throws Error 当 model 不含 `/` 或 `/` 在首位时（视为缺 provider 前缀）
 */
export function parseModel(model: string): { provider: string; model: string } {
  const idx = model.indexOf('/');
  if (idx <= 0) {
    throw new Error(`model 缺少 provider 前缀（应为 "provider/model-id"）: ${model}`);
  }
  return { provider: model.slice(0, idx), model };
}
