// ============================================================
// ③ server/domain/asset/rename-service — 资产改名 + 项目级名字同步
// ============================================================
//
// 文件职责：
//   提供所有资产类型改名能力。改 assets.name 的同时，把项目下所有
//   "按名字字符串烘焙进文本/JSON"的位置（projects.scriptData/characterMapping、
//   episodes.*、shots.*、storyboards.*、tasks.*、其余 CHARACTER 资产的描述字段）
//   里的旧名一次性替换为新名，保证名字一致、视频生成时的按名解析仍可用。
//
// 移植自 app1 src/core/asset/rename-service.ts。语义 1:1 对齐，差异仅在
// 持久层：app1 用 prisma.$transaction，dramaforge 用 @server/infra 的 tx()(PoolClient
// + BEGIN/COMMIT/ROLLBACK)；SQL 走裸 query，无 ORM。
//
// 为什么需要全量替换：
//   DramaForge 的角色名在分镜/剧本里是"按名字字符串"存储的，characterId 仅在
//   抽取去重时使用、未接到分镜引用上。只改 assets.name 会让按名解析失效并留下
//   大量陈旧名字，因此改名必须在一个事务内同步替换所有出现处。
//
// 替换策略：
//   递归子串替换（split/join）。对中文角色名基本无歧义；一次请求只改一个角色，
//   避免跨角色串扰。带 denylist 跳过 URL/id/路径/标识符字段，避免改坏图片地址或
//   稳定标识（characterId 等）。
//
// 安全约束：零 ffmpeg 依赖。
// ============================================================

import { query, tx, type QueryFn } from '@server/infra';

// ------------------------------------------------------------
// 递归替换器
// ------------------------------------------------------------

/**
 * 字段名 denylist：这些 key 对应的 value 是 URL / id / 路径 / 标识符，
 * 改名时绝不替换，避免改坏图片/音频地址或稳定标识（characterId、costumeKey 等）。
 *
 * 注意：数值/布尔类型的 value 不会被替换（replaceNameDeep 原样返回），
 * 这里列出的主要是字符串类型的标识/地址字段。
 */
const RENAME_SKIP_KEYS = new Set<string>([
  // 标识 / 外键
  'id', 'assetId', 'characterId', 'voiceprintId', 'voiceId', 'projectId',
  'episodeId', 'shotId', 'folderId', 'storyboardId', 'taskId', 'sceneId', 'scene_id',
  'material_id', 'currentMaterialId',
  // URL / 路径 / 文件
  'imageUrl', 'designImage', 'pencilImageUrl', 'gridImageUrl', 'pencilPaintingUrl',
  'thumbnailUrl', 'audioUrl', 'videoUrl', 'materialUrl', 'currentMaterialUrl',
  'image', 'url', 'path', 'src', 'href', 'file', 'fileName', 'filename',
  // 任务 input/output 里的参考资源 URL（可能含角色名路径，如 /api/reference-audio/{name}，绝不能改）
  'referenceImageUrls', 'referenceImageUrl',
  'referenceAudioUrls', 'referenceAudioUrl',
  'characterReferenceImageUrls', 'characterReferenceImageUrl',
  'referenceVideoUrls', 'referenceVideoUrl',
  'imageUrls', 'audioUrls', 'videoUrls', 'fileUrls',
  'firstFrameUrl', 'lastFrameUrl',
  'sceneRefUrls', 'sceneImageUrl', 'sceneRefUrl',
  'clipUrl', 'compositeUrl', 'outputUrl', 'resultUrl',
  // 标识性短键（枚举 / 索引 / 来源标记）
  'key', 'promptRef', 'costumeKey', 'kind', 'type', 'index', 'sourceField',
  'voiceSource', 'episodeNumber', 'sortOrder', 'shotIndex', 'groupIndex',
  'durationSeconds', 'version', 'createdAt', 'updatedAt', 'isConfirmed',
  'regenLocked', 'firstEpisode', 'isNewCharacter', 'totalDuration', 'start', 'end',
]);

/**
 * 递归子串替换：把 value 中所有出现的 oldName 替换为 newName。
 *
 * - 字符串：split(oldName).join(newName)（全局子串替换，精确等值也覆盖）
 * - 数组：逐项递归
 * - 对象：按 key 递归 value；key 在 denylist 中则该 value 原样保留
 * - null/undefined/数值/布尔：原样返回
 *
 * 纯函数，无副作用，便于单测。
 */
export function replaceNameDeep<T>(value: T, oldName: string, newName: string): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (!oldName || !value.includes(oldName)) return value;
    return value.split(oldName).join(newName) as unknown as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = replaceNameDeep(v, oldName, newName);
      if (r !== v) changed = true;
      return r;
    });
    return (changed ? next : value) as unknown as T;
  }
  if (typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (RENAME_SKIP_KEYS.has(k)) {
        out[k] = v;
      } else {
        const r = replaceNameDeep(v, oldName, newName);
        if (r !== v) changed = true;
        out[k] = r;
      }
    }
    return (changed ? out : value) as unknown as T;
  }
  return value;
}

// ------------------------------------------------------------
// 改名主流程
// ------------------------------------------------------------

/** 改名校验错误（4xx），由路由层捕获后转为 400 响应 */
export class RenameValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RenameValidationError';
  }
}

/** 新名字段长度上限（对齐 web 端 UI maxLength=100 的同名输入框，见 app1）。 */
export const RENAME_NAME_MAX_LENGTH = 100;

/** 改名结果摘要 */
export interface RenameResult {
  assetId: string;
  oldName: string;
  newName: string;
  /** 各表实际发生更新的行数（信息性，便于前端提示） */
  counts: {
    assets: number;
    episodes: number;
    shots: number;
    storyboards: number;
    tasks: number;
    renderJobs: number;
    taskEvents: number;
    materials: number;
  };
}

/** 字段定义：name=列名；kind=text|json；manualStringify=true 表示该 JSONB 列
 *  在 dramaforge 的裸 SQL 下需手动 JSON.stringify 后再写入（无 ORM 自动序列化）。 */
interface FieldDef {
  name: string;
  kind: 'text' | 'json';
  manualStringify?: boolean;
}

/** 对单条记录的指定字段做改名替换，返回需要写回的 data（仅含变化字段）。 */
function buildRenamedData(
  record: Record<string, unknown>,
  fields: FieldDef[],
  oldName: string,
  newName: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const { name: f, kind, manualStringify } of fields) {
    const orig = record[f];
    if (orig === null || orig === undefined) continue;
    const replaced =
      kind === 'json'
        ? replaceNameDeep(orig, oldName, newName)
        : replaceNameDeep(String(orig), oldName, newName);
    // 用 JSON.stringify 统一比较（对象/字符串都适用）
    if (JSON.stringify(replaced) !== JSON.stringify(orig)) {
      data[f] = kind === 'json' && manualStringify ? JSON.stringify(replaced) : replaced;
    }
  }
  return data;
}

// 各表待替换的字段
// 注：dramaforge JSONB 列在 pg driver 读回时已自动 parse 为对象，故 kind=json 走
//     replaceNameDeep 对象路径即可；写回时一律 JSON.stringify（manualStringify=true）
//     并靠 PostgreSQL 的 TEXT→JSONB 隐式赋值转换落库。
const ASSET_FIELDS: FieldDef[] = [
  { name: 'description', kind: 'text' },
  { name: 'background', kind: 'text' },
  { name: 'basePrompt', kind: 'text' },
  { name: 'voiceTrait', kind: 'text' },
  { name: 'significance', kind: 'text' },
  { name: 'mood', kind: 'text' },
  { name: 'baseAmbience', kind: 'text' },
  { name: 'tags', kind: 'json', manualStringify: true },
  { name: 'relationships', kind: 'json', manualStringify: true },
  { name: 'coverageScenes', kind: 'json', manualStringify: true },
  { name: 'identityLock', kind: 'json', manualStringify: true },
  { name: 'costumes', kind: 'json', manualStringify: true },
  { name: 'metadata', kind: 'json', manualStringify: true },
];

const PROJECT_FIELDS: FieldDef[] = [
  // 源输入也必须同步，否则重新分析会从旧名称重新生成派生数据。
  { name: 'description', kind: 'text' },
  { name: 'novelText', kind: 'text' },
  { name: 'videoScriptDraft', kind: 'text' },
  { name: 'artStylePrompt', kind: 'text' },
  { name: 'scriptData', kind: 'json', manualStringify: true },
  { name: 'characterMapping', kind: 'json', manualStringify: true },
  { name: 'voiceprintMapping', kind: 'json', manualStringify: true }, // @deprecated，仍在被读取，一并同步
];

const EPISODE_FIELDS: FieldDef[] = [
  { name: 'title', kind: 'text' },
  { name: 'novelText', kind: 'text' },
  { name: 'content', kind: 'text' },
  { name: 'videoScriptDraft', kind: 'text' },
  { name: 'emotionArc', kind: 'text' },
  { name: 'defaultVisualStyle', kind: 'json', manualStringify: true },
  { name: 'scenes', kind: 'json', manualStringify: true },
  { name: 'scriptData', kind: 'json', manualStringify: true },
  { name: 'characterAnalysis', kind: 'json', manualStringify: true },
  { name: 'voiceprintAnalysis', kind: 'json', manualStringify: true }, // @deprecated
];

const SHOT_FIELDS: FieldDef[] = [
  { name: 'visualPrompt', kind: 'text' },
  { name: 'stylePrompt', kind: 'text' },
  { name: 'referencedAssets', kind: 'json', manualStringify: true },
  { name: 'metadata', kind: 'json', manualStringify: true }, // 含 storyboardTable / assetReferenceBindings 等
];

const STORYBOARD_FIELDS: FieldDef[] = [
  { name: 'description', kind: 'text' },
  { name: 'dialogue', kind: 'text' },
  { name: 'metadata', kind: 'json', manualStringify: true },
];

const TASK_FIELDS: FieldDef[] = [
  // 视频任务创建时把 visualPrompt（含台词+角色名）快照进 input.prompt；
  // 改名后排队中/待重试的任务也会用新名。URL/ID 字段由 denylist 保护，不会被改坏。
  { name: 'input', kind: 'json', manualStringify: true },
  { name: 'output', kind: 'json', manualStringify: true },
];

const RENDER_JOB_FIELDS: FieldDef[] = [
  { name: 'input', kind: 'json', manualStringify: true },
  { name: 'result', kind: 'json', manualStringify: true },
];

const TASK_EVENT_FIELDS: FieldDef[] = [
  { name: 'payload', kind: 'json', manualStringify: true },
];

const MATERIAL_FIELDS: FieldDef[] = [
  { name: 'params', kind: 'json', manualStringify: true },
];

/**
 * 在事务 client 上对单条记录做改名替换 UPDATE。
 *
 * @returns true 表示该行发生了更新（用于计数）
 */
async function renameRow(
  q: QueryFn,
  table: string,
  rowId: unknown,
  row: Record<string, unknown>,
  fields: FieldDef[],
  oldName: string,
  newName: string,
  options: { idColumn?: string; touchUpdatedAt?: boolean } = {},
): Promise<boolean> {
  const data = buildRenamedData(row, fields, oldName, newName);
  if (Object.keys(data).length === 0) return false;

  const columns = Object.keys(data);
  const setClauses = columns.map((c, i) => `"${c}" = $${i + 1}`);
  if (options.touchUpdatedAt !== false) setClauses.push(`"updatedAt" = NOW()`);
  const params = [...columns.map((c) => data[c]), rowId];
  const placeholder = `$${columns.length + 1}`;
  await q.query(
    `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${options.idColumn ?? 'id'} = ${placeholder}`,
    params,
  );
  return true;
}

/**
 * 改一个资产的名字，并在同一事务内把旧名同步替换到项目下所有出现处。
 *
 * 校验（抛 RenameValidationError，400）：
 *   - 新名非空、≠旧名、长度 ≤ RENAME_NAME_MAX_LENGTH
 *   - 资产类型是 CHARACTER/PROP/LOCATION/ENTITY
 *   - 同项目同类型不存在另一个同名资产（唯一约束兜底）
 *
 * 事务内顺序执行（共享 PoolClient，禁 Promise.all）：
 *   1. 更新目标资产 name
 *   2. 所有 CHARACTER 资产的描述性字段（含目标自身）替换旧名
 *   3. project.scriptData/characterMapping/voiceprintMapping 替换
 *   4. 每个 episode 的 content/scenes/scriptData/characterAnalysis 替换
 *   5. 每个 shot 的 visualPrompt/referencedAssets/metadata 替换
 *   6. 每个 storyboard（遗留）的 description/dialogue/metadata 替换
 *   7. 每个 task 的 input/output 替换
 *
 * 注：novelText / videoScriptDraft（原始输入）不动；已生成视频文件不可变，
 *     仅 prompt/metadata 文本更新，需新视频时用户重新生成。
 */
export async function renameAsset(
  projectId: string,
  assetId: string,
  newNameRaw: string,
): Promise<RenameResult> {
  const newName = (newNameRaw ?? '').trim();
  if (!newName) throw new RenameValidationError('新名字不能为空');
  if (newName.length > RENAME_NAME_MAX_LENGTH) {
    throw new RenameValidationError(`新名字长度不能超过 ${RENAME_NAME_MAX_LENGTH} 个字符`);
  }

  // 预检：资产存在、归属、类型、旧名、同名冲突（事务前 fail-fast）
  // 用裸 query 而非 getAsset：只需 id/projectId/kind/name 四列，无需 toAssetRecord
  // 的 Date→ISO 全字段转换，避免不必要耦合（对齐 app1 的 prisma.findUnique 路径）。
  const assetRes = await query(
    'SELECT id, "projectId", kind, name FROM assets WHERE id = $1',
    [assetId],
  );
  const assetRow = assetRes.rows[0] as { projectId: string; kind: string; name: string } | undefined;
  if (!assetRow) throw new RenameValidationError('资产不存在');
  if (assetRow.projectId !== projectId) {
    throw new RenameValidationError('无权访问该资产');
  }
  if (!['CHARACTER', 'PROP', 'LOCATION', 'ENTITY'].includes(assetRow.kind)) {
    throw new RenameValidationError(`不支持资产类型 ${assetRow.kind} 改名`);
  }
  const oldName = assetRow.name;
  if (newName === oldName) throw new RenameValidationError('新名字与原名字相同');

  const clashResult = await query(
    'SELECT id FROM assets WHERE "projectId" = $1 AND kind = $2 AND name = $3 AND id != $4 LIMIT 1',
    [projectId, assetRow.kind, newName, assetId],
  );
  if (clashResult.rows.length > 0) {
    throw new RenameValidationError(`已存在同类型同名资产「${newName}」`);
  }

  const counts = {
    assets: 0,
    episodes: 0,
    shots: 0,
    storyboards: 0,
    tasks: 0,
    renderJobs: 0,
    taskEvents: 0,
    materials: 0,
  };

  await tx(async (q) => {
    // 事务内读取全部相关数据（同一 PoolClient，保证一致性）
    const projectRes = await q.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    const allAssetsRes = await q.query(
      'SELECT * FROM assets WHERE "projectId" = $1',
      [projectId],
    );
    const episodesRes = await q.query(
      'SELECT * FROM episodes WHERE "projectId" = $1',
      [projectId],
    );
    const shotsRes = await q.query(
      'SELECT * FROM shots WHERE "projectId" = $1',
      [projectId],
    );
    const storyboardsRes = await q.query(
      'SELECT * FROM storyboards WHERE "projectId" = $1',
      [projectId],
    );
    const tasksRes = await q.query(
      'SELECT * FROM tasks WHERE "projectId" = $1',
      [projectId],
    );
    const renderJobsRes = await q.query(
      `SELECT * FROM render_jobs
        WHERE input->>'projectId' = $1
           OR input#>>'{filmMeta,projectId}' = $1
           OR result->>'projectId' = $1`,
      [projectId],
    );
    const taskEventsRes = await q.query(
      `SELECT te.* FROM task_events te
        JOIN tasks t ON t.id = te."taskId"
       WHERE t."projectId" = $1`,
      [projectId],
    );
    const materialsRes = await q.query(
      'SELECT * FROM materials WHERE "projectId" = $1',
      [projectId],
    );

    // 1. 目标资产改名
    await q.query(
      'UPDATE assets SET name = $1, "updatedAt" = NOW() WHERE id = $2',
      [newName, assetId],
    );
    counts.assets += 1;

    // 2. 所有 CHARACTER 资产的描述性字段替换（含目标自身，保证自描述里的旧名也更新）
    for (const a of allAssetsRes.rows as Record<string, unknown>[]) {
      const updated = await renameRow(q, 'assets', a.id as string, a, ASSET_FIELDS, oldName, newName);
      if (updated) counts.assets += 1;
    }

    // 3. project JSONB（novelText/videoScriptDraft 不动）
    const projectRow = projectRes.rows[0] as Record<string, unknown> | undefined;
    if (projectRow) {
      const data = buildRenamedData(projectRow, PROJECT_FIELDS, oldName, newName);
      if (Object.keys(data).length > 0) {
        const columns = Object.keys(data);
        const setClauses = columns.map((c, i) => `"${c}" = $${i + 1}`);
        setClauses.push(`"updatedAt" = NOW()`);
        const params = [...columns.map((c) => data[c]), projectId];
        const placeholder = `$${columns.length + 1}`;
        await q.query(
          `UPDATE projects SET ${setClauses.join(', ')} WHERE id = ${placeholder}`,
          params,
        );
      }
    }

    // 4. episodes
    for (const e of episodesRes.rows as Record<string, unknown>[]) {
      const updated = await renameRow(q, 'episodes', e.id as string, e, EPISODE_FIELDS, oldName, newName);
      if (updated) counts.episodes += 1;
    }

    // 5. shots
    for (const s of shotsRes.rows as Record<string, unknown>[]) {
      const updated = await renameRow(q, 'shots', s.id as string, s, SHOT_FIELDS, oldName, newName);
      if (updated) counts.shots += 1;
    }

    // 6. storyboards（遗留，可能为空）
    for (const sb of storyboardsRes.rows as Record<string, unknown>[]) {
      const updated = await renameRow(q, 'storyboards', sb.id as string, sb, STORYBOARD_FIELDS, oldName, newName);
      if (updated) counts.storyboards += 1;
    }

    // 7. tasks：更新视频/图片等任务的 input（含 prompt 台词+角色名快照）/ output，
    //    使排队中/待重试的任务用新名；URL/ID 字段由 denylist 保护
    for (const t of tasksRes.rows as Record<string, unknown>[]) {
      const updated = await renameRow(q, 'tasks', t.id as string, t, TASK_FIELDS, oldName, newName);
      if (updated) counts.tasks += 1;
    }

    // 8. 客户端渲染快照、任务事件与镜头素材参数也可能烘焙资产名。
    // 这些表没有统一 updatedAt 列，因此显式关闭时间戳触碰。
    for (const job of renderJobsRes.rows as Record<string, unknown>[]) {
      const updated = await renameRow(q, 'render_jobs', job.id, job, RENDER_JOB_FIELDS, oldName, newName, { touchUpdatedAt: false });
      if (updated) counts.renderJobs += 1;
    }
    for (const event of taskEventsRes.rows as Record<string, unknown>[]) {
      const updated = await renameRow(q, 'task_events', event.id, event, TASK_EVENT_FIELDS, oldName, newName, { touchUpdatedAt: false });
      if (updated) counts.taskEvents += 1;
    }
    for (const material of materialsRes.rows as Record<string, unknown>[]) {
      const updated = await renameRow(q, 'materials', material.id, material, MATERIAL_FIELDS, oldName, newName, { touchUpdatedAt: false });
      if (updated) counts.materials += 1;
    }
  });

  return { assetId, oldName, newName, counts };
}
