// ============================================================
// web/lib/render-job-slots — 客户端 render-worker 槽位数读取
// ============================================================
//
// 文件职责：
//   getRenderJobSlots() — 从 system_configs 读 RENDER_JOB_SLOTS 一行
//   （JSON number），返回客户端多槽并行上限的全局提示值。
//   供 /api/client/heartbeat（无鉴权）下发；per-user 真上限由
//   /api/render/jobs/next 按 users."maxConcurrent" 硬强制。
//
// 设计要点（镜像 versions.ts 的 SAFE_DEFAULT 模式）：
//   - 表缺失/行缺失/解析失败一律回退 DEFAULT_RENDER_JOB_SLOTS，绝不抛错——
//     heartbeat 是 ops 路径，配置坏不能连锁挂掉客户端。
//   - 运维可 SQL 调参（UPDATE system_configs SET value='5' WHERE key=
//     'RENDER_JOB_SLOTS'）不重部署；新客户端下次心跳即生效。
//
// web 禁止 import 任何 ffmpeg 模块；本模块仅做 pg query + JSON 解析。
// ============================================================

import { query } from '@dramaforge/server';

/** 默认槽位数：对齐迁移 0016-user-concurrency-10.sql 的 maxConcurrent=10 默认。 */
export const DEFAULT_RENDER_JOB_SLOTS = 10;

/** system_configs 中的槽位键名 */
const SLOTS_KEY = 'RENDER_JOB_SLOTS';

/**
 * 读取客户端 render-worker 槽位提示。
 *
 * 任何错误（表缺失/行缺失/JSON 解析失败/非数值）均回退默认值，不抛错。
 *
 * @returns 槽位数（1..16，超出按 16 截断；始终为正整数）
 */
export async function getRenderJobSlots(): Promise<number> {
  try {
    const result = await query(
      `SELECT value FROM system_configs WHERE key = $1 LIMIT 1`,
      [SLOTS_KEY],
    );
    const row = result.rows[0] as { value?: string | null } | undefined;
    if (!row || !row.value) return DEFAULT_RENDER_JOB_SLOTS;
    const parsed = JSON.parse(row.value) as unknown;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
      return DEFAULT_RENDER_JOB_SLOTS;
    }
    const n = Math.floor(parsed);
    if (n < 1) return 1;
    if (n > 16) return 16;
    return n;
  } catch {
    // 配置缺失/解析失败：回退默认，绝不抛错
    return DEFAULT_RENDER_JOB_SLOTS;
  }
}

/**
 * 管理员写入客户端 render-worker 槽位提示（system_configs.RENDER_JOB_SLOTS）。
 *
 * upsert 幂等；value 存 JSON number 字符串。任何错误上抛由 route 层 handleApiError
 * 处理（写路径与读路径不同：写失败要让管理员看到，不能静默）。
 *
 * @param slots 槽位数（1-16，route 层已校验）
 */
export async function setRenderJobSlots(slots: number): Promise<void> {
  await query(
    `INSERT INTO system_configs (key, value)
     VALUES ('RENDER_JOB_SLOTS', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(slots)],
  );
}
