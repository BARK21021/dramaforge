// ============================================================
// ③ server/domain/episode — 分集 CRUD（episodes 表）
// ============================================================
//
// 文件职责：
//   episodes 表的读写仓储（P7.1 Task 1）。支撑项目工作台的"分集列表 +
//   剧本输入"阶段。每集是 AI 分析（P7.2）的独立单元，拥有独立的 novelText
//   输入文本 + 五阶段 stageStatus。
//
//   操作：
//     1. listByProject(projectId)     — 列出项目的所有分集（sortOrder 升序）
//     2. create(projectId, input)     — 新建分集（自动分配 episodeNumber/sortOrder）
//     3. getById(id)                  — 取单集
//     4. update(id, patch)            — PATCH 白名单字段 + stageStatus 单调推进
//     5. remove(id)                   — 删分集（shots 经 FK ON DELETE CASCADE 自动清）
//     6. reorder(projectId, ids)      — 批量重排 episodeNumber/sortOrder
//
// 表结构（见 0001-init.sql episodes CREATE + 多处 ALTER 扩展列）：
//   episodes(id, "projectId" FK→projects CASCADE, "episodeNumber", title, content,
//            "contentKilo", status, "defaultVisualStyle" JSONB, scenes JSONB,
//            "emotionArc", "createdAt", "updatedAt", "videoScriptDraft",
//            "novelText", "stageStatus", "scriptData" JSONB, "sortOrder")
//   UNIQUE("projectId", "episodeNumber")
//
//   - Prisma 遗留：所有驼峰列名在 SQL 中需加双引号
//   - id 用纯 UUID genId()，不加 'ep-' 前缀（那是 app1 Prisma 习惯）
//   - shots 表 "episodeId" REFERENCES episodes(id) ON DELETE CASCADE → 删分集自动清镜头
//   - status/stageStatus/createdAt/updatedAt 让 DB DEFAULT 处理
//
// 风格对齐 domain/project/service.ts：函数式 + 末尾聚合对象，不 try/catch
// （异常 bubble 给 route 层显式 catch + handleApiError）。
// ============================================================

import { query } from '@server/infra';
import { genId } from '@shared/utils';
import type {
  CreateEpisodeInput,
  EpisodeRecord,
  EpisodeStageStatus,
  ReorderEpisodesInput,
  UpdateEpisodePatch,
} from '@shared/episode';
import {
  createEpisodeSchema,
  reorderEpisodesSchema,
  updateEpisodeSchema,
} from '@shared/episode';

/**
 * episodes 表的原始 pg 行（驼峰列名直接透传）。
 *
 * - JSONB 字段（scenes 等）：pg 默认解析为对象，也可能为 null
 * - TIMESTAMPTZ（createdAt/updatedAt）：pg 默认解析为 Date
 *
 * 模块私有，不从 barrel 导出（避免与 project.mapRow 在 domain `export *` 时撞名）。
 */
interface EpisodeRow {
  id: string;
  projectId: string;
  episodeNumber: number;
  title: string | null;
  content: string | null;
  contentKilo: number | null;
  status: string;
  defaultVisualStyle: unknown;
  scenes: unknown;
  emotionArc: string | null;
  videoScriptDraft: string | null;
  novelText: string | null;
  stageStatus: string;
  scriptData: unknown;
  sortOrder: number;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * 解析 JSONB 字段：pg 返回对象则原样用，返回字符串则 JSON.parse。
 * 兼容 mock 测试直接传对象或字符串。
 */
function parseJson<T>(v: unknown): T {
  if (typeof v === 'string') return JSON.parse(v) as T;
  return v as T;
}

/**
 * TIMESTAMPTZ → ISO 字符串；null 透传。
 * pg 默认返回 Date，mock 可能返回 Date/string/null。
 */
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * 将 pg 行映射为 EpisodeRecord 契约对象。
 *
 * - 驼峰列名直接取（episodes 表本就是驼峰）
 * - JSONB 字段经 parseJson（兼容 string|object）
 * - 时间戳转 ISO 字符串
 * - status/stageStatus 强转联合类型（DB 列是 TEXT，无 CHECK 约束）
 */
function mapRow(row: EpisodeRow): EpisodeRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    episodeNumber: row.episodeNumber,
    title: row.title,
    content: row.content,
    contentKilo: row.contentKilo,
    status: row.status as EpisodeRecord['status'],
    defaultVisualStyle: parseJson(row.defaultVisualStyle),
    scenes: parseJson(row.scenes),
    emotionArc: row.emotionArc,
    videoScriptDraft: row.videoScriptDraft,
    novelText: row.novelText,
    stageStatus: row.stageStatus as EpisodeStageStatus,
    scriptData: parseJson(row.scriptData),
    sortOrder: row.sortOrder,
    createdAt: toIsoOrNull(row.createdAt) ?? '',
    updatedAt: toIsoOrNull(row.updatedAt) ?? '',
  };
}

/** stageStatus 的流程顺序索引（input=0 … production=4）。未知值 -1。 */
function stageOrder(s: string | null | undefined): number {
  if (!s) return -1;
  return (
    ['input', 'analyzing', 'assets', 'storyboard', 'production'].indexOf(s)
  );
}

/**
 * 列出项目的所有分集。
 *
 * 按 sortOrder 升序、episodeNumber 升序兜底——对齐 app1 episodes GET 的排序
 * （app1 先 sortBy sortOrder 再 fallback episodeNumber）。
 *
 * @param projectId - 项目 ID
 * @returns 该项目的所有分集记录（已排序）
 */
export async function listByProject(
  projectId: string,
): Promise<EpisodeRecord[]> {
  const result = await query(
    `SELECT * FROM episodes WHERE "projectId" = $1 ORDER BY "sortOrder" ASC, "episodeNumber" ASC`,
    [projectId],
  );
  return result.rows.map((r) => mapRow(r as unknown as EpisodeRow));
}

/**
 * 新建分集（自动分配 episodeNumber / sortOrder）。
 *
 * episodeNumber = 当前项目 max(episodeNumber) + 1；sortOrder = episodeNumber - 1。
 * title 缺省 `第 N 集`。novelText 提供时同步落 contentKilo（千字）。status/
 * stageStatus 走 DB DEFAULT（'PENDING' / 'input'）。
 *
 * 校验：直接用 @shared/episode 的 createEpisodeSchema。校验失败抛 ZodError，
 * bubble 给 route 层 handleApiError 转 400。
 *
 * @returns 新建的 EpisodeRecord（含 DB DEFAULT 回填的 status/timestamps）
 */
export async function create(
  projectId: string,
  input: CreateEpisodeInput,
): Promise<EpisodeRecord> {
  const validated = createEpisodeSchema.parse(input);

  // 查当前最大 episodeNumber，自动分配下一集号
  const maxResult = await query(
    `SELECT "episodeNumber" FROM episodes WHERE "projectId" = $1
     ORDER BY "episodeNumber" DESC LIMIT 1`,
    [projectId],
  );
  const maxRow = maxResult.rows[0] as { episodeNumber?: number } | undefined;
  const nextNumber = (maxRow?.episodeNumber ?? 0) + 1;

  const id = genId();
  const title = validated.title?.trim() || `第 ${nextNumber} 集`;
  const novelText = validated.novelText ?? null;
  const contentKilo =
    novelText != null ? Math.ceil(novelText.length / 1000) : null;

  const result = await query(
    `INSERT INTO episodes
       (id, "projectId", "episodeNumber", "sortOrder", title, "novelText",
        content, "contentKilo")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      projectId,
      nextNumber,
      nextNumber - 1,
      title,
      novelText,
      validated.content ?? null,
      contentKilo,
    ],
  );
  return mapRow(result.rows[0] as unknown as EpisodeRow);
}

/**
 * 取单个分集（不带 shots；带 shots 的详情见 P7.2+ 工作台阶段）。
 *
 * @param id - 分集 ID
 * @returns 分集记录，不存在返回 null
 */
export async function getById(id: string): Promise<EpisodeRecord | null> {
  const result = await query(`SELECT * FROM episodes WHERE id = $1`, [id]);
  const row = result.rows[0] as unknown as EpisodeRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * 更新分集（PATCH 白名单 + stageStatus 单调推进）。
 *
 * 仅更新 patch 中出现的字段。业务规则：
 *   - stageStatus：只在目标顺序 ≥ 当前顺序时应用（防回退），否则保留当前
 *   - novelText：同步重算 contentKilo
 *   - JSONB 字段（scriptData/scenes/defaultVisualStyle）：JSON.stringify 后写
 *   - 至少刷新 updatedAt（即使无业务字段也更新时间戳）
 *
 * @param id   - 分集 ID
 * @param patch - 更新补丁（@shared/episode updateEpisodeSchema）
 * @returns 更新后的 EpisodeRecord
 * @throws Error 分集不存在（getById 返回 null）
 */
export async function update(
  id: string,
  patch: UpdateEpisodePatch,
): Promise<EpisodeRecord> {
  const validated = updateEpisodeSchema.parse(patch);

  const current = await getById(id);
  if (!current) {
    throw new Error(`分集不存在: ${id}`);
  }

  // 构建动态 SET 子句。add() 走参数化占位（$n），addLiteral() 内联 SQL 字面
  // （仅用于 NOW()，我硬编码无注入风险）。
  const fragments: string[] = [];
  const values: unknown[] = [];
  const add = (col: string, val: unknown): void => {
    fragments.push(`${col} = $${values.length + 1}`);
    values.push(val);
  };
  const addLiteral = (col: string, sql: string): void => {
    fragments.push(`${col} = ${sql}`);
  };

  if (validated.title !== undefined) {
    add('title', validated.title.trim());
  }
  if (validated.novelText !== undefined) {
    add('"novelText"', validated.novelText);
    add('"contentKilo"', Math.ceil(validated.novelText.length / 1000));
  }
  if (validated.content !== undefined) {
    add('content', validated.content);
  }
  if (validated.videoScriptDraft !== undefined) {
    add('"videoScriptDraft"', validated.videoScriptDraft);
  }
  if (validated.stageStatus !== undefined) {
    // 单调推进：目标顺序 ≥ 当前才应用，否则保留当前（防回退）
    const applied =
      stageOrder(validated.stageStatus) >= stageOrder(current.stageStatus)
        ? validated.stageStatus
        : current.stageStatus;
    add('"stageStatus"', applied);
  }
  if (validated.status !== undefined) {
    add('status', validated.status);
  }
  if (validated.emotionArc !== undefined) {
    add('"emotionArc"', validated.emotionArc);
  }
  if (validated.scriptData !== undefined) {
    add(
      '"scriptData"',
      validated.scriptData == null ? null : JSON.stringify(validated.scriptData),
    );
  }
  if (validated.scenes !== undefined) {
    add('scenes', validated.scenes == null ? null : JSON.stringify(validated.scenes));
  }
  if (validated.defaultVisualStyle !== undefined) {
    add(
      '"defaultVisualStyle"',
      validated.defaultVisualStyle == null
        ? null
        : JSON.stringify(validated.defaultVisualStyle),
    );
  }
  if (validated.sortOrder !== undefined) {
    add('"sortOrder"', validated.sortOrder);
  }
  if (validated.episodeNumber !== undefined) {
    add('"episodeNumber"', validated.episodeNumber);
  }

  // 总是刷新 updatedAt（NOW() 字面内联，DB 算，无需 JS Date 参数）
  addLiteral('"updatedAt"', 'NOW()');

  const setClause = fragments.join(', ');
  const result = await query(
    `UPDATE episodes SET ${setClause} WHERE id = $${values.length + 1} RETURNING *`,
    [...values, id],
  );
  return mapRow(result.rows[0] as unknown as EpisodeRow);
}

/**
 * 删除分集（shots 经 FK ON DELETE CASCADE 自动清，无需手动）。
 *
 * @param id - 分集 ID
 */
export async function remove(id: string): Promise<void> {
  await query(`DELETE FROM episodes WHERE id = $1`, [id]);
}

/**
 * 闭环守卫：复位卡在 analyzing 超时（>35min，越过 inline task 的 30min timeoutAt
 * + 5min 余量）的集。
 *
 * 对齐 renderJobRepo.sweepStuckShots 范式：fire-and-forget 后台 runner 被 web 重启
 * 杀掉时，episode 会永久留在 stageStatus='analyzing'（split/route.ts:45 的 EPISODE_BUSY
 * 409 会误拦后续操作）。本 sweep 每 60s 由 ai-worker 借宿调度，把这些孤儿复位回
 * input/PENDING 让用户可重试。幂等：WHERE 仅匹配 analyzing，不会动其他阶段。
 *
 * 注意：不能用 episodeRepo.update({stageStatus:'input'}) 复位——update() 的单调推进
 * 守卫会把 analyzing→input 的回退静默忽略（applied=current）。必须走裸 SQL 绕过守卫，
 * 这是显式的「复位」语义，不是「推进」语义。
 *
 * @returns 本次复位的行数
 */
export async function sweepStuckAnalyzing(): Promise<number> {
  const { rows } = await query(
    `UPDATE episodes
        SET "stageStatus"='input', status='PENDING', "updatedAt"=NOW()
      WHERE "stageStatus"='analyzing'
        AND "updatedAt" < NOW() - INTERVAL '35 minutes'
      RETURNING id`,
  );
  return rows.length;
}

/**
 * 单集复位：把指定 episode 从 analyzing 复位回 input/PENDING（失败路径专用）。
 *
 * 与 sweepStuckAnalyzing 同语义但按 id 精确命中。WHERE 守卫 "stageStatus"='analyzing'
 * 保证：若 runner 失败前 episode 已被并发推进到 assets（成功路径竞态），本调用不会
 * 覆盖成功结果（幂等、零误伤）。绕过 update() 单调推进守卫的理由同 sweepStuckAnalyzing。
 */
export async function resetAnalyzingToInput(episodeId: string): Promise<void> {
  await query(
    `UPDATE episodes
        SET "stageStatus"='input', status='PENDING', "updatedAt"=NOW()
      WHERE id=$1 AND "stageStatus"='analyzing'`,
    [episodeId],
  );
}

/**
 * 批量重排项目的分集顺序。
 *
 * 按传入 episodeIds 数组顺序重写 episodeNumber（从 1 起）和 sortOrder（从 0 起）。
 * 校验：reorderEpisodesSchema（episodeIds 非空数组）。
 *
 * @param projectId   - 项目 ID（每条 UPDATE 限定 projectId，防越权改他集）
 * @param input       - { episodeIds: string[] }
 * @returns 重排后的全部分集列表（已排序）
 */
export async function reorder(
  projectId: string,
  input: ReorderEpisodesInput,
): Promise<EpisodeRecord[]> {
  const validated = reorderEpisodesSchema.parse(input);

  // 逐条更新（条数少，无需事务；projectId 限定防越权）
  await Promise.all(
    validated.episodeIds.map((eid, idx) =>
      query(
        `UPDATE episodes SET "episodeNumber" = $1, "sortOrder" = $2
         WHERE id = $3 AND "projectId" = $4`,
        [idx + 1, idx, eid, projectId],
      ),
    ),
  );

  return listByProject(projectId);
}

/**
 * 分集仓储对象（聚合所有函数，便于整体注入/mock）。
 * 对齐 projectRepo / renderJobRepo 末尾聚合对象风格。
 */
export const episodeRepo = {
  listByProject,
  create,
  getById,
  update,
  remove,
  reorder,
  sweepStuckAnalyzing,
  resetAnalyzingToInput,
};
