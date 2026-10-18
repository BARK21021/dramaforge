// Episode contract — frozen. All other modules depend on these types.
// 见 docs/superpowers/plans/2026-07-19-cs-ui-vertical-slice-p7-1-episodes.md
//
// 列名/字段对齐 packages/server/src/infra/migrations/0001-init.sql 的 episodes 表
// （Prisma 遗留：驼峰列名，SQL 需加双引号，e.g. "projectId"/"createdAt"/"novelText"）。
//
// 字段语义对齐 app1 src/app/api/projects/[projectId]/episodes/route.ts 的创建逻辑
// 与 [episodeId]/route.ts 的 PATCH 白名单（只读 reference，未改 app1）：
//   - novelText：分集独立输入文本（小说/剧本原文）
//   - content：完整分集剧本内容
//   - contentKilo：novelText 字数（千字），写入 novelText 时同步重算
//   - stageStatus：五阶段工作流状态（input→analyzing→assets→storyboard→production）
//   - scriptData/scenes/defaultVisualStyle：JSONB，后续 AI 分析阶段写入（P7.2+）

import { z } from 'zod';

// ============================================================
// 枚举
// ============================================================

/**
 * 分集状态枚举。
 *
 * 核对来源：
 *   - 0001-init.sql episodes 表：`status TEXT NOT NULL DEFAULT 'PENDING'`
 *     （行内注释列了 PENDING|ANALYZING|COMPLETED|CONFIRMED）
 *   - app1 [episodeId]/route.ts VALID_STATUSES：PENDING|ANALYZING|COMPLETED|FAILED
 *
 * 取并集：PENDING|ANALYZING|COMPLETED|CONFIRMED|FAILED。DB 列是 TEXT 无 CHECK
 * 约束，历史数据可能出现其他值，消费方需做防御性 fallback。
 */
export type EpisodeStatus =
  | 'PENDING'
  | 'ANALYZING'
  | 'COMPLETED'
  | 'CONFIRMED'
  | 'FAILED';

/**
 * 分集五阶段工作流状态（对齐 app1 stage-config.ts 的 STAGES 顺序）。
 *
 *   input → analyzing → assets → storyboard → production
 *
 * update() 实施单调推进：只能前进不能回退（与 app1 getStageOrder 比较逻辑一致），
 * 防止后续阶段误覆盖回前序阶段。
 */
export type EpisodeStageStatus =
  | 'input'
  | 'analyzing'
  | 'assets'
  | 'storyboard'
  | 'production';

// ============================================================
// Zod schema（前后端共享单一来源）
// ============================================================

/**
 * 创建分集输入的 Zod schema。
 *
 * POST /api/projects/[id]/episodes 的请求体校验。episodeNumber/sortOrder 由
 * service 自动分配（max+1），不在输入里。status/stageStatus 走 DB DEFAULT
 * （'PENDING' / 'input'）。
 *
 *   - title：可选，1-100 字符；缺省时 service 填 `第 N 集`
 *   - novelText：可选，分集输入文本；写入时同步算 contentKilo
 *   - content：可选，完整剧本内容
 */
export const createEpisodeSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  novelText: z.string().optional(),
  content: z.string().optional(),
});

/** 创建分集输入（zod 推断类型） */
export type CreateEpisodeInput = z.infer<typeof createEpisodeSchema>;

/**
 * 更新分集输入的 Zod schema（PATCH 白名单）。
 *
 * 对齐 app1 [episodeId]/route.ts 的 PATCH 允许字段。所有字段可选——
 * 缺省 = 不更新。JSONB 字段（scriptData/scenes/defaultVisualStyle）声明为
 * unknown 透传，shape 由后续 AI 阶段（P7.2+）稳定。
 *
 *   - stageStatus/status：枚举校验；service 层再加单调推进业务规则
 *   - novelText：写入时同步重算 contentKilo
 *   - sortOrder/episodeNumber：拖拽排序 / 集号调整
 */
export const updateEpisodeSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  novelText: z.string().optional(),
  content: z.string().optional(),
  videoScriptDraft: z.string().optional(),
  stageStatus: z
    .enum(['input', 'analyzing', 'assets', 'storyboard', 'production'])
    .optional(),
  status: z
    .enum(['PENDING', 'ANALYZING', 'COMPLETED', 'CONFIRMED', 'FAILED'])
    .optional(),
  scriptData: z.unknown().optional(),
  scenes: z.unknown().optional(),
  defaultVisualStyle: z.unknown().optional(),
  emotionArc: z.string().optional(),
  sortOrder: z.number().int().optional(),
  episodeNumber: z.number().int().optional(),
});

/** 更新分集输入（zod 推断类型） */
export type UpdateEpisodePatch = z.infer<typeof updateEpisodeSchema>;

/**
 * 批量重排分集的 Zod schema。
 *
 * POST /api/projects/[id]/episodes?reorder=1 的请求体。按数组顺序重写
 * episodeNumber（从 1 起）和 sortOrder（从 0 起）。
 */
export const reorderEpisodesSchema = z.object({
  episodeIds: z.array(z.string().min(1)).min(1),
});

/** 批量重排输入（zod 推断类型） */
export type ReorderEpisodesInput = z.infer<typeof reorderEpisodesSchema>;

// ============================================================
// DB 记录契约
// ============================================================

/**
 * 分集记录（对齐 episodes 表完整字段）。
 *
 * 时间戳（createdAt/updatedAt）：DB 是 TIMESTAMPTZ，pg 返回 Date；
 * mapRow 统一转 ISO 字符串。
 *
 * JSONB 字段（defaultVisualStyle/scenes/scriptData）：兼容对象 | string | null；
 * 类型声明为 unknown 让消费方自行 narrow（shape 后续 slice 才稳定）。
 */
export interface EpisodeRecord {
  id: string;
  projectId: string;
  episodeNumber: number;
  title: string | null;
  content: string | null;
  contentKilo: number | null;
  status: EpisodeStatus;
  defaultVisualStyle: unknown;
  scenes: unknown;
  emotionArc: string | null;
  videoScriptDraft: string | null;
  novelText: string | null;
  stageStatus: EpisodeStageStatus;
  scriptData: unknown;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
