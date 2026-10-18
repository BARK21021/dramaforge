// ============================================================
// Project Portability Module — 项目结构快照导出与安全克隆导入
// ============================================================
//
// 云端只搬运元数据；sf-asset:// 媒体文件由 Electron 客户端写入 .sfproject
// 文件夹。导入时客户端先恢复媒体并改写 URL，再把快照交给这里克隆入库。
// ============================================================

import { query, tx, type QueryFn } from '@server/infra';
import { genId } from '@shared/utils';

const TRANSFER_VERSION = 1 as const;
const TABLE_ORDER = [
  'episodes',
  'assets',
  'storyboards',
  'shots',
  'storyboard_versions',
  'materials',
  'asset_image_revisions',
  'render_jobs',
  // 参数模板（用户级"资产"）：导出项目时一并带上该用户全部模板，导入归属新账号。
  'seedance_presets',
] as const;
type TransferTable = (typeof TABLE_ORDER)[number];

export interface ProjectTransferSnapshot {
  format: 'dramaforge-project';
  version: typeof TRANSFER_VERSION;
  exportedAt: string;
  project: Record<string, unknown>;
  records: Record<TransferTable, Array<Record<string, unknown>>>;
}

export class ProjectTransferError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ProjectTransferError';
    this.statusCode = statusCode;
  }
}

/** 导出当前用户拥有的一个项目。任务、计费、密钥等账户数据永不进入迁移包。 */
export async function exportProjectSnapshot(
  userId: string,
  projectId: string,
): Promise<ProjectTransferSnapshot> {
  const projectResult = await query(
    'SELECT * FROM projects WHERE id = $1 AND "userId" = $2',
    [projectId, userId],
  );
  if (projectResult.rows.length === 0) {
    throw new ProjectTransferError('项目不存在或无权导出', 404);
  }

  const [
    episodes,
    assets,
    storyboards,
    shots,
    storyboardVersions,
    materials,
    revisions,
    renderJobs,
    seedancePresets,
  ] =
    await Promise.all([
      query('SELECT * FROM episodes WHERE "projectId" = $1 ORDER BY "sortOrder", "episodeNumber"', [projectId]),
      query('SELECT * FROM assets WHERE "projectId" = $1 ORDER BY "createdAt"', [projectId]),
      query('SELECT * FROM storyboards WHERE "projectId" = $1 ORDER BY episode, "sortOrder"', [projectId]),
      query('SELECT * FROM shots WHERE "projectId" = $1 ORDER BY "sortOrder", "shotIndex"', [projectId]),
      // 分镜历史版本（2026-08-01 新增表）：项目迁移必须带上，否则导入后分镜版本历史丢失。
      query(
        'SELECT * FROM storyboard_versions WHERE "projectId" = $1 ORDER BY "episodeId", ordinal',
        [projectId],
      ),
      query('SELECT * FROM materials WHERE "projectId" = $1 ORDER BY "createdAt"', [projectId]),
      query('SELECT * FROM asset_image_revisions WHERE "projectId" = $1 ORDER BY "generationOrdinal"', [projectId]),
      // 成片库没有 projectId 列，只导出明确归属于本项目且已完成的历史成片。
      query(
        `SELECT * FROM render_jobs
          WHERE status = 'COMPLETED' AND user_id = $2
            AND (input->'filmMeta'->>'projectId' = $1 OR input->>'projectId' = $1)`,
        [projectId, userId],
      ),
      query(
        'SELECT * FROM seedance_presets WHERE "userId" = $1 ORDER BY "createdAt"',
        [userId],
      ),
    ]);

  return {
    format: 'dramaforge-project',
    version: TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    project: projectResult.rows[0] as Record<string, unknown>,
    records: {
      episodes: episodes.rows as Array<Record<string, unknown>>,
      assets: assets.rows as Array<Record<string, unknown>>,
      storyboards: storyboards.rows as Array<Record<string, unknown>>,
      shots: shots.rows as Array<Record<string, unknown>>,
      storyboard_versions: storyboardVersions.rows as Array<Record<string, unknown>>,
      materials: materials.rows as Array<Record<string, unknown>>,
      asset_image_revisions: revisions.rows as Array<Record<string, unknown>>,
      render_jobs: renderJobs.rows as Array<Record<string, unknown>>,
      seedance_presets: seedancePresets.rows as Array<Record<string, unknown>>,
    },
  };
}

function validateSnapshot(value: unknown): asserts value is ProjectTransferSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectTransferError('迁移包不是有效对象');
  }
  const candidate = value as Partial<ProjectTransferSnapshot>;
  if (candidate.format !== 'dramaforge-project' || candidate.version !== TRANSFER_VERSION) {
    throw new ProjectTransferError('不支持的项目迁移包格式或版本');
  }
  if (!candidate.project || typeof candidate.project !== 'object' || Array.isArray(candidate.project)) {
    throw new ProjectTransferError('迁移包缺少项目数据');
  }
  if (!candidate.records || typeof candidate.records !== 'object') {
    throw new ProjectTransferError('迁移包缺少业务记录');
  }
  let total = 0;
  for (const table of TABLE_ORDER) {
    const rows = candidate.records[table];
    // 旧客户端包缺少后来新增的表（如 storyboard_versions）→ 宽容视为空，保证"旧包可导入新服务端"。
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new ProjectTransferError(`迁移包缺少 ${table} 记录`);
    total += rows.length;
  }
  // 防止恶意 JSON 让一次事务构造无限 SQL/参数；正常单项目远低于该上限。
  if (total > 100_000) throw new ProjectTransferError('迁移包记录数超过 100000 条上限');
}

function remapDeep(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapDeep(item, idMap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, remapDeep(item, idMap)]),
    );
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 只插入目标数据库真实存在且快照携带的列。这样旧客户端包可导入新服务端，
 * 新客户端包导入字段较少的兼容部署时也会忽略未知扩展列。
 *
 * jsonb 列必须 JSON.stringify + ::jsonb 强转：node-postgres 对【数组】参数会序列化成
 * PostgreSQL 数组字面量（{a,b}）而非 JSON，直接插 jsonb 列报 22P02 invalid input syntax
 * for type json（对象虽侥幸被 stringify，但统一处理最稳，对齐代码库其他 59 处 ::jsonb 用法）。
 */
async function insertPortableRow(
  q: QueryFn,
  table: 'projects' | TransferTable,
  row: Record<string, unknown>,
): Promise<void> {
  const columnsResult = await q.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`,
    [table],
  );
  const colType = new Map(
    (columnsResult.rows as Array<{ column_name: string; data_type: string }>).map(
      (item) => [item.column_name, item.data_type],
    ),
  );
  const allowed = new Set(colType.keys());
  const entries = Object.entries(row).filter(([column]) => allowed.has(column));
  if (entries.length === 0) throw new ProjectTransferError(`迁移目标表 ${table} 没有兼容字段`);
  const columns = entries.map(([column]) => quoteIdentifier(column));
  const placeholders: string[] = [];
  const values: unknown[] = [];
  entries.forEach(([column, value], index) => {
    const isJson = colType.get(column) === 'jsonb' || colType.get(column) === 'json';
    if (isJson && value !== null && value !== undefined) {
      // 对象/数组 → JSON.stringify（数组尤其必须，否则 pg 当数组字面量）；字符串假定已是合法 JSON 原样传。
      placeholders.push(`$${index + 1}::jsonb`);
      values.push(typeof value === 'string' ? value : JSON.stringify(value));
    } else {
      placeholders.push(`$${index + 1}`);
      values.push(value);
    }
  });
  await q.query(
    `INSERT INTO ${quoteIdentifier(table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values,
  );
}

/** 将迁移快照克隆为当前用户的新项目，所有主键和关联引用都会重新映射。 */
export async function importProjectSnapshot(
  userId: string,
  unsafeSnapshot: unknown,
): Promise<{ projectId: string; title: string; importedCounts: Record<TransferTable, number> }> {
  validateSnapshot(unsafeSnapshot);
  const snapshot = unsafeSnapshot;
  const idMap = new Map<string, string>();
  const oldProjectId = String(snapshot.project.id ?? '');
  if (!oldProjectId) throw new ProjectTransferError('迁移包项目 ID 无效');
  idMap.set(oldProjectId, genId());

  // 先为全部记录预分配 ID，随后深度改写 JSON 中的交叉引用，避免依赖插入完成顺序。
  for (const table of TABLE_ORDER) {
    for (const row of snapshot.records[table] ?? []) {
      const oldId = typeof row.id === 'string' ? row.id : null;
      if (oldId) idMap.set(oldId, genId());
      if (table === 'render_jobs' && typeof row.task_id === 'string') {
        idMap.set(row.task_id, genId());
      }
    }
  }

  const projectId = idMap.get(oldProjectId)!;
  const originalTitle = String(snapshot.project.title ?? '未命名项目').slice(0, 90);
  const importedTitle = `${originalTitle}（导入）`;
  const counts = Object.fromEntries(TABLE_ORDER.map((table) => [table, 0])) as Record<TransferTable, number>;

  await tx(async (q) => {
    const project = remapDeep(snapshot.project, idMap) as Record<string, unknown>;
    project.id = projectId;
    project.userId = userId;
    project.title = importedTitle;
    project.sourceProjectId =
      typeof snapshot.project.sourceProjectId === 'string' && idMap.has(snapshot.project.sourceProjectId)
        ? idMap.get(snapshot.project.sourceProjectId)
        : null;
    project.createdAt = new Date();
    project.updatedAt = new Date();
    await insertPortableRow(q, 'projects', project);

    for (const table of TABLE_ORDER) {
      for (const sourceRow of snapshot.records[table] ?? []) {
        const row = remapDeep(sourceRow, idMap) as Record<string, unknown>;
        if (typeof sourceRow.id === 'string') row.id = idMap.get(sourceRow.id);
        if ('projectId' in row) row.projectId = projectId;
        if ('userId' in row) row.userId = userId;
        if ('user_id' in row) row.user_id = userId;
        if (table === 'render_jobs') {
          row.task_id = typeof sourceRow.task_id === 'string'
            ? idMap.get(sourceRow.task_id) ?? genId()
            : genId();
          row.status = 'COMPLETED';
          row.claimed_by = null;
          row.claim_token = null;
        }
        await insertPortableRow(q, table, row);
        counts[table] += 1;
      }
    }
  });

  return { projectId, title: importedTitle, importedCounts: counts };
}
