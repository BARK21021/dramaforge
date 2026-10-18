// Project contract — frozen. All other modules depend on these types.
// See docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice-p3.md Task 1.
//
// 列名/字段对齐 packages/server/src/infra/migrations/0001-init.sql 的 projects 表
// （Prisma 遗留：驼峰列名，SQL 需加双引号，e.g. "userId"/"createdAt"）。
//
// ProjectStatus / ProjectCategory 枚举对齐 app1 src/app/workspace/page.tsx 的
// STATUS_LABELS / CATEGORIES 显示映射（只读 reference，未改 app1）。

import { z } from 'zod';

// ============================================================
// 枚举
// ============================================================

/**
 * 项目状态枚举。
 *
 * 核对来源：
 *   - 0001-init.sql 行 124：`status TEXT NOT NULL DEFAULT 'DRAFT'`
 *     （行内注释只列了 DRAFT/PROCESSING/COMPLETED，但 app1 实际使用更细粒度）
 *   - app1/src/app/workspace/page.tsx 行 91-98 STATUS_LABELS 完整键集：
 *     DRAFT / SCREENWRITING / ASSET_DESIGN / STORYBOARD / PRODUCTION / COMPLETE
 *
 * implementer 核对到的全部值（取并集，以 app1 实际使用为准）：
 *   'DRAFT' | 'SCREENWRITING' | 'ASSET_DESIGN' | 'STORYBOARD' | 'PRODUCTION' | 'COMPLETE'
 *
 * 注：DB 列为 TEXT，不强制 CHECK 约束；此处的联合类型只是契约层枚举，
 * 历史数据可能出现其他值，消费方需做防御性 fallback。
 */
export type ProjectStatus =
  | 'DRAFT'
  | 'SCREENWRITING'
  | 'ASSET_DESIGN'
  | 'STORYBOARD'
  | 'PRODUCTION'
  | 'COMPLETE';

/**
 * 项目分类枚举（0001-init.sql 行 515：`"category" TEXT NOT NULL DEFAULT 'DOMESTIC'`）。
 *
 * 对齐 app1/src/app/workspace/page.tsx 行 84-88 CATEGORIES：
 *   ORIGINAL / DOMESTIC / OVERSEAS
 */
export type ProjectCategory = 'ORIGINAL' | 'DOMESTIC' | 'OVERSEAS';

/**
 * 项目内容来源。不同项目分类只允许其中两个值，组合约束由
 * createProjectSchema 统一校验，避免前后端各自维护一套规则。
 */
export type ProjectSourceMode =
  | 'VIDEO_REWRITE'
  | 'LOCAL_SCRIPT'
  | 'EPISODE_INPUT'
  | 'ORIGINAL_PROJECT'
  | 'REFERENCE_VIDEO'
  | 'OUTLINE_TO_SCRIPT';
/** 国内直出与海外转绘在创建时锁定的画面风格。 */
export type ProjectArtStyle = 'realistic' | '2d_anime' | '3d_anime';

/** 项目级画风锁。兼容 app1 的 anime2d/anime3d 历史键。 */
export interface ProjectArtStylePreset {
  key: ProjectArtStyle;
  label: string;
  assetImageKey: string;
  promptZh: string;
  promptEn: string;
  /**
   * 生图阶段前置注入的五维风格锁定段（画风/人物/光影/材质/调色），
   * 对齐 app1 src/core/ai/style-presets.ts 的 buildProjectStyleLockSection。
   * 文本类调用方（提取/分镜/串生成）仍用 promptZh/promptEn，本字段仅供生图强约束。
   */
  lockContentZh: string;
  lockContentEn: string;
}

const PROJECT_ART_STYLE_PRESETS: Record<ProjectArtStyle, ProjectArtStylePreset> = {
  realistic: {
    key: 'realistic',
    label: '电影级写实',
    assetImageKey: '电影级写实风格',
    promptZh: '电影级写实风格，细腻有质感的皮肤表现，自然光影，摄影级画质，35mm 胶片质感，电影级调色，人物面部特征精致自然，服装材质写实，环境光影符合物理规律（虚构影视角色）',
    promptEn: 'Cinematic photoreal style, detailed skin texture, natural lighting, photographic quality, 35mm film aesthetic, cinematic color grading, refined facial features, realistic fabric materials, physically accurate environmental lighting (fictional film characters)',
    lockContentZh: '## 项目风格锁定：电影级写实\n本项目全局风格锁定为「电影级写实」（虚构影视角色，与任何真实人物无关），所有生成内容必须严格遵循以下约束：\n- 画风：电影级写实质感，摄影级画质，禁止动漫/卡通/插画/3D渲染/CGI风格，必须为真人摄影级写实（不得出现3D仿真人、CG建模质感）\n- 人物：细腻有质感的皮肤表现、精致的面部特征、电影化的角色比例\n- 光影：自然光影，符合物理规律的光照、阴影、反射，35mm 胶片质感\n- 材质：服装、道具、环境材质写实（棉麻/金属/木材/石材等真实质感）\n- 调色：电影级调色，肤色还原准确，禁止过度饱和或风格化色调',
    lockContentEn: '## Project Style Lock: Cinematic Realistic\nThe project global style is locked to "Cinematic Realistic" (fictional film characters, unrelated to any real person). All generated content must strictly follow these constraints:\n- Art style: Photorealistic cinematic quality, photographic realism, NO anime/cartoon/illustration/3D-render/CGI styles — must be live-action photographic realism (no 3D simulated humans, no CG-modeled skin)\n- Characters: Detailed cinematic skin texture, refined facial features, film-grade character proportions\n- Lighting: Natural lighting, physically accurate illumination, shadows, reflections, 35mm film aesthetic\n- Materials: Realistic fabric, prop, and environment materials (cotton/metal/wood/stone textures)\n- Color grading: Cinematic color grading, accurate skin tones, NO oversaturated or stylized colors',
  },
  '2d_anime': {
    key: '2d_anime',
    label: '2D 动漫',
    assetImageKey: '二次元动漫风格',
    promptZh: '2D 动漫风格，日系动画画风，赛璐璐上色，清晰线稿，扁平化色彩，大眼角色特征，动漫式光影，色彩鲜明饱和，手绘质感',
    promptEn: '2D anime style, Japanese animation aesthetic, cel shading, clean line art, flat colors, large expressive eyes, anime-style lighting, vibrant saturated colors, hand-drawn texture',
    lockContentZh: '## 项目风格锁定：2D动漫风\n本项目全局风格锁定为「2D动漫风」，所有生成内容必须严格遵循以下约束：\n- 画风：2D 日系动漫风格，赛璐璐上色，清晰线稿，禁止写实/3D 风格\n- 人物：大眼角色特征，简化面部细节，动漫式比例，表情夸张生动\n- 光影：扁平化光影，动漫式高光与阴影，色彩鲜明饱和\n- 材质：简化材质表现，色彩块面化，无真实纹理细节\n- 调色：高饱和度，对比鲜明，动漫式色彩方案',
    lockContentEn: '## Project Style Lock: 2D Anime\nThe project global style is locked to "2D Anime". All generated content must strictly follow these constraints:\n- Art style: 2D Japanese anime style, cel shading, clean line art, NO realistic/3D styles\n- Characters: Large expressive eyes, simplified facial details, anime proportions, vivid expressions\n- Lighting: Flat lighting, anime-style highlights and shadows, vibrant saturated colors\n- Materials: Simplified material representation, block colors, no realistic texture details\n- Color grading: High saturation, strong contrast, anime color palette',
  },
  '3d_anime': {
    key: '3d_anime',
    label: '3D 动漫',
    assetImageKey: '3D动漫风格',
    promptZh: '3D 动漫风格，皮克斯/迪士尼画风，3D 渲染，柔和光影，圆润角色建模，次表面散射皮肤，卡通材质，景深效果，高级渲染质感',
    promptEn: '3D anime style, Pixar/Disney aesthetic, 3D rendering, soft lighting, rounded character modeling, subsurface scattering skin, cartoon materials, depth of field, premium render quality',
    lockContentZh: '## 项目风格锁定：3D动漫风\n本项目全局风格锁定为「3D动漫风」，所有生成内容必须严格遵循以下约束：\n- 画风：3D 动漫风格，皮克斯/迪士尼画风，3D 渲染质感，禁止纯 2D 或纯写实\n- 人物：圆润角色建模，柔和面部特征，次表面散射皮肤效果，3D 卡通比例\n- 光影：柔和全局光照，3D 渲染光影，景深效果，体积光\n- 材质：卡通材质，柔和高光，3D 渲染材质质感\n- 调色：温暖明快色调，3D 动漫标准调色，高级渲染质感',
    lockContentEn: '## Project Style Lock: 3D Anime\nThe project global style is locked to "3D Anime". All generated content must strictly follow these constraints:\n- Art style: 3D anime style, Pixar/Disney aesthetic, 3D render quality, NO pure 2D or pure realistic styles\n- Characters: Rounded character modeling, soft facial features, subsurface scattering skin, 3D cartoon proportions\n- Lighting: Soft global illumination, 3D rendered lighting, depth of field, volumetric light\n- Materials: Cartoon materials, soft highlights, 3D rendered material quality\n- Color grading: Warm bright tones, standard 3D anime color grading, premium render quality',
  },
};

export function getProjectArtStylePreset(
  value: string | null | undefined,
): ProjectArtStylePreset | null {
  const normalized = value === 'anime2d'
    ? '2d_anime'
    : value === 'anime3d'
      ? '3d_anime'
      : value;
  return normalized && normalized in PROJECT_ART_STYLE_PRESETS
    ? PROJECT_ART_STYLE_PRESETS[normalized as ProjectArtStyle]
    : null;
}

// ============================================================
// Zod schema（前后端共享单一来源）
// ============================================================

/**
 * 创建项目输入的 Zod schema。
 *
 * POST /api/projects 的请求体校验。内容来源和转绘风格属于创建时硬约束，
 * 必须在入库前拒绝非法组合，不能让 Zod 静默剥离后由 UI 误以为已生效。
 *
 *   - title: 必填，1-100 字符
 *   - description: 可选，最长 2000 字符
 *   - category: 可选枚举，service 默认 'DOMESTIC'
 *   - sourceMode: ORIGINAL 仅 VIDEO_REWRITE/LOCAL_SCRIPT；DOMESTIC 仅
 *     EPISODE_INPUT/ORIGINAL_PROJECT；OVERSEAS 额外支持 REFERENCE_VIDEO
 *     （参考视频转绘：原片切片做 Seedance reference_video）
 *   - sourceProjectId: ORIGINAL_PROJECT 必填，所有权与剧本内容由 service 校验
 *   - artStyle: DOMESTIC/OVERSEAS 必填，ORIGINAL 禁止设置
 */
export const createProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().max(2000).optional(),
    category: z.enum(['ORIGINAL', 'DOMESTIC', 'OVERSEAS']).optional(),
    sourceMode: z
      .enum(['VIDEO_REWRITE', 'LOCAL_SCRIPT', 'EPISODE_INPUT', 'ORIGINAL_PROJECT', 'REFERENCE_VIDEO', 'OUTLINE_TO_SCRIPT'])
      .optional(),
    sourceProjectId: z.string().min(1).optional(),
    artStyle: z.enum(['realistic', '2d_anime', '3d_anime']).nullable().optional(),
    artStylePrompt: z.string().max(4000).nullable().optional(),
    novelText: z.string().nullable().optional(),
  })
  .superRefine((input, ctx) => {
    const category = input.category ?? 'DOMESTIC';
    const sourceMode =
      input.sourceMode ?? (category === 'ORIGINAL' ? 'VIDEO_REWRITE' : 'EPISODE_INPUT');

    const allowedModes =
      category === 'ORIGINAL'
        ? ['VIDEO_REWRITE', 'LOCAL_SCRIPT', 'OUTLINE_TO_SCRIPT']
        : category === 'OVERSEAS'
          ? ['EPISODE_INPUT', 'ORIGINAL_PROJECT', 'REFERENCE_VIDEO']
          : ['EPISODE_INPUT', 'ORIGINAL_PROJECT'];
    if (!allowedModes.includes(sourceMode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceMode'],
        message: `项目分类 ${category} 不支持内容来源 ${sourceMode}`,
      });
    }

    if (sourceMode === 'ORIGINAL_PROJECT' && !input.sourceProjectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceProjectId'],
        message: '调用原创整剧时必须选择源项目',
      });
    }
    if (sourceMode !== 'ORIGINAL_PROJECT' && input.sourceProjectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceProjectId'],
        message: '只有调用原创整剧时可以设置源项目',
      });
    }

    if (category !== 'ORIGINAL' && !input.artStyle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artStyle'],
        message: '国内直出和海外转绘项目必须选择画面风格',
      });
    }
    if (category === 'ORIGINAL' && input.artStyle != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artStyle'],
        message: '剧本原创项目不生成画面，不能设置画面风格',
      });
    }
    if (category === 'ORIGINAL' && input.artStylePrompt != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artStylePrompt'],
        message: '剧本原创项目不能设置画面风格提示词',
      });
    }
  });

/** 创建项目输入（zod 推断类型） */
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

// ============================================================
// DB 记录契约
// ============================================================

/**
 * 项目记录（对齐 projects 表完整字段）。
 *
 * 时间戳（createdAt/updatedAt）：DB 是 TIMESTAMPTZ，pg 返回 Date；
 * mapRow 统一转 ISO 字符串。
 *
 * JSONB 字段（scriptData/characterMapping/longVideoProgress/voiceprintMapping）：
 * 兼容对象 | string | null；消费方按需 parse。类型上声明为 unknown 让消费方
 * 自行 narrow，避免在契约层强加结构（这些字段的 shape 后续 slice 才稳定）。
 *
 * artStyle：DB TEXT，可空；app1 旧值 `realistic/2d_anime/3d_anime`，本 slice 不校验。
 * sourceProjectId：ORIGINAL 项目可引用源项目（ON DELETE SET NULL）。
 */
export interface ProjectRecord {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  category: ProjectCategory;
  status: ProjectStatus;
  version: number;
  artStyle: string | null;
  artStylePrompt: string | null;
  novelText: string | null;
  videoScriptDraft: string | null;
  scriptData: unknown;
  characterMapping: unknown;
  voiceprintMapping: unknown;
  longVideoProgress: unknown;
  sourceProjectId: string | null;
  scriptOverride: boolean;
  createdAt: string;
  updatedAt: string;
  /** 项目列表聚合字段；项目详情查询可以不返回。 */
  episodeCount?: number;
}
