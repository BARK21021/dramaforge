// ============================================================
// ③ server/domain/project — 项目 CRUD（projects 表）
// ============================================================
//
// 文件职责：
//   projects 表的读写仓储。当前 slice（P3 Task 1）只实现项目列表页所需的
//   两个操作：
//     1. listByUser(userId) — 列出用户的所有项目（按 updatedAt desc）
//     2. create(userId, input) — 创建新项目（仅落核心字段）
//
//   其他操作（getById/update/delete/lock 乐观锁等）留给后续 slice。
//
// 表结构（见 0001-init.sql projects 表 + 多处 ALTER 扩展列）：
//   projects(id, "userId", title, description, "novelText", "scriptData",
//            "artStyle", "artStylePrompt", status, version,
//            "createdAt", "updatedAt", "videoScriptDraft",
//            "voiceprintMapping", "characterMapping", "longVideoProgress",
//            "category", "sourceProjectId", "scriptOverride")
//
//   - Prisma 遗留：所有驼峰列名在 SQL 中需加双引号（e.g. "userId"/"createdAt"）
//   - id 用纯 UUID genId()，不加 'proj-' 前缀（那是 app1 Prisma 习惯）
//   - status/version/createdAt/updatedAt 让 DB DEFAULT 处理，INSERT 不显式写
//
// 风格对齐 task/render-job-repo.ts：函数式 + 末尾聚合对象，不 try/catch
// （异常 bubble 给 route 层 handleApiError 处理）。
// ============================================================

import { createHash } from 'node:crypto';
import { query, tx } from '@server/infra';
import { normalizeProjectScriptForHash } from '@shared/project-script-snapshot';
import { genId } from '@shared/utils';
import type {
  CreateProjectInput,
  ProjectCategory,
  ProjectRecord,
  ProjectSourceMode,
} from '@shared/project';
import { createProjectSchema } from '@shared/project';

/**
 * 创建项目时依赖数据库才能判断的业务校验错误。
 * route 将该错误稳定映射为 400，避免把“源项目不可用”误报成服务器 500。
 */
export class ProjectValidationError extends Error {
  readonly code = 'PROJECT_VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

/**
 * projects 表的原始 pg 行（驼峰列名直接透传）。
 *
 * - JSONB 字段（scriptData 等）：pg 默认解析为对象，也可能为 null
 * - TIMESTAMPTZ（createdAt/updatedAt）：pg 默认解析为 Date
 */
export interface ProjectRow {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  category: ProjectCategory;
  status: string;
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
  createdAt: unknown;
  updatedAt: unknown;
  episodeCount?: number | string;
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
 * 将 pg 行映射为 ProjectRecord 契约对象。
 *
 * - 驼峰列名直接取（projects 表本就是驼峰，无需转换）
 * - JSONB 字段透传给 parseJson（兼容 string|object）
 * - 时间戳转 ISO 字符串
 * - status/category 强转为联合类型（DB 列是 TEXT，无 CHECK 约束）
 */
export function mapRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    category: row.category as ProjectCategory,
    status: row.status as ProjectRecord['status'],
    version: row.version,
    artStyle: row.artStyle,
    artStylePrompt: row.artStylePrompt,
    novelText: row.novelText,
    videoScriptDraft: row.videoScriptDraft,
    scriptData: parseJson(row.scriptData),
    characterMapping: parseJson(row.characterMapping),
    voiceprintMapping: parseJson(row.voiceprintMapping),
    longVideoProgress: parseJson(row.longVideoProgress),
    sourceProjectId: row.sourceProjectId,
    scriptOverride: row.scriptOverride,
    createdAt: toIsoOrNull(row.createdAt) ?? '',
    updatedAt: toIsoOrNull(row.updatedAt) ?? '',
    ...(row.episodeCount !== undefined
      ? { episodeCount: Math.max(0, Number(row.episodeCount) || 0) }
      : {}),
  };
}

/**
 * 列出用户的所有项目。
 *
 * 不过滤 status（草稿/完成/生产中均返回，UI 自行展示状态徽章）。
 * 按 "updatedAt" DESC 排序——对齐 app1 项目列表顺序。
 *
 * @param userId - 用户 ID
 * @returns 该用户的所有项目记录（按 updatedAt 降序）
 */
export async function listByUser(userId: string): Promise<ProjectRecord[]> {
  const result = await query(
    `SELECT p.*, COUNT(e.id)::int AS "episodeCount"
       FROM projects p
       LEFT JOIN episodes e ON e."projectId" = p.id
      WHERE p."userId" = $1
      GROUP BY p.id
      ORDER BY p."updatedAt" DESC`,
    [userId],
  );
  return result.rows.map((r) => mapRow(r as unknown as ProjectRow));
}

/**
 * 创建新项目。
 *
 * 落核心字段及创建时不可丢失的来源元数据；status/version/createdAt/
 * updatedAt 仍让 DB DEFAULT 处理（'DRAFT' / 1 / NOW() / NOW()）。
 *
 * 校验：直接用 shared/project.ts 的 createProjectSchema（前后端单一来源）。
 * 校验失败抛 ZodError，bubble 给 route 层 handleApiError 转 400。
 *
 * @param userId - 用户 ID（从 session 取，不信任客户端传入）
 * @param input  - 创建输入（包含内容来源、源项目和海外风格硬约束）
 * @returns 新建的 ProjectRecord（含 DB DEFAULT 回填的 status/version/timestamps）
 */
export async function create(
  userId: string,
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const validated = createProjectSchema.parse(input);

  const category = validated.category ?? 'DOMESTIC';
  const sourceMode: ProjectSourceMode =
    validated.sourceMode ?? (category === 'ORIGINAL' ? 'VIDEO_REWRITE' : 'EPISODE_INPUT');

  // ORIGINAL_PROJECT 必须实时读取源项目，所有权、分类和完整剧本缺一不可。
  // 这里不能只信任 sourceProjectId，否则可跨用户复制私有剧本。
  let sourceProject: ProjectRecord | null = null;
  if (sourceMode === 'ORIGINAL_PROJECT') {
    sourceProject = await getById(validated.sourceProjectId!);
    if (
      !sourceProject ||
      sourceProject.userId !== userId ||
      sourceProject.category !== 'ORIGINAL'
    ) {
      throw new ProjectValidationError('引用的剧本原创项目不存在或无权访问');
    }
    if (!String(sourceProject.novelText ?? '').trim()) {
      throw new ProjectValidationError('所选原创项目还没有完整剧本');
    }
  }

  const novelText = sourceProject
    ? String(sourceProject.novelText)
    : category === 'ORIGINAL'
      ? (validated.novelText ?? null)
      : null;
  // scriptData.sourceMode 是工作台分支选择的持久化依据；引用剧本时额外同步
  // novelText，兼容 app1 仍从 scriptData 读取原文的旧链路。这里只冻结原文，
  // 不从项目标题推断集数；实际集数由后续 AI 通读冻结原文后动态决定。
  const scriptData = {
    sourceMode,
    ...(novelText ? { novelText } : {}),
    ...(sourceProject && novelText
      ? {
          sourceScriptSnapshot: {
            version: 1 as const,
            text: normalizeProjectScriptForHash(novelText),
            hash: createHash('sha256')
              .update(normalizeProjectScriptForHash(novelText), 'utf8')
              .digest('hex'),
            sourceProjectId: sourceProject.id,
          },
        }
      : {}),
  };

  const id = genId();
  const result = await query(
    `INSERT INTO projects
      (id, "userId", title, description, category, "sourceProjectId",
       "scriptData", "artStyle", "artStylePrompt", "novelText", "scriptOverride")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, FALSE)
     RETURNING *`,
    [
      id,
      userId,
      validated.title,
      validated.description ?? null,
      category,
      sourceProject?.id ?? null,
      JSON.stringify(scriptData),
      validated.artStyle ?? null,
      validated.artStylePrompt ?? null,
      novelText,
    ],
  );
  return mapRow(result.rows[0] as unknown as ProjectRow);
}

/**
 * 取单个项目（供 workspace/[projectId] 工作台按 id 加载）。
 *
 * 返回完整 ProjectRecord（含 userId）—— ownership 校验由调用方（route 层）
 * 做 `project.userId === auth.userId` 判断，与 app1 ensureProjectOwnership
 * 策略一致（不在此处 403/404，避免泄露存在性）。
 *
 * @param id - 项目 ID
 * @returns 项目记录，不存在返回 null
 */
export async function getById(id: string): Promise<ProjectRecord | null> {
  const result = await query(`SELECT * FROM projects WHERE id = $1`, [id]);
  const row = result.rows[0] as unknown as ProjectRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * 部分更新项目（PATCH 白名单）。
 *
 * P7.1：支持用户可见的核心字段 title / description / status / category。
 * 批3（P7.x-T3）：追加 scriptData 字段（JSONB 浅合并写入），供 text-to-style
 * route 把海外转绘的 localizationProfile 落到项目级（跨集共享，对齐 app1
 * `prisma.project.update({ data: { scriptData: { ...existing, localizationProfile } } })`）。
 *
 * 其他 JSONB / 脚本字段（characterMapping / artStyle …）留给后续 slice。
 *
 * @param id    - 项目 ID
 * @param patch - { title?, description?, status?, category?, scriptData? }
 * @returns 更新后的 ProjectRecord
 * @throws Error 项目不存在
 */
export async function update(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    status?: ProjectRecord['status'];
    category?: ProjectCategory;
    /**
     * JSONB 浅合并写入：现有 scriptData 与 patch.scriptData 浅合并（顶层键覆盖）。
     * 对齐 app1 text-to-style route 行 159-168 的 merge 语义。
     */
    scriptData?: Record<string, unknown>;
    /**
     * 整剧重写产物落库（转绘 X3.6a）：长视频整剧重写完成后，orchestrator 把
     * 重写后的全剧 novelText / videoScriptDraft 写回项目级。对齐 app1
     * processLongVideo 末尾 `prisma.project.update({ novelText, videoScriptDraft })`。
     */
    novelText?: string | null;
    videoScriptDraft?: string | null;
    /**
     * 长视频处理进度（转绘 X3.6a）：LongVideoProgress JSONB。整剧重写
     * orchestrator 按阶段（splitting/transcribing/outlining/scripting/completed）
     * 回写，UI 轮询 progress route 读它渲染进度条。整列覆盖（非浅合并）。
     */
    longVideoProgress?: unknown;
  },
): Promise<ProjectRecord> {
  const current = await getById(id);
  if (!current) {
    throw new Error(`项目不存在: ${id}`);
  }

  const fragments: string[] = [];
  const values: unknown[] = [];
  const add = (col: string, val: unknown): void => {
    fragments.push(`${col} = $${values.length + 1}`);
    values.push(val);
  };

  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new Error('项目标题不能为空');
    add('title', patch.title.trim());
  }
  if (patch.description !== undefined) {
    add('description', patch.description);
  }
  if (patch.status !== undefined) {
    add('status', patch.status);
  }
  if (patch.category !== undefined) {
    add('category', patch.category);
  }
  if (patch.scriptData !== undefined) {
    // JSONB 浅合并：现有 scriptData 顶层键 + patch 顶层键（patch 覆盖）。
    // 现有 scriptData 可能是 null / 对象 / 字符串（mock 兼容）；统一降级到 {}。
    const existing =
      current.scriptData &&
      typeof current.scriptData === 'object' &&
      !Array.isArray(current.scriptData)
        ? (current.scriptData as Record<string, unknown>)
        : {};
    const merged = { ...existing, ...patch.scriptData };
    add('"scriptData"', JSON.stringify(merged));
  }
  // 转绘 X3.6a：整剧重写产物 + 进度（整列覆盖，非浅合并）。
  if (patch.novelText !== undefined) {
    add('"novelText"', patch.novelText);
  }
  if (patch.videoScriptDraft !== undefined) {
    add('"videoScriptDraft"', patch.videoScriptDraft);
  }
  if (patch.longVideoProgress !== undefined) {
    add('"longVideoProgress"', JSON.stringify(patch.longVideoProgress));
  }
  // NOW() 字面内联（非参数化），DB 算时间戳；此处硬编码无注入风险
  fragments.push('"updatedAt" = NOW()');

  const setClause = fragments.join(', ');
  const result = await query(
    `UPDATE projects SET ${setClause} WHERE id = $${values.length + 1} RETURNING *`,
    [...values, id],
  );
  return mapRow(result.rows[0] as unknown as ProjectRow);
}

/**
 * 删除单个项目。
 *
 * ownership 必须由 route 在调用前校验；数据库外键负责级联删除分集、镜头、
 * 资产等项目内数据，引用该项目的 sourceProjectId 则按表约束置为 NULL。
 *
 * @returns true 表示实际删除了一行；并发重复删除时返回 false
 */
export async function remove(id: string): Promise<boolean> {
  const result = await query('DELETE FROM projects WHERE id = $1 RETURNING id', [id]);
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * Apply text-to-style character aliases to the project-wide semantic identity map.
 * The project row is locked so two episode conversions cannot overwrite each other.
 */
export async function updateCharacterMappingRoleIdentityByAliasMap(
  projectId: string,
  aliasMap: ReadonlyMap<string, string>,
): Promise<number> {
  if (aliasMap.size === 0) return 0;
  return tx(async (q) => {
    const selected = await q.query(
      'SELECT "characterMapping" FROM projects WHERE id = $1 FOR UPDATE',
      [projectId],
    );
    const raw = (selected.rows[0] as { characterMapping?: unknown } | undefined)?.characterMapping;
    const mapping = typeof raw === 'string'
      ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })()
      : raw;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return 0;
    const record = mapping as Record<string, unknown>;
    if (!Array.isArray(record.entries)) return 0;

    let updatedCount = 0;
    const entries = record.entries.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const entry = { ...(value as Record<string, unknown>) };
      const roleIdentity = typeof entry.roleIdentity === 'string' ? entry.roleIdentity : '';
      const name = typeof entry.name === 'string' ? entry.name : '';
      const matched = [roleIdentity, name].find((candidate) => candidate && aliasMap.has(candidate));
      if (!matched) return entry;
      const replacement = aliasMap.get(matched);
      if (!replacement) return entry;
      if (roleIdentity === matched || roleIdentity.includes(matched)) {
        entry.roleIdentity = roleIdentity.replace(matched, replacement);
      }
      if (name === matched) entry.name = replacement;
      updatedCount++;
      return entry;
    });
    if (updatedCount === 0) return 0;

    await q.query(
      'UPDATE projects SET "characterMapping" = $1::jsonb, "updatedAt" = NOW() WHERE id = $2',
      [JSON.stringify({ ...record, entries }), projectId],
    );
    return updatedCount;
  });
}

/**
 * 项目仓储对象（聚合所有函数，便于整体注入/mock）。
 * 对齐 render-job-repo 末尾聚合对象风格。
 */
export const projectRepo = {
  listByUser,
  create,
  getById,
  update,
  remove,
  updateCharacterMappingRoleIdentityByAliasMap,
};
