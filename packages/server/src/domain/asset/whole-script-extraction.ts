// ============================================================
// ③ server/domain/asset/whole-script-extraction — 整剧资产提取（转绘 X4.4）
// ============================================================
//
// 移植自 app1 src/core/video/whole-script-asset-extraction.ts（117 行）。app1 在
// EPISODE_SPLIT BullMQ 任务内会调用本逻辑；独立 route 也可用于手动重新提取，
// 故由独立 web route POST /api/projects/[id]/whole-script-asset-extraction 触发（UI
// 在 ORIGINAL 整剧 novelText 落定后主动调一次）。
//
// 行为：
//   1. 调用方保证传入的是项目最终整剧文本；OVERSEAS 已在整剧任务中完成本地化。
//   2. 调云端 DeepSeek text_generation，system prompt 要求整剧阅读后输出 JSON
//      {characters:[{name,description}], locations:[], props:[]}。
//   3. 读已有 assets 去重（kind: name.toLowerCase()），新名 insert。
//
// C/S 适配：
//   - app1 `gateway.request({capability:'text_generation',...})` → dramaforge `callAI('deepseek',
//     model, {capability:'text_generation', userId, input:{messages, temperature}})`。
//   - app1 `prisma.asset.create/findMany` → dramaforge `createAsset` / `listAssets`（asset domain）。
//   - **绝不调 replaceExtractedAssets**（会清掉用户已确认/已绑音色/已生图资产）；本函数
//     用 createAsset 单条插 + 去重，照搬 app1 的 "add-if-missing" 语义。
//   - 纯文本调用，零媒体字节，无 dramaforge-assets-client-local 冲突。
//
// leaf module：依赖 @server/gateway（callAI）+ ./service（listAssets/createAsset）。
// 服务器禁止 import ffmpeg（本模块零 ffmpeg 依赖）。
// ============================================================

import { callAI } from '@server/gateway';
import { tx, type QueryFn } from '@server/infra';
import { genId } from '@shared/utils';
import {
  listAssets,
  mergeCostumeMetadataPreservingImages,
  type AssetRecord,
} from './service';
import { normalizeAssetName, shouldProtectAssetFromDeletion } from './asset-reuse';
import { safeParseJsonObject } from '../prompt/json-repair';
import {
  COSTUME_KEY_SLUG_HINTS,
  dedupCostumes,
  slugifyCostumeKey,
  validateSuggestedVoices,
  loadPresetVoiceManifest,
  type ExtractedAssets,
  type LocalizationProfile,
} from '../prompt';
import {
  validateAssetCreate,
  validateAssetUpdate,
  type AssetCreateInput,
} from './validation';

/** app1 同名导出类型。 */
/** 整剧提取的角色/物品/环境变体（形状对齐 parseAssetExtraction 产出的 costume）。 */
interface WholeScriptCostume {
  key: string;
  label: string;
  description: string;
  identity_lock: string[];
  coverage_scenes: string[];
  /** 该变体出场的集号（AI 看 === EP{n} === 标记输出）。 */
  coverage_episodes?: number[];
  variant_type?: 'costume' | 'period';
}

interface ExtractedAsset {
  name: string;
  description?: string;
  source_names?: string[];
  costumes?: WholeScriptCostume[];
  suggested_voices?: Array<{ file: string; desc?: string; reason?: string; gender?: string }>;
}

/**
 * 物品/环境基准兜底：整剧提取未输出变体时合成 default 基准（与单集 ensureDefaultBaseline 同口径）。
 */
function ensureWholeScriptDefaultBaseline(costumes: WholeScriptCostume[], fallbackDescription: string): WholeScriptCostume[] {
  if (costumes.length > 0) return costumes;
  return [{
    key: 'default',
    label: '默认',
    description: fallbackDescription || '',
    identity_lock: [],
    coverage_scenes: [],
    coverage_episodes: [],
  }];
}

/**
 * 从整剧提取的原始角色对象里解析服装变体数组（key 用 slugifyCostumeKey 归一，
 * 与单集 parseAssetExtraction 同款映射）。仅保留含 key/label/description 的条目。
 */
function parseWholeScriptCostumes(raw: unknown): WholeScriptCostume[] {
  if (!Array.isArray(raw)) return [];
  return dedupCostumes(
    raw
      .filter((cv): cv is Record<string, unknown> => Boolean(cv)
        && typeof cv === 'object'
        && !Array.isArray(cv)
        && (cv.key || cv.label || cv.description))
      .map((cv, idx) => {
        const rawKey = typeof cv.key === 'string' ? cv.key.trim() : '';
        const label = typeof cv.label === 'string' ? cv.label.trim() : '';
        const normalizedKey = !rawKey || /^(default|默认)$/i.test(rawKey)
          ? 'default'
          : slugifyCostumeKey(rawKey || label, idx);
        const identityLockRaw = cv.identity_lock ?? cv.identityLock;
        const identityLock = Array.isArray(identityLockRaw)
          ? identityLockRaw.filter((x: unknown): x is string => typeof x === 'string')
          : [];
        const coverageScenesRaw = cv.coverage_scenes ?? cv.coverageScenes;
        const coverageScenes = Array.isArray(coverageScenesRaw)
          ? coverageScenesRaw.filter((x: unknown): x is string => typeof x === 'string')
          : [];
        const coverageEpsRaw = cv.coverage_episodes ?? cv.coverageEpisodes;
        const coverageEpisodes = Array.isArray(coverageEpsRaw)
          ? coverageEpsRaw.filter((x: unknown): x is number => typeof x === 'number' && Number.isFinite(x))
          : [];
        return {
          key: normalizedKey,
          label,
          description: typeof cv.description === 'string' ? cv.description.trim() : '',
          identity_lock: identityLock,
          coverage_scenes: coverageScenes,
          coverage_episodes: coverageEpisodes,
          ...(cv.variant_type === 'period' ? { variant_type: 'period' as const } : {}),
        };
      }),
  );
}

interface WholeScriptAssetResult {
  characters?: ExtractedAsset[];
  locations?: ExtractedAsset[];
  props?: ExtractedAsset[];
}

type IndexedAsset = Pick<
  AssetRecord,
  'id' | 'kind' | 'name' | 'metadata' | 'isConfirmed' | 'imageUrl' | 'regenLocked' | 'costumes' | 'voiceTrait'
>;

export interface WholeScriptAssetExtractionOutput {
  created: number;
  totalDetected: number;
  cost: number;
  normalized?: number;
  merged?: number;
  deferred?: boolean;
  reason?: string;
}

/** 资产提取默认模型（app1 默认 deepseek/deepseek-v4-flash）。 */
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * Transaction-bound subset of createAsset. It intentionally writes only the
 * fields owned by whole-series extraction; all writes use the caller's QueryFn
 * so a later failure rolls the complete extraction batch back.
 */
async function createAssetInTransaction(
  q: QueryFn,
  input: AssetCreateInput,
  costumes?: readonly WholeScriptCostume[] | null,
  voiceTrait?: string | null,
): Promise<IndexedAsset> {
  const validation = validateAssetCreate(input);
  if (!validation.valid) {
    throw new Error(`资产校验失败: ${validation.errors.join('; ')}`);
  }

  const id = genId();
  const costumesJson = costumes && costumes.length > 0 ? JSON.stringify(costumes) : null;
  const result = await q.query(
    `INSERT INTO assets
      (id, "projectId", kind, name, description, "imageUrl", metadata, tags,
       version, "assetType", "basePrompt", "isConfirmed", costumes, "voiceTrait", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12::jsonb, $13, NOW(), NOW())`,
    [
      id,
      input.projectId,
      input.kind,
      input.name,
      input.description ?? null,
      input.imageUrl ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.assetType ?? null,
      input.basePrompt ?? null,
      input.isConfirmed ?? false,
      costumesJson,
      voiceTrait ?? null,
    ],
  );
  if (result.rowCount === 0) throw new Error('资产创建失败');

  return {
    id,
    kind: input.kind,
    name: input.name,
    metadata: input.metadata ?? null,
    isConfirmed: input.isConfirmed ?? false,
    imageUrl: input.imageUrl ?? null,
    regenLocked: false,
    costumes: costumesJson ? (JSON.parse(costumesJson) as Record<string, unknown>[]) : null,
    voiceTrait: voiceTrait ?? null,
  };
}

/**
 * Updates only the two identity fields owned by extraction. In particular this
 * never replaces costumes/imageUrl and never touches image-revision rows.
 */
async function updateAssetIdentityInTransaction(
  q: QueryFn,
  assetId: string,
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const validation = validateAssetUpdate({ name, metadata });
  if (!validation.valid) {
    throw new Error(`资产更新校验失败: ${validation.errors.join('; ')}`);
  }
  const result = await q.query(
    'UPDATE assets SET name = $1, metadata = $2, "updatedAt" = NOW() WHERE id = $3',
    [name, JSON.stringify(metadata), assetId],
  );
  if (result.rowCount === 0) throw new Error('资产不存在');
}

/** @deprecated 整剧任务现已保证海外先转风格再提取，分类不再触发延后。 */
export function shouldDeferWholeScriptAssetExtraction(category: unknown): boolean {
  void category;
  return false;
}

type ChineseDisplayNameKind = 'LOCATION' | 'PROP';

interface ChineseDisplayNameTarget {
  id: string;
  kind: ChineseDisplayNameKind;
  originalName: string;
  asset: ExtractedAsset;
}

const CHINESE_DISPLAY_NAME_FAILURE = '整剧资产中文展示名规范化失败';

/** A production display name must contain Han text and must not contain Latin letters. */
function isValidChineseDisplayName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  return name.length > 0 && /[\u3400-\u9fff]/u.test(name) && !/[A-Za-z]/u.test(name);
}

/**
 * Repairs only invalid LOCATION/PROP display names in one small, deterministic call.
 * This runs before the write loop so an invalid repair can never leak into the asset table.
 */
async function normalizeChineseDisplayNames(
  parsed: WholeScriptAssetResult,
  userId: string,
  model: string,
): Promise<number> {
  const targets: ChineseDisplayNameTarget[] = [];
  const collect = (
    kind: ChineseDisplayNameKind,
    assets: ExtractedAsset[] | undefined,
  ): void => {
    if (!Array.isArray(assets)) return;
    assets.forEach((asset, index) => {
      const originalName = typeof asset?.name === 'string' ? asset.name.trim() : '';
      if (!isValidChineseDisplayName(originalName)) {
        targets.push({ id: `${kind}:${index}`, kind, originalName, asset });
      }
    });
  };

  collect('LOCATION', parsed.locations);
  collect('PROP', parsed.props);
  if (targets.length === 0) return 0;

  const response = await callAI('deepseek', model, {
    capability: 'text_generation',
    userId,
    input: {
      messages: [
        {
          role: 'system',
          content: [
            '你是影视制作资产名称规范器，把 LOCATION 和 PROP 的展示名翻译或规范为准确、简洁的简体中文。',
            '只改名称，不得新增、删除、合并、重排或重新解释资产。',
            '每个返回 name 必须至少包含一个汉字，且不得包含任何 A-Z 或 a-z 拉丁字母。',
            '输出必须是一个完整 JSON 对象，顶层唯一字段为 assets；不要 Markdown 代码围栏、解释、注释或省略号。',
            '完整格式：{"assets":[{"id":"LOCATION:0","name":"中文名"}]}。每个输入 id 必须原样返回且恰好一次。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            assets: targets.map((target) => ({
              id: target.id,
              kind: target.kind,
              original_name: target.originalName,
              source_names: Array.isArray(target.asset.source_names)
                ? target.asset.source_names
                : [],
              description: typeof target.asset.description === 'string'
                ? target.asset.description
                : '',
            })),
          }),
        },
      ],
      temperature: 0,
      maxTokens: Math.min(4096, Math.max(512, targets.length * 160)),
    },
  });

  const responseMeta = (response.meta ?? {}) as { content?: string };
  const normalized: unknown = safeParseJsonObject(
    typeof responseMeta.content === 'string' ? responseMeta.content : '',
  );
  // The requested object and its bare array payload carry the same complete,
  // unambiguous contract. Keep item/id/name validation below strict.
  const returnedAssets = Array.isArray(normalized)
    ? normalized
    : normalized && typeof normalized === 'object'
      ? (normalized as Record<string, unknown>).assets
      : undefined;
  if (!Array.isArray(returnedAssets)) {
    throw new Error(`${CHINESE_DISPLAY_NAME_FAILURE}\uff1a\u8fd4\u56de\u683c\u5f0f\u65e0\u6548`);
  }

  const expectedIds = new Set(targets.map((target) => target.id));
  const namesById = new Map<string, string>();
  for (const value of returnedAssets) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${CHINESE_DISPLAY_NAME_FAILURE}\uff1a\u8fd4\u56de\u683c\u5f0f\u65e0\u6548`);
    }
    const item = value as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!expectedIds.has(id) || namesById.has(id) || !isValidChineseDisplayName(name)) {
      throw new Error(`${CHINESE_DISPLAY_NAME_FAILURE}\uff1a${id || '\u672a\u77e5\u8d44\u4ea7'}`);
    }
    namesById.set(id, name);
  }
  if (namesById.size !== expectedIds.size) {
    throw new Error(`${CHINESE_DISPLAY_NAME_FAILURE}\uff1a\u8fd4\u56de\u8d44\u4ea7\u4e0d\u5b8c\u6574`);
  }

  // Apply only after the complete response has passed strict validation.
  for (const target of targets) {
    const name = namesById.get(target.id);
    if (!name) {
      throw new Error(`${CHINESE_DISPLAY_NAME_FAILURE}\uff1a\u8fd4\u56de\u8d44\u4ea7\u4e0d\u5b8c\u6574`);
    }
    const sourceNames = Array.isArray(target.asset.source_names)
      ? target.asset.source_names.filter((value): value is string => typeof value === 'string')
      : [];
    target.asset.name = name;
    target.asset.source_names = Array.from(new Set([
      ...sourceNames,
      target.originalName,
    ].map((value) => value.trim()).filter(Boolean)));
  }

  return typeof response.cost === 'number' ? response.cost : 0;
}

/**
 * 海外转绘改编段：注入整剧资产提取 prompt，强制把角色/道具/环境的视觉文化
 * 改编到本地化档案指定的目标文化（族裔、服饰、建筑），仅角色名保持剧本锁定。
 * 解决"中文源叙述 → 默认东亚面孔 / 中国古风服饰"的族裔漂移问题。
 */
function buildOverseasAdaptationSection(localizationProfile?: LocalizationProfile): string {
  const tl = localizationProfile?.targetLanguage;
  const profileLine = tl
    ? `本地化档案：目标语言=${tl.zh || tl.en}；目标区域=${tl.region}；文化指引=${tl.cultureHint}。`
    : (localizationProfile?.stylePrompt
      ? `本地化要求：${localizationProfile.stylePrompt.slice(0, 500)}。`
      : '未提供档案时，按目标语言姓名与对白推断目标文化语境。');
  return [
    '【海外本地化改编·最高优先级】',
    '本项目是海外本地化改编。目标文化与族裔由本地化档案、目标语言姓名和对白共同决定，绝不沿用源文本的东亚/中国视觉文化。下方任何"跟随剧本/不臆造族裔"的规则，在海外改编下让位于本段。',
    '- 角色：每个角色须重塑为目标文化/地区的人物——五官、脸型、发型、肤色、体型服从目标地区族裔（如英语/欧洲语境→欧洲/白人面孔与发色体型）。不得因源叙述是中文就生成东亚面孔。',
    '- 服饰与物质文化：按目标文化与剧情时代改写服装/配饰/道具/建筑——把源文化服饰替换为目标文化同等身份的对应物（例：「王子/贵族」→欧洲贵族或时代正装，如合身礼服、斗篷、呢料、时代剪裁；严禁东亚长袍/汉服/和服等源文化服饰）。',
    '- 仅「角色名」保持剧本锁定名（不改名、不音译），只改编视觉文化。',
    '- 描述语言仍用简体中文（制作端展示用），但内容必须是目标文化的外貌与服饰，不得保留源文化服饰用词（如「长袍」「汉服」「金线绣袍」须改写为目标文化对应物）。',
    profileLine,
  ].join('\n');
}

/**
 * 在整剧 novelText 上一次 AI 读取，建立项目级共享资产（不按分集截断，避免后半段
 * 才出场的人物/场景/道具遗漏）。
 *
 * @param projectId 项目 ID
 * @param novelText 整剧完整剧本（route 层已校验非空）
 * @param userId    调用方（计费/凭证归属）
 * @param category  项目 category（OVERSEAS 时注入海外改编段，改写视觉文化到目标语境）
 * @param model     DeepSeek 模型 ID（默认 deepseek/deepseek-v4-flash）
 * @param localizationProfile 文本转风格阶段持久化的目标语言与文化档案（OVERSEAS 改编用）
 */
export async function extractWholeScriptAssets(
  projectId: string,
  novelText: string,
  userId: string,
  category: unknown,
  model: string = DEFAULT_MODEL,
  localizationProfile?: LocalizationProfile,
): Promise<WholeScriptAssetExtractionOutput> {
  const isOverseas = String(category ?? '').toUpperCase() === 'OVERSEAS';
  const overseasAdaptationSection = isOverseas
    ? buildOverseasAdaptationSection(localizationProfile)
    : '';

  const existing: AssetRecord[] = await listAssets(projectId);
  const legacyDisplayNames = existing
    .filter((asset) => (asset.kind === 'LOCATION' || asset.kind === 'PROP')
      && (!/[\u3400-\u9fff]/u.test(asset.name) || /[A-Za-z]/u.test(asset.name)))
    .map((asset) => `${asset.kind}:${asset.name}`);
  const legacyNormalizationBlock = legacyDisplayNames.length > 0
    ? `\n---历史资产名规范清单开始---\n${legacyDisplayNames.join('\n')}\n---历史资产名规范清单结束---\n` +
      '上述每个历史 LOCATION/PROP 都必须在结果中得到覆盖：name 改为纯简体中文规范名，原完整名称写入 source_names；语义重复项合并到同一条。'
    : '';

  // 预设音色清单：注入 prompt 供 AI 推荐音色；提取后再用同一份做 suggested_voices 文件名校验。
  const voiceManifest = loadPresetVoiceManifest();
  const voiceListDesc = voiceManifest.length > 0
    ? voiceManifest.map((v) => `  - ${v.file}: ${v.desc} (${v.gender})`).join('\n')
    : '无可用音色';

  // provider 按 model 前缀路由：`kimi/` 前缀走 kimi（REFERENCE_VIDEO 模式
  // 用户所选 2.6/2.7/3 与视频转剧本共用下拉），其余默认 deepseek。
  // maxTokens 按 provider 钳制：kimi 输出上限 262144（kimi.ts
  // KIMI_MAX_OUTPUT_TOKENS），DeepSeek V4 Pro 393216（app1 catalog 值）。
  const provider = model.startsWith('kimi/') ? 'kimi' : 'deepseek';
  const maxTokens = provider === 'kimi' ? 262_144 : 393_216;
  const result = await callAI(provider, model, {
    capability: 'text_generation',
    userId,
    input: {
      messages: [
        {
          role: 'system',
          content: `你是影视制片资产统筹。完整阅读整部剧本，提取后续所有分集共用的生产资产。
${overseasAdaptationSection}
规则：
1. characters：所有具名或持续出场人物，合并别名；描述包含身份、年龄感、外貌。主 description 只写一个默认/常态外貌（基础长相 + 最常出场的那套服装），禁止在主 description 里列举多种形态、体型或年龄段。
2. locations：所有需要独立搭景/绘制的地点，合并同义地点，但区分明显不同的时间或状态版本。location 描述只写场所本身——建筑结构、空间布局、材质、光影氛围；场景中出现的具体物件/家具/道具归入 props，不要写进 location。
3. props：推动因果、反复出现、揭示身份或必须保持连续性的关键道具，以及场景中出现的具体物件/家具；不要收录普通背景杂物。
4. 必须覆盖剧本后半段，禁止只分析开头；广告、平台口播、二维码、商品推广不算资产。
5. locations 和 props 的 name 必须使用简体中文，作为制作端统一展示名；即使原剧本是英文或其他语言也必须翻译成准确、简洁的中文名称。
6. locations 和 props 同时输出 source_names，列出剧本原文名称及常见别名，供跨语言镜头匹配；characters 的 name 保持剧本锁定角色名，不得擅自翻译。
7. 若用户附带"历史资产名规范清单"，必须逐项覆盖；中英混排名也要改为纯中文 display name，并把原完整名称保存在 source_names，语义重复项合并。
8. 【变体·强制】characters / locations / props 三类都必须输出 costumes 变体数组（与角色完全对齐）：即便只有一个常态也至少输出 1 条 default 基准。每条含 key/label/description/identity_lock/variant_type/coverage_episodes。
   - 三类语义：characters=服装造型变体；props=状态变体（如 完好/破损/开启/封印）；locations=时段或状态变体（如 白昼/深夜/破损/荒废）。
   - key：最常出场/基准状态用 "default"；其余用语义化英文 slug（小写、连字符、无中文、无空格、无数字后缀）。参考 slug：${COSTUME_KEY_SLUG_HINTS.map((h) => h.slug).join('、')}。都不合适就自造一个简短英文 slug。同一套服装跨场景必须复用同一 key；禁止 custom-N、variant-N、recovery-casual-1 这类带数字后缀或无语义的 key。
   - label：必须用简体中文（无论原剧本是中文还是英文，都输出中文 label，如"便装/战损/康复便装/婚纱"）。
   - description：必须用简体中文，具体到上衣/裤子/鞋子/材质/颜色/配饰（角色）、形态/材质/颜色/破损处（道具）、光照/时段/天气/可见变化（环境）。每条至少 3 个视觉细节，同一资产不同变体必须在至少 3 个视觉细节上有差异。同一套服装无论原文用什么语言，只输出一条中文 description。
   - identity_lock：只列该变体专属锁定（角色如"银色领带夹"；道具如"裂痕走向"；环境如"逆光剪影"）；跨变体不变的核心特征不写这里。
   - variant_type：普通换装/状态用 "costume"（缺省）；同一人物不同人生阶段（幼年/成年/老年、童年闪回 vs 成年主线）用 "period"——period 变体允许年龄/脸型/身高/体型不同。
   - 【隐性变体识别·强制】必须主动从剧本正文识别状态/造型变化：角色（受辱/失态、闪回换装、换装动作、半裸/裸露）、道具（破损/开启/封印/变形/染血/解体）、环境（昼夜切换/破损/天气/荒废）。任一资产经历状态切换，必须至少输出 2 个变体；禁止把所有场景合并成单个 default。
   - 跨变体一致性（costume 型）：同一角色五官/脸型/身高/体型/身份跨变体 100% 一致；同一道具造型/材质/标志性细节跨变体一致；同一环境建筑结构/空间布局跨变体一致。变体只改变上述合法维度。
   - 【禁止重复变体·强制】同一变体只能出现一次：相同 label、或仅结尾括号后缀不同的必须合并；服务端按 key/label 强制去重，请勿浪费输出。
   - 【出场集号·强制】每个变体必须输出 coverage_episodes：标注它在哪几集出场——看正文中的 === EP{n} === 标记，把该变体出现的集号 n 填进数组（如出现在第 1、3 集则 [1,3]）。default 基准至少覆盖其出场的集。整剧无分镜场景号，coverage_scenes 一律省略，不要编造 S1/S2。
9. 只输出 JSON（JSON 的键名/字符串值一律用 ASCII 半角双引号 " ，严禁中文全角引号 "" ）：{"characters":[{"name":"","description":"","costumes":[{"key":"default","label":"便装","description":"","identity_lock":[],"variant_type":"costume","coverage_episodes":[1]}],"suggested_voices":[{"file":"参考音频文件名","desc":"音色描述","reason":"推荐理由"}]}],"locations":[{"name":"中文名","source_names":["原文名"],"description":"","costumes":[{"key":"default","label":"白昼","description":"","identity_lock":[],"variant_type":"costume","coverage_episodes":[1]}]}],"props":[{"name":"中文名","source_names":["原文名"],"description":"","costumes":[{"key":"default","label":"完好","description":"","identity_lock":[],"variant_type":"costume","coverage_episodes":[1]}]}]}。
10. 【音色推荐·强制】每个 character 必须输出 suggested_voices 数组：根据角色性别、年龄、性格，从下方参考音色清单推荐 3-6 个最匹配的音色；每条含 file（必须是清单里存在的文件名，逐字复制、不得篡改）、desc（音色描述）、reason（为什么适合该角色）。考虑性别匹配、年龄匹配、性格气质匹配；无完全合适的也要选最接近的，不要留空数组。
    参考音色清单：
${voiceListDesc}`,
        },
        {
          role: 'user',
          content: `---整部剧本开始---\n${novelText}\n---整部剧本结束---${legacyNormalizationBlock}`,
        },
      ],
      temperature: 0.2,
      // app1's model catalog injects the V4 Pro output/context limits. The C/S
      // gateway has no catalog layer, so pass them explicitly or long-series
      // asset JSON silently falls back to a much smaller provider default.
      maxTokens,
      contextWindow: 1_048_576,
    },
  });

  const meta = (result.meta ?? {}) as { content?: string };
  const content = typeof meta.content === 'string' ? meta.content : '';
  const parsedValue: unknown = safeParseJsonObject(content);
  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    throw new Error('整剧资产提取返回格式无效');
  }
  const parsed = parsedValue as WholeScriptAssetResult;

  // Enforce LOCATION/PROP display-name invariants before update/create/delete begins.
  const displayNameNormalizationCost = await normalizeChineseDisplayNames(parsed, userId, model);

  // 音色：对角色 suggested_voices 做三级文件名校验（voiceManifest 在 prompt 构造前已加载；
  // 防止 AI 篡改文件名 → 客户端播放 404）。校验后按角色名建索引，落库时回填。
  const voicesByName = new Map<string, Array<{ file: string; desc?: string; reason?: string; gender?: string }>>();
  if (Array.isArray(parsed.characters) && parsed.characters.length > 0) {
    const validatedVoices = validateSuggestedVoices(
      {
        characters: parsed.characters.map((character) => ({
          name: typeof character?.name === 'string' ? character.name : '',
          suggested_voices: Array.isArray((character as { suggested_voices?: unknown }).suggested_voices)
            ? (character as { suggested_voices: unknown[] }).suggested_voices
            : [],
        })),
        items: [],
        environments: [],
        entities: [],
      } as unknown as ExtractedAssets,
      voiceManifest,
    );
    for (const character of validatedVoices.characters) {
      voicesByName.set(
        typeof character.name === 'string' ? character.name : '',
        Array.isArray(character.suggested_voices) ? character.suggested_voices : [],
      );
    }
  }

  const groups: Array<{ kind: 'CHARACTER' | 'LOCATION' | 'PROP'; values: ExtractedAsset[] }> = [
    {
      kind: 'CHARACTER',
      // 角色服装变体经 slugifyCostumeKey 归一 key（与单集 parseAssetExtraction 同款）；
      // suggested_voices 经 validateSuggestedVoices 三级校验后按角色名回填。
      values: Array.isArray(parsed.characters)
        ? parsed.characters.map((character) => ({
            ...character,
            costumes: parseWholeScriptCostumes((character as { costumes?: unknown }).costumes),
            suggested_voices:
              voicesByName.get(typeof character.name === 'string' ? character.name : '') ?? [],
          }))
        : [],
    },
    {
      kind: 'LOCATION',
      values: Array.isArray(parsed.locations)
        ? parsed.locations.map((location) => ({
            ...location,
            costumes: ensureWholeScriptDefaultBaseline(
              parseWholeScriptCostumes((location as { costumes?: unknown }).costumes),
              typeof location.description === 'string' ? location.description : '',
            ),
          }))
        : [],
    },
    {
      kind: 'PROP',
      values: Array.isArray(parsed.props)
        ? parsed.props.map((prop) => ({
            ...prop,
            costumes: ensureWholeScriptDefaultBaseline(
              parseWholeScriptCostumes((prop as { costumes?: unknown }).costumes),
              typeof prop.description === 'string' ? prop.description : '',
            ),
          }))
        : [],
    },
  ];

  const writeSummary = await tx(async (q) => {
    const existingByAlias = new Map<string, IndexedAsset[]>();
    const displayNameAliases = (name: string): string[] => {
      const aliases = new Set([name.trim()]);
      const latin = name.match(/[A-Za-z][A-Za-z0-9'’._\- ]*[A-Za-z0-9]/gu)?.[0]
        ?.trim().replace(/[（(]+$/u, '').trim();
      const han = name.match(/[\u3400-\u9fff][\u3400-\u9fff· ]*/gu)?.[0]
        ?.trim();
      if (latin) aliases.add(latin);
      if (han) aliases.add(han);
      return Array.from(aliases).filter(Boolean);
    };
    const aliasKey = (kind: string, alias: string): string =>
      `${kind}:${normalizeAssetName(alias)}`;
    const registerAliases = (asset: IndexedAsset, aliases: readonly string[]): void => {
      for (const alias of aliases) {
        if (!alias.trim()) continue;
        const key = aliasKey(asset.kind, alias);
        const bucket = existingByAlias.get(key) ?? [];
        if (!bucket.includes(asset)) bucket.push(asset);
        existingByAlias.set(key, bucket);
      }
    };
    const unregisterAsset = (asset: IndexedAsset): void => {
      for (const [key, bucket] of existingByAlias) {
        const next = bucket.filter((candidate) => candidate !== asset);
        if (next.length > 0) existingByAlias.set(key, next);
        else existingByAlias.delete(key);
      }
    };
    for (const asset of existing) {
      const metadataAliases = Array.isArray(asset.metadata?.sourceNames)
        ? asset.metadata.sourceNames.filter((name): name is string => typeof name === 'string')
        : [];
      registerAliases(asset, [...displayNameAliases(asset.name), ...metadataAliases]);
    }

    let created = 0;
    let normalized = 0;
    const merged = 0;
    let totalDetected = 0;
    for (const group of groups) {
      for (const asset of group.values) {
        const name = typeof asset?.name === 'string' ? asset.name.trim() : '';
        if (!name) continue;
        totalDetected += 1;
        const sourceNames = Array.isArray(asset.source_names)
          ? Array.from(new Set(asset.source_names.filter((value): value is string => typeof value === 'string')
              .map((value) => value.trim()).filter(Boolean)))
          : [];
        const aliases = [name, ...sourceNames];
        // 角色音色：suggested_voices → voiceTrait（首个 desc）+ metadata.suggested_voices/confirmed_voice。
        const suggestedVoices = group.kind === 'CHARACTER' && Array.isArray(asset.suggested_voices)
          ? asset.suggested_voices.filter((v) => v && typeof v.file === 'string')
          : [];
        const voiceTrait = suggestedVoices.length > 0 && suggestedVoices[0]?.desc
          ? suggestedVoices[0].desc
          : null;
        const voiceMeta: Record<string, unknown> = suggestedVoices.length > 0
          ? {
              suggested_voices: suggestedVoices.map((v) => ({ file: v.file, desc: v.desc ?? '', gender: v.gender ?? '' })),
              confirmed_voice: { file: suggestedVoices[0].file, desc: suggestedVoices[0].desc ?? '', gender: suggestedVoices[0].gender ?? '' },
            }
          : {};
        const matches = Array.from(new Set(
          aliases.flatMap((alias) => existingByAlias.get(aliasKey(group.kind, alias)) ?? []),
        ));
        const reusable = matches.find((candidate) => shouldProtectAssetFromDeletion(candidate))
          ?? matches.find((candidate) => candidate.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())
          ?? matches[0];
        if (reusable) {
          const currentMetadata = reusable.metadata && typeof reusable.metadata === 'object'
            ? reusable.metadata
            : {};
          const normalizedDisplayName = group.kind !== 'CHARACTER'
            && /[一-鿿]/.test(name)
            && reusable.name.trim().toLocaleLowerCase() !== name.toLocaleLowerCase()
            ? name
            : reusable.name;
          const mergedSourceNames = Array.from(new Set([
            ...(Array.isArray(currentMetadata.sourceNames)
              ? currentMetadata.sourceNames.filter((value): value is string => typeof value === 'string')
              : []),
            ...sourceNames,
            ...matches.map((candidate) => candidate.name),
            ...matches.flatMap((candidate) => Array.isArray(candidate.metadata?.sourceNames)
              ? candidate.metadata.sourceNames.filter((value): value is string => typeof value === 'string')
              : []),
          ].map((value) => value.trim()).filter((value) =>
            value && value.toLocaleLowerCase() !== normalizedDisplayName.toLocaleLowerCase()),
          ));
          const nextMetadata = {
            ...currentMetadata,
            sourceNames: mergedSourceNames,
            ...voiceMeta,
            // 不覆盖用户已确认绑定的音色
            ...(currentMetadata.confirmed_voice ? { confirmed_voice: currentMetadata.confirmed_voice } : {}),
          };
          await updateAssetIdentityInTransaction(
            q,
            reusable.id,
            normalizedDisplayName,
            nextMetadata,
          );
          if (normalizedDisplayName !== reusable.name) normalized += 1;

          unregisterAsset(reusable);
          reusable.name = normalizedDisplayName;
          reusable.metadata = nextMetadata;
          registerAliases(reusable, [
            ...displayNameAliases(normalizedDisplayName),
            ...mergedSourceNames,
          ]);

          // 变体（角色/物品/环境）：把本次 AI 提取的 costumes 合并进已有资产（保留已有
          // 变体图片/用户编辑，仅合并元数据）。这是「重跑整剧提取补全已有资产变体」的关键路径。
          if (asset.costumes && asset.costumes.length > 0) {
            const mergedCostumes = mergeCostumeMetadataPreservingImages(
              reusable.costumes,
              asset.costumes as unknown as readonly Record<string, unknown>[],
              reusable.imageUrl,
            );
            await q.query(
              'UPDATE assets SET costumes = $1::jsonb, "updatedAt" = NOW() WHERE id = $2',
              [JSON.stringify(mergedCostumes), reusable.id],
            );
            reusable.costumes = mergedCostumes;
          }

          // 角色音色：补全 voiceTrait 列（不覆盖已有）；metadata 的 suggested_voices/confirmed_voice
          // 已随 nextMetadata 写入。这是「重跑整剧提取补全已有资产音色」的关键路径。
          if (group.kind === 'CHARACTER' && !reusable.voiceTrait && voiceTrait) {
            await q.query(
              'UPDATE assets SET "voiceTrait" = $1, "updatedAt" = NOW() WHERE id = $2',
              [voiceTrait, reusable.id],
            );
            reusable.voiceTrait = voiceTrait;
          }

          // Add/update only: never delete a duplicate. Existing assets may own
          // costumes and image revisions even when their imageUrl is currently null.
          continue;
        }
        const metadata = {
          source: 'whole-script-ai-split',
          extracted: true,
          wholeScript: true,
          ...(sourceNames.length > 0 ? { sourceNames } : {}),
          ...voiceMeta,
        };
        const createdRecord = await createAssetInTransaction(
          q,
          {
            projectId,
            kind: group.kind,
            name,
            description: typeof asset.description === 'string' ? asset.description.trim() : '',
            metadata,
          },
          asset.costumes,
          group.kind === 'CHARACTER' ? voiceTrait : null,
        );
        registerAliases(createdRecord, aliases);
        created += 1;
      }
    }
    return { created, normalized, merged, totalDetected };
  });

  return {
    created: writeSummary.created,
    totalDetected: writeSummary.totalDetected,
    cost: (typeof result.cost === 'number' ? result.cost : 0) + displayNameNormalizationCost,
    normalized: writeSummary.normalized,
    merged: writeSummary.merged,
  };
}
