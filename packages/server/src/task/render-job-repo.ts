// ============================================================
// ④ server/task/render-job-repo — render_jobs 表 CRUD + 原子认领（核心新件）
// ============================================================
//
// 文件职责：
//   render_jobs 是 C/S 架构的调度核心：服务器只写表 + 客户端 HTTP 拉取。
//   本模块封装 render_jobs 表的所有读写：
//     1. create()            — 插入 PENDING 行
//     2. claimNext(userId, machineId) — 按用户原子认领（FOR UPDATE SKIP LOCKED）
//     3. markRunning/markResult/markFailed — 按完整租约做 CAS 状态推进
//     4. reapStale(timeoutMs)— 回收超时 CLAIMED/RUNNING 行（客户端崩溃自愈）
//     5. getById()/getByTaskId() — 按作业 ID 或 SSE taskId 查询
//     6. cancel()/retry()     — 用户操作的 CAS 状态转换
//
// 设计要点：
//   - claimNext 用 tx + FOR UPDATE SKIP LOCKED：多个客户端并发拉取不会拿到同一行
//   - claimToken 每次认领都更换，旧客户端即使迟到也无法覆盖新认领的结果
//   - heartbeat_at 续租；CLAIMED/RUNNING 超时后重置 PENDING 重新派发
//   - 所有 JSONB 字段（input/result）用 JSON.stringify 写入、mapRow 时解析
//   - TIMESTAMPTZ 由 pg 解析为 Date，mapRow 统一转 ISO 字符串
//   - 全部走 @server/infra 的 query/tx，无直接 pg import
//
// 服务器禁止 import 任何 ffmpeg 模块；render_jobs 由客户端 render-worker 执行。
// ============================================================

import { query, tx, type QueryFn } from '@server/infra';
import { genId } from '@shared/utils';
import type {
  ChainCompileInput,
  ConcatInput,
  RenderJob,
  RenderJobGroupClip,
  RenderJobInput,
  RenderJobResult,
  RenderJobStatus,
  RenderJobType,
} from '@shared/render-job';

/**
 * render_jobs 表行结构（pg 返回的原始 row）
 *
 * - input/result: JSONB，pg 默认解析为对象；也兼容字符串（mock 测试）
 * - *_at: TIMESTAMPTZ，pg 默认解析为 Date；也兼容字符串
 */
export interface RenderJobRow {
  id: string;
  task_id: string;
  user_id: string;
  type: RenderJobType;
  input: unknown;
  status: RenderJobStatus;
  progress: number;
  stage: string | null;
  claimed_by: string | null;
  claim_token: string | null;
  created_at: unknown;
  claimed_at: unknown;
  heartbeat_at: unknown;
  completed_at: unknown;
  error: string | null;
  result: unknown;
  progress_clips: unknown;
}

/**
 * 解析 JSONB 字段：pg 返回对象则原样用，返回字符串则 JSON.parse
 * 兼容 mock 测试直接传对象或字符串
 */
function parseJson<T>(v: unknown): T {
  if (typeof v === 'string') return JSON.parse(v) as T;
  return v as T;
}

/**
 * TIMESTAMPTZ → ISO 字符串；null 透传
 * pg 默认返回 Date，mock 可能返回 Date/string/null
 */
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * 将 pg 行映射为 RenderJob 契约对象
 *
 * - 下划线列名 → 驼峰字段
 * - input/result JSONB 解析
 * - 时间戳转 ISO 字符串
 */
export function mapRow(row: RenderJobRow): RenderJob {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    type: row.type,
    status: row.status,
    progress: row.progress ?? 0,
    stage: row.stage ?? null,
    input: parseJson<RenderJobInput>(row.input),
    result: row.result == null ? null : parseJson<RenderJobResult>(row.result),
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    error: row.error,
    createdAt: toIsoOrNull(row.created_at) ?? '',
    claimedAt: toIsoOrNull(row.claimed_at),
    heartbeatAt: toIsoOrNull(row.heartbeat_at),
    completedAt: toIsoOrNull(row.completed_at),
    progressClips: parseJson<RenderJobGroupClip[]>(row.progress_clips ?? '[]'),
  };
}

/** Active claims are recycled after two minutes without an accepted callback. */
export const DEFAULT_RENDER_JOB_LEASE_TIMEOUT_MS = 120_000;

/**
 * Claim 硬上限（秒）：无论心跳多新，claimed_at 超过此时长即判卡死并回收。
 *
 * 兜底 executeJob 卡死但心跳定时器（client render-worker loop.ts renewLease 30s）
 * 仍在续租的情形——那种任务 heartbeat_at 永远新鲜，单靠上面的 heartbeat 超时
 * （LEASE_TIMEOUT 2min）永远触发不了，导致 reap 永不回收、render-worker 单线程被
 * 永久占用（CHAIN_COMPILE 假死 + 后续 CONCAT 不被领取的堆积）。
 * 4h：CHAIN_COMPILE strict 一键出片是逐组串行 + 真实云端生成，典型 30-60min，
 * 大分集（54 镜 / 多场景组）可达 ~1h+，均属合法执行（心跳每 30s 续租）。超过
 * 4h 且心跳始终新鲜才判定卡死（executeJob 挂起但定时器存活）。回收后客户端
 * 下一次 /progress 续租会因 claim_token 失配收到 409（见 progress route），触发
 * executionController.abort() 自愈中断卡死执行。
 */
export const MAX_CLAIM_DURATION_SECONDS = 4 * 60 * 60;

/**
 * Claim 硬上限（秒）按 render_job.type 分档。
 *
 * LONG_VIDEO_REWRITE 是客户端 ⑩ 长 ffmpeg + LLM pipeline：Kimi 分段 + DeepSeek 大纲 +
 * 多段重写续写循环，单次编排典型 1-6 小时。套用统一 4h 硬上限时，多设备登录 /
 * 客户端崩溃重启 / 第二台机器打开会让新 claimNext 把仍在合法编排的原 job 当卡死回收
 * （claimed_at 超 4h），原 client 下次 renewLease 收 409 → executionController.abort
 * → 丢 in-flight LLM 调用（单次最坏 ~50min Kimi chat 损失）。给它 12h 覆盖最长编排 + 余量。
 * 其他类型（CHAIN_COMPILE / CONCAT / SPLIT 等）走默认 4h。
 */
export const MAX_CLAIM_DURATION_SECONDS_BY_TYPE: Record<string, number> = {
  LONG_VIDEO_REWRITE: 12 * 60 * 60, // 12h，覆盖 1-6h 编排 + 余量
};
/** 某类型 render_job 的 claim 硬上限（秒）；未知类型走默认 MAX_CLAIM_DURATION_SECONDS(4h)。纯函数，供单测。 */
export function maxClaimDurationSecondsForType(type: string): number {
  return MAX_CLAIM_DURATION_SECONDS_BY_TYPE[type] ?? MAX_CLAIM_DURATION_SECONDS;
}

export type RenderJobTransition =
  | { outcome: 'applied'; job: RenderJob; followUpJob?: RenderJob }
  | { outcome: 'already_applied'; job: RenderJob }
  | { outcome: 'rejected'; job: RenderJob | null }
  | {
      outcome: 'failed_validation';
      job: RenderJob;
    }
  | {
      // 部分完成：≥1 组成功 + 其余失败。job 终态 COMPLETED，但 outputUrl 为空（部分片不算整集
      // 成片，不阻塞后续 retry→maybeCreateEpisodeConcat）。成功镜头已 COMPLETED，失败镜头
      // FAILED+videoError。result.meta 带 failedGroups>0 + partialCompleted=true 供 UI 区分展示。
      outcome: 'partial_completed';
      job: RenderJob;
    };

/** 分集串生成的原子"创建或复用"结果。 */
export interface ChainGenerateDispatchResult {
  job: RenderJob;
  reused: boolean;
}

/** 客户端上报的组片只允许映射到任务输入中声明的同一批镜头。 */
interface TrustedChainShotGroup {
  shotIds: string[];
  videoUrl: string;
}

/** 判断 JSONB 解码值是否为普通对象形状。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从 CHAIN_COMPILE 任务输入与客户端结果中提取可信组片映射。
 *
 * 结果里的 shotIds、顺序和组数必须与派发时的服务器权威分组完全一致；URL 也必须
 * 指向客户端本地 sf-asset key。这样被篡改的客户端不能借完成回调覆盖任意镜头。
 * 历史任务没有 shotIds 时返回 null，继续保持只保存整集结果的兼容行为。
 */
function readTrustedChainShotGroups(
  job: RenderJob,
  result: RenderJobResult,
): { projectId: string; episodeId: string; groups: TrustedChainShotGroup[] } | null {
  if (job.type !== 'CHAIN_COMPILE' || !isRecord(job.input)) return null;
  const inputGroups = Array.isArray(job.input.groupResults) ? job.input.groupResults : [];
  const expectedGroups = inputGroups.filter((group) =>
    isRecord(group) && Array.isArray(group.shotIds) && group.shotIds.length > 0);
  // 旧版任务只带 url/params，不具备安全回写镜头所需的服务器白名单。
  if (expectedGroups.length === 0) return null;

  const filmMeta = isRecord(job.input.filmMeta) ? job.input.filmMeta : null;
  const projectId = typeof filmMeta?.projectId === 'string' ? filmMeta.projectId : '';
  const episodeId = typeof filmMeta?.episodeId === 'string' ? filmMeta.episodeId : '';
  let resultGroups: unknown[] | null = isRecord(result.meta) && Array.isArray(result.meta.groupClips)
    ? result.meta.groupClips
    : null;
  if (!projectId || !episodeId) {
    throw new Error('CHAIN_COMPILE 组片结果缺少完整的镜头映射');
  }
  if (!resultGroups) {
    if (expectedGroups.length !== 1) {
      // 旧 1.1.6 多组任务只上报整集成片；无法反推出各组 URL，宁可不写也不能误绑整集。
      return null;
    }
    const legacyLocalKey = isRecord(result.meta) && typeof result.meta.localKey === 'string'
      ? result.meta.localKey
      : '';
    const legacyVideoUrl = typeof result.outputUrl === 'string' ? result.outputUrl : '';
    // 单组任务的整集成片就是该组本身，因此可为已安装旧客户端提供安全兼容回写。
    resultGroups = [{
      shotIds: (expectedGroups[0] as Record<string, unknown>).shotIds,
      localKey: legacyLocalKey,
      videoUrl: legacyVideoUrl,
    }];
  }
  if (resultGroups.length !== expectedGroups.length) {
    throw new Error('CHAIN_COMPILE 组片结果缺少完整的镜头映射');
  }

  // expectedGroups 是 input.groupResults 过滤后的保序子集；组号 = 原数组下标 + 1
  // （客户端 localKey 的 -group-N 用原始下标，校验必须对齐原下标而非过滤后位置）。
  const groupNoByExpectedIndex = new Map<number, number>();
  {
    let expectedIdx = 0;
    for (let gi = 0; gi < inputGroups.length; gi += 1) {
      if (isRecord(inputGroups[gi]) && Array.isArray(inputGroups[gi].shotIds) && inputGroups[gi].shotIds.length > 0) {
        groupNoByExpectedIndex.set(expectedIdx, gi + 1);
        expectedIdx += 1;
      }
    }
  }

  // legacy 兼容：单组任务且客户端未上报 groupClips 时，服务端用整集 key 构造组片
  // （localKey 无 -group-N 后缀），组号语义校验豁免该分支。
  const hasReportedGroupClips = isRecord(result.meta) && Array.isArray((result.meta as Record<string, unknown>).groupClips);
  const legacyConstructedGroup = expectedGroups.length === 1 && !hasReportedGroupClips;

  const seenShotIds = new Set<string>();
  const groups: TrustedChainShotGroup[] = expectedGroups.map((expected, index) => {
    const expectedShotIds = (expected as Record<string, unknown>).shotIds as unknown[];
    const reported = resultGroups[index];
    if (!isRecord(reported) || !Array.isArray(reported.shotIds)) {
      throw new Error(`CHAIN_COMPILE 第 ${index + 1} 组镜头映射无效`);
    }
    const shotIds = expectedShotIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    const reportedShotIds = reported.shotIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (
      shotIds.length !== expectedShotIds.length
      || reportedShotIds.length !== reported.shotIds.length
      || shotIds.length !== reportedShotIds.length
      || shotIds.some((id, shotIndex) => id !== reportedShotIds[shotIndex])
    ) {
      throw new Error(`CHAIN_COMPILE 第 ${index + 1} 组镜头映射与任务输入不一致`);
    }
    for (const shotId of shotIds) {
      if (seenShotIds.has(shotId)) throw new Error(`CHAIN_COMPILE 镜头 ${shotId} 被重复分组`);
      seenShotIds.add(shotId);
    }

    const localKey = typeof reported.localKey === 'string' ? reported.localKey : '';
    const videoUrl = typeof reported.videoUrl === 'string' ? reported.videoUrl : '';
    // 组号语义校验：localKey 必须带本组声明组号（`-group-${groupNo}.mp4`），防客户端
    // 回传的 localKey 与实际组错位（22 集 8/1 组视频串位教训：S4-34→group-4 / S2-17→group-9）。
    const declaredGroupNo = groupNoByExpectedIndex.get(index);
    const groupNoPattern = new RegExp(`^[a-z0-9-]+-group-${declaredGroupNo ?? '\\d+'}\\.mp4$`, 'i');
    if (
      !/^[a-z0-9-]+\.mp4$/i.test(localKey)
      || (!legacyConstructedGroup && !groupNoPattern.test(localKey))
      || videoUrl !== `sf-asset://${localKey}`
    ) {
      throw new Error(`CHAIN_COMPILE 第 ${index + 1} 组本地视频地址无效`);
    }
    return { shotIds, videoUrl };
  });

  return { projectId, episodeId, groups };
}

/**
 * 门禁失败时从客户端上报结果中提取【可安全回写的成功组子集】。
 *
 * 与 readTrustedChainShotGroups 的区别：strict 模式会跳过被 AI 拒的组，客户端只上报
 * 成功组，故 resultGroups 与 expectedGroups 不再等长等序——这里改为按 shotIds 内容
 * 精确匹配每个 reported 组到某个 expected 组，只回写匹配且地址合法的组；不匹配/非法
 * 的 reported 组丢弃（其镜头归入 FAILED）。安全不变量不变：只绑定服务端已声明 shotIds
 * 的子集，篡改客户端无法借完成回调注入任意镜头。
 *
 * 返回 null 表示非 CHAIN_COMPILE / 旧版任务无 shotIds 声明 / 无 filmMeta（调用方保持
 * 原 G3-1 全标 FAILED 行为）。allDeclaredShotIds 为 job 声明的全部去重 shotIds（供
 * 级联标 FAILED 时减去已成功回写的）。
 */
function readPartialTrustedChainShotGroups(
  job: RenderJob,
  result: RenderJobResult,
): {
  projectId: string;
  episodeId: string;
  persistedGroups: TrustedChainShotGroup[];
  allDeclaredShotIds: string[];
} | null {
  if (job.type !== 'CHAIN_COMPILE' || !isRecord(job.input)) return null;
  const inputGroups = Array.isArray(job.input.groupResults) ? job.input.groupResults : [];
  const expectedGroups = inputGroups.filter((group) =>
    isRecord(group) && Array.isArray(group.shotIds) && group.shotIds.length > 0);
  if (expectedGroups.length === 0) return null;

  const filmMeta = isRecord(job.input.filmMeta) ? job.input.filmMeta : null;
  const projectId = typeof filmMeta?.projectId === 'string' ? filmMeta.projectId : '';
  const episodeId = typeof filmMeta?.episodeId === 'string' ? filmMeta.episodeId : '';
  if (!projectId || !episodeId) return null;

  const declaredSeen = new Set<string>();
  const allDeclaredShotIds: string[] = [];
  const expectedByShotKey = new Map<string, { shotIds: string[]; groupNo: number }>();
  for (let gi = 0; gi < inputGroups.length; gi += 1) {
    const group = inputGroups[gi];
    if (!isRecord(group) || !Array.isArray(group.shotIds)) continue;
    const shotIds = (group.shotIds as unknown[])
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (shotIds.length === 0) continue;
    expectedByShotKey.set(shotIds.join('\n'), { shotIds, groupNo: gi + 1 });
    for (const id of shotIds) {
      if (!declaredSeen.has(id)) {
        declaredSeen.add(id);
        allDeclaredShotIds.push(id);
      }
    }
  }

  const resultGroups = isRecord(result.meta) && Array.isArray(result.meta.groupClips)
    ? result.meta.groupClips
    : null;
  if (!resultGroups) {
    return { projectId, episodeId, persistedGroups: [], allDeclaredShotIds };
  }

  const seenShotIds = new Set<string>();
  const persistedGroups: TrustedChainShotGroup[] = [];
  for (const reported of resultGroups) {
    if (!isRecord(reported) || !Array.isArray(reported.shotIds)) continue;
    const reportedShotIds = reported.shotIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const matched = expectedByShotKey.get(reportedShotIds.join('\n'));
    if (!matched) continue; // 不匹配任何服务端声明组 → 丢弃（防注入）
    if (reportedShotIds.some((id) => seenShotIds.has(id))) continue; // 重复组 → 丢弃
    const localKey = typeof reported.localKey === 'string' ? reported.localKey : '';
    const videoUrl = typeof reported.videoUrl === 'string' ? reported.videoUrl : '';
    // 组号语义校验：localKey 的 -group-N 必须等于声明组号（与 readTrustedChainShotGroups 一致）。
    const groupNoPattern = new RegExp(`^[a-z0-9-]+-group-${matched.groupNo}\\.mp4$`, 'i');
    if (
      !/^[a-z0-9-]+\.mp4$/i.test(localKey)
      || !groupNoPattern.test(localKey)
      || videoUrl !== `sf-asset://${localKey}`
    ) continue;
    reportedShotIds.forEach((id) => seenShotIds.add(id));
    persistedGroups.push({ shotIds: reportedShotIds, videoUrl });
  }

  return { projectId, episodeId, persistedGroups, allDeclaredShotIds };
}

/**
 * 门禁失败时把【成功组子集】回写为 COMPLETED，让用户能看到已生成的镜头片段。
 *
 * 复用 persistChainShotGroups 的 per-group last-request-wins 守卫：更新的成功任务不被
 * 本失败链的迟到回写覆盖。不写 prompt 元数据（仅成功路径有意义）。不另取分集锁——失败
 * 链不派发成片，shot 写竞争由 last-request-wins 守卫 + 行级 last-write-wins 兜底。
 * 返回实际持久化的 shotIds 集合，供调用方计算缺失镜头。
 *
 * NOTE: per-group UPDATE 与 persistChainShotGroups:317-346 重复（热修隔离成功路径，不抽
 * 公共 helper 降风险）；后续可抽取 writeShotGroupMaterial 共用。
 */
async function persistPartialShotGroups(
  q: QueryFn,
  job: RenderJob,
  partial: { projectId: string; episodeId: string; persistedGroups: TrustedChainShotGroup[] },
): Promise<Set<string>> {
  const persisted = new Set<string>();
  for (const group of partial.persistedGroups) {
    await q.query(
      `UPDATE shots AS target
          SET "currentMaterialUrl"=$1, "videoStatus"='COMPLETED',
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('materialUpdatedAt', $7::text, 'newSeenCount', 0),
              "updatedAt"=NOW()
        WHERE target.id=ANY($2::text[])
          AND target."projectId"=$3
          AND target."episodeId"=$4
          AND NOT EXISTS (
            SELECT 1
              FROM render_jobs AS newer
              JOIN render_jobs AS current ON current.id=$6
             WHERE newer.user_id=$5
               AND newer.type='CHAIN_COMPILE'
               AND newer.status='COMPLETED'
               AND (
                 newer.created_at > current.created_at
                 OR (newer.created_at = current.created_at AND newer.id > current.id)
               )
               AND EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(
                     CASE
                       WHEN jsonb_typeof(newer.input -> 'groupResults')='array'
                         THEN newer.input -> 'groupResults'
                       ELSE '[]'::jsonb
                     END
                   ) AS newer_group
                  WHERE jsonb_typeof(newer_group -> 'shotIds')='array'
                    AND (newer_group -> 'shotIds') ? target.id
               )
          )`,
      [
        group.videoUrl,
        group.shotIds,
        partial.projectId,
        partial.episodeId,
        job.userId,
        job.id,
        new Date().toISOString(),
      ],
    );
    for (const id of group.shotIds) persisted.add(id);
  }
  return persisted;
}

interface EpisodeShotForConcat {
  id: string;
  videoStatus: string | null;
  currentMaterialUrl: string | null;
  durationSeconds: number | null;
}

/**
 * 在同一分集上串行化"组片写回 + 完整性检查 + 自动合片派发"。
 *
 * 不使用进程内锁：生产可能有多个 web 容器，只有 PostgreSQL 事务级 advisory lock
 * 能让跨进程的最后两个镜头组形成确定顺序，并在事务结束时自动释放。
 */
async function lockEpisodeRenderLifecycle(
  q: QueryFn,
  userId: string,
  episodeId: string,
): Promise<void> {
  await q.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`episode-render-lifecycle:${userId}:${episodeId}`],
  );
}

/**
 * 从 CHAIN_COMPILE 任务 input.groupResults 提取所有组声明的 shotIds（去重）。
 * 用于链任务失败时批量标 FAILED；参考 readTrustedChainShotGroups 的提取路径，
 * 但不需要结果映射校验——失败回滚只需知道 job 声明了哪些镜头。
 * 旧版任务 groupResults 没 shotIds 时返回 null，调用方据此跳过（不能盲标）。
 */
function extractChainFailedShotIds(job: RenderJob): string[] | null {
  if (job.type !== 'CHAIN_COMPILE' || !isRecord(job.input)) return null;
  const inputGroups = Array.isArray(job.input.groupResults) ? job.input.groupResults : [];
  const seen = new Set<string>();
  const shotIds: string[] = [];
  for (const group of inputGroups) {
    if (!isRecord(group) || !Array.isArray(group.shotIds)) continue;
    for (const id of group.shotIds) {
      if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
        seen.add(id);
        shotIds.push(id);
      }
    }
  }
  return shotIds.length > 0 ? shotIds : null;
}

/**
 * 从 CHAIN_COMPILE 任务 input.groupResults[groupIndex] 提取该组实际下发的 prompt。
 * groupResults 与 readTrustedChainShotGroups 返回的 trusted.groups 按索引对齐
 * （按声明顺序映射、不重排），因此用 groupIndex 直查即可。无 params 或 prompt
 * 非非空字符串时返回 null，调用方据此跳过回写（对齐 app1 saveGroupPrompt 的
 * `if (!firstShotId || typeof prompt !== "string") return` 前置守卫）。
 */
function extractChainGroupPrompt(job: RenderJob, groupIndex: number): string | null {
  if (!isRecord(job.input)) return null;
  const inputGroups = Array.isArray(job.input.groupResults) ? job.input.groupResults : [];
  const group = inputGroups[groupIndex];
  if (!isRecord(group) || !isRecord(group.params)) return null;
  const prompt = group.params.prompt;
  return typeof prompt === 'string' && prompt.length > 0 ? prompt : null;
}

/** 在 render_job 终态事务内把每个客户端本地组片写回对应镜头。 */
async function persistChainShotGroups(
  q: QueryFn,
  job: RenderJob,
  result: RenderJobResult,
): Promise<{ projectId: string; episodeId: string } | null> {
  const trusted = readTrustedChainShotGroups(job, result);
  if (!trusted) return null;

  await lockEpisodeRenderLifecycle(q, job.userId, trusted.episodeId);

  const allShotIds = trusted.groups.flatMap((group) => group.shotIds);
  const ownedShots = await q.query(
    `SELECT id FROM shots
      WHERE id=ANY($1::text[]) AND "projectId"=$2 AND "episodeId"=$3
      FOR UPDATE`,
    [allShotIds, trusted.projectId, trusted.episodeId],
  );
  // 归属变化或删除必须让整个终态回滚；不能留下"半组成功"的不可解释状态。
  if (ownedShots.rows.length !== allShotIds.length) {
    throw new Error('CHAIN_COMPILE 组片写回镜头数量不一致');
  }

  for (const [groupIndex, group] of trusted.groups.entries()) {
    const groupUpdate = await q.query(
      `UPDATE shots AS target
          SET "currentMaterialUrl"=$1, "videoStatus"='COMPLETED',
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('materialUpdatedAt', $7::text, 'newSeenCount', 0),
              "updatedAt"=NOW()
        WHERE target.id=ANY($2::text[])
          AND target."projectId"=$3
          AND target."episodeId"=$4
          AND NOT EXISTS (
            SELECT 1
              FROM render_jobs AS newer
              JOIN render_jobs AS current ON current.id=$6
             WHERE newer.user_id=$5
               AND newer.type='CHAIN_COMPILE'
               AND newer.status='COMPLETED'
               AND (
                 newer.created_at > current.created_at
                 OR (newer.created_at = current.created_at AND newer.id > current.id)
               )
               AND EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(
                     CASE
                       WHEN jsonb_typeof(newer.input -> 'groupResults')='array'
                         THEN newer.input -> 'groupResults'
                       ELSE '[]'::jsonb
                     END
                   ) AS newer_group
                  WHERE jsonb_typeof(newer_group -> 'shotIds')='array'
                    AND (newer_group -> 'shotIds') ? target.id
               )
          )`,
      [
        group.videoUrl,
        group.shotIds,
        trusted.projectId,
        trusted.episodeId,
        job.userId,
        job.id,
        new Date().toISOString(),
      ],
    );
    // 行数少于本组并非失败：它表示同一镜头已有"创建时间更晚"的成功任务，
    // 旧客户端迟到的回调必须被静默丢弃，保证素材按派发顺序 last-request-wins。
    // G3-3 对齐 app1 video.worker.ts saveGroupPrompt：仅在本组素材确实落库后
    // （rowCount>0，未被更新的成功任务抢占）才把实际下发 prompt 回写该组首镜
    // metadata，避免迟到旧任务的 prompt 覆盖新任务的 prompt。键名/格式与 dramaforge
    // chain-generate route + group-prompt-snapshot 保持一致（ISO 字符串时间戳）。
    if (groupUpdate.rowCount && groupUpdate.rowCount > 0) {
      const prompt = extractChainGroupPrompt(job, groupIndex);
      const firstShotId = group.shotIds[0];
      if (prompt && firstShotId) {
        await q.query(
          `UPDATE shots
             SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'seedanceGroupPrompt', $1::text,
                   'seedanceGroupPromptUpdatedAt', $2::text
                 ),
                 "updatedAt" = NOW()
           WHERE id = $3
             AND "projectId" = $4
             AND "episodeId" = $5
             -- 用户手改版本（source='user' 且有正文）优先：任务完成回写不覆盖。
             -- 否则渲染窗口内保存的手改版会被派发时固化的 auto 版覆盖，且 source 仍
             -- 为 'user' → 下次生成把被覆盖的 auto 版当用户版原样用（历史 bug 类别）。
             AND (
               COALESCE(metadata, '{}'::jsonb)->>'seedanceGroupPromptSource' IS DISTINCT FROM 'user'
               OR COALESCE(metadata, '{}'::jsonb)->>'seedanceGroupPrompt' IS NULL
               OR COALESCE(metadata, '{}'::jsonb)->>'seedanceGroupPrompt' = ''
             )`,
          [
            prompt,
            new Date().toISOString(),
            firstShotId,
            trusted.projectId,
            trusted.episodeId,
          ],
        );
      }
    }
  }
  return { projectId: trusted.projectId, episodeId: trusted.episodeId };
}

/** 按镜头顺序去重组片 URL；同组多个镜头只进入一次 ffmpeg concat。 */
export function buildEpisodeConcatClips(
  shots: readonly EpisodeShotForConcat[],
): ConcatInput['clips'] {
  const clips: ConcatInput['clips'] = [];
  const indexByUrl = new Map<string, number>();
  for (const shot of shots) {
    const url = shot.currentMaterialUrl!;
    const durationSec = Math.max(0, Number(shot.durationSeconds) || 0);
    const existingIndex = indexByUrl.get(url);
    if (existingIndex === undefined) {
      indexByUrl.set(url, clips.length);
      clips.push({ url, durationSec });
      continue;
    }
    // durationSec 只作审计/进度估算；ffmpeg 仍以本地文件真实时长为准。
    clips[existingIndex].durationSec = (clips[existingIndex].durationSec ?? 0) + durationSec;
  }
  return clips;
}

/**
 * 最后一个子集组片完成后，幂等创建整集 CONCAT。
 *
 * 整集 CHAIN_COMPILE 自身已经输出完整成片，不再重复拼接；只有单镜/成组任务逐步
 * 补齐全剧时才需要额外 CONCAT。分集锁已由 persistChainShotGroups 持有，因此两个
 * 并发完成回调不可能各自插入一条成片任务。
 */
async function maybeCreateEpisodeConcat(
  q: QueryFn,
  sourceJob: RenderJob,
  scope: { projectId: string; episodeId: string } | null,
): Promise<RenderJob | null> {
  if (!scope || sourceJob.type !== 'CHAIN_COMPILE' || !isRecord(sourceJob.input)) return null;

  const shotsResult = await q.query(
    `SELECT id,
            "videoStatus" AS "videoStatus",
            "currentMaterialUrl" AS "currentMaterialUrl",
            "durationSeconds" AS "durationSeconds"
       FROM shots
      WHERE "projectId"=$1 AND "episodeId"=$2
      ORDER BY "sortOrder" ASC, "shotIndex" ASC, id ASC`,
    [scope.projectId, scope.episodeId],
  );
  const shots = shotsResult.rows as EpisodeShotForConcat[];
  if (
    shots.length === 0
    || shots.some((shot) =>
      shot.videoStatus !== 'COMPLETED'
      || typeof shot.currentMaterialUrl !== 'string'
      || shot.currentMaterialUrl.length === 0)
  ) {
    return null;
  }

  const sourceMeta = isRecord(sourceJob.input.filmMeta) ? sourceJob.input.filmMeta : null;
  const sourceShotIds = sourceMeta?.shotIds;
  const sourceCoversWholeEpisode = !Array.isArray(sourceShotIds)
    && sourceMeta?.shotCount === shots.length
    && typeof sourceJob.result?.outputUrl === 'string'
    && sourceJob.result.outputUrl.length > 0;
  // app1 的整集一键串生成会自行 assembleFilm；C/S 的整集 CHAIN_COMPILE 同样如此。
  if (sourceCoversWholeEpisode) return null;

  const activeGeneration = await q.query(
    `SELECT id FROM render_jobs
      WHERE user_id=$1
        AND id<>$2
        AND type='CHAIN_COMPILE'
        AND status IN ('PENDING', 'CLAIMED', 'RUNNING')
        AND input #>> '{filmMeta,episodeId}'=$3
      LIMIT 1`,
    [sourceJob.userId, sourceJob.id, scope.episodeId],
  );
  // 另一个更新任务尚未落定时不能冻结旧素材快照；待它成功回调后再由它派发成片。
  if (activeGeneration.rows.length > 0) return null;

  const existingFilm = await q.query(
    `SELECT id FROM render_jobs
      WHERE user_id=$1
        AND id<>$2
        AND type IN ('CONCAT', 'CHAIN_COMPILE')
        AND status IN ('PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED')
        AND input #>> '{filmMeta,episodeId}'=$3
        AND CASE
              WHEN jsonb_typeof(input #> '{filmMeta,shotIds}')='array'
                THEN jsonb_array_length(input #> '{filmMeta,shotIds}')
              ELSE 0
            END=0
        AND (
          input #>> '{filmMeta,shotCount}' IS NULL
          OR input #>> '{filmMeta,shotCount}'=$4
        )
        AND (
          status IN ('PENDING', 'CLAIMED', 'RUNNING')
          OR COALESCE(result ->> 'outputUrl', '')<>''
        )
      LIMIT 1`,
    [sourceJob.userId, sourceJob.id, scope.episodeId, String(shots.length)],
  );
  if (existingFilm.rows.length > 0) return null;

  const episodeResult = await q.query(
    `SELECT e."episodeNumber" AS "episodeNumber",
            e.title AS "episodeTitle",
            p.title AS "projectTitle"
       FROM episodes AS e
       JOIN projects AS p ON p.id=e."projectId"
      WHERE e.id=$1 AND e."projectId"=$2 AND p."userId"=$3
      LIMIT 1`,
    [scope.episodeId, scope.projectId, sourceJob.userId],
  );
  const episode = episodeResult.rows[0] as {
    episodeNumber?: number | null;
    episodeTitle?: string | null;
    projectTitle?: string | null;
  } | undefined;
  if (!episode) return null;

  const clips = buildEpisodeConcatClips(shots);
  const totalDuration = shots.reduce(
    (sum, shot) => sum + Math.max(0, Number(shot.durationSeconds) || 0),
    0,
  );
  const input: ConcatInput = {
    clips,
    autoCompiled: true,
    sourceRenderJobId: sourceJob.id,
    filmMeta: {
      projectId: scope.projectId,
      episodeId: scope.episodeId,
      episodeNumber: episode.episodeNumber ?? null,
      episodeTitle: episode.episodeTitle ?? null,
      projectTitle: episode.projectTitle ?? null,
      shotCount: shots.length,
      totalDuration,
    },
  };
  const followUpId = genId();
  const followUpTaskId = genId();
  const inserted = await q.query(
    `INSERT INTO render_jobs (id, task_id, user_id, type, input, status)
     VALUES ($1, $2, $3, 'CONCAT', $4::jsonb, 'PENDING')
     RETURNING *`,
    [followUpId, followUpTaskId, sourceJob.userId, JSON.stringify(input)],
  );
  return mapRow(inserted.rows[0] as RenderJobRow);
}

/** 用户作业列表的服务端过滤条件；limit 在仓储内再次收紧。 */
export interface RenderJobListFilters {
  status?: RenderJobStatus;
  type?: RenderJobType;
  projectId?: string;
  limit?: number;
}

/**
 * 创建一个 render_job（status=PENDING）
 *
 * @param id - 可选预生成 id。dispatch 在 mint 确定性 outputKey 时需要
 *             提前知道 id（outputKey = `renders/<userId>/<id>.mp4`），故
 *             允许 dispatch 传入 genId() 的结果；不传则本函数自生成。
 * @returns 新建的 RenderJob（含 id）
 */
export async function create(
  taskId: string,
  userId: string,
  type: RenderJobType,
  input: RenderJobInput,
  id?: string,
): Promise<RenderJob> {
  const resolvedId = id ?? genId();
  const result = await query(
    `INSERT INTO render_jobs (id, task_id, user_id, type, input, status)
     VALUES ($1, $2, $3, $4, $5, 'PENDING')
     RETURNING *`,
    [resolvedId, taskId, userId, type, JSON.stringify(input)],
  );
  return mapRow(result.rows[0] as RenderJobRow);
}

/**
 * 原子创建或复用同一分集、同一镜头范围的 CHAIN_COMPILE 作业。
 *
 * 旧实现是"先 SELECT、后 INSERT"两个独立语句：两个并发点击都可能先读到空值，
 * 随后各插一行。这里用 scope advisory xact lock 把检查与插入放进同一事务，既不
 * 需要写死项目数量，也能覆盖多 web 实例。返回既有作业时保留其原 taskId，前端
 * 才能真正接管 SSE/轮询，而不是只拿到一个无法追踪的 renderJobId。
 */
export async function createOrReuseChainGenerate(
  taskId: string,
  userId: string,
  input: ChainCompileInput,
): Promise<ChainGenerateDispatchResult> {
  const filmMeta = input.filmMeta;
  const episodeId = filmMeta?.episodeId;
  if (typeof episodeId !== 'string' || episodeId.length === 0) {
    return { job: await create(taskId, userId, 'CHAIN_COMPILE', input), reused: false };
  }

  const shotIds = Array.isArray(input.filmMeta?.shotIds) ? input.filmMeta.shotIds : null;
  const scopeKey = JSON.stringify(shotIds);
  return tx(async (q) => {
    // 与完成回调使用同一分集锁，确保"新任务入队"和"最后一组触发 CONCAT"互相可见；
    // 否则一个尚未提交的 PENDING 重生任务可能被完整性检查漏掉，冻结旧素材快照。
    await lockEpisodeRenderLifecycle(q, userId, episodeId);
    await q.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`chain-dispatch:${userId}:${episodeId}:${scopeKey}`],
    );

    const existing = await q.query(
      `SELECT * FROM render_jobs
        WHERE user_id=$1
          AND type IN ('CHAIN_COMPILE', 'CONCAT')
          AND status IN ('PENDING', 'CLAIMED', 'RUNNING')
          AND input #>> '{filmMeta,episodeId}'=$2
          AND COALESCE(input #> '{filmMeta,shotIds}', 'null'::jsonb)
              = COALESCE($3::jsonb, 'null'::jsonb)
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId, episodeId, shotIds ? JSON.stringify(shotIds) : null],
    );
    if (existing.rows[0]) {
      return {
        job: mapRow(existing.rows[0] as RenderJobRow),
        reused: true,
      };
    }

    const id = genId();
    const inserted = await q.query(
      `INSERT INTO render_jobs (id, task_id, user_id, type, input, status)
       VALUES ($1, $2, $3, 'CHAIN_COMPILE', $4::jsonb, 'PENDING')
       RETURNING *`,
      [id, taskId, userId, JSON.stringify(input)],
    );
    return {
      job: mapRow(inserted.rows[0] as RenderJobRow),
      reused: false,
    };
  });
}

/**
 * 回收当前用户的超时租约，再原子认领下一个 PENDING render_job。
 *
 * 用 tx + FOR UPDATE SKIP LOCKED：多个客户端并发调用互不拿到同一行。
 * 跳过被锁定的行，避免热点行阻塞其他 worker。
 *
 * @param userId - 仅从当前用户的待处理作业中认领
 * @param machineId - 客户端机器标识（写入 claimed_by 用于进度/结果校验）
 * @returns 认领到的 RenderJob，或 null（无 PENDING 行）
 */
export async function claimNext(
  userId: string,
  machineId: string,
): Promise<RenderJob | null> {
  return tx(async (q) => {
    await q.query(
      `UPDATE render_jobs
         SET status='PENDING', claimed_by=NULL, claim_token=NULL,
             claimed_at=NULL, heartbeat_at=NULL, completed_at=NULL,
             error=NULL, result=NULL
       WHERE user_id=$1
         AND status IN ('CLAIMED', 'RUNNING')
         AND (
           COALESCE(heartbeat_at, claimed_at) <
               now() - make_interval(secs => $2::double precision / 1000.0)
           OR claimed_at <
               now() - make_interval(secs =>
                 CASE
                   WHEN type = 'LONG_VIDEO_REWRITE' THEN ${MAX_CLAIM_DURATION_SECONDS_BY_TYPE.LONG_VIDEO_REWRITE}::double precision
                   ELSE ${MAX_CLAIM_DURATION_SECONDS}::double precision
                 END
               )
         )`,
      [userId, DEFAULT_RENDER_JOB_LEASE_TIMEOUT_MS],
    );

    const claimToken = genId();
    const result = await q.query(
      `UPDATE render_jobs
         SET status='CLAIMED', claimed_by=$2, claim_token=$3,
             claimed_at=now(), heartbeat_at=now(), completed_at=NULL,
             error=NULL, result=NULL
       WHERE id = (
         SELECT id FROM render_jobs
         WHERE status='PENDING'
           AND user_id=$1
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [userId, machineId, claimToken],
    );
    return result.rows[0] ? mapRow(result.rows[0] as RenderJobRow) : null;
  });
}

/**
 * 标记 render_job 为 RUNNING（客户端开始执行 ffmpeg）
 */
export async function markRunning(
  id: string,
  userId: string,
  machineId: string,
  claimToken: string,
  progress?: number,
  stage?: string,
): Promise<RenderJob | null> {
  // progress/stage 可选：/progress 路由每次上报带上，持久化到行——根治刷新 / 4s 轮询 /
  // 直接查行看到 0% 假死（曾导致误判 cancel 健康推进中的链）。其它调用方不传 = 原行为
  // （仅推进 status='RUNNING' + heartbeat）。progress 钳 0-100；stage 空串视为不传。
  const setClauses = ["status='RUNNING'", 'heartbeat_at=now()'];
  const params: unknown[] = [];
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    params.push(Math.max(0, Math.min(100, Math.round(progress))));
    setClauses.push(`progress=$${params.length}`);
  }
  if (typeof stage === 'string' && stage.length > 0) {
    params.push(stage);
    setClauses.push(`stage=$${params.length}`);
  }
  const w = params.length + 1;
  params.push(id, userId, machineId, claimToken);
  const result = await query(
    `UPDATE render_jobs
        SET ${setClauses.join(', ')}
      WHERE id=$${w}
        AND user_id=$${w + 1}
        AND claimed_by=$${w + 2}
        AND claim_token=$${w + 3}
        AND status IN ('CLAIMED', 'RUNNING')
      RETURNING *`,
    params,
  );
  return result.rows[0] ? mapRow(result.rows[0] as RenderJobRow) : null;
}

/**
 * 把一组渐进回传片段 append 到 render_jobs.progress_clips（仅本人在跑的作业）。
 *
 * 每组完成时 /progress 路由调用：把 {shotIds, videoUrl} 追加到行内 JSONB 数组，供
 * 恢复端点 GET /api/tasks/[taskId] 读 progressClips 把已完成组翻成视频——不再依赖
 * task_events（其 "taskId" 外键到 tasks，而 CHAIN_COMPILE 只插 render_jobs 不入 tasks，
 * groupClip 永不落 task_events 正是刷新丢渐进片的根因）。
 *
 * owner + 状态守卫防伪造（只本人在 CLAIMED/RUNNING 的作业接受 append）。前端
 * applyProgressClips 按 shotId 幂等覆盖，故偶发重复 append 无害。
 */
export async function appendGroupClip(
  id: string,
  userId: string,
  clip: RenderJobGroupClip,
): Promise<void> {
  await query(
    `UPDATE render_jobs
        SET progress_clips = progress_clips || $3::jsonb
      WHERE id = $1
        AND user_id = $2
        AND status IN ('CLAIMED', 'RUNNING')`,
    [id, userId, JSON.stringify([clip])],
  );
}

/**
 * 标记 render_job 为 COMPLETED 并写入结果
 */
export async function markResult(
  id: string,
  userId: string,
  machineId: string,
  claimToken: string,
  result: RenderJobResult,
): Promise<RenderJobTransition> {
  const encodedResult = JSON.stringify(result);
  return tx(async (q) => {
    const applied = await q.query(
      `UPDATE render_jobs
         SET status='COMPLETED', result=$5::jsonb, error=NULL,
             completed_at=now(), heartbeat_at=now()
       WHERE id=$1
         AND user_id=$2
         AND claimed_by=$3
         AND claim_token=$4
         AND status='RUNNING'
       RETURNING *`,
      [id, userId, machineId, claimToken, encodedResult],
    );
    if (applied.rows[0]) {
      const job = mapRow(applied.rows[0] as RenderJobRow);
      // 与 COMPLETED 状态共用同一事务，保证刷新时不会观察到"任务完成但镜头仍待生成"。
      let episodeScope: { projectId: string; episodeId: string } | null;
      try {
        episodeScope = await persistChainShotGroups(q, job, result);
      } catch (validationError) {
        // 组片完整性校验失败（镜头映射不全/无效/地址非法）：strict 模式跳过了被 AI 拒
        // 的镜头，客户端只上报成功组 → resultGroups 与 expectedGroups 不等长 → 门禁抛错。
        // 但已成功的镜头不该被连坐：先从 result.meta.groupClips 按白名单挑出成功组回写
        // COMPLETED（让用户看到已生成片段），只把缺失的镜头标 FAILED + videoError。
        // 区分两种结局（"跳过 vs 完成"两套逻辑）：
        //   - ≥1 组成功 → job 判 COMPLETED（部分完成）：result.meta 带 partialCompleted=true +
        //     failedGroups，但 outputUrl 为空（部分片不算整集成片，不阻塞 retry→CONCAT）。
        //   - 0 组成功 → job 维持 FAILED + result=NULL（用户拿 0 产出，对齐 failed route 退款）。
        // 原 G3-1 把全部声明镜头标 FAILED，连成功的也毁（4928 连续 4 条同死法）；现已按子集回写。
        const partial = readPartialTrustedChainShotGroups(job, result);
        const persistedShotIds = partial
          ? await persistPartialShotGroups(q, job, partial)
          : new Set<string>();
        const reason = validationError instanceof Error
          ? validationError.message
          : String(validationError);
        // 只把【未成功回写】的声明镜头标 FAILED；已 COMPLETED 的不动（IS DISTINCT FROM 守卫）。
        // partial 为 null（非 CHAIN_COMPILE / 旧版无 shotIds / 无 filmMeta）时退回原全标行为。
        const declaredShotIds = partial ? partial.allDeclaredShotIds : extractChainFailedShotIds(job);
        if (declaredShotIds && declaredShotIds.length > 0) {
          const missingShotIds = declaredShotIds.filter((sid) => !persistedShotIds.has(sid));
          if (missingShotIds.length > 0) {
            await q.query(
              `UPDATE shots
                 SET "videoStatus"='FAILED', "updatedAt"=NOW()
               WHERE id = ANY($1::text[])
                 AND "videoStatus" IS DISTINCT FROM 'COMPLETED'`,
              [missingShotIds],
            );
          }
        }
        // 把客户端上报的每组失败错误写到对应镜头 metadata.videoError，前端在失败的镜头组旁
        // 展示具体报错（"把报错详细内容写在出现错误的镜头组旁边"）。成功回写的镜头清掉 videoError
        // （防上轮失败残留）。仅 partial 非 null（CHAIN_COMPILE + 有 shotIds 声明）时执行。
        if (partial) {
          const groupErrors = isRecord(result.meta) && Array.isArray(result.meta.failedGroupErrors)
            ? result.meta.failedGroupErrors
            : [];
          for (const fe of groupErrors) {
            if (!isRecord(fe) || !Array.isArray(fe.shotIds) || fe.shotIds.length === 0) continue;
            const shotIds = fe.shotIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
            if (shotIds.length === 0) continue;
            const errMsg = typeof fe.error === 'string' ? fe.error.slice(0, 500) : String(fe.error ?? '');
            if (!errMsg) continue;
            await q.query(
              `UPDATE shots
                  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('videoError', $1::text),
                      "updatedAt" = NOW()
                WHERE id = ANY($2::text[])
                  AND "projectId" = $3 AND "episodeId" = $4
                  AND "videoStatus" IS DISTINCT FROM 'COMPLETED'`,
              [errMsg, shotIds, partial.projectId, partial.episodeId],
            );
          }
          if (persistedShotIds.size > 0) {
            await q.query(
              `UPDATE shots
                  SET metadata = metadata - 'videoError', "updatedAt" = NOW()
                WHERE id = ANY($1::text[])
                  AND "projectId" = $2 AND "episodeId" = $3`,
              [[...persistedShotIds], partial.projectId, partial.episodeId],
            );
          }
        }
        // 部分完成（≥1 组成功）：job 判 COMPLETED，保留 result.meta 透传统计 + 标 partialCompleted，
        // 但 outputUrl 为空（部分片不算整集成片；maybeCreateEpisodeConcat 的 existingFilm 查询要求
        // outputUrl<>'' 才算整片，故不阻塞后续 retry 失败组→全 COMPLETED→CONCAT）。
        if (partial && persistedShotIds.size > 0) {
          const partialResult = {
            ...result,
            outputUrl: undefined,
            meta: { ...(isRecord(result.meta) ? result.meta : {}), partialCompleted: true },
          };
          await q.query(
            `UPDATE render_jobs
               SET status='COMPLETED', result=$2::jsonb, error=NULL,
                   completed_at=now(), heartbeat_at=now()
             WHERE id=$1`,
            [id, JSON.stringify(partialResult)],
          );
          const partialRow = await q.query(
            `SELECT * FROM render_jobs WHERE id=$1`,
            [id],
          );
          return {
            outcome: 'partial_completed',
            job: mapRow(partialRow.rows[0] as RenderJobRow),
          };
        }
        // 0 组成功：维持原 FAILED + result=NULL（用户拿 0 产出，对齐 failed route 退款）。
        await q.query(
          `UPDATE render_jobs
             SET status='FAILED', error=$2, result=NULL,
                 completed_at=now(), heartbeat_at=now()
           WHERE id=$1`,
          [id, `[CHAIN_COMPILE 组片校验失败] ${reason}`],
        );
        const failedRow = await q.query(
          `SELECT * FROM render_jobs WHERE id=$1`,
          [id],
        );
        return {
          outcome: 'failed_validation',
          job: mapRow(failedRow.rows[0] as RenderJobRow),
        };
      }
      // app1 对齐：只有最后一组让全镜头齐备时才派发整集 CONCAT；该派发与镜头
      // 写回共享事务和分集锁，不会出现双成片或"完成事件先到、合片尚未入队"。
      const followUpJob = await maybeCreateEpisodeConcat(q, job, episodeScope);
      return {
        outcome: 'applied',
        job,
        ...(followUpJob ? { followUpJob } : {}),
      };
    }

    const inspected = await q.query(
      `SELECT render_jobs.*,
              (user_id=$2 AND claimed_by=$3 AND claim_token=$4
               AND result=$5::jsonb) AS payload_matches
         FROM render_jobs
        WHERE id=$1
        FOR UPDATE`,
      [id, userId, machineId, claimToken, encodedResult],
    );
    const row = inspected.rows[0] as (RenderJobRow & { payload_matches: boolean }) | undefined;
    if (row?.status === 'COMPLETED' && row.payload_matches === true) {
      return { outcome: 'already_applied', job: mapRow(row) };
    }
    return { outcome: 'rejected', job: row ? mapRow(row) : null };
  });
}

/**
 * 标记 render_job 为 FAILED 并写入错误信息
 */
export async function markFailed(
  id: string,
  userId: string,
  machineId: string,
  claimToken: string,
  error: string,
): Promise<RenderJobTransition> {
  return tx(async (q) => {
    const applied = await q.query(
      `UPDATE render_jobs
         SET status='FAILED', error=$5, result=NULL,
             completed_at=now(), heartbeat_at=now()
       WHERE id=$1
         AND user_id=$2
         AND claimed_by=$3
         AND claim_token=$4
         AND status='RUNNING'
       RETURNING *`,
      [id, userId, machineId, claimToken, error],
    );
    if (applied.rows[0]) {
      const job = mapRow(applied.rows[0] as RenderJobRow);
      // G3-1 链失败镜头级联：尽量保住已成功组，只把未保住的声明镜头标 FAILED。
      // 渐进回传(progress_clips)由已鉴权的 /progress 端点写入(信任等级同 /result)，
      // 失败时复用 partial 安全门禁把它们标 COMPLETED——不另开信任口，白名单 shotIds
      // 子集校验全走 readPartialTrustedChainShotGroups/persistPartialShotGroups。
      // job 终态仍 FAILED(无整片产出)，仅镜头级保住成果，重跑时 chain-generate route
      // 的 shouldReuseGroupVideo 自动跳过这些组(省钱)。对齐 app1 failShots()：只标
      // input.groupResults 声明的 shotIds，已 COMPLETED 的不动(旧失败回调不破坏新成功)。
      if (job.type === 'CHAIN_COMPILE') {
        let persistedShotIds = new Set<string>();
        let declaredShotIds: string[] | null = extractChainFailedShotIds(job);
        if (job.progressClips.length > 0) {
          const pseudoResult: RenderJobResult = {
            meta: {
              groupClips: job.progressClips.map((clip) => ({
                shotIds: clip.shotIds,
                videoUrl: clip.videoUrl,
                localKey: clip.videoUrl.startsWith('sf-asset://')
                  ? clip.videoUrl.slice('sf-asset://'.length) : '',
              })),
            },
          };
          const partial = readPartialTrustedChainShotGroups(job, pseudoResult);
          if (partial) {
            declaredShotIds = partial.allDeclaredShotIds;
            if (partial.persistedGroups.length > 0) {
              persistedShotIds = await persistPartialShotGroups(q, job, partial);
            }
          }
        }
        const missingShotIds = (declaredShotIds ?? []).filter((sid) => !persistedShotIds.has(sid));
        if (missingShotIds.length > 0) {
          await q.query(
            `UPDATE shots
               SET "videoStatus"='FAILED', "updatedAt"=NOW()
             WHERE id = ANY($1::text[])
               AND "videoStatus" IS DISTINCT FROM 'COMPLETED'`,
            [missingShotIds],
          );
        }
      }
      return { outcome: 'applied', job };
    }

    const inspected = await q.query(
      `SELECT * FROM render_jobs WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const row = inspected.rows[0] as RenderJobRow | undefined;
    if (
      row?.status === 'FAILED' &&
      row.user_id === userId &&
      row.claimed_by === machineId &&
      row.claim_token === claimToken &&
      row.error === error
    ) {
      return { outcome: 'already_applied', job: mapRow(row) };
    }
    return { outcome: 'rejected', job: row ? mapRow(row) : null };
  });
}

/**
 * 统计某用户当前活动认领数（CLAIMED + RUNNING），跨机器合计。
 *
 * 供 /api/render/jobs/next 做 per-user 并发硬上限：用户已认领数达到
 * users."maxConcurrent" 时不再发新 job（204）。终态（COMPLETED/FAILED/
 * CANCELLED）自动退出计数，不占位。刚崩溃客户端的残留行最多占住上限
 * ~一个回收周期（heartbeat 2min / reapStale 60s 扫描），客户端 5s 轮询自愈。
 */
export async function countActiveClaims(userId: string): Promise<number> {
  const r = await query(
    `SELECT count(*)::int AS n FROM render_jobs
      WHERE user_id = $1 AND status IN ('CLAIMED','RUNNING')`,
    [userId],
  );
  return (r.rows[0] as { n?: number } | undefined)?.n ?? 0;
}

/**
 * 回收超时 CLAIMED/RUNNING 行：重置为 PENDING 重新派发
 *
 * 客户端崩溃/断网会导致活动租约永远不回执；本函数按最后 heartbeat
 * （旧数据回退 claimed_at）把超时行重置回 PENDING。
 *
 * @param timeoutMs - 超时阈值（毫秒）
 * @returns 重置的行数
 */
export async function reapStale(timeoutMs: number): Promise<number> {
  // 先收集要回收的 CHAIN_COMPILE job 涉及的 shotIds——回收后镜头必须回 PENDING，
  // 否则客户端崩溃→job 回收→重新认领前镜头永久卡 GENERATING（前端转圈）。
  // 非 CHAIN_COMPILE job（CONCAT/SPLIT 等）无 shotIds 声明，extractChainFailedShotIds 返回 null 跳过。
  const staleCond = `status IN ('CLAIMED', 'RUNNING')
       AND (
         COALESCE(heartbeat_at, claimed_at) <
             now() - make_interval(secs => $1::double precision / 1000.0)
         OR claimed_at <
             now() - make_interval(secs =>
               CASE
                 WHEN type = 'LONG_VIDEO_REWRITE' THEN ${MAX_CLAIM_DURATION_SECONDS_BY_TYPE.LONG_VIDEO_REWRITE}::double precision
                 ELSE ${MAX_CLAIM_DURATION_SECONDS}::double precision
               END
             )
       )`;
  const stale = await query(
    `SELECT * FROM render_jobs WHERE ${staleCond}`,
    [timeoutMs],
  );
  const shotIdSet = new Set<string>();
  for (const row of stale.rows) {
    const ids = extractChainFailedShotIds(mapRow(row as RenderJobRow));
    if (ids) for (const sid of ids) shotIdSet.add(sid);
  }
  const result = await query(
    `UPDATE render_jobs
       SET status='PENDING', claimed_by=NULL, claim_token=NULL,
           claimed_at=NULL, heartbeat_at=NULL, completed_at=NULL,
           error=NULL, result=NULL
     WHERE ${staleCond}`,
    [timeoutMs],
  );
  if (shotIdSet.size > 0) {
    // 回 PENDING（租约丢失≠失败，可能重新认领重跑；已 COMPLETED 不动防误伤）。
    await query(
      `UPDATE shots SET "videoStatus"='PENDING', "updatedAt"=NOW()
       WHERE id = ANY($1::text[]) AND "videoStatus" IS DISTINCT FROM 'COMPLETED'`,
      [[...shotIdSet]],
    );
  }
  return result.rowCount ?? 0;
}

/**
 * 按 id 查询单个 render_job
 *
 * @returns RenderJob，或 null（不存在）
 */
export async function getById(id: string): Promise<RenderJob | null> {
  const result = await query(
    `SELECT * FROM render_jobs WHERE id=$1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0] as RenderJobRow) : null;
}

/**
 * 列出当前用户的作业，供全局/分集任务状态条恢复页面状态。
 *
 * projectId 兼容两种已落库 input 形状：成片任务放在 filmMeta.projectId，
 * 长视频任务放在 input.projectId。查询始终以 user_id 为第一过滤条件。
 */
export async function listByUser(
  userId: string,
  filters: RenderJobListFilters = {},
): Promise<RenderJob[]> {
  const clauses = ['user_id=$1'];
  const params: unknown[] = [userId];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.status) clauses.push(`status=${addParam(filters.status)}`);
  if (filters.type) clauses.push(`type=${addParam(filters.type)}`);
  if (filters.projectId) {
    const projectParam = addParam(filters.projectId);
    clauses.push(
      `(input #>> '{filmMeta,projectId}'=${projectParam} OR input->>'projectId'=${projectParam})`,
    );
  }

  // 防止未来调用方把列表端点变成无界全表扫描。
  const limit = Math.max(1, Math.min(200, Math.trunc(filters.limit ?? 100)));
  const limitParam = addParam(limit);
  const result = await query(
    `SELECT * FROM render_jobs
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ${limitParam}`,
    params,
  );
  return result.rows.map((row) => mapRow(row as RenderJobRow));
}

/**
 * 按 taskId 查询当前用户最近的一条 render_job。
 *
 * taskId 是 SSE 与 GenerationProgress 的公共标识；userId 必须进入 SQL 条件，
 * 不能先查任意用户再在应用层过滤，否则重复 taskId 会让合法用户误命中 404。
 */
export async function getByTaskId(
  taskId: string,
  userId: string,
): Promise<RenderJob | null> {
  const result = await query(
    `SELECT * FROM render_jobs
      WHERE task_id=$1 AND user_id=$2
      ORDER BY created_at DESC
      LIMIT 1`,
    [taskId, userId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as RenderJobRow) : null;
}

/**
 * 取消尚未进入终态的作业。状态更新带 userId 与 active 状态条件，防止越权和
 * 并发完成覆盖；迟到的客户端 result/failed 回调会因 RUNNING CAS 失败被拒绝。
 */
export async function cancel(id: string, userId: string): Promise<RenderJob | null> {
  const result = await query(
    `UPDATE render_jobs
        SET status='CANCELLED', error='用户已取消', completed_at=now(), heartbeat_at=now()
      WHERE id=$1 AND user_id=$2
        AND status IN ('PENDING', 'CLAIMED', 'RUNNING')
      RETURNING *`,
    [id, userId],
  );
  const cancelled = result.rows[0] ? mapRow(result.rows[0] as RenderJobRow) : null;
  if (cancelled) {
    // 取消 CHAIN_COMPILE 时把镜头回 PENDING（取消≠失败，用户可重试）；已 COMPLETED 不动
    // （防迟到回调/旧任务误伤新成功结果）。与 markFailed 的 G3-1 镜像，但语义是"回可重试"非"失败"。
    const shotIds = extractChainFailedShotIds(cancelled);
    if (shotIds && shotIds.length > 0) {
      await query(
        `UPDATE shots SET "videoStatus"='PENDING', "updatedAt"=NOW()
         WHERE id = ANY($1::text[]) AND "videoStatus" IS DISTINCT FROM 'COMPLETED'`,
        [shotIds],
      );
    }
  }
  return cancelled;
}

/**
 * 把失败或已取消作业恢复为 PENDING，并清空上一轮租约与终态数据。
 * 复用原 job/taskId，使 SSE 订阅和 UI 持久化引用无需换 ID。
 */
export async function retry(id: string, userId: string): Promise<RenderJob | null> {
  const result = await query(
    `UPDATE render_jobs
        SET status='PENDING', claimed_by=NULL, claim_token=NULL,
            claimed_at=NULL, heartbeat_at=NULL, completed_at=NULL,
            error=NULL, result=NULL
      WHERE id=$1 AND user_id=$2 AND status IN ('FAILED', 'CANCELLED')
      RETURNING *`,
    [id, userId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as RenderJobRow) : null;
}

/**
 * 2026-08-03 历史版本修复：重试不再原地重置，而是复制为全新 job（新 id + 新 taskId）。
 *
 * 原地重置（retry）会让客户端用同一个 jobId 重跑：本地成片文件名
 * <jobId>.mp4 / <jobId>-group-N.mp4 被覆盖，films 记录被清空重写，
 * 旧版本文件与引用全部丢失——用户反馈"重新生成后旧版找不回"（第五集案例）。
 *
 * 复制新 job 后：旧 job 保留 FAILED/CANCELLED 终态记录（含 error 历史），
 * 新 job 用新 jobId 落新文件名，客户端认领新 job；完成后 films 库自然出现
 * 两个版本，成片面板按集分组已支持展示全部版本（时间倒序）。
 *
 * 兼容性：非 CHAIN_COMPILE input 原样复制；CHAIN_COMPILE 把已保住的组改 pass-through
 * （见 rewriteChainRetryInput），其余原样。taskId 全新（SSE/轮询按新 taskId 跟踪，不与旧记录冲突）。
 */
/**
 * 收集 CHAIN_COMPILE input 声明的全部 shotIds 的当前状态，供重试时判定哪些组可复用。
 * 作用域内的小工具（与 extractChainFailedShotIds 的提取逻辑重复，刻意隔离不抽公共
 * helper，对齐 persistPartialShotGroups 的 NOTE 取舍）。
 */
async function readChainInputShotStates(
  input: unknown,
): Promise<Map<string, { videoStatus: string | null; currentMaterialUrl: string | null }>> {
  const states = new Map<string, { videoStatus: string | null; currentMaterialUrl: string | null }>();
  if (!isRecord(input) || !Array.isArray(input.groupResults)) return states;
  const shotIds: string[] = [];
  const seen = new Set<string>();
  for (const group of input.groupResults) {
    if (!isRecord(group) || !Array.isArray(group.shotIds)) continue;
    for (const id of group.shotIds) {
      if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
        seen.add(id);
        shotIds.push(id);
      }
    }
  }
  if (shotIds.length === 0) return states;
  const res = await query(
    `SELECT id, "videoStatus", "currentMaterialUrl" FROM shots WHERE id = ANY($1::text[])`,
    [shotIds],
  );
  for (const r of res.rows as Array<{
    id: string;
    videoStatus: string | null;
    currentMaterialUrl: string | null;
  }>) {
    states.set(r.id, { videoStatus: r.videoStatus, currentMaterialUrl: r.currentMaterialUrl });
  }
  return states;
}

/**
 * 重写 CHAIN_COMPILE input.groupResults：把"整组 COMPLETED + 同一可复用 sf-asset:// URL"
 * 的组改成 pass-through（去 params 带 url，客户端跳过重生成）；其余组强制重生成
 * （保留 params、清 url，避免把陈旧 url 误当 pass-through）。镜像 chain-generate route
 * 的 shouldReuseGroupVideo 判定。复用仅认 sf-asset://（chain 组视频的本地契约），保守。
 */
function rewriteChainRetryInput(
  input: unknown,
  shotStates: Map<string, { videoStatus: string | null; currentMaterialUrl: string | null }>,
): unknown {
  if (!isRecord(input) || !Array.isArray(input.groupResults)) return input;
  const groupResults = input.groupResults.map((group) => {
    if (!isRecord(group) || !Array.isArray(group.shotIds)) return group;
    const shotIds = group.shotIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (shotIds.length === 0) return group;
    const states = shotIds.map((sid) => shotStates.get(sid));
    const allCompleted = states.every((s) => s?.videoStatus === 'COMPLETED');
    const urls = states.map((s) => s?.currentMaterialUrl ?? '');
    const reusable = allCompleted
      && new Set(urls).size === 1
      && typeof urls[0] === 'string'
      && urls[0].startsWith('sf-asset://');
    if (reusable) {
      return { shotIds, url: urls[0] };               // pass-through：跳过重生成
    }
    return { shotIds, params: group.params ?? {}, url: '' }; // 强制重生成
  });
  return { ...input, groupResults };
}

export async function createRetryCopy(
  id: string,
  userId: string,
): Promise<RenderJob | null> {
  const existing = await query(
    `SELECT * FROM render_jobs
      WHERE id=$1 AND user_id=$2 AND status IN ('FAILED', 'CANCELLED')`,
    [id, userId],
  );
  const row = existing.rows[0] as RenderJobRow | undefined;
  if (!row) return null;

  // CHAIN_COMPILE 重试复用：把已保住的组（B1 markFailed 从 progress_clips 标的
  // COMPLETED + sf-asset://）改成 pass-through，客户端只补失败组（省钱）。
  const inputToInsert = row.type === 'CHAIN_COMPILE'
    ? rewriteChainRetryInput(row.input, await readChainInputShotStates(row.input))
    : row.input;

  const newId = genId();
  const newTaskId = genId();
  const inserted = await query(
    `INSERT INTO render_jobs
       (id, task_id, user_id, type, input, status, progress, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', 0, NOW(), NOW())
     RETURNING *`,
    [newId, newTaskId, row.user_id, row.type, JSON.stringify(inputToInsert)],
  );
  return mapRow(inserted.rows[0] as RenderJobRow);
}

/**
 * 管理员/运维强制失败：不需要 lease token，从 PENDING/CLAIMED/RUNNING 任一非终态
 * CAS 到 FAILED，并复刻 markFailed 的 G3-1 镜头级联（CHAIN_COMPILE 声明的 shots→FAILED）。
 *
 * 用途：CHAIN_COMPILE 假死（client loop.ts renewLease 心跳定时器仍续租但 executeJob 卡死，
 * reapStale 的 2min 心跳条件永不触发、20min 硬 cap 还没到）时运维需要提前手动止血。
 * 裸 SQL `UPDATE render_jobs SET status='FAILED'` 会绕过 markFailed 的镜头级联，导致
 * shots 永久卡 GENERATING、前端转圈刷新也不停（见 dramaforge-manual-intervene-shots-stuck）；
 * 本函数提供"正确级联"的入口（经 admin route / 运维脚本调用，杜绝裸 UPDATE）。
 *
 * 与 markFailed 的差异：无 lease 校验（运维没有客户端的 claim_token）、从任一非终态都可
 * 推进。返回 shotIds 供调用方发 SSE FAILED 事件，让前端实时停转（不必等刷新）。
 */
export async function forceFail(
  id: string,
  reason: string,
): Promise<
  | { outcome: 'applied'; job: RenderJob; shotIds: string[] | null }
  | { outcome: 'already_terminal'; job: RenderJob | null }
> {
  return tx(async (q) => {
    const applied = await q.query(
      `UPDATE render_jobs
         SET status='FAILED', error=$2, result=NULL,
             completed_at=now(), heartbeat_at=now()
       WHERE id=$1
         AND status IN ('PENDING', 'CLAIMED', 'RUNNING')
       RETURNING *`,
      [id, reason],
    );
    if (!applied.rows[0]) {
      const cur = await q.query(`SELECT * FROM render_jobs WHERE id=$1`, [id]);
      return {
        outcome: 'already_terminal',
        job: cur.rows[0] ? mapRow(cur.rows[0] as RenderJobRow) : null,
      };
    }
    const job = mapRow(applied.rows[0] as RenderJobRow);
    // G3-1 级联（镜像 markFailed）：链任务失败时把声明的 shots 标 FAILED，
    // 已 COMPLETED 不动防误伤新成功结果。
    const shotIds = extractChainFailedShotIds(job);
    if (shotIds && shotIds.length > 0) {
      await q.query(
        `UPDATE shots
           SET "videoStatus"='FAILED', "updatedAt"=NOW()
         WHERE id = ANY($1::text[])
           AND "videoStatus" IS DISTINCT FROM 'COMPLETED'`,
        [shotIds],
      );
    }
    return { outcome: 'applied', job, shotIds };
  });
}

/**
 * 终态级联兜底 sweep：扫近 24h 终态 CHAIN_COMPILE job，把它声明但仍卡 GENERATING
 * 的镜头强制对齐（FAILED job→FAILED，CANCELLED job→PENDING）。幂等（只动 GENERATING）。
 *
 * 兜底任何绕过 markFailed/cancel/retry/reapStale 镜头级联的路径：裸 SQL UPDATE、级联
 * 事务中途崩溃、将来的 bug。让"镜头永久卡 GENERATING → 前端转圈刷新也不停"不可能
 * 发生（最多滞后一个 sweep 周期 60s）。借宿 ai-worker 60s 定时（仿 reapStale）。
 *
 * @returns 本次修正的镜头行数
 */
export async function sweepStuckShots(): Promise<number> {
  const jobs = await query(
    `SELECT * FROM render_jobs
      WHERE type='CHAIN_COMPILE'
        AND status IN ('FAILED', 'CANCELLED')
        AND completed_at > now() - interval '24 hours'`,
  );
  let fixed = 0;
  for (const row of jobs.rows) {
    const job = mapRow(row as RenderJobRow);
    const shotIds = extractChainFailedShotIds(job);
    if (!shotIds || shotIds.length === 0) continue;
    const target = job.status === 'CANCELLED' ? 'PENDING' : 'FAILED';
    const r = await query(
      `UPDATE shots SET "videoStatus"=$1, "updatedAt"=NOW()
        WHERE id = ANY($2::text[]) AND "videoStatus"='GENERATING'`,
      [target, shotIds],
    );
    fixed += r.rowCount ?? 0;
  }
  return fixed;
}

/**
 * Zombie job 回收：检测 RUNNING + heartbeat 新鲜但 progress 长时间不动（>10min）的 job。
 *
 * 这类 job 的客户端 executeJob 卡死了（死锁/网络挂起/ffmpeg hang），但 heartbeat 续租定时器
 * 仍在跑，导致 reapStale 的 heartbeat 超时条件永不触发。如果只看 heartbeat，会认为 job
 * 还活着，shots 永久卡 GENERATING。
 *
 * 判定：status=RUNNING + progress 未达 100 + 最后 heartbeat 距上次 progress 更新超过 staleMs。
 * 实现上复用 heartbeat_at 作为 progress 变更的代理时间戳（markRunning 每次更新都写 heartbeat_at
 * + progress），因此 heartbeat_at 更新但 progress 不变 = zombie。为避免误杀正常长转码，用
 * 一个较长的 staleMs（默认 15min）。
 */
export async function reapZombieJobs(staleMs: number): Promise<number> {
  // 找 RUNNING 且 heartbeat 新鲜（<2min，否则 reapStale 会处理）但 claimed 后超过 staleMs 的 job。
  // 长时间 RUNNING 且没有 progress 推进 = zombie。
  const result = await query(
    `SELECT * FROM render_jobs
      WHERE status = 'RUNNING'
        AND progress < 100
        AND heartbeat_at IS NOT NULL
        AND heartbeat_at > now() - interval '2 minutes'
        AND claimed_at < now() - make_interval(secs => $1::double precision / 1000.0)`,
    [staleMs],
  );
  if (result.rows.length === 0) return 0;
  const shotIdSet = new Set<string>();
  for (const row of result.rows) {
    const ids = extractChainFailedShotIds(mapRow(row as RenderJobRow));
    if (ids) for (const sid of ids) shotIdSet.add(sid);
    const r = row as RenderJobRow;
    console.warn(
      `[render-jobs] zombie job ${r.id}: RUNNING ${r.progress}% ` +
      `for >${Math.round(staleMs / 60000)}min with fresh heartbeat, force-failing`,
    );
  }
  // 回收到 PENDING（跟 reapStale 一样，重新排队而不是直接失败——客户端可能下次就成功）
  const reset = await query(
    `UPDATE render_jobs
       SET status='PENDING', claimed_by=NULL, claim_token=NULL,
           claimed_at=NULL, heartbeat_at=NULL, completed_at=NULL,
           error=NULL, result=NULL
     WHERE id = ANY($1::text[])`,
    [result.rows.map((r) => (r as { id: string }).id)],
  );
  if (shotIdSet.size > 0) {
    await query(
      `UPDATE shots SET "videoStatus"='PENDING', "updatedAt"=NOW()
        WHERE id = ANY($1::text[]) AND "videoStatus" IS DISTINCT FROM 'COMPLETED'`,
      [[...shotIdSet]],
    );
  }
  return reset.rowCount ?? 0;
}

/**
 * render-job 仓储对象（聚合所有函数，便于整体注入/mock）
 */
export const renderJobRepo = {
  create,
  createOrReuseChainGenerate,
  claimNext,
  countActiveClaims,
  markRunning,
  appendGroupClip,
  markResult,
  markFailed,
  reapStale,
  reapZombieJobs,
  getById,
  listByUser,
  getByTaskId,
  cancel,
  retry,
  createRetryCopy,
  forceFail,
  sweepStuckShots,
};
