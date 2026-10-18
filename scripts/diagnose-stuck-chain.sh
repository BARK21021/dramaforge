#!/usr/bin/env bash
# =============================================================================
# diagnose-stuck-chain.sh — dramaforge chain 假死一键诊断
# =============================================================================
# 机械化 known-issue 的 live gotcha：
#   「监视卡死任务不能只看 heartbeat（客户端进程活着 ≠ 生成在推进），
#     必须交叉验：claim 硬上限 + 近 N 分钟日志活动 + 扣费推进 + result 产出」
# 详见 docs/known-issues/chain-fakedeath.md。
#
# 这是 harness-engineering「闭环」原则的产物——把一条反复口述的 gotcha 变成
# agent / 运维都能一键跑的工具（写入工具 → 让错误自动可见）。
#
# 在哪跑：生产服务器上（任意目录，只用 docker exec，绝不直连网络 pg——会被
# 安全分类器拦）。凭据不写进脚本：pg user/db 从 dramaforge-postgres 容器 env 现取。
#
# 用法：
#   服务器直接：  bash scripts/diagnose-stuck-chain.sh [logmin]
#   本地一键：    ssh -i "KEY" root@YOUR_SERVER 'bash -s 15' < scripts/diagnose-stuck-chain.sh
#   （[logmin] = 日志/扣费活动窗口分钟数，默认 15）
# =============================================================================
set -uo pipefail

LOGMIN="${1:-15}"
PG_CONTAINER="dramaforge-postgres"

# pg user/db 从容器 env 现取，默认回落到 compose 默认值（postgres / dramaforge）
PGUSER="$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo postgres)"
PGDB="$(docker exec "$PG_CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo dramaforge)"

psql() { docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" "$@"; }

echo "================================================================"
echo " dramaforge chain 假死诊断   activity window = ${LOGMIN} min   pg=${PGUSER}@${PGDB}"
echo "================================================================"
echo

# ---- ① 非终态 render_jobs（权威清单）+ 硬上限判定 ----
# 阈值镜像 packages/server/src/task/render-job-repo.ts 的 maxClaimDurationSecondsForType：
#   LONG_VIDEO_REWRITE = 12h，其余 = 4h（strict 一键出片典型 30-60min，4h 覆盖+余量）。
echo "## ① 非终态 render_jobs (PENDING/CLAIMED/RUNNING) —— cap=PAST_CAP 即已过 claim 硬上限"
psql -c "
SELECT id,
       type,
       status,
       task_id,
       user_id,
       CASE WHEN claimed_at IS NULL THEN NULL
            ELSE extract(epoch from now()-claimed_at)::int END  AS claim_age_s,
       CASE WHEN heartbeat_at IS NULL THEN NULL
            ELSE extract(epoch from now()-heartbeat_at)::int END AS hb_age_s,
       (result IS NOT NULL) AS has_result,
       CASE
         WHEN claimed_at IS NOT NULL
              AND ( (type='LONG_VIDEO_REWRITE' AND claimed_at < now()-interval '12 hours')
                 OR (type<>'LONG_VIDEO_REWRITE' AND claimed_at < now()-interval '4 hours'))
            THEN 'PAST_CAP' ELSE 'ok'
       END AS cap,
       CASE
         WHEN heartbeat_at IS NOT NULL AND now()-heartbeat_at < interval '2 minutes'
            THEN 'FRESH' ELSE 'stale'
       END AS hb
FROM render_jobs
WHERE status IN ('PENDING','CLAIMED','RUNNING')
ORDER BY claimed_at DESC NULLS LAST;
"
echo

# ---- ② 假死签名：心跳新鲜(<2min) + 过硬上限 + 无 result —— reapStale 本该回收却没回收 ----
echo "## ② ⚠ 假死签名（hb<2min FRESH 且 PAST_CAP 且无 result）"
psql -c "
SELECT id, type, task_id, user_id,
       extract(epoch from now()-claimed_at)::int  AS claim_age_s,
       extract(epoch from now()-heartbeat_at)::int AS hb_age_s
FROM render_jobs
WHERE status IN ('CLAIMED','RUNNING')
  AND heartbeat_at IS NOT NULL
  AND now()-heartbeat_at < interval '2 minutes'
  AND result IS NULL
  AND ( (type='LONG_VIDEO_REWRITE' AND claimed_at < now()-interval '12 hours')
     OR (type<>'LONG_VIDEO_REWRITE' AND claimed_at < now()-interval '4 hours') );
"
echo "   （空 = 无典型假死；非空 = 这些 job 心跳还在续但早已过硬上限，reapStale 漏回收）"
echo

# ---- ③ 近 N 分钟容器日志活动（生成推进的旁证）----
echo "## ③ 近 ${LOGMIN} min 容器日志活动"
for c in dramaforge-ai-worker dramaforge-web; do
  if docker ps --format '{{.Names}}' | grep -qx "$c"; then
    total=$(docker logs --since "${LOGMIN}m" "$c" 2>&1 | wc -l | tr -d ' ')
    errs=$(docker logs --since "${LOGMIN}m" "$c" 2>&1 | grep -ciE 'error|exception|fail|ECONNREFUSED|OOM|timeout|duplicate key' || true)
    echo "   $c: ${total} 行 / 疑似错误 ${errs} 行"
  else
    echo "   $c: 容器未运行（跳过）"
  fi
done
echo

# ---- ④ 近 N 分钟计费扣费推进（生成真实推进的硬证据）----
echo "## ④ 近 ${LOGMIN} min billing_ledger 扣费推进"
psql -c "
SELECT count(*) AS rows, coalesce(sum(credits),0) AS credits
FROM billing_ledger
WHERE \"createdAt\" > now() - interval '${LOGMIN} minutes';
"
echo

echo "================================================================"
echo " 判读："
echo "  • ② 非空 = 典型假死（心跳续租骗过 lease 超时，但 claim 硬上限已到；reaper 应回收）。"
echo "  • ① 有 PAST_CAP 但 ② 空 = 卡死但心跳已停（等 lease 2min 超时回收，正常路径）。"
echo "  • ③ 日志近 0 行 + ④ 扣费 0 + 仍有 RUNNING job = 生成彻底卡住（非 heartbeat 能反映）。"
echo "  • 止血走 admin route POST /api/admin/render-jobs/[id]/force-fail，别裸 UPDATE。"
echo "  • 详见 docs/known-issues/chain-fakedeath.md。"
echo "================================================================"
