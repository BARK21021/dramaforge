// ============================================================
// 平台 API Key 池 - 多 Key 加权轮询与健康管理
// ============================================================
//
// 文件职责（port app1 src/core/config/api-key-pool.ts，改 raw SQL 适配 dramaforge）：
//   平台级（api_configs."userId" IS NULL）多 Key 池：
//   1. pick(provider)：LoadBalancer 加权选一个可用 key（跳过 cooldown/invalid/disabled）
//   2. recordSuccess/recordFailure：按错误类型决定 cooldown 时长（健康熔断）
//   3. reapCooldownKeys：后台清扫过期 cooldown → 恢复 active
//   4. classifyKeyError：把原始错误分类为 auth/quota/rate_limit/server_error/network/timeout
//
// 与 app1 的差异：
//   - app1 是用户级（BYOK，按 userId 查）；dramaforge 是平台级（userId IS NULL，admin 管、全用户共享，GC-1）
//   - raw SQL via @server/infra query（dramaforge 不用 Prisma）
//   - cooldown 时长用常量（不依赖 app1 的 KEY_POOL_COOLDOWN_*_MS env）
//
// 池为空时 pick 返回 null，调用方明确提示管理员配置，不读取服务器环境变量 Key。
// ============================================================

import { query } from '@server/infra';

/**
 * Key 错误类型，决定 cooldown 策略
 */
export type KeyErrorKind =
  | 'auth' // 401 / 真·invalid 403 → 永久禁用（invalid）。注意 AccountOverdue 403 不在此列（→ quota）
  | 'quota' // 429 quota/billing 或 AccountOverdue 403（账户欠费）→ 30min cooldown 暂时关
  | 'rate_limit' // 429 rate limit → 60s cooldown
  | 'client_error' // 4xx（含 ARK 内容审核 400）→ 换 key 无效，只记审计不烧 key
  | 'server_error' // 5xx → 连续 N 次后 5min cooldown
  | 'network' // ENOTFOUND/ECONNRESET → 连续 N 次后 5min cooldown
  | 'timeout'; // timeout → 连续 N 次后 5min cooldown

/** cooldown / 熔断常量（毫秒） */
const COOLDOWN_QUOTA_MS = 30 * 60 * 1000; // 30min
const COOLDOWN_RATE_LIMIT_MS = 60 * 1000; // 60s
const COOLDOWN_SERVER_ERROR_MS = 5 * 60 * 1000; // 5min
const MAX_CONSECUTIVE_FAILURES = 5; // 连续失败阈值（server_error/network/timeout）
/**
 * 2026-08-03：连续欠费熔断阈值。AccountOverdue 是账号级问题——30min cooldown 到期
 * 自动恢复后仍会立刻失败（7/31 案例：3 把 key 循环欠费 30 分钟 × N 次，用户 38 次
 * 生成白跑）。连续欠费达到该次数 → keyStatus='quota_blocked' 停用，不再自动恢复，
 * 由运维充值后手动恢复（防止无效重试烧请求 + 触发监控告警）。
 */
const QUOTA_BLOCK_THRESHOLD = 3;

/**
 * 并发感知 pick 的有界等待参数。
 *
 * 所有 key 在途都打满时，pick 不超发（避免 429 雪崩），而是轮询等待 release()
 * 释放名额。正常 sizing（worker 并发 ≤ Σ maxConcurrent）下不会进入等待；此为
 * admin 加 key / 某把 key 进 cooldown 降容时的安全网——自动降速而非崩。
 */
const PICK_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 最多等 5 分钟（≈ 单个视频任务上限）
const PICK_POLL_INTERVAL_MS = 250; // 轮询间隔

import { sleep } from '@dramaforge/shared';

/**
 * 从池中选出的 key（供 credentials.ts 构造 ProviderCredential）
 */
export interface PoolEntry {
  /** api_configs 行 id（→ ProviderCredential.configId，用于健康回写 + 粘性锁） */
  configId: string;
  apiKey: string;
  baseUrl?: string;
  label?: string;
  weight: number;
}

/**
 * 根据错误状态码/消息分类错误类型。
 * 供 callAI 失败时调用，将原始错误转为 KeyErrorKind 喂给 recordFailure。
 */
export function classifyKeyError(error: unknown): KeyErrorKind {
  const err = error as {
    status?: number;
    response?: { status?: number };
    statusCode?: number;
    message?: string;
    code?: string;
  };
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  const msg = String(err?.message ?? err?.code ?? '').toLowerCase();
  // AccountOverdue（账户欠费/无余额权限）虽是 403，但 key 本身有效——只是账户没钱。
  // 误判 'auth' 会把好 key 永久写死 invalid（生产事故：7 个 ark key 同账户被一次性连坐）。
  // 归 'quota'（30min cooldown 暂时关掉），账户充值后 cooldown 到期自动恢复 active。
  if (
    status === 403 &&
    /accountoverdue|overdue|余额|no.?credit|insufficient.*balance|billing.*balance/.test(msg)
  ) {
    return 'quota';
  }
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) {
    if (/quota|billing|exhausted|insufficient/.test(msg)) return 'quota';
    return 'rate_limit';
  }
  // 4xx 客户端错误（含 ARK 内容审核 InputText/ImageSensitiveContentDetected）：
  // 换 key 无效——同账号同样判审核/同样参数错。绝不累计 consecutiveFailures、不进 cooldown，
  // 否则一把正常 key 会被用户的敏感输入连续 5 次误烧（生产事故根因）。
  if (status && status >= 400 && status < 500) return 'client_error';
  if (status && status >= 500) return 'server_error';
  if (/timeout|etimedout|aborted/.test(msg)) return 'timeout';
  if (/enotfound|econnreset|econnrefused|epipe|fetch failed/.test(msg)) return 'network';
  return 'server_error';
}

export class ApiKeyPool {
  /**
   * 每 key 在途请求数（进程内计数，单 worker 进程下准确）。
   *
   * 并发感知调度：pick 选「在途最少且未达 maxConcurrent」的 key，并在选中瞬间 +1
   * 预留（pick→callAI 间无 await，单进程下原子，防竞态超发）。
   * 配合 worker 并发 ≤ Σ(maxConcurrent)，可保证单 key 永不超过厂商并发上限。
   *
   * 多 worker 进程时此计数会分裂，需改 Redis 共享计数——当前单 worker 够用。
   */
  private inFlight = new Map<string, number>();

  /**
   * 从平台池选一个可用 key（并发感知：跳过 cooldown/invalid/disabled + 在途已满的）。
   *
   * 选择策略：在 active 且在途 < maxConcurrent 的 key 中，按 weight 加权比例选
   *「在途/权重」比值最小的（平手按 weight 大优先）——权重大者吸收更多流量，
   * 实现 weight 66/33 → 在跑视频 2:1 的按比例分布。选中即预留 inFlight+1，
   * 由 callAI 在调用结束后 release()。所有 key 都在途打满时有界等待（见下）。
   *
   * @returns 选中的 key（已预留一个在途名额）；池空返回 null
   */
  async pick(provider: string): Promise<PoolEntry | null> {
    try {
      const res = await query(
        `SELECT id, "apiKey", "baseUrl", weight, label, "maxConcurrent"
         FROM api_configs
         WHERE "userId" IS NULL
           AND provider = $1
           AND "isEnabled" = TRUE
           AND "keyStatus" = 'active'
           AND ("disabledUntil" IS NULL OR "disabledUntil" < NOW())
         ORDER BY "createdAt" ASC`,
        [provider],
      );
      const rows = (res.rows ?? []) as Array<{
        id: string;
        apiKey: string;
        baseUrl: string | null;
        weight: number;
        label: string | null;
        maxConcurrent: number | null;
      }>;
      if (rows.length === 0) return null;

      const used = (id: string) => this.inFlight.get(id) ?? 0;
      const hasCapacity = (r: (typeof rows)[number]) =>
        (r.maxConcurrent ?? Infinity) - used(r.id) > 0;

      // 并发感知：优先选还有余量的 key。
      let candidates = rows.filter(hasCapacity);

      // 全部在途打满 → 有界等待（轮询）直到有空位，避免超发触发 429 雪崩。
      // 正常 sizing（worker 并发 ≤ Σ maxConcurrent）下不会进入此分支；
      // 这是 admin 加 key / 某把 key 进 cooldown 降容时的安全网（自动降速而非崩）。
      if (candidates.length === 0) {
        const deadline = Date.now() + PICK_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await sleep(PICK_POLL_INTERVAL_MS);
          candidates = rows.filter(hasCapacity);
          if (candidates.length > 0) break;
        }
        if (candidates.length === 0) {
          console.warn(
            `[ApiKeyPool] pick(${provider}) 所有 key 在途打满，等待 ${PICK_WAIT_TIMEOUT_MS / 1000}s 仍无空位（可能全部 cooldown）`,
          );
          return null;
        }
      }

      // 加权比例分配：选 (在途 / 权重) 比值最小的 key —— 权重大的 key 吸收更多流量，
      // 实现 weight 66/33 → 在跑视频 2:1 的按比例分布（仅在需求 < 总容量时体现；
      // 满载时各 key 受各自 maxConcurrent 硬上限约束）。平手按 weight 大优先。
      const ratio = (r: (typeof rows)[number]) => used(r.id) / (r.weight ?? 1);
      candidates.sort((a, b) => {
        const diff = ratio(a) - ratio(b);
        if (diff !== 0) return diff;
        return (b.weight ?? 1) - (a.weight ?? 1);
      });
      const picked = candidates[0];

      // 预留在途名额（选中即占，防 pick 返回到 callAI 记录间的竞态超发）
      this.inFlight.set(picked.id, used(picked.id) + 1);

      // 异步更新 lastUsedAt（fire-and-forget，不阻塞主流程）
      query(`UPDATE api_configs SET "lastUsedAt" = NOW() WHERE id = $1`, [picked.id]).catch(
        () => {},
      );

      return {
        configId: picked.id,
        apiKey: picked.apiKey,
        baseUrl: picked.baseUrl ?? undefined,
        label: picked.label ?? undefined,
        weight: picked.weight ?? 1,
      };
    } catch (err) {
      console.warn(`[ApiKeyPool] pick(${provider}) 失败:`, err);
      return null;
    }
  }

  /**
   * 释放一把 key 的在途名额。
   *
   * callAI 在 provider 调用结束（无论成败）后调用，与 pick() 的预留配对。
   * 对未被 pick 预留过的 configId（如 pickById 粘性锁路径）是 no-op，安全。
   */
  release(configId: string): void {
    const cur = this.inFlight.get(configId) ?? 0;
    if (cur <= 0) return; // 防御：不计成负数
    this.inFlight.set(configId, cur - 1);
  }

  /**
   * 按 configId（pinned）直接取一个具体 key（粘性锁复用：复用已上传文件时锁回原 key）。
   * 不走轮询，但校验 enabled/active。
   * @returns 该 config 的 key；不存在/不可用返回 null
   */
  async pickById(configId: string): Promise<PoolEntry | null> {
    try {
      const res = await query(
        `SELECT id, "apiKey", "baseUrl", weight, label
         FROM api_configs
         WHERE id = $1 AND "userId" IS NULL AND "isEnabled" = TRUE`,
        [configId],
      );
      const r = res.rows?.[0] as
        | { id: string; apiKey: string; baseUrl: string | null; weight: number; label: string | null }
        | undefined;
      if (!r?.apiKey) return null;
      return {
        configId: r.id,
        apiKey: r.apiKey,
        baseUrl: r.baseUrl ?? undefined,
        label: r.label ?? undefined,
        weight: r.weight ?? 1,
      };
    } catch (err) {
      console.warn(`[ApiKeyPool] pickById(${configId}) 失败:`, err);
      return null;
    }
  }

  /** 记录成功：清零 consecutiveFailures，状态回 active */
  async recordSuccess(configId: string): Promise<void> {
    try {
      await query(
        `UPDATE api_configs
         SET "consecutiveFailures" = 0, "lastUsedAt" = NOW(), "keyStatus" = 'active'
         WHERE id = $1`,
        [configId],
      );
    } catch (err) {
      console.warn(`[ApiKeyPool] recordSuccess(${configId}) 失败:`, err);
    }
  }

  /** 记录失败：按错误类型决定 cooldown */
  async recordFailure(
    configId: string,
    errorKind: KeyErrorKind,
    errorMessage?: string,
  ): Promise<void> {
    try {
      const msg = errorMessage?.slice(0, 500);

      switch (errorKind) {
        case 'client_error':
          // 4xx 客户端错误（含内容审核）：换 key 无效，只记审计，不动 key 健康。
          await query(
            `UPDATE api_configs
             SET "lastErrorMessage" = $2
             WHERE id = $1`,
            [configId, msg ?? '客户端请求错误（4xx，含内容审核）'],
          );
          break;

        case 'auth':
          // 永久禁用（invalid），需 admin 修复后手动重置
          await query(
            `UPDATE api_configs
             SET "keyStatus" = 'invalid', "disabledUntil" = NULL,
                 "errorCount" = "errorCount" + 1,
                 "consecutiveFailures" = "consecutiveFailures" + 1,
                 "lastErrorMessage" = $2
             WHERE id = $1`,
            [configId, msg ?? 'invalid api key (401/403)'],
          );
          console.warn(`[ApiKeyPool] key ${configId} 标记 invalid（认证失败，需 admin 修复）`);
          break;

        case 'quota': {
          // 原子计数（对齐 server_error 分支的 RETURNING 模式，防并发覆盖）
          const incr = await query(
            `UPDATE api_configs
               SET "errorCount" = "errorCount" + 1,
                   "consecutiveFailures" = "consecutiveFailures" + 1,
                   "lastErrorMessage" = $2
             WHERE id = $1
             RETURNING "consecutiveFailures"`,
            [configId, msg ?? 'quota exceeded (429)'],
          );
          const quotaCount = Number(
            (incr.rows?.[0] as { consecutiveFailures?: number } | undefined)?.consecutiveFailures ?? 0,
          );
          if (quotaCount >= QUOTA_BLOCK_THRESHOLD) {
            // 连续欠费达阈值 → 熔断停用，不再自动恢复（欠费是账号级，恢复后必再失败）
            await query(
              `UPDATE api_configs
               SET "keyStatus" = 'quota_blocked', "disabledUntil" = NULL,
                   "lastErrorMessage" = $2
               WHERE id = $1 AND "consecutiveFailures" >= $3`,
              [
                configId,
                msg ?? `连续欠费 ${quotaCount} 次，已停止自动恢复（充值后需人工恢复）`,
                QUOTA_BLOCK_THRESHOLD,
              ],
            );
            console.error(
              `[ApiKeyPool] key ${configId} 连续欠费 ${quotaCount} 次 → quota_blocked（需人工充值后恢复）`,
            );
          } else {
            const until = new Date(Date.now() + COOLDOWN_QUOTA_MS);
            await query(
              `UPDATE api_configs
               SET "keyStatus" = 'cooldown', "disabledUntil" = $2,
                   "lastErrorMessage" = $3
               WHERE id = $1`,
              [configId, until, msg ?? 'quota exceeded (429)'],
            );
          }
          break;
        }

        case 'rate_limit': {
          const until = new Date(Date.now() + COOLDOWN_RATE_LIMIT_MS);
          await query(
            `UPDATE api_configs
             SET "keyStatus" = 'cooldown', "disabledUntil" = $2,
                 "errorCount" = "errorCount" + 1,
                 "consecutiveFailures" = "consecutiveFailures" + 1,
                 "lastErrorMessage" = $3
             WHERE id = $1`,
            [configId, until, msg ?? 'rate limit (429)'],
          );
          break;
        }

        case 'server_error':
        case 'network':
        case 'timeout': {
          // P1-4：原子计数消除 SELECT-then-UPDATE 竞态。
          // 旧实现先 SELECT "consecutiveFailures" 应用层 +1 再 UPDATE 写回——两次 SQL 间
          // 并发的 recordSuccess（强制置 0）或并发失败会被后写覆盖，导致 consecutiveFailures
          // 不准、cooldown 时机偏移（误杀刚恢复的 key，或让坏 key 多烧几次才熔断）。
          // 现改为单条原子 UPDATE ... "consecutiveFailures"="consecutiveFailures"+1
          // RETURNING 新值，应用层据返回值判阈值（DB 自增天然串行化并发 +1）。
          const incr = await query(
            `UPDATE api_configs
               SET "errorCount" = "errorCount" + 1,
                   "consecutiveFailures" = "consecutiveFailures" + 1,
                   "lastErrorMessage" = $2
             WHERE id = $1
             RETURNING "consecutiveFailures"`,
            [configId, msg ?? errorKind],
          );
          const newCount = Number(
            (incr.rows?.[0] as { consecutiveFailures?: number } | undefined)?.consecutiveFailures ?? 0,
          );

          // 达阈值进 cooldown（计数已在上一条原子完成，本条只置熔断状态）。
          // WHERE 再校验 "consecutiveFailures" >= 阈值：若 RETURNING 到本 UPDATE 之间有
          // recordSuccess 抢先置 0，则本条不触发（防误杀刚恢复的 key，闭环竞态根因）。
          if (newCount >= MAX_CONSECUTIVE_FAILURES) {
            const until = new Date(Date.now() + COOLDOWN_SERVER_ERROR_MS);
            await query(
              `UPDATE api_configs
               SET "keyStatus" = 'cooldown', "disabledUntil" = $2,
                   "lastErrorMessage" = $3
               WHERE id = $1 AND "consecutiveFailures" >= $4`,
              [configId, until, msg ?? `${errorKind} 连续失败 ${newCount} 次`, MAX_CONSECUTIVE_FAILURES],
            );
            console.warn(
              `[ApiKeyPool] key ${configId} 进 cooldown（${errorKind} 连续失败 ${newCount} 次）`,
            );
          }
          break;
        }
      }
    } catch (err) {
      console.warn(`[ApiKeyPool] recordFailure(${configId}) 失败:`, err);
    }
  }

  /**
   * 后台清扫：将 disabledUntil 已过期的 cooldown key 恢复为 active。
   * @returns 恢复的 key 数量
   */
  async reapCooldownKeys(): Promise<number> {
    try {
      const result = await query(
        `UPDATE api_configs
         SET "keyStatus" = 'active', "disabledUntil" = NULL, "consecutiveFailures" = 0
         WHERE "keyStatus" = 'cooldown'
           AND "disabledUntil" IS NOT NULL
           AND "disabledUntil" < NOW()`,
      );
      const count = (result as { rowCount?: number }).rowCount ?? 0;
      if (count > 0) {
        console.log(`[ApiKeyPool] 恢复 ${count} 个过期 cooldown key 为 active`);
      }
      return count;
    } catch (err) {
      console.warn(`[ApiKeyPool] reapCooldownKeys 失败:`, err);
      return 0;
    }
  }
}

/** 平台 key 池单例 */
let _instance: ApiKeyPool | null = null;
export function getApiKeyPool(): ApiKeyPool {
  if (!_instance) _instance = new ApiKeyPool();
  return _instance;
}

// ============================================================
// cooldown reap 定时（借宿 ai-worker，仿 payment/sweep.ts）
// ============================================================

/** key 池 cooldown reap sweep 句柄 */
export interface ReapSweepHandle {
  stop: () => void;
}

/** cooldown reap 节拍（默认 60s，对齐 payment sweep） */
const KEY_POOL_REAP_INTERVAL_MS = 60 * 1000;

/**
 * 启动 key 池 cooldown reap 定时（常驻 worker 调一次）。
 * 每 tick 把 disabledUntil 已过期的 cooldown key 恢复为 active（自动解除限流/熔断）。
 * overlap guard：上一 tick 没跑完不起新 tick。返回 stop 句柄。
 */
export function startKeyPoolReapSweep(intervalMs = KEY_POOL_REAP_INTERVAL_MS): ReapSweepHandle {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await getApiKeyPool().reapCooldownKeys();
    } catch (err) {
      // 定时器层绝不能因 tick 死掉
      console.error('[key-pool-reap] tick 未捕获异常', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
