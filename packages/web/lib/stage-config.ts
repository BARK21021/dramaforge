// ============================================================
// 阶段配置（共享） — page.tsx 与 EpisodeWorkspace.tsx 共用
// ============================================================
//
// @file stage-config.ts
// @description 提取自 page.tsx 的阶段定义，避免 page.tsx ↔ EpisodeWorkspace
//              之间的循环依赖。包含 5 阶段配置、状态映射函数、状态标签。
//
// 落地位置（dramaforge）：packages/web/lib/stage-config.ts
// 理由：纯 lib，任何位置（hooks/、components/、app/...）都能引，
// 避免 components/stage-config.ts 被 hooks 引入造成非常规依赖方向
// （recon 批2 §5.8）。
// ============================================================

/**
 * 阶段配置定义
 *
 * 定义项目的 5 个工作阶段，每个阶段包含：
 * - key: 阶段唯一标识符
 * - label: 阶段显示名称
 * - desc: 阶段简短描述（卡片副标题，凸显"模块"感而非流程节点）
 * - icon: 阶段图标的 SVG 路径
 */
export const STAGES = [
  { key: "input", label: "输入", desc: "导入剧本或视频", icon: "M3 5h18M3 12h18M3 19h12" },
  { key: "analyzing", label: "编剧分析", desc: "解析场景与角色", icon: "M7 4v16M17 4v16M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18" },
  { key: "assets", label: "资产设定", desc: "角色·场景·物品", icon: "M12 2l2.4 7.4H22l-6 4.6 2.3 7.4L12 16.8 5.7 21.4 8 14 2 9.4h7.6L12 2z" },
  { key: "storyboard", label: "分镜设计", desc: "镜头与分组规划", icon: "M3 3h18v18H3zM9 3v18M15 3v18" },
  { key: "production", label: "生产制作", desc: "视频合成与导出", icon: "M23 7l-7 5 7 5V7zM1 5h15v14H1z" },
] as const;

/** 阶段键类型，从 STAGES 配置中提取 */
export type StageKey = (typeof STAGES)[number]["key"];

/**
 * 获取阶段在流程中的顺序索引
 *
 * @param key - 阶段键
 * @returns 阶段索引（0-4）
 */
export function stageOrder(key: StageKey): number {
  return STAGES.findIndex((s) => s.key === key);
}

/**
 * 根据分集的 stageStatus 推导初始 viewStage
 * - "complete" → "production"（已完成的集默认看制作阶段）
 * - 其他合法阶段值 → 原样返回
 * - 未知值 → "input"
 */
export function deriveStageFromEpisode(stageStatus: string | undefined | null): StageKey {
  if (!stageStatus) return "input";
  if (stageStatus === "complete") return "production";
  if (STAGES.some((s) => s.key === stageStatus)) return stageStatus as StageKey;
  return "input";
}

/**
 * 项目状态显示标签映射
 */
export const STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿", SCREENWRITING: "编剧中", ASSET_DESIGN: "资产设定",
  STORYBOARD: "分镜设计", PRODUCTION: "生产中", COMPLETE: "已完成",
};
