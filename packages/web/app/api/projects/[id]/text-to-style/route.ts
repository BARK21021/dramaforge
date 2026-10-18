// ============================================================
// POST /api/projects/[id]/text-to-style — 文本转风格（批3 Step 5）
// ============================================================
//
// 原剧本 + 目标风格提示词 → LLM 改写为海外转绘风格剧本。
// 保持剧情骨架与格式不变；转换人物/环境/对白/字幕语言等风格维度。
//
// 流程：
//   1. requireUser + ownership 校验
//   2. DOMESTIC 拒绝（国内直出项目不需要文本转风格）
//   3. body 校验（text ≥10 字符 / stylePrompt 非空 / 长度上限）
//   4. parseModel 拆 provider；buildTextStylePrompt 构造 system/user
//   5. episodeNumber>1 时服务端 pg query 合并 CHARACTER/PROP/LOCATION 资产
//   6. callAI(text_generation) → cleanAiOutput → buildLocalizationProfile
//   7. 返回 { script, localizationProfile, rawLength, aliasMap }
//
// Q1（coordinator 修订 → 最终）：localizationProfile 写 project.scriptData
// （跨集共享，对齐 app1 text-to-style route 行 159-168）。前端 InputStage 同时
// 也写 episode.scriptData.localizationProfile（per-episode 副本，对齐 app1
// InputStage 行 280-293）。双写 + 读 episode 是 app1 原版模式，迁移不改。
//
// 角色别名从改写结果解析后原子回写 characterMapping；废弃的 voiceprintMapping
// 保持只读兼容，不再继续写入。
//
// GC 翻译：
//   - BYOK（GC-1）：callAI 用云端 key（getCredential 读环境变量/api_configs 表）
//   - dramaforge-keys-cloud-server-only：同上，本 route 不读用户 api-config
//   - prefer-better-lib-not-selfbuilt：复用 server 现有 buildTextStylePrompt /
//     cleanAiOutput / buildLocalizationProfile / callAI，零自研
//
// 鉴权：session REQUIRED + 项目 ownership。
// 响应（UI-facing envelope）：
//   200 { success:true, data: { script, localizationProfile, rawLength, aliasMap } }
//   400 EMPTY_TEXT / TEXT_TOO_LONG / EMPTY_STYLE / BAD_CATEGORY / BAD_MODEL
//   401 UNAUTHORIZED / 404 NOT_FOUND / 500 INTERNAL_ERROR
//   502 AI_GATEWAY_ERROR / AI_EMPTY
//
// web 禁止 import ffmpeg。零 ffmpeg 依赖。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  callAI,
  GatewayError,
  projectRepo,
  query,
  buildTextStylePrompt,
  cleanAiOutput,
  buildLocalizationProfile,
  parseCharacterAliasMap,
  updateCharacterMappingRoleIdentityByAliasMap,
  type LocalizationProfile,
} from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { requireBalanceOrFail } from '@web/lib/balance-gate';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';
import { parseModel } from '@web/lib/model-parser';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** 默认文本模型（与 analyze route 对齐） */
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/** 原文本最小长度 */
const MIN_TEXT_LENGTH = 10;
/** 原文本最大长度（避免超长输入） */
const MAX_TEXT_LENGTH = 200000;
/** 风格提示词最大长度 */
const MAX_STYLE_PROMPT_LENGTH = 5000;

/** 跨集已确认资产（CHARACTER/PROP/LOCATION 元数据，纯文本，非媒体字节） */
interface ExistingAsset {
  kind: string;
  name: string;
  description: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;

    // 1. ownership + category 校验
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }
    // 余额前置预检（对齐 app1 precheckBalance）：0 积分挡在昂贵 AI 调用之前。
    const balanceBlocked = await requireBalanceOrFail(auth.userId);
    if (balanceBlocked) return balanceBlocked;
    if (project.category === 'DOMESTIC') {
      return apiFail(
        {
          error: '国内直出项目不需要文本转风格，请直接保存并分析剧本',
          code: 'BAD_CATEGORY',
        },
        400,
      );
    }

    // 2. 解析请求体
    let body: {
      text?: unknown;
      stylePrompt?: unknown;
      model?: unknown;
      existingAssets?: unknown;
      episodeNumber?: unknown;
    };
    try {
      const raw = (await req.json()) as unknown;
      body =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as typeof body)
          : {};
    } catch {
      body = {};
    }

    const text = typeof body.text === 'string' ? body.text : '';
    const stylePrompt = typeof body.stylePrompt === 'string' ? body.stylePrompt : '';
    const modelId = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
    const frontendExistingAssets: ExistingAsset[] = Array.isArray(body.existingAssets)
      ? (body.existingAssets as ExistingAsset[]).filter(
          (a) => a && typeof a.kind === 'string' && typeof a.name === 'string',
        )
      : [];
    const episodeNumber =
      typeof body.episodeNumber === 'number' ? body.episodeNumber : undefined;

    // 3. 校验 text / stylePrompt
    if (!text || text.trim().length < MIN_TEXT_LENGTH) {
      return apiFail(
        { error: `请提供原剧本文本（至少 ${MIN_TEXT_LENGTH} 个字符）`, code: 'EMPTY_TEXT' },
        400,
      );
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return apiFail(
        {
          error: `原剧本文本过长（${text.length} 字符，上限 ${MAX_TEXT_LENGTH}）`,
          code: 'TEXT_TOO_LONG',
        },
        400,
      );
    }
    if (!stylePrompt || !stylePrompt.trim()) {
      return apiFail(
        { error: '请提供目标风格提示词', code: 'EMPTY_STYLE' },
        400,
      );
    }
    if (stylePrompt.length > MAX_STYLE_PROMPT_LENGTH) {
      return apiFail(
        {
          error: `目标风格提示词过长（${stylePrompt.length} 字符，上限 ${MAX_STYLE_PROMPT_LENGTH}）`,
          code: 'STYLE_TOO_LONG',
        },
        400,
      );
    }

    // 4. parseModel 拆 provider
    let parsed: { provider: string; model: string };
    try {
      parsed = parseModel(modelId);
    } catch (err) {
      return apiFail(
        { error: err instanceof Error ? err.message : 'model 格式错', code: 'BAD_MODEL' },
        400,
      );
    }

    // 5. 跨集名称一致性保障：第二集及之后，从 DB 自动加载项目全部资产（不限
    //    isConfirmed），与前端传入的资产合并去重，确保后续集始终复用首集锁定的
    //    角色名/物品名/环境名，避免每集独立翻译导致同一角色出现不同命名。
    let existingAssets = frontendExistingAssets;
    if (episodeNumber && episodeNumber > 1) {
      try {
        const dbResult = await query(
          `SELECT kind, name, description FROM assets WHERE "projectId" = $1 AND kind IN ('CHARACTER', 'PROP', 'LOCATION')`,
          [projectId],
        );
        const dbAssets: ExistingAsset[] = (dbResult.rows as Array<{
          kind: string;
          name: string;
          description: string | null;
        }>).map((a) => ({
          kind: a.kind,
          name: a.name,
          description: a.description || '',
        }));
        // 合并去重（以 name+kind 为主键，DB 优先 — DB 是权威来源）
        const seen = new Set(existingAssets.map((a) => `${a.kind}:${a.name}`));
        for (const dbAsset of dbAssets) {
          const key = `${dbAsset.kind}:${dbAsset.name}`;
          if (!seen.has(key)) {
            existingAssets.push(dbAsset);
            seen.add(key);
          }
        }
      } catch {
        // 跨集资产自动加载失败 → 回退到前端传入的资产，不阻塞主流程
      }
    }

    // 6. 调 AI 风格改写
    const { system, user } = buildTextStylePrompt(
      text,
      stylePrompt,
      existingAssets,
      episodeNumber,
    );

    let aiRawText: string;
    try {
      const result = await callAI(parsed.provider, parsed.model, {
        capability: 'text_generation',
        input: {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.7,
          // 改写后剧本可能较长，拉满 maxTokens 避免截断（对齐 app1 + analyze route）
          maxTokens: 393216,
        },
        userId: auth.userId,
      });
      await billDirectGeneration({
        userId: auth.userId,
        result,
        description: '原创剧本文本转风格',
        taskType: 'text_to_style',
      });

      const meta = (result.meta ?? {}) as Record<string, unknown>;
      aiRawText = typeof meta.content === 'string' ? meta.content : '';
    } catch (err) {
      if (err instanceof GatewayError) {
        return apiFail(
          {
            error: `AI 文本转风格失败 [provider=${err.provider}]: ${err.message}`,
            code: 'AI_GATEWAY_ERROR',
            category: 'provider',
            retryable: true,
          },
          502,
        );
      }
      throw err;
    }

    if (!aiRawText || aiRawText.trim().length < 10) {
      return apiFail(
        {
          error: 'AI 文本转风格返回内容为空，请重试',
          code: 'AI_EMPTY',
          category: 'provider',
          retryable: true,
        },
        502,
      );
    }

    // 7. 清理 AI 输出（剥套话）+ 派生结构化本地化档案
    const script = cleanAiOutput(aiRawText);
    const localizationProfile: LocalizationProfile =
      buildLocalizationProfile(stylePrompt);

    // 本地化目标必须跟随剧本进入后续编剧/资产/生图阶段，不能只停留在前端输入框。
    // 写 project.scriptData.localizationProfile（项目级跨集共享，对齐 app1
    // text-to-style route 行 159-168 的写入路径）。前端 InputStage 也会写
    // episode.scriptData.localizationProfile（per-episode denormalized 副本，
    // 对齐 app1 InputStage 行 280-293）。
    try {
      await projectRepo.update(projectId, {
        scriptData: { localizationProfile },
      });
    } catch {
      // 项目级 scriptData 写入失败不应阻塞主流程（剧本已生成、profile 已返回）；
      // 前端 InputStage 仍会通过 PATCH episode 写 episode 级副本兜底。
    }

    // 统一新旧角色命名空间，后续资产提取和镜头引用会继续复用同一角色 ID。
    const parsedAliasMap = parseCharacterAliasMap(script);
    if (parsedAliasMap.size > 0) {
      try {
        await updateCharacterMappingRoleIdentityByAliasMap(projectId, parsedAliasMap);
      } catch (error) {
        // 映射回写不应丢掉已经生成的剧本；保留日志供管理员修复。
        console.warn('[text-to-style] 角色别名回写失败:', error);
      }
    }
    const aliasMap = Object.fromEntries(parsedAliasMap);

    return apiSuccess({
      script,
      localizationProfile,
      rawLength: aiRawText.length,
      aliasMap,
    });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/text-to-style');
  }
}
