// ============================================================
// @web/lib/seedance-narrative-rewrite — 镜头组提示词 LLM 审核友好重写（层2）
// ============================================================
//
// 在 chain-generate 拼好 combinedPrompt 之后、写回 snapshot 之前，调一次 deepseek
// text_generation，把提示词重写成「审核友好 + 贴合 Seedance 官方公式」的版本：
// 去年龄词（child/少年）、暴力电影化、删纯编排/QA 训话、补影视术语。
//
// 这是创作语境声明（SEEDANCE_CREATION_CONTEXT）从「additive 塞进 prompt」升级为
// 「LLM system prompt 驱动重写」的落地：规则进 system，重写后的 prompt 自然内化，
// 比 prompt 开头声明一段更彻底，且能覆盖 sanitizePromptForModeration 管不到的
// 年龄词和语义级敏感。
//
// 安全网（任一不满足都 throw，调用方 catch 后降级原 prompt，绝不阻断主链路）：
//   1. 重写后用 validateSavedPromptAssetRefs 校验「图片N」引用与原 assetRefs 一致——
//      LLM 一旦改坏引用序号会导致参考图对不上、角色脸丢失（dramaforge-chain-compile-face-lost）。
//   2. 输出过短/为空降级。
//   3. 结构守卫 assertRewriteStructurePreserved：时间码 [MM:SS-MM:SS] 的数量与每个值
//      不得变（防丢镜头/并镜头/改时长），承重衔接标记（主体开场状态/首尾衔接）若原文
//      存在不得被删（防被当元信息洗掉，见 dramaforge-prevframe-continuity-prompt）。
//   4. callAI/billDirectGeneration 抛错降级。
//
// 计费：并入链路任务总成本（billingTaskId 累计结算，不单独向用户列项）。
// 缓存：READY 命中的 snapshot 已是重写结果（groupPromptMetadata 写回 rewrittenPrompt），
//      命中即跳过本调用，不重复花钱。
// ============================================================

import { callAI } from '@dramaforge/server';
import {
  SEEDANCE_CREATION_CONTEXT,
  validateSavedPromptAssetRefs,
  type AssetRef,
} from '@server/domain/prompt/seedance-helpers';
import { billDirectGeneration } from './direct-media-generation';

/** 重写用的文本模型（与 generate-storyboard 默认模型一致）。 */
const REWRITE_MODEL = 'deepseek-v4-flash';

const REWRITE_SYSTEM = [
  SEEDANCE_CREATION_CONTEXT,
  '',
  '你在上面「创作语境与镜头规范」的约束下，重写下面这条即将发给火山 Seedance 视频模型的镜头组提示词，使其审核友好且更贴合官方公式 [主体]+[场景]+[动作]+[运镜]+[时长]+[音频]+[风格]+@引用+时间分段。',
  '',
  '重写规则（必须逐条遵守）：',
  '1. 【load-bearing 不可动】保留全部「图片N」「音频N」资产引用、时间码 [MM:SS-MM:SS] 的值与数量、「### 当前生成组分镜」下每个 Shot 的结构与顺序、以及「## 开场连续性锁定」整段（含「主体开场状态」「首尾衔接」行）。改一个序号/时间码会导致参考图对不上、角色脸丢失或时长错位；删衔接段会导致跨组画面断裂。只改措辞，不动结构、引用编号、时间码和衔接指令。',
  '2. 把任何指向低龄的词（child/kid/young/boy/girl/小孩/少年/少女/儿童）改写为角色名或「青年/成年角色」。',
  '3. 暴力/冲突用电影化措辞（交锋、对峙、负伤、倒地、制服，而非流血、死亡、杀戮、爆头、断肢），不渲染血腥/色情/政治敏感细节。',
  '4. 删掉纯编排与 QA 训话（如「本组任务」「镜头职责」「生成验收/声音验收/连续性验收」之类元信息），只留官方公式有效信号。注意：「## 开场连续性锁定」段（主体开场状态/首尾衔接）是承重的跨组衔接与人物状态指令，不是元信息，必须原样保留、不得删改。',
  '5. 直接输出重写后的提示词正文，不要任何解释、前言、markdown 代码块标记（```）或标题包装。',
  '6. 保持原语种（中文输入输出中文，英文输入输出英文）。',
  '7. 目标是「同义精炼 + 审核友好」，不是「压缩」——不要缩短到丢失关键叙事、场景或动作信息。',
  '8. 情绪外化（必须）：把提示词里残留的抽象情绪词（开心/快乐/愤怒/生气/悲伤/难过/紧张/害怕/震惊等）改写成可见的身体动作，如「开心」→「嘴角上扬、眉眼舒展、脚步轻快」，「愤怒」→「双拳紧握、下颌绷紧、胸口起伏」；删掉无法被镜头拍到的纯情绪判断，只留可见的表情、动作与声音。',
].join('\n');

export interface RewriteGroupPromptOptions {
  userId: string;
  assetRefs: readonly { name: string; kind: string }[];
  billingTaskId: string;
  groupIndex: number;
}

/** 从提示词中提取所有时间码区间 `[MM:SS-MM:SS]`，归一为 `MM:SS-MM:SS` 字符串数组。 */
export function extractTimecodeRanges(s: string): string[] {
  return [...s.matchAll(/\[(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\]/g)].map(
    (m) => `${m[1]}-${m[2]}`,
  );
}

/**
 * 重写后结构守卫：镜头组的「结构与基准内容」不得被 LLM 改坏。
 *
 * 检查（任一不过即 throw，调用方应降级原 prompt）：
 *  - 时间码 [MM:SS-MM:SS] 的数量与每个值必须与原文一致（防丢镜头/并镜头/改时长）；
 *  - 承重衔接标记（主体开场状态/首尾衔接）若原文存在，重写后必须仍在（防被当元信息删）。
 *
 * 纯函数，直接单测。时间码是语言无关的强结构信号（每镜一个），无需再数 Shot 标题。
 */
export function assertRewriteStructurePreserved(
  original: string,
  rewritten: string,
): void {
  const origTc = extractTimecodeRanges(original);
  const newTc = extractTimecodeRanges(rewritten);
  if (origTc.length !== newTc.length) {
    throw new Error(
      `LLM 重写破坏了时间码数量（${origTc.length}→${newTc.length}），降级原 prompt`,
    );
  }
  const newTcSet = new Set(newTc);
  for (const tc of origTc) {
    if (!newTcSet.has(tc)) {
      throw new Error(`LLM 重写丢失/改写了时间码 ${tc}，降级原 prompt`);
    }
  }
  for (const marker of ['主体开场状态', '首尾衔接']) {
    if (original.includes(marker) && !rewritten.includes(marker)) {
      throw new Error(
        `LLM 重写删除了承重衔接标记「${marker}」，降级原 prompt`,
      );
    }
  }
}

/**
 * 用 deepseek 把镜头组提示词重写成审核友好版。
 *
 * @returns 重写后的 prompt；任何异常（输出异常/引用破坏/调用失败）都 throw，
 *          调用方应 catch 后降级用原 prompt（不阻断主链路）。
 */
export async function rewriteGroupPromptForModeration(
  prompt: string,
  opts: RewriteGroupPromptOptions,
): Promise<string> {
  const result = await callAI('deepseek', REWRITE_MODEL, {
    capability: 'text_generation',
    input: {
      messages: [
        { role: 'system', content: REWRITE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      // 关闭链式推理：本重写是「保结构、改措辞」的确定性任务（时间码/图片N 引用序号有
      // 硬校验兜底，改坏即降级原 prompt，不阻断主链路），无需深度推理。chain-generate
      // 逐组串行调用此函数，关闭 thinking 把每组从 ~40s 降到 ~5-10s，避免整集循环超过
      // 网关 504（曾阻塞一键出片）。
      thinking: 'disabled',
    },
    userId: opts.userId,
  });

  const meta = (result.meta ?? {}) as { content?: unknown };
  const rewritten = typeof meta.content === 'string' ? meta.content.trim() : '';
  if (!rewritten || rewritten.length < prompt.length * 0.3) {
    throw new Error('LLM 重写输出异常（过短或为空），降级原 prompt');
  }
  // 引用一致性校验：LLM 改坏「图片N」序号会导致参考图错位、角色脸丢失，不一致立即降级。
  if (
    opts.assetRefs.length > 0
    && !validateSavedPromptAssetRefs(rewritten, opts.assetRefs as AssetRef[])
  ) {
    throw new Error('LLM 重写破坏了图片N 引用一致性，降级原 prompt');
  }
  // 结构守卫：时间码数量/值不得变，承重衔接段不得被删——坏了立即降级，保镜头组结构与基准内容。
  assertRewriteStructurePreserved(prompt, rewritten);

  await billDirectGeneration({
    userId: opts.userId,
    result,
    description: '提示词审核友好重写',
    taskType: 'prompt_moderation_rewrite',
    billingTaskId: opts.billingTaskId,
    billingUnitId: `rewrite-${opts.groupIndex}`,
  });

  return rewritten;
}
