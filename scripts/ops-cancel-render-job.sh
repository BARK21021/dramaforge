#!/usr/bin/env bash
# =============================================================================
# ops-cancel-render-job.sh — 把指定 render_job 置 CANCELLED（运维止血）
# =============================================================================
# 用途：CHAIN_COMPILE 假死 / 被回收继续跑浪费重生 / 需要手动停掉某个 render_job，
# 而 UI 又没有取消入口时（例如被 stale-reclaim 捡回来继续跑的废弃全量任务）。
#
# 只把目标 job 推到 CANCELLED 终态：
#   - 终态后不会再被 claimNext 回收、不会被 createOrReuse 复用；
#   - 客户端 worker 下一次心跳 /progress 会因 status 不在 ('CLAIMED','RUNNING') 拿到 409
#     → executionController.abort() 自愈中断在跑的执行（见 render-worker/loop.ts）；
#   - 不动 shots 表：已 COMPLETED 的镜头（原片）不受影响；仅可能卡 GENERATING 的镜头
#     由 ai-worker 60s 的 sweepStuckShots 自然回 PENDING（CANCELLED job → PENDING）。
#     等价于 renderJobRepo.cancel 的语义，但用裸 SQL 方便运维一键执行。
#
# 在哪跑：生产服务器上（任意目录，只用 docker exec，绝不直连网络 pg——会被安全
# 分类器拦）。凭据不写进脚本：pg user/db 从 dramaforge-postgres 容器 env 现取。
#
# 用法：
#   服务器直接：  bash scripts/ops-cancel-render-job.sh <render_job_id>
#   本地一键：    ssh -i ~/.ssh/deploy_key root@YOUR_SERVER \
#                   'bash -s <render_job_id>' < scripts/ops-cancel-render-job.sh
# =============================================================================
set -uo pipefail

JOBID="${1:-}"
if [ -z "$JOBID" ]; then
  echo "用法: $0 <render_job_id>" >&2
  exit 1
fi

PG_CONTAINER="dramaforge-postgres"
PGUSER="$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo postgres)"
PGDB="$(docker exec "$PG_CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo dramaforge)"

echo "================================================================"
echo " ops cancel render_job   job=${JOBID}   pg=${PGUSER}@${PGDB}"
echo "================================================================"

echo "## before"
docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -c \
  "SELECT id, type, status, claimed_at, heartbeat_at FROM render_jobs WHERE id='${JOBID}';"

echo "## cancel (only PENDING/CLAIMED/RUNNING → CANCELLED)"
UPDATE_OUT="$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -t -A -c \
  "UPDATE render_jobs SET status='CANCELLED', error='ops-cancel: 运维手动止血', completed_at=now(), heartbeat_at=now() WHERE id='${JOBID}' AND status IN ('PENDING','CLAIMED','RUNNING') RETURNING id,status;")"

if [ -z "$UPDATE_OUT" ]; then
  echo "  ⚠ 未更新：job 已是终态（COMPLETED/FAILED/CANCELLED/TIMEOUT），无需取消。"
else
  echo "  ✅ 已取消：${UPDATE_OUT}"
fi

echo "## after"
docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -c \
  "SELECT id, type, status, error FROM render_jobs WHERE id='${JOBID}';"
