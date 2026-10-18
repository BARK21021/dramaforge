// ============================================================
// JSON 修复与安全解析工具
// ============================================================
//
// 文件职责：
//   提供 LLM 输出的 JSON 文本的安全解析能力。
//   LLM 经常返回带有 markdown 代码块包裹（```json ... ```）、
//   前后多余文本、尾随逗号、单引号等非标准 JSON 格式的文本，
//   本模块通过多轮清洗尝试将其解析为合法 JS 对象。
//
// 核心功能：
//   1. safeParseJsonObject - 安全解析 JSON 文本，失败返回 null（不抛异常）
//   2. 提取代码块中的 JSON 内容
//   3. 容忍尾随逗号、单引号等常见 LLM 输出瑕疵
//
// 使用场景：
//   - 解析 LLM 返回的剧本分析、资产提取、角色映射等 JSON 结果
//   - 任何需要从可能不规范的文本中提取 JSON 对象的场景
// ============================================================

import { jsonrepair } from "jsonrepair";

/**
 * 从文本中提取 JSON 对象字符串
 *
 * 尝试以下策略按顺序提取：
 *   1. 去除 markdown 代码块包裹（```json ... ``` 或 ``` ... ```）
 *   2. 匹配第一个 `{` 到最后一个 `}` 之间的内容（容忍前后多余文本）
 *   3. 原样返回（调用方自行尝试解析）
 *
 * @param text - 可能包含 JSON 的原始文本
 * @returns 提取出的 JSON 字符串；无法提取时返回原文本
 */
function extractJsonText(text: string): string {
  if (!text || typeof text !== "string") return "";

  let trimmed = text.trim();

  // 1. 去除 markdown 代码块包裹
  const codeBlockMatch = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    trimmed = codeBlockMatch[1].trim();
  }

  // 2. 匹配第一个 { 到最后一个 }（容忍前后多余文本）
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

/**
 * 尝试修复常见的 JSON 格式瑕疵
 *
 * 修复内容：
 *   - 移除尾随逗号（}, ] 前的逗号）
 *   - 移除单行注释（// ...）
 *
 * @param text - 待修复的 JSON 文本
 * @returns 修复后的文本
 */
function repairJson(text: string): string {
  let result = text;

  try {
    // 移除尾随逗号：}, ] 或 } 前的逗号
    result = result.replace(/,(\s*[}\]])/g, "$1");

    // 移除单行注释（不在字符串字面量内的 // 注释，简化处理）
    result = result.replace(/\/\/[^\n\r]*/g, "");
  } catch {
    // 修复失败则原样返回
  }

  return result;
}

/**
 * 安全解析 JSON 文本为对象
 *
 * 多轮尝试策略（任一成功即返回）：
 *   1. 直接 JSON.parse 原文
 *   2. 提取代码块/花括号内容后解析
 *   3. 修复尾随逗号等瑕疵后解析
 *
 * 解析失败时返回 null，不抛出异常，便于调用方优雅降级。
 *
 * @param text - 可能包含 JSON 的文本（LLM 输出、API 响应等）
 * @returns 解析后的对象；失败或输入为空时返回 null
 *
 * @example
 * const data = safeParseJsonObject('```json\n{"characters": []}\n```');
 * if (data && Array.isArray(data.characters)) { ... }
 *
 * @example
 * const rawParsed = safeParseJsonObject(content);
 * if (!rawParsed || !Array.isArray(rawParsed.characters)) { ... }
 */
export function safeParseJsonObject(text: string): any | null {
  if (!text || typeof text !== "string") return null;

  // 策略 1：直接解析原文
  try {
    return JSON.parse(text);
  } catch {
    // 继续尝试其他策略
  }

  // 策略 2：提取代码块/花括号内容后解析
  const extracted = extractJsonText(text);
  if (extracted && extracted !== text) {
    try {
      return JSON.parse(extracted);
    } catch {
      // 继续尝试修复
    }
  }

  // 策略 3：修复尾随逗号等常见瑕疵后解析
  const repaired = repairJson(extracted || text);
  try {
    return JSON.parse(repaired);
  } catch {
    // 继续尝试更强的 JSON 修复
  }

  // 策略 4：使用 jsonrepair 处理缺引号、转义异常、尾随逗号等更复杂的 LLM 输出瑕疵
  try {
    return JSON.parse(jsonrepair(repaired));
  } catch {
    // 所有策略均失败
    return null;
  }
}
