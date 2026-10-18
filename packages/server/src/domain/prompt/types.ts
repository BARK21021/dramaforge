// ============================================================
// prompt 子域共享类型（P7.2-T1）
// ============================================================
// 从 app1 src/core/types/entities.ts 移植的最小类型。
// 仅放 prompt 模板构建/解析需要的类型；完整 AssetRecord/ShotRecord 等
// 待将来 asset/storyboard domain 移植时各自建类型，届时把 CostumeVariant 迁过去。
// ============================================================

/**
 * 角色造型变体。
 * - costume 型（默认）：同一角色换不同服装/配饰，五官/脸型/身高/体型跨变体必须一致。
 * - period 型：同一角色在不同时间段（如小时候/成年/老年），允许年龄/身材/五官随时段自然演变。
 * 由 generate-image/route.ts 在 costumeKey 命中时注入生图 prompt。
 */
export interface CostumeVariant {
  /** 稳定机器 id：default | formal | battle-damaged | label slug */
  key: string;
  /**
   * 全局稳定编号（如 "Leo-03"）：资产生成时按 `{资产slug}-{数组序号:02d}` 分配并落库。
   * 引用对齐/审计/提示词标注一律用 code，不再靠名称匹配。缺失时按同规则现算（幂等）。
   */
  code?: string;
  /** 人类可读 label：便装/正装/战损/小时候/成年 */
  label: string;
  /** 该造型的外观描述（生图时替换基础 description） */
  description: string;
  /** 该造型的视觉锁定（生图时与基础 identityLock 合并） */
  identityLock: string[];
  /** 变体图 URL（生成前为 null）。default 变体与顶层 imageUrl 保持同步 */
  imageUrl: string | null;
  /** 该造型出现的场景 id 列表 */
  coverageScenes: string[];
  /**
   * 变体类型。costume=换装（保五官，默认）；period=同人物不同时段（允许年龄/身材演变）。
   * 缺省视为 costume（向后兼容存量数据）。
   */
  variantType?: 'costume' | 'period';
}
